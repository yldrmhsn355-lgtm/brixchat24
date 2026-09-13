import { z } from "zod";

const tcpPortSchema = z.coerce.number().int().min(1).max(65_535);

export type TrustProxyConfig = false | number | string[];

export type DatabaseServiceScope = "api" | "worker";

/**
 * Resolves the process-specific database credential first. DATABASE_URL stays
 * as a backwards-compatible local/tooling fallback; production deployments
 * can make the split mandatory with REQUIRE_SERVICE_DATABASE_URLS=true.
 */
export function resolveServiceDatabaseUrl(
  input: NodeJS.ProcessEnv,
  scope: DatabaseServiceScope,
  developmentFallback = "postgresql://brixchat:brixchat@localhost:5434/brixchat",
): {
  url: string;
  source:
    "API_DATABASE_URL" | "WORKER_DATABASE_URL" | "DATABASE_URL" | "development";
} {
  const serviceKey =
    scope === "api" ? "API_DATABASE_URL" : "WORKER_DATABASE_URL";
  const serviceUrl = input[serviceKey]?.trim();
  if (serviceUrl) return { url: serviceUrl, source: serviceKey };
  const sharedUrl = input.DATABASE_URL?.trim();
  if (sharedUrl) return { url: sharedUrl, source: "DATABASE_URL" };
  return { url: developmentFallback, source: "development" };
}

/**
 * Fastify's `trustProxy: true` trusts every hop and lets a caller-controlled
 * X-Forwarded-For value influence request.ip. Require either a verified hop
 * count or an explicit address/CIDR allow-list instead.
 */
export function parseTrustProxy(value: string | undefined): TrustProxyConfig {
  const normalized = value?.trim();
  if (
    !normalized ||
    ["false", "0", "off", "no"].includes(normalized.toLowerCase())
  )
    return false;

  if (["true", "on", "yes", "*"].includes(normalized.toLowerCase()))
    throw new Error(
      "TRUST_PROXY must be false, a positive hop count, or a comma-separated address/CIDR allow-list",
    );

  if (/^\d+$/.test(normalized)) {
    const hops = Number(normalized);
    if (Number.isSafeInteger(hops) && hops > 0) return hops;
    throw new Error("TRUST_PROXY hop count must be a positive integer");
  }

  const addresses = normalized
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  if (!addresses.length)
    throw new Error("TRUST_PROXY address/CIDR allow-list cannot be empty");
  return addresses;
}

export function resolveWorkerHealthPort(input: NodeJS.ProcessEnv): number {
  const railwayPort = input.PORT?.trim();
  const workerPort = input.WORKER_HEALTH_PORT?.trim();
  const source = railwayPort ? "PORT" : "WORKER_HEALTH_PORT";
  const parsed = tcpPortSchema.safeParse(railwayPort || workerPort || 4100);
  if (!parsed.success)
    throw new Error(`${source} must be a valid TCP port between 1 and 65535`);
  return parsed.data;
}

const automationRuntimeSchema = z.object({
  AUTOMATION_WORKER_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(2),
  AUTOMATION_MAX_STEPS: z.coerce.number().int().min(1).max(1_000).default(100),
  AUTOMATION_MAX_LOOP_ITERATIONS: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20),
  AUTOMATION_MAX_EXECUTION_DURATION: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(604_800_000)
    .default(3_600_000),
  AUTOMATION_MAX_SUBFLOW_DEPTH: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5),
  AUTOMATION_DEFAULT_RETRY_LIMIT: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5),
  AUTOMATION_STALE_EXECUTION_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_440)
    .default(5),
  AUTOMATION_STALE_LOCK_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(3_600)
    .default(120),
  AUTOMATION_EVENT_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3_650)
    .default(90),
  AUTOMATION_LOG_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3_650)
    .default(30),
  AUTOMATION_WEBHOOK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(10_000),
  AUTOMATION_MAX_ACTIONS_PER_RUN: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20),
});

export type AutomationRuntimeConfig = {
  workerConcurrency: number;
  maxSteps: number;
  maxLoopIterations: number;
  maxExecutionDurationMs: number;
  maxSubflowDepth: number;
  defaultRetryLimit: number;
  staleExecutionMinutes: number;
  staleLockSeconds: number;
  eventRetentionDays: number;
  logRetentionDays: number;
  webhookTimeoutMs: number;
  maxActionsPerRun: number;
};

export function resolveAutomationRuntimeConfig(
  input: NodeJS.ProcessEnv,
): AutomationRuntimeConfig {
  const value = automationRuntimeSchema.parse(input);
  return {
    workerConcurrency: value.AUTOMATION_WORKER_CONCURRENCY,
    maxSteps: value.AUTOMATION_MAX_STEPS,
    maxLoopIterations: value.AUTOMATION_MAX_LOOP_ITERATIONS,
    maxExecutionDurationMs: value.AUTOMATION_MAX_EXECUTION_DURATION,
    maxSubflowDepth: value.AUTOMATION_MAX_SUBFLOW_DEPTH,
    defaultRetryLimit: value.AUTOMATION_DEFAULT_RETRY_LIMIT,
    staleExecutionMinutes: value.AUTOMATION_STALE_EXECUTION_MINUTES,
    staleLockSeconds: value.AUTOMATION_STALE_LOCK_SECONDS,
    eventRetentionDays: value.AUTOMATION_EVENT_RETENTION_DAYS,
    logRetentionDays: value.AUTOMATION_LOG_RETENTION_DAYS,
    webhookTimeoutMs: value.AUTOMATION_WEBHOOK_TIMEOUT_MS,
    maxActionsPerRun: value.AUTOMATION_MAX_ACTIONS_PER_RUN,
  };
}

const trustProxySchema = z
  .string()
  .optional()
  .transform((value, context) => {
    try {
      return parseTrustProxy(value);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          error instanceof Error ? error.message : "TRUST_PROXY is invalid",
      });
      return z.NEVER;
    }
  });

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  WEB_URL: z.string().url().default("http://localhost:3000"),
  PORT: tcpPortSchema.optional(),
  WORKER_HEALTH_PORT: tcpPortSchema.default(4100),
  TRUST_PROXY: trustProxySchema,
});
export type AppConfig = z.infer<typeof schema>;
export const parseConfig = (input: NodeJS.ProcessEnv): AppConfig =>
  schema.parse(input);
