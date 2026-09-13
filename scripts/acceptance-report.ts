import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const acceptanceServices = [
  "meta",
  "bitrix",
  "storage",
  "malware",
  "smtp",
] as const;

export type AcceptanceService = (typeof acceptanceServices)[number];
export type AcceptanceStatus = "pass" | "fail" | "blocked";
export type SafeEvidenceValue = string | number | boolean | null;

export interface AcceptanceCheck {
  scenario: string;
  status: AcceptanceStatus;
  checkedAt: string;
  durationMs: number;
  correlationId: string;
  evidence: Record<string, SafeEvidenceValue>;
  missingConfiguration?: string[];
  errorCode?: string;
}

export interface AcceptanceReport {
  schemaVersion: 2;
  service: AcceptanceService;
  status: AcceptanceStatus;
  generatedAt: string;
  expiresAt: string;
  commitSha: string;
  environment: string;
  requiredScenarios: string[];
  checks: AcceptanceCheck[];
  signature: string;
}

export const requiredAcceptanceScenarios: Record<
  AcceptanceService,
  readonly string[]
> = {
  meta: ["verify", "send-text", "wait-status", "wait-inbound"],
  bitrix: ["health", "crm-context", "open-channels"],
  storage: ["all"],
  malware: ["all"],
  smtp: ["all"],
};

const reportFile = (root: string, service: AcceptanceService) =>
  join(root, "artifacts", "acceptance", `${service}-acceptance-report.json`);

export function isAcceptanceService(value: string): value is AcceptanceService {
  return acceptanceServices.includes(value as AcceptanceService);
}

export function hashEvidence(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = Reflect.get(error, "code");
    if (typeof code === "string" && /^[A-Z0-9_-]{1,80}$/i.test(code))
      return code.toUpperCase();
    const name = Reflect.get(error, "name");
    if (typeof name === "string" && /^[A-Z0-9_-]{1,80}$/i.test(name))
      return name.toUpperCase();
  }
  return "EXTERNAL_ACCEPTANCE_FAILED";
}

function summarize(
  service: AcceptanceService,
  checks: AcceptanceCheck[],
): AcceptanceStatus {
  const latest = new Map(checks.map((check) => [check.scenario, check]));
  const required = requiredAcceptanceScenarios[service];
  if (required.some((scenario) => latest.get(scenario)?.status === "fail"))
    return "fail";
  return required.every((scenario) => latest.get(scenario)?.status === "pass")
    ? "pass"
    : "blocked";
}

export async function loadAcceptanceReport(
  root: string,
  service: AcceptanceService,
): Promise<AcceptanceReport | null> {
  return readFile(reportFile(root, service), "utf8")
    .then((value) => JSON.parse(value) as AcceptanceReport)
    .then((report) =>
      report.schemaVersion === 2 && report.service === service ? report : null,
    )
    .catch(() => null);
}

export async function recordAcceptanceCheck(input: {
  root: string;
  service: AcceptanceService;
  check: AcceptanceCheck;
  commitSha: string;
  environment: string;
  now?: Date;
  maxAgeHours?: number;
  signingKey: string;
}): Promise<AcceptanceReport> {
  assertSigningKey(input.signingKey);
  const now = input.now ?? new Date();
  const existing = await loadAcceptanceReport(input.root, input.service);
  const reusableChecks =
    existing?.commitSha === input.commitSha &&
    verifyAcceptanceReportSignature(existing, input.signingKey)
      ? existing.checks
      : [];
  const checks = [
    ...reusableChecks.filter(
      (check) => check.scenario !== input.check.scenario,
    ),
    input.check,
  ].sort((a, b) => a.scenario.localeCompare(b.scenario));
  const unsigned = {
    schemaVersion: 2 as const,
    service: input.service,
    status: summarize(input.service, checks),
    generatedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + (input.maxAgeHours ?? 24) * 60 * 60 * 1000,
    ).toISOString(),
    commitSha: input.commitSha,
    environment: input.environment,
    requiredScenarios: [...requiredAcceptanceScenarios[input.service]],
    checks,
  };
  const report: AcceptanceReport = {
    ...unsigned,
    signature: signAcceptanceReport(unsigned, input.signingKey),
  };
  const dir = join(input.root, "artifacts", "acceptance");
  await mkdir(dir, { recursive: true });
  await writeFile(
    reportFile(input.root, input.service),
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    join(dir, `${input.service}-acceptance-report.md`),
    renderAcceptanceMarkdown(report),
  );
  return report;
}

