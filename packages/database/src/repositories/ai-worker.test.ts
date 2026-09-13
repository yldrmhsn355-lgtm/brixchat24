import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../index";
import { AiWorkerRepository } from "./ai";

interface QueryCall {
  text: string;
  values: unknown[];
}

function createSqlStub(responses: unknown[][]) {
  const calls: QueryCall[] = [];
  const sql = ((first: unknown, ...values: unknown[]) => {
    if (
      Array.isArray(first) &&
      Object.prototype.hasOwnProperty.call(first, "raw")
    ) {
      calls.push({ text: (first as string[]).join("?"), values });
      return Promise.resolve(responses.shift() ?? []);
    }
    return { values: first };
  }) as unknown as DatabaseClient;
  return { sql, calls };
}

describe("AiWorkerRepository queue isolation", () => {
  it("reclaims stale work and uses SKIP LOCKED for a single conversation claim", async () => {
    const { sql, calls } = createSqlStub([[], []]);

    const claimed = await new AiWorkerRepository(sql).claimRunRequest(
      "ai-worker-a",
      240,
    );

    expect(claimed).toBeNull();
    expect(calls[0]?.text).toContain("status='processing'");
    expect(calls[0]?.text).toContain("make_interval(secs => ?)");
    expect(calls[0]?.values).toContain(240);
    expect(calls[1]?.text).toContain("FOR UPDATE SKIP LOCKED LIMIT 1");
    expect(calls[1]?.text).toContain(
      "processing.conversation_id=request.conversation_id",
    );
    expect(calls[1]?.values).toContain("ai-worker-a");
  });
});
