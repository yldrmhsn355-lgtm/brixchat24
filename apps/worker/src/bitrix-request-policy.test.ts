import { describe, expect, it } from "vitest";
import { workerBitrixRequestPolicy } from "./bitrix-request-policy";

describe("worker Bitrix request policy", () => {
  it("delegates retries to the durable job queue", () => {
    expect(workerBitrixRequestPolicy).toEqual({ maxAttempts: 1 });
  });
});
