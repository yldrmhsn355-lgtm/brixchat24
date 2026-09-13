import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acceptanceServices,
  loadAcceptanceReport,
  safeErrorCode,
  validateAcceptanceReport,
  type AcceptanceStatus,
} from "./acceptance-report";

export interface ReleaseGateCheck {
  name: string;
  status: AcceptanceStatus;
  reason: string;
  evidence: string;
}

export interface ReleaseGateReport {
  status: AcceptanceStatus;
  classification: string;
  generatedAt: string;
  commitSha: string;
  checks: ReleaseGateCheck[];
}

interface StaticEvidence {
  path: string;
  validate?: (content: string) => boolean;
  immutable?: boolean;
}

interface SourceIntegrity {
  headSha: string;
  clean: boolean;
}

function inspectSourceIntegrity(root: string): SourceIntegrity {
  const headSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const status = execFileSync(
    "git",
    ["-C", root, "status", "--porcelain", "--untracked-files=all"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim();
  return { headSha, clean: status.length === 0 };
}

const staticEvidence: StaticEvidence[] = [
  {
    path: "artifacts/security/dependency-audit.json",
    validate: (content) => {
      const parsed = JSON.parse(content) as {
        metadata?: { vulnerabilities?: { critical?: number } };
      };
      return (parsed.metadata?.vulnerabilities?.critical ?? 0) === 0;
    },
  },
  {
    path: "artifacts/security/sbom.cdx.json",
    validate: (content) =>
      (JSON.parse(content) as { bomFormat?: string }).bomFormat === "CycloneDX",
  },
  {
    path: "artifacts/security/licenses.json",
    validate: (content) => typeof JSON.parse(content) === "object",
  },
  {
    path: "artifacts/security/secret-scan.json",
    validate: (content) =>
      (JSON.parse(content) as { findings?: unknown[] }).findings?.length === 0,
  },
  {
    path: "artifacts/performance/load-test-report.md",
    validate: (content) => content.includes("Result: **PASS**"),
  },
  {
    path: "artifacts/recovery/migration-safety-report.json",
    validate: (content) =>
      (JSON.parse(content) as { status?: string }).status === "pass",
  },
  {
    path: "artifacts/recovery/backup-restore-report.json",
    validate: (content) => {
      const parsed = JSON.parse(content) as {
        status?: string;
        sourceEnvironment?: string;
        sourceReadOnlyDump?: boolean;
        dumpSha256?: string;
        restoredMigrationRows?: number;
        temporaryDatabaseRemoved?: boolean;
      };
      return (
        parsed.status === "pass" &&
        parsed.sourceEnvironment === "production" &&
        parsed.sourceReadOnlyDump === true &&
        /^[a-f0-9]{64}$/.test(parsed.dumpSha256 ?? "") &&
        (parsed.restoredMigrationRows ?? 0) > 0 &&
        parsed.temporaryDatabaseRemoved === true
      );
    },
  },
  { path: "docs/RELEASE-CHECKLIST.md", immutable: true },
  { path: "docs/ROLLBACK.md", immutable: true },
];

async function validateStaticEvidence(input: {
  root: string;
  descriptor: StaticEvidence;
  now: Date;
  maxAgeHours: number;
}): Promise<ReleaseGateCheck> {
  const fullPath = join(input.root, input.descriptor.path);
  try {
    await access(fullPath);
    const content = await readFile(fullPath, "utf8");
    if (input.descriptor.validate && !input.descriptor.validate(content))
      return {
        name: input.descriptor.path,
        status: "fail",
        reason: "evidence_failed_validation",
        evidence: input.descriptor.path,
      };
    if (!input.descriptor.immutable) {
      const metadata = await stat(fullPath);
      const oldestAllowed =
        input.now.getTime() - input.maxAgeHours * 60 * 60 * 1000;
      if (metadata.mtimeMs < oldestAllowed)
        return {
          name: input.descriptor.path,
          status: "blocked",
          reason: "evidence_expired",
          evidence: input.descriptor.path,
        };
    }
    return {
      name: input.descriptor.path,
      status: "pass",
      reason: "evidence_valid",
      evidence: input.descriptor.path,
    };
  } catch {
    return {
      name: input.descriptor.path,
      status: "fail",
      reason: "evidence_missing_or_invalid",
      evidence: input.descriptor.path,
    };
  }
}

export async function evaluateReleaseGate(input: {
  root: string;
  expectedCommitSha: string;
  signingKey?: string;
  now?: Date;
  maxAgeHours?: number;
  sourceIntegrity?: SourceIntegrity;
}): Promise<ReleaseGateReport> {
  const now = input.now ?? new Date();
  const sourceIntegrity =
    input.sourceIntegrity ?? inspectSourceIntegrity(input.root);
  const sourceMatches =
    sourceIntegrity.clean &&
    sourceIntegrity.headSha === input.expectedCommitSha;
  const checks: ReleaseGateCheck[] = [
    {
      name: "source_commit_integrity",
      status: sourceMatches ? "pass" : "blocked",
      reason: !sourceIntegrity.clean
        ? "working_tree_dirty"
        : sourceIntegrity.headSha !== input.expectedCommitSha
          ? "head_commit_mismatch"
          : "clean_matching_commit",
      evidence: input.expectedCommitSha,
    },
    ...(await Promise.all(
    staticEvidence.map((descriptor) =>
      validateStaticEvidence({
        root: input.root,
        descriptor,
        now,
        maxAgeHours: input.maxAgeHours ?? 24,
      }),
    ),
    )),
  ];
  for (const service of acceptanceServices) {
    const report = await loadAcceptanceReport(input.root, service);
    const result = validateAcceptanceReport({
      report,
      expectedCommitSha: input.expectedCommitSha,
      ...(input.signingKey ? { signingKey: input.signingKey } : {}),
      now,
    });
    checks.push({
      name: `${service}_external_acceptance`,
      status: result.status,
      reason: result.reason,
      evidence: `artifacts/acceptance/${service}-acceptance-report.json`,
    });
  }
  const status: AcceptanceStatus = checks.some(
    (check) => check.status === "fail",
  )
    ? "fail"
    : checks.some((check) => check.status === "blocked")
      ? "blocked"
      : "pass";
  return {
    status,
    classification:
      status === "pass"
        ? "Production Release Candidate"
        : status === "blocked"
          ? "Production Candidate - Evidence Pending"
          : "Not releasable",
    generatedAt: now.toISOString(),
    commitSha: input.expectedCommitSha,
    checks,
  };
}

function currentCommitSha(): string {
  return (
    process.env.RELEASE_COMMIT_SHA ??
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    process.env.GITHUB_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  );
}

async function main() {
  const root = process.cwd();
  const signingKey = process.env.ACCEPTANCE_EVIDENCE_SIGNING_KEY;
  const report = await evaluateReleaseGate({
    root,
    expectedCommitSha: currentCommitSha(),
    ...(signingKey ? { signingKey } : {}),
    maxAgeHours: Number(process.env.RELEASE_EVIDENCE_MAX_AGE_HOURS ?? 24),
  });
  await mkdir(join(root, "artifacts", "release"), { recursive: true });
  await writeFile(
    join(root, "artifacts", "release", "release-gate.json"),
    JSON.stringify(report, null, 2),
  );
  process.stdout.write(JSON.stringify(report) + "\n");
  if (report.status === "fail") process.exitCode = 1;
  else if (report.status === "blocked") process.exitCode = 2;
}

if (process.argv[1]?.match(/release-gate\.(?:ts|js)$/))
  void main().catch((error) => {
    process.stderr.write(
      JSON.stringify({
        status: "fail",
        errorCode: safeErrorCode(error),
      }) + "\n",
    );
    process.exitCode = 1;
  });
