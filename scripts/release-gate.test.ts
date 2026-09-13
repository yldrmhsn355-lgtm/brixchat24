import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptanceServices,
  createAcceptanceCheck,
  recordAcceptanceCheck,
  requiredAcceptanceScenarios,
} from "./acceptance-report";
import { evaluateReleaseGate } from "./release-gate";

const roots: string[] = [];
const commitSha = "c".repeat(40);
const signingKey = "release-gate-test-signing-key-32-characters";
const now = new Date("2026-07-26T14:00:00.000Z");
const cleanSource = { headSha: commitSha, clean: true };

async function put(root: string, path: string, content: string) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function validStaticEvidence(root: string) {
  await put(
    root,
    "artifacts/security/dependency-audit.json",
    JSON.stringify({ metadata: { vulnerabilities: { critical: 0 } } }),
  );
  await put(
    root,
    "artifacts/security/sbom.cdx.json",
    JSON.stringify({ bomFormat: "CycloneDX" }),
  );
  await put(root, "artifacts/security/licenses.json", "{}");
  await put(
    root,
    "artifacts/security/secret-scan.json",
    JSON.stringify({ findings: [] }),
  );
  await put(
    root,
    "artifacts/performance/load-test-report.md",
    "Result: **PASS**",
  );
  await put(
    root,
    "artifacts/recovery/migration-safety-report.json",
    JSON.stringify({ status: "pass" }),
  );
  await put(
    root,
    "artifacts/recovery/backup-restore-report.json",
    JSON.stringify({
      status: "pass",
      sourceEnvironment: "production",
      sourceReadOnlyDump: true,
      dumpSha256: "a".repeat(64),
      restoredMigrationRows: 9,
      temporaryDatabaseRemoved: true,
    }),
  );
  await put(root, "docs/RELEASE-CHECKLIST.md", "# release");
  await put(root, "docs/ROLLBACK.md", "# rollback");
}

async function validAcceptanceEvidence(root: string) {
  for (const service of acceptanceServices)
    for (const scenario of requiredAcceptanceScenarios[service])
      await recordAcceptanceCheck({
        root,
        service,
        commitSha,
        environment: "production",
        now,
        signingKey,
        check: createAcceptanceCheck({
          scenario,
          status: "pass",
          startedAt: now.getTime(),
          now,
        }),
      });
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "brixchat-release-gate-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("release gate evidence", () => {
  it("passes only with valid static and external evidence", async () => {
    const root = await temporaryRoot();
    await validStaticEvidence(root);
    await validAcceptanceEvidence(root);
    const report = await evaluateReleaseGate({
      root,
      expectedCommitSha: commitSha,
      signingKey,
      now,
      sourceIntegrity: cleanSource,
    });
    expect(report.status).toBe("pass");
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("cannot bypass missing external reports with environment flags", async () => {
    const root = await temporaryRoot();
    await validStaticEvidence(root);
    process.env.META_ACCEPTANCE_PASSED = "true";
    const report = await evaluateReleaseGate({
      root,
      expectedCommitSha: commitSha,
      signingKey,
      now,
      sourceIntegrity: cleanSource,
    });
    delete process.env.META_ACCEPTANCE_PASSED;
    expect(report.status).toBe("blocked");
    expect(
      report.checks.find((check) => check.name === "meta_external_acceptance"),
    ).toMatchObject({ status: "blocked", reason: "report_missing" });
  });

  it("fails when backup restoration evidence did not pass", async () => {
    const root = await temporaryRoot();
    await validStaticEvidence(root);
    await validAcceptanceEvidence(root);
    await put(
      root,
      "artifacts/recovery/backup-restore-report.json",
      JSON.stringify({
        status: "failed",
        sourceEnvironment: "production",
        sourceReadOnlyDump: true,
        dumpSha256: "a".repeat(64),
        restoredMigrationRows: 9,
        temporaryDatabaseRemoved: true,
      }),
    );
    const report = await evaluateReleaseGate({
      root,
      expectedCommitSha: commitSha,
      signingKey,
      now,
      sourceIntegrity: cleanSource,
    });
    expect(report.status).toBe("fail");
    expect(
      report.checks.find(
        (check) =>
          check.name === "artifacts/recovery/backup-restore-report.json",
      ),
    ).toMatchObject({ status: "fail" });
  });

  it("blocks a dirty source tree even when every evidence report passes", async () => {
    const root = await temporaryRoot();
    await validStaticEvidence(root);
    await validAcceptanceEvidence(root);
    const report = await evaluateReleaseGate({
      root,
      expectedCommitSha: commitSha,
      signingKey,
      now,
      sourceIntegrity: { headSha: commitSha, clean: false },
    });
    expect(report.status).toBe("blocked");
    expect(
      report.checks.find(
        (check) => check.name === "source_commit_integrity",
      ),
    ).toMatchObject({ status: "blocked", reason: "working_tree_dirty" });
  });
});
