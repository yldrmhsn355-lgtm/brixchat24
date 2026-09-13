import { describe, expect, it } from "vitest";
import { validateProductionConfig } from "./index";

const validApiEnv = (): NodeJS.ProcessEnv => ({
  JWT_ACCESS_SECRET: "a".repeat(32),
  JWT_REFRESH_SECRET: "b".repeat(32),
  APP_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  EMAIL_PROVIDER: "smtp",
  OBJECT_STORAGE_PROVIDER: "r2",
  S3_BUCKET_PUBLIC: "false",
  MALWARE_SCANNER_PROVIDER: "clamav",
  CLAMAV_HOST: "clamav.railway.internal",
  CLAMAV_PORT: "3310",
  CLAMAV_HEALTHCHECK_TIMEOUT_MS: "2000",
  CLAMAV_SCAN_TIMEOUT_MS: "30000",
  MESSAGING_PROVIDER_MODE: "meta",
  CRM_PROVIDER_MODE: "bitrix24",
  WEB_PUBLIC_URL: "https://brixchat24.com",
  API_PUBLIC_URL: "https://api.brixchat24.com",
  WEBHOOK_PUBLIC_URL: "https://api.brixchat24.com/api/v1/webhooks/meta",
  CORS_ALLOWED_ORIGINS: "https://brixchat24.com",
  COOKIE_SECURE: "true",
  COOKIE_SAME_SITE: "lax",
  COOKIE_DOMAIN: ".brixchat24.com",
  LOG_LEVEL: "info",
  DATABASE_URL: "postgresql://user:password@db/brixchat?sslmode=require",
  API_DATABASE_URL:
    "postgresql://api_scoped:password@db/brixchat?sslmode=require",
  REDIS_URL: "redis://redis:6379",
  REDIS_PRIVATE_NETWORK: "true",
  DISTRIBUTED_RATE_LIMIT_ENABLED: "true",
  METRICS_API_KEY: "m".repeat(24),
  META_WHATSAPP_VERIFY_TOKEN: "v".repeat(16),
  META_WHATSAPP_APP_SECRET: "w".repeat(16),
  BITRIX24_WEBHOOK_TOKEN: "x".repeat(16),
  INTERNAL_OPERATIONS_TOKEN: "i".repeat(24),
  ALLOW_DEVELOPMENT_ADMIN: "false",
});

const validWorkerEnv = (): NodeJS.ProcessEnv => {
  const env = validApiEnv();
  env.WORKER_DATABASE_URL =
    "postgresql://worker_owner:password@db/brixchat?sslmode=require";
  for (const key of [
    "JWT_ACCESS_SECRET",
    "JWT_REFRESH_SECRET",
    "EMAIL_PROVIDER",
    "WEB_PUBLIC_URL",
    "WEBHOOK_PUBLIC_URL",
    "CORS_ALLOWED_ORIGINS",
    "COOKIE_SECURE",
    "COOKIE_SAME_SITE",
    "COOKIE_DOMAIN",
    "METRICS_API_KEY",
    "META_WHATSAPP_VERIFY_TOKEN",
    "META_WHATSAPP_APP_SECRET",
    "BITRIX24_WEBHOOK_TOKEN",
    "INTERNAL_OPERATIONS_TOKEN",
    "ALLOW_DEVELOPMENT_ADMIN",
    "API_DATABASE_URL",
    "DISTRIBUTED_RATE_LIMIT_ENABLED",
  ])
    delete env[key];
  return env;
};