export function createAcceptanceCheck(input: {
  scenario: string;
  status: AcceptanceStatus;
  startedAt: number;
  now?: Date;
  correlationId?: string;
  evidence?: Record<string, SafeEvidenceValue>;
  missingConfiguration?: string[];
  errorCode?: string;
}): AcceptanceCheck {
  const now = input.now ?? new Date();
  return {
    scenario: input.scenario,
    status: input.status,
    checkedAt: now.toISOString(),
    durationMs: Math.max(0, now.getTime() - input.startedAt),
    correlationId: input.correlationId ?? randomUUID(),
    evidence: input.evidence ?? {},
    ...(input.missingConfiguration?.length
      ? { missingConfiguration: [...input.missingConfiguration].sort() }
      : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  };
}

export function validateAcceptanceReport(input: {
  report: AcceptanceReport | null;
  expectedCommitSha: string;
  signingKey?: string;
  now?: Date;
}): { status: AcceptanceStatus; reason: string } {
  if (!input.report) return { status: "blocked", reason: "report_missing" };
  if (!input.signingKey || input.signingKey.length < 32)
    return { status: "blocked", reason: "signing_key_missing" };
  if (!verifyAcceptanceReportSignature(input.report, input.signingKey))
    return { status: "fail", reason: "signature_invalid" };
  if (input.report.commitSha !== input.expectedCommitSha)
    return { status: "blocked", reason: "commit_mismatch" };
  if (
    new Date(input.report.expiresAt).getTime() <=
    (input.now ?? new Date()).getTime()
  )
    return { status: "blocked", reason: "report_expired" };
  if (input.report.status !== "pass")
    return {
      status: input.report.status,
      reason: "required_scenarios_incomplete",
    };
  return { status: "pass", reason: "fresh_matching_evidence" };
}

type UnsignedAcceptanceReport = Omit<AcceptanceReport, "signature">;

function assertSigningKey(signingKey: string) {
  if (signingKey.length < 32)
    throw Object.assign(
      new Error(
        "Acceptance evidence signing key must be at least 32 characters",
      ),
      { code: "ACCEPTANCE_SIGNING_KEY_INVALID" },
    );
}

function signAcceptanceReport(
  report: UnsignedAcceptanceReport,
  signingKey: string,
): string {
  return createHmac("sha256", signingKey)
    .update(JSON.stringify(report))
    .digest("base64url");
}

export function verifyAcceptanceReportSignature(
  report: AcceptanceReport,
  signingKey: string,
): boolean {
  if (signingKey.length < 32) return false;
  const { signature, ...unsigned } = report;
  const expected = Buffer.from(
    signAcceptanceReport(unsigned, signingKey),
    "base64url",
  );
  const actual = Buffer.from(signature, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function renderAcceptanceMarkdown(report: AcceptanceReport): string {
  const rows = report.checks
    .map(
      (check) =>
        `| ${check.scenario} | ${check.status} | ${check.checkedAt} | ${check.errorCode ?? "-"} |`,
    )
    .join("\n");
  return `# ${report.service.toUpperCase()} acceptance

Status: **${report.status}**

Commit: \`${report.commitSha}\`

Generated: ${report.generatedAt}

Expires: ${report.expiresAt}

| Scenario | Status | Checked | Error |
| --- | --- | --- | --- |
${rows || "| none | blocked | - | report_missing |"}
`;
}
