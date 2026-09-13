import { describe, expect, it, vi } from "vitest";
import {
  probeWorkerHealth,
  resolvePositiveMilliseconds,
} from "./worker-health";

function healthyInput() {
  return {
    tickHealthy: true,
    lastTickAt: 1_000,
    maxTickAgeMs: 5_000,
    dependencyTimeoutMs: 50,
    databasePing: vi.fn(async () => undefined),
    redisPing: vi.fn(async () => "PONG"),
    storagePing: vi.fn(async () => ({ healthy: true })),
    scannerPing: vi.fn(async () => ({ healthy: true })),
    now: 2_000,
  };
}

describe("worker health probe", () => {
  it("uses positive health timing configuration", () => {
    expect(resolvePositiveMilliseconds("2500", 100)).toBe(2500);
    expect(resolvePositiveMilliseconds("0", 100)).toBe(100);
  });

  it("is healthy only when the loop and all dependencies are healthy", async () => {
    await expect(probeWorkerHealth(healthyInput())).resolves.toMatchObject({
      healthy: true,
      dependencies: {
        postgresql: { healthy: true },
        redis: { healthy: true },
        objectStorage: { healthy: true },
        malwareScanner: { healthy: true },
        workerLoop: { healthy: true },
      },
    });
  });

  it("is unhealthy when ClamAV reports an unhealthy PING", async () => {
    const input = healthyInput();
    input.scannerPing = vi.fn(async () => ({ healthy: false }));

    await expect(probeWorkerHealth(input)).resolves.toMatchObject({
      healthy: false,
      dependencies: { malwareScanner: { healthy: false } },
    });
  });

  it("is unhealthy when private object storage is unavailable", async () => {
    const input = healthyInput();
    input.storagePing = vi.fn(async () => ({ healthy: false }));

    await expect(probeWorkerHealth(input)).resolves.toMatchObject({
      healthy: false,
      dependencies: { objectStorage: { healthy: false } },
    });
  });

  it("bounds a stalled ClamAV PING and reports unhealthy", async () => {
    const input = healthyInput();
    input.dependencyTimeoutMs = 20;
    input.scannerPing = vi.fn(() => new Promise<never>(() => undefined));
    const startedAt = Date.now();

    await expect(probeWorkerHealth(input)).resolves.toMatchObject({
      healthy: false,
      dependencies: { malwareScanner: { healthy: false } },
    });
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("reports an otherwise healthy worker as stale", async () => {
    await expect(
      probeWorkerHealth({
        ...healthyInput(),
        lastTickAt: 1_000,
        maxTickAgeMs: 500,
        now: 2_000,
      }),
    ).resolves.toMatchObject({
      healthy: false,
      dependencies: { workerLoop: { healthy: false, ageMs: 1_000 } },
    });
  });
});
