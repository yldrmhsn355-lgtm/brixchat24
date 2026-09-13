import { createHash } from "node:crypto";

export type AutomationContinuationJob = {
  id: string;
  organizationId: string;
  runId: string;
  versionId: string;
  nodeId: string;
  generation: number;
  resumeAt: Date;
};

type ContinuationQueue = {
  add(
    name: string,
    data: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<unknown>;
};

function safeSegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
}

export function automationContinuationQueueName(environment: string) {
  return `brixchat:${safeSegment(environment || "development")}:automation-continuations`;
}

export function automationContinuationJobId(
  continuation: Pick<
    AutomationContinuationJob,
    "organizationId" | "runId" | "nodeId" | "generation"
  >,
) {
  return [
    "automation",
    continuation.organizationId,
    continuation.runId,
    safeSegment(continuation.nodeId),
    continuation.generation,
  ].join("__");
}

export function automationCancellationKeyHash(
  organizationId: string,
  cancellationKey: string,
) {
  return createHash("sha256")
    .update(`${organizationId}\u0000${cancellationKey}`)
    .digest("hex");
}

export async function scheduleAutomationContinuation(
  queue: ContinuationQueue,
  continuation: AutomationContinuationJob,
) {
  const delay = Math.min(
    2_147_483_647,
    Math.max(0, continuation.resumeAt.getTime() - Date.now()),
  );
  return queue.add(
    "resume",
    {
      continuationId: continuation.id,
      organizationId: continuation.organizationId,
      runId: continuation.runId,
      versionId: continuation.versionId,
      nodeId: continuation.nodeId,
      generation: continuation.generation,
    },
    {
      jobId: automationContinuationJobId(continuation),
      delay,
      attempts: 1,
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    },
  );
}
