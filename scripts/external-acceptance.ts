import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAcceptanceCheck,
  isAcceptanceService,
  loadAcceptanceReport,
  recordAcceptanceCheck,
  safeErrorCode,
  type AcceptanceStatus,
} from "./acceptance-report";
import {
  AcceptanceConfirmationRequiredError,
  MissingAcceptanceConfigurationError,
  runAcceptanceProbe,
} from "./acceptance-probes";

const root = process.cwd();
const statePath = join(
  root,
  "artifacts",
  "acceptance",
  ".meta-acceptance-state.json",
);

function currentCommitSha(): string {
  const injected =
    process.env.ACCEPTANCE_COMMIT_SHA ??
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    process.env.GITHUB_SHA;
  if (injected) return injected;
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

async function loadMetaState(): Promise<Record<string, string>> {
  return readFile(statePath, "utf8")
    .then((value) => JSON.parse(value) as Record<string, string>)
    .catch(() => ({}));
}

async function saveMetaState(state: Record<string, string>) {
  await mkdir(join(root, "artifacts", "acceptance"), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
}

function exitFor(status: AcceptanceStatus) {
  if (status === "fail") process.exitCode = 1;
  else if (status === "blocked") process.exitCode = 2;
}

export async function main() {
  const serviceArg = process.argv[2] ?? "";
  const scenario = process.argv[3] ?? "all";
  if (!isAcceptanceService(serviceArg))
    throw Object.assign(
      new Error("Use meta, bitrix, storage, malware or smtp"),
      {
        code: "ACCEPTANCE_SERVICE_UNSUPPORTED",
      },
    );
  const service = serviceArg;
  const commitSha = currentCommitSha();
  const signingKey = process.env.ACCEPTANCE_EVIDENCE_SIGNING_KEY;
  if (!signingKey || signingKey.length < 32) {
    process.stdout.write(
      JSON.stringify({
        service,
        scenario,
        status: "blocked",
        missingConfiguration: ["ACCEPTANCE_EVIDENCE_SIGNING_KEY"],
        errorCode: "ACCEPTANCE_SIGNING_KEY_INVALID",
      }) + "\n",
    );
    process.exitCode = 2;
    return;
  }
  if (scenario === "report") {
    const report = await loadAcceptanceReport(root, service);
    const status = report?.status ?? "blocked";
    process.stdout.write(
      JSON.stringify({
        service,
        status,
        commitSha: report?.commitSha ?? null,
        requiredScenarios: report?.requiredScenarios ?? [],
        completedScenarios:
          report?.checks
            .filter((check) => check.status === "pass")
            .map((check) => check.scenario) ?? [],
      }) + "\n",
    );
    exitFor(status);
    return;
  }

  const startedAt = Date.now();
  const correlationId = randomUUID();
  const env = { ...process.env };
  if (service === "meta" && scenario === "wait-status") {
    const state = await loadMetaState();
    env.META_ACCEPTANCE_PROVIDER_MESSAGE_ID ??= state.providerMessageId;
  }

  let status: AcceptanceStatus = "pass";
  let evidence = {};
  let missingConfiguration: string[] | undefined;
  let errorCode: string | undefined;
  try {
    const result = await runAcceptanceProbe({
      service,
      scenario,
      env,
      correlationId,
    });
    evidence = result.evidence;
    if (service === "meta" && result.privateState)
      await saveMetaState({
        ...(await loadMetaState()),
        ...result.privateState,
        correlationId,
      });
  } catch (error) {
    if (error instanceof MissingAcceptanceConfigurationError) {
      status = "blocked";
      missingConfiguration = error.missing;
    } else if (error instanceof AcceptanceConfirmationRequiredError) {
      status = "blocked";
      missingConfiguration = [error.confirmation];
    } else {
      status = "fail";
    }
    errorCode = safeErrorCode(error);
  }

  const check = createAcceptanceCheck({
    scenario,
    status,
    startedAt,
    correlationId,
    evidence,
    ...(missingConfiguration ? { missingConfiguration } : {}),
    ...(errorCode ? { errorCode } : {}),
  });
  const report = await recordAcceptanceCheck({
    root,
    service,
    check,
    commitSha,
    environment:
      process.env.ACCEPTANCE_ENVIRONMENT ??
      process.env.APP_ENV ??
      process.env.NODE_ENV ??
      "unknown",
    signingKey,
  });
  process.stdout.write(
    JSON.stringify({
      service,
      scenario,
      status,
      reportStatus: report.status,
      correlationId,
      missingConfiguration: check.missingConfiguration ?? [],
      errorCode: check.errorCode ?? null,
    }) + "\n",
  );
  exitFor(status);
}

if (process.argv[1]?.match(/external-acceptance\.(?:ts|js)$/))
  void main().catch((error) => {
    process.stderr.write(
      JSON.stringify({
        status: "fail",
        errorCode: safeErrorCode(error),
      }) + "\n",
    );
    process.exitCode = 1;
  });
