import { buildApp } from "./app";
import { validateProductionConfig } from "@brixchat/integrations";
import { parseTrustProxy, resolveServiceDatabaseUrl } from "@brixchat/config";
import { readFileSync } from "node:fs";
const secret = (key: string) => {
  if (process.env[key]) return process.env[key];
  const file = process.env[`${key}_FILE`];
  return file ? readFileSync(file, "utf8").trim() : undefined;
};
const database = resolveServiceDatabaseUrl(process.env, "api");
const runtimeEnv: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: database.url,
  JWT_ACCESS_SECRET: secret("JWT_ACCESS_SECRET"),
  JWT_REFRESH_SECRET: secret("JWT_REFRESH_SECRET"),
  APP_ENCRYPTION_KEY: secret("APP_ENCRYPTION_KEY"),
  GOOGLE_TOKEN_ENCRYPTION_KEY: secret("GOOGLE_TOKEN_ENCRYPTION_KEY"),
  METRICS_API_KEY: secret("METRICS_API_KEY"),
  META_WHATSAPP_APP_SECRET: secret("META_WHATSAPP_APP_SECRET"),
  META_WHATSAPP_VERIFY_TOKEN: secret("META_WHATSAPP_VERIFY_TOKEN"),
  BITRIX24_WEBHOOK_TOKEN: secret("BITRIX24_WEBHOOK_TOKEN"),
  INTERNAL_OPERATIONS_TOKEN: secret("INTERNAL_OPERATIONS_TOKEN"),
  PADDLE_API_KEY: secret("PADDLE_API_KEY"),
  PADDLE_WEBHOOK_SECRET: secret("PADDLE_WEBHOOK_SECRET"),
};
const environment =
  process.env.APP_ENV ?? process.env.NODE_ENV ?? "development";
if (environment === "production") {
  if (!process.env.API_SCOPED_DATABASE_URL) {
    process.stderr.write('API_SCOPED_DATABASE_URL is required in production.\n');
    process.exit(1);
  }
  const validation = validateProductionConfig(runtimeEnv);
  if (!validation.valid) {
    process.stderr.write(
      JSON.stringify({
        level: "fatal",
        event: "configuration.invalid",
        checks: validation.checks.filter((check) => check.status === "fatal"),
      }) + "\n",
    );
    process.exit(1);
  }
  if (database.source === "DATABASE_URL")
    process.stderr.write(
      JSON.stringify({
        level: "warn",
        event: "configuration.database_role_fallback",
        service: "api",
        source: database.source,
      }) + "\n",
    );
}
const app = buildApp({
  jwtSecret:
    runtimeEnv.JWT_ACCESS_SECRET ??
    process.env.JWT_SECRET ??
    "local-development-secret-change-me-now",
  webUrl:
    process.env.WEB_PUBLIC_URL ??
    process.env.WEB_URL ??
    "http://localhost:3300",
  corsAllowedOrigins: (
    process.env.CORS_ALLOWED_ORIGINS ??
    process.env.WEB_PUBLIC_URL ??
    process.env.WEB_URL ??
    "http://localhost:3300"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  databaseUrl: database.url,
  scopedDatabaseUrl: process.env.API_SCOPED_DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  redisHealthTimeoutMs: process.env.REDIS_HEALTH_TIMEOUT_MS
    ? Number(process.env.REDIS_HEALTH_TIMEOUT_MS)
    : undefined,
  distributedRateLimitEnabled:
    process.env.DISTRIBUTED_RATE_LIMIT_ENABLED === "true",
  openApiEnabled: process.env.OPENAPI_ENABLED === "true",
  metaAppSecret: runtimeEnv.META_WHATSAPP_APP_SECRET,
  metaVerifyToken: runtimeEnv.META_WHATSAPP_VERIFY_TOKEN,
  appEncryptionKey: runtimeEnv.APP_ENCRYPTION_KEY,
  accessTokenTtlMinutes: Number(process.env.ACCESS_TOKEN_TTL_MINUTES ?? 15),
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
  cookieSecure: process.env.COOKIE_SECURE === "true",
  cookieSameSite:
    (process.env.COOKIE_SAME_SITE as "lax" | "strict" | "none" | undefined) ??
    "lax",
  cookieDomain: process.env.COOKIE_DOMAIN,
  apiPublicUrl: process.env.API_PUBLIC_URL,
  fakeProviderMode: process.env.FAKE_PROVIDER_MODE as
    | "success"
    | "temporary_error"
    | "permanent_error"
    | "auth_failure"
    | "token_expired"
    | "permission_denied"
    | undefined,
  metaApiVersion: process.env.META_WHATSAPP_API_VERSION,
  bitrixClientId: process.env.BITRIX24_CLIENT_ID,
  bitrixClientSecret: process.env.BITRIX24_CLIENT_SECRET,
  objectStorageLocalPath: process.env.OBJECT_STORAGE_LOCAL_PATH,
  metricsApiKey: runtimeEnv.METRICS_API_KEY,
  environment,
  configEnv: runtimeEnv,
  internalOperationsToken: runtimeEnv.INTERNAL_OPERATIONS_TOKEN,
  databasePoolMax: Number(process.env.API_DATABASE_POOL_MAX ?? 10),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  paddleApiKey: runtimeEnv.PADDLE_API_KEY,
  paddleClientToken: process.env.PADDLE_CLIENT_TOKEN,
  paddleWebhookSecret: runtimeEnv.PADDLE_WEBHOOK_SECRET,
  paddleEnvironment:
    process.env.PADDLE_ENVIRONMENT === "production" ? "production" : "sandbox",
  paddleCheckoutUrl:
    process.env.PADDLE_CHECKOUT_URL ??
    `${process.env.WEB_PUBLIC_URL ?? process.env.WEB_URL ?? "http://localhost:3300"}/app/billing`,
  billingGraceDays: Number(process.env.BILLING_GRACE_DAYS ?? 7),
});
await app.listen({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 4000),
});