describe("validateProductionConfig", () => {
  it("supports private same-server storage with ClamAV and rejects relative roots", () => {
    const env = { ...validApiEnv(), OBJECT_STORAGE_PROVIDER: "filesystem", OBJECT_STORAGE_FILESYSTEM_ROOT: process.cwd(), CLAMAV_HOST: "127.0.0.1" };
    expect(validateProductionConfig(env).valid).toBe(true);
    expect(validateProductionConfig({ ...env, OBJECT_STORAGE_FILESYSTEM_ROOT: "relative" }).errors).toContain("FILESYSTEM_STORAGE_ROOT_INVALID");
    expect(validateProductionConfig({ ...env, MALWARE_SCANNER_PROVIDER: "noop" }).errors).toContain("NOOP_MALWARE_SCANNER");
  });
  it("starts without external accounts while preserving core security checks", () => {
    const env = validApiEnv();
    env.EMAIL_PROVIDER = "disabled";
    env.OBJECT_STORAGE_PROVIDER = "disabled";
    env.MALWARE_SCANNER_PROVIDER = "disabled";
    delete env.META_WHATSAPP_VERIFY_TOKEN;
    delete env.META_WHATSAPP_APP_SECRET;
    delete env.BITRIX24_WEBHOOK_TOKEN;
    delete env.CLAMAV_HOST;
    expect(validateProductionConfig(env).valid).toBe(true);
    expect(
      validateProductionConfig({ ...env, JWT_ACCESS_SECRET: "weak" }).valid,
    ).toBe(false);
    expect(
      validateProductionConfig({ ...env, COOKIE_SECURE: "false" }).valid,
    ).toBe(false);
    expect(
      validateProductionConfig({ ...env, MALWARE_SCANNER_PROVIDER: "noop" })
        .valid,
    ).toBe(false);
  });
  it("keeps the full API validation as the default scope", () => {
    const result = validateProductionConfig(validApiEnv());

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.checks.map(({ check }) => check)).toEqual([
      "jwt_access_secret",
      "jwt_refresh_secret",
      "encryption_key",
      "email_provider",
      "object_storage",
      "bucket_visibility",
      "malware_scanner",
      "clamav_host",
      "clamav_port",
      "clamav_health_timeout",
      "clamav_scan_timeout",
      "messaging_provider",
      "crm_provider",
      "web_public_url",
      "api_public_url",
      "webhook_public_url",
      "cors_allowlist",
      "secure_cookie",
      "cookie_same_site",
      "debug_logging",
      "service_database_url",
      "database_tls",
      "redis_security",
      "distributed_rate_limit",
      "metrics_protection",
      "webhook_secret",
      "meta_app_secret",
      "bitrix_webhook_token",
      "internal_operations_token",
      "default_admin",
      "cookie_domain",
    ]);
  });

  it("allows a worker to omit API-only secrets and settings", () => {
    const result = validateProductionConfig(validWorkerEnv(), {
      scope: "worker",
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.checks.map(({ check }) => check)).toEqual([
      "encryption_key",
      "object_storage",
      "bucket_visibility",
      "malware_scanner",
      "clamav_host",
      "clamav_port",
      "clamav_health_timeout",
      "clamav_scan_timeout",
      "messaging_provider",
      "crm_provider",
      "api_public_url",
      "debug_logging",
      "service_database_url",
      "database_tls",
      "redis_security",
    ]);
  });

  it.each([
    [
      "encryption key",
      { APP_ENCRYPTION_KEY: undefined },
      "APP_ENCRYPTION_KEY_WEAK",
    ],
    [
      "non-base64 encryption key",
      { APP_ENCRYPTION_KEY: "e".repeat(32) },
      "APP_ENCRYPTION_KEY_WEAK",
    ],
    [
      "remote storage",
      { OBJECT_STORAGE_PROVIDER: "local" },
      "LOCAL_OBJECT_STORAGE",
    ],
    ["private bucket", { S3_BUCKET_PUBLIC: "true" }, "PUBLIC_BUCKET"],
    ["ClamAV", { MALWARE_SCANNER_PROVIDER: "noop" }, "NOOP_MALWARE_SCANNER"],
    ["ClamAV host", { CLAMAV_HOST: "" }, "CLAMAV_HOST_INVALID"],
    [
      "ClamAV loopback host",
      { CLAMAV_HOST: "127.0.0.1" },
      "CLAMAV_HOST_INVALID",
    ],
    ["ClamAV port", { CLAMAV_PORT: "65536" }, "CLAMAV_PORT_INVALID"],
    [
      "ClamAV health timeout",
      { CLAMAV_HEALTHCHECK_TIMEOUT_MS: "0" },
      "CLAMAV_HEALTHCHECK_TIMEOUT_INVALID",
    ],
    [
      "ClamAV scan timeout",
      { CLAMAV_SCAN_TIMEOUT_MS: "not-a-number" },
      "CLAMAV_SCAN_TIMEOUT_INVALID",
    ],
    [
      "Meta messaging",
      { MESSAGING_PROVIDER_MODE: "fake" },
      "FAKE_MESSAGING_PROVIDER",
    ],
    ["Bitrix CRM", { CRM_PROVIDER_MODE: "fake" }, "FAKE_CRM_PROVIDER"],
    [
      "API public URL",
      { API_PUBLIC_URL: "http://api.brixchat24.com" },
      "API_PUBLIC_URL_INSECURE",
    ],
    [
      "URL-level database TLS",
      {
        WORKER_DATABASE_URL: "postgresql://user:password@db/brixchat",
        DATABASE_SSL: "true",
      },
      "DATABASE_TLS_MISSING",
    ],
    [
      "unambiguous database TLS",
      {
        WORKER_DATABASE_URL:
          "postgresql://user:password@db/brixchat?sslmode=require&sslmode=disable",
      },
      "DATABASE_TLS_MISSING",
    ],
    [
      "valid Redis URL",
      { REDIS_URL: undefined, REDIS_PRIVATE_NETWORK: "true" },
      "REDIS_URL_INVALID",
    ],
    [
      "valid Redis protocol",
      {
        REDIS_URL: "https://redis.example.com",
        REDIS_PRIVATE_NETWORK: "true",
      },
      "REDIS_URL_INVALID",
    ],
    [
      "Redis security",
      { REDIS_URL: "redis://redis:6379", REDIS_PRIVATE_NETWORK: "false" },
      "REDIS_SECURITY_MISSING",
    ],
  ])("still rejects a worker without %s", (_name, overrides, errorCode) => {
    const result = validateProductionConfig(
      { ...validWorkerEnv(), ...overrides },
      { scope: "worker" },
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(errorCode);
  });

  it("allows rediss without a private-network declaration", () => {
    const result = validateProductionConfig(
      {
        ...validWorkerEnv(),
        REDIS_URL: "rediss://redis.example.com:6380",
        REDIS_PRIVATE_NETWORK: "false",
      },
      { scope: "worker" },
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("can fail closed when distributed API rate limiting is required", () => {
    const result = validateProductionConfig({
      ...validApiEnv(),
      DISTRIBUTED_RATE_LIMIT_ENABLED: "false",
      REQUIRE_DISTRIBUTED_RATE_LIMIT: "true",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("DISTRIBUTED_RATE_LIMIT_DISABLED");
  });

  it("can fail closed when a process-specific database credential is required", () => {
    const env = validWorkerEnv();
    delete env.WORKER_DATABASE_URL;
    env.REQUIRE_SERVICE_DATABASE_URLS = "true";

    const result = validateProductionConfig(env, { scope: "worker" });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("WORKER_DATABASE_URL_MISSING");
  });
});
