type ScannerHealth = { healthy: boolean };

export interface WorkerHealthProbeInput {
  tickHealthy: boolean;
  lastTickAt: number;
  maxTickAgeMs: number;
  dependencyTimeoutMs: number;
  databasePing: () => Promise<unknown>;
  redisPing: () => Promise<unknown>;
  storagePing: () => Promise<{ healthy: boolean }>;
  scannerPing: () => Promise<ScannerHealth>;
  now?: number;
}

export function resolvePositiveMilliseconds(
  value: string | undefined,
  fallback: number,
) {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? milliseconds
    : fallback;
}

async function boundedHealthCheck(
  check: () => Promise<boolean>,
  timeoutMs: number,
) {
  let timer: NodeJS.Timeout | undefined;
  const operation = Promise.resolve()
    .then(check)
    .catch(() => false);
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probeWorkerHealth(input: WorkerHealthProbeInput) {
  const [postgresql, redis, objectStorage, malwareScanner] = await Promise.all([
    boundedHealthCheck(async () => {
      await input.databasePing();
      return true;
    }, input.dependencyTimeoutMs),
    boundedHealthCheck(async () => {
      await input.redisPing();
      return true;
    }, input.dependencyTimeoutMs),
    boundedHealthCheck(
      async () => (await input.storagePing()).healthy,
      input.dependencyTimeoutMs,
    ),
    boundedHealthCheck(
      async () => (await input.scannerPing()).healthy,
      input.dependencyTimeoutMs,
    ),
  ]);
  const now = input.now ?? Date.now();
  const tickAgeMs = Math.max(0, now - input.lastTickAt);
  const workerLoop =
    Number.isFinite(input.lastTickAt) &&
    tickAgeMs <= Math.max(1, input.maxTickAgeMs);
  const healthy =
    input.tickHealthy &&
    workerLoop &&
    postgresql &&
    redis &&
    objectStorage &&
    malwareScanner;
  return {
    healthy,
    dependencies: {
      postgresql: { healthy: postgresql },
      redis: { healthy: redis },
      objectStorage: { healthy: objectStorage },
      malwareScanner: { healthy: malwareScanner },
      workerLoop: { healthy: workerLoop, ageMs: tickAgeMs },
    },
  };
}
