import { describe, expect, it, vi } from "vitest";
import {
  automationCancellationKeyHash,
  automationContinuationJobId,
  automationContinuationQueueName,
  scheduleAutomationContinuation,
} from "./automation-continuation";

const continuation = {
  id: "42000000-0000-4000-8000-000000000001",
  organizationId: "42000000-0000-4000-8000-000000000002",
  runId: "42000000-0000-4000-8000-000000000003",
  versionId: "42000000-0000-4000-8000-000000000004",
  nodeId: "wait-1",
  generation: 2,
  resumeAt: new Date(Date.now() + 60_000),
};

describe("automation continuation queue", () => {
  it("builds deterministic namespaced queue and job identifiers", () => {
    expect(automationContinuationQueueName("Production EU")).toBe(
      "brixchat:production-eu:automation-continuations",
    );
    expect(automationContinuationJobId(continuation)).toBe(
      "automation__42000000-0000-4000-8000-000000000002__42000000-0000-4000-8000-000000000003__wait-1__2",
    );
  });

  it("hashes cancellation keys without exposing the original value", () => {
    const hash = automationCancellationKeyHash(
      continuation.organizationId,
      "conversation:secret-phone:customer-reply",
    );

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain("secret-phone");
  });

  it("schedules identifier-only delayed job data with a deterministic job id", async () => {
    const add = vi.fn(async () => ({ id: "job" }));
    const queue = { add };

    await scheduleAutomationContinuation(queue, continuation);

    expect(add).toHaveBeenCalledWith(
      "resume",
      {
        continuationId: continuation.id,
        organizationId: continuation.organizationId,
        runId: continuation.runId,
        versionId: continuation.versionId,
        nodeId: continuation.nodeId,
        generation: continuation.generation,
      },
      expect.objectContaining({
        jobId: automationContinuationJobId(continuation),
        delay: expect.any(Number),
        attempts: 1,
      }),
    );
  });
});
