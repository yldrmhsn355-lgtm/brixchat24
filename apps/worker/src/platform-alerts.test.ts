import { describe, expect, it } from "vitest";
import { platformAlertFingerprint } from "./platform-alerts";

describe("platform alert identity", () => {
  it("deduplicates the same signal for the same organization", () => {
    const first = platformAlertFingerprint(
      "queue",
      "00000000-0000-4000-8000-000000000001",
      "outbox",
    );
    const second = platformAlertFingerprint(
      "queue",
      "00000000-0000-4000-8000-000000000001",
      "outbox",
    );
    expect(first).toBe(second);
    expect(first).toHaveLength(64);
  });

  it("separates tenants and categories", () => {
    const base = platformAlertFingerprint(
      "queue",
      "00000000-0000-4000-8000-000000000001",
      "outbox",
    );
    expect(
      platformAlertFingerprint(
        "queue",
        "00000000-0000-4000-8000-000000000002",
        "outbox",
      ),
    ).not.toBe(base);
    expect(platformAlertFingerprint("worker", null, "outbox")).not.toBe(base);
  });
});
