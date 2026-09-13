import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptanceServices,
  createAcceptanceCheck,
  hashEvidence,
  recordAcceptanceCheck,
  requiredAcceptanceScenarios,
  validateAcceptanceReport,
} from "./acceptance-report";

const roots: string[] = [];
const commitSha = "a".repeat(40);
const signingKey = "acceptance-test-signing-key-32-characters";
const now = new Date("2026-07-26T12:00:00.000Z");

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "brixchat-acceptance-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("acceptance evidence", () => {
  it("stays blocked until every required scenario passes", async () => {
    const root = await temporaryRoot();
    const service = "meta" as const;
    let report = await recordAcceptanceCheck({
      root,
      service,
      commitSha,
      environment: "staging",
      now,
      signingKey,
      check: createAcceptanceCheck({
        scenario: "verify",
        status: "pass",
        startedAt: now.getTime(),
        now,
      }),
    });
    expect(report.status).toBe("blocked");

    for (const scenario of requiredAcceptanceScenarios.meta.slice(1))
      report = await recordAcceptanceCheck({
        root,
        service,
        commitSha,
        environment: "staging",
        now,
        signingKey,
        check: createAcceptanceCheck({
          scenario,
          status: "pass",
          startedAt: now.getTime(),
          now,
        }),
      });

    expect(report.status).toBe("pass");
    expect(
      validateAcceptanceReport({
        report,
        expectedCommitSha: commitSha,
        signingKey,
        now,
      }),
    ).toEqual({ status: "pass", reason: "fresh_matching_evidence" });
  });

  it("rejects stale evidence and evidence from another commit", async () => {
    const root = await temporaryRoot();
    let report = null;
    for (const scenario of requiredAcceptanceScenarios.smtp)
      report = await recordAcceptanceCheck({
        root,
        service: "smtp",
        commitSha,
        environment: "production",
        now,
        maxAgeHours: 1,
        signingKey,
        check: createAcceptanceCheck({
          scenario,
          status: "pass",
          startedAt: now.getTime(),
          now,
        }),
      });
    expect(
      validateAcceptanceReport({
        report,
        expectedCommitSha: "b".repeat(40),
        signingKey,
        now,
      }).reason,
    ).toBe("commit_mismatch");
    expect(
      validateAcceptanceReport({
        report,
        expectedCommitSha: commitSha,
        signingKey,
        now: new Date(now.getTime() + 2 * 60 * 60 * 1000),
      }).reason,
    ).toBe("report_expired");
  });

  it("rejects a report edited after it was signed", async () => {
    const root = await temporaryRoot();
    const report = await recordAcceptanceCheck({
      root,
      service: "smtp",
      commitSha,
      environment: "production",
      now,
      signingKey,
      check: createAcceptanceCheck({
        scenario: "all",
        status: "pass",
        startedAt: now.getTime(),
        now,
      }),
    });
    const tampered = {
      ...report,
      environment: "forged-production",
    };

    expect(
      validateAcceptanceReport({
        report: tampered,
        expectedCommitSha: commitSha,
        signingKey,
        now,
      }),
    ).toEqual({ status: "fail", reason: "signature_invalid" });
  });

  it("writes only hashed recipient evidence", async () => {
    const root = await temporaryRoot();
    const recipient = "+905551112233";
    await recordAcceptanceCheck({
      root,
      service: "smtp",
      commitSha,
      environment: "production",
      now,
      signingKey,
      check: createAcceptanceCheck({
        scenario: "all",
        status: "pass",
        startedAt: now.getTime(),
        now,
        evidence: { recipientHash: hashEvidence(recipient) },
      }),
    });
    const content = await readFile(
      join(root, "artifacts", "acceptance", "smtp-acceptance-report.json"),
      "utf8",
    );
    expect(content).not.toContain(recipient);
    expect(content).toContain(hashEvidence(recipient));
  });

  it("defines a non-empty acceptance contract for every service", () => {
    for (const service of acceptanceServices)
      expect(requiredAcceptanceScenarios[service].length).toBeGreaterThan(0);
  });
});
