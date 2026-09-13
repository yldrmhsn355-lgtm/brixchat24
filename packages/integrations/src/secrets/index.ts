import { readFile } from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";
export interface SecretProvider {
  getSecret(key: string): Promise<string>;
}
export class EnvironmentSecretProvider implements SecretProvider {
  constructor(private env: NodeJS.ProcessEnv = process.env) {}
  async getSecret(key: string) {
    const value = this.env[key];
    if (!value) throw new Error(`SECRET_MISSING:${key}`);
    return value;
  }
}
export class FileSecretProvider implements SecretProvider {
  constructor(private files: Record<string, string>) {}
  async getSecret(key: string) {
    const path = this.files[key];
    if (!path) throw new Error(`SECRET_FILE_MISSING:${key}`);
    return (await readFile(path, "utf8")).trim();
  }
}
export interface ProductionConfigResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  checks: SafeConfigurationCheck[];
}
export interface SafeConfigurationCheck {
  check: string;
  status: "pass" | "warning" | "fatal";
  description: string;
}
export type ProductionConfigScope = "api" | "worker";
export interface ProductionConfigValidationOptions {
  scope?: ProductionConfigScope;
}

function redisProtocol(value: string | undefined): "redis:" | "rediss:" | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      !url.hostname ||
      (url.protocol !== "redis:" && url.protocol !== "rediss:")
    )
      return null;
    return url.protocol;
  } catch {
    return null;
  }
}

function productionClamAvHost(value: string | undefined): boolean {
  const host = value?.trim().toLowerCase();
  if (!host) return false;
  return !(
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host.startsWith("127.") ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0:0:0:0:0:0:0:1" ||
    host === "0.0.0.0"
  );
}

function validPort(value: string | undefined): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function positiveMilliseconds(value: string | undefined): boolean {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds > 0;
}

function databaseTlsRequired(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const modes = new URL(value).searchParams.getAll("sslmode");
    return (
      modes.length === 1 &&
      /^(require|verify-ca|verify-full)$/i.test(modes[0] ?? "")
    );
  } catch {
    return false;
  }
}

export function validateProductionConfig(
  env: NodeJS.ProcessEnv,
  options: ProductionConfigValidationOptions = {},
): ProductionConfigResult {
  const scope = options.scope ?? "api";
  const mediaDisabled =
    (env.OBJECT_STORAGE_PROVIDER ?? "disabled") === "disabled" &&
    (env.MALWARE_SCANNER_PROVIDER ?? "disabled") === "disabled";
  const errors: string[] = [],
    warnings: string[] = [],
    checks: SafeConfigurationCheck[] = [];
  const check = (
    name: string,
    ok: boolean,
    code: string,
    description: string,
    severity: "fatal" | "warning" = "fatal",
  ) => {
    checks.push({ check: name, status: ok ? "pass" : severity, description });
    if (!ok) (severity === "fatal" ? errors : warnings).push(code);
  };
  const weak = (value: string | undefined) =>
    !value ||
    value.length < 32 ||
    /local-development|replace-with|change-me|secret/i.test(value);
  const validEncryptionKey = (value: string | undefined) => {
    if (!value) return false;
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 && decoded.toString("base64") === value;
  };
  const serviceDatabaseKey =
    scope === "api" ? "API_DATABASE_URL" : "WORKER_DATABASE_URL";
  const serviceDatabaseUrl = env[serviceDatabaseKey] ?? env.DATABASE_URL;
  if (scope === "api") {
    check(
      "jwt_access_secret",
      !weak(env.JWT_ACCESS_SECRET),
      "JWT_ACCESS_SECRET_WEAK",
      "Access signing secret is non-default and at least 32 characters.",
    );
    check(
      "jwt_refresh_secret",
      !weak(env.JWT_REFRESH_SECRET),
      "JWT_REFRESH_SECRET_WEAK",
      "Refresh signing secret is non-default and at least 32 characters.",
    );
  }
  check(
    "encryption_key",
    validEncryptionKey(env.APP_ENCRYPTION_KEY),
    "APP_ENCRYPTION_KEY_WEAK",
    "Encryption key is a valid base64-encoded 32-byte value.",
  );
  if (env.GOOGLE_DRIVE_ENABLED === "true") {
    check(
      "google_client_id",
      Boolean(env.GOOGLE_CLIENT_ID),
      "GOOGLE_CLIENT_ID_MISSING",
      "Google OAuth client id is configured.",
    );
    check(
      "google_client_secret",
      Boolean(
        env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CLIENT_SECRET.length >= 16,
      ),
      "GOOGLE_CLIENT_SECRET_MISSING",
      "Google OAuth client secret is configured.",
    );
    check(
      "google_oauth_redirect_uri",
      Boolean(env.GOOGLE_OAUTH_REDIRECT_URI?.startsWith("https://")),
      "GOOGLE_OAUTH_REDIRECT_URI_INSECURE",
      "Google OAuth redirect URI uses HTTPS.",
    );
    check(
      "google_token_encryption_key",
      validEncryptionKey(env.GOOGLE_TOKEN_ENCRYPTION_KEY),
      "GOOGLE_TOKEN_ENCRYPTION_KEY_WEAK",
      "Google refresh tokens use a dedicated base64-encoded 32-byte key.",
    );
  }
  if (scope === "api") {
    check(
      "email_provider",
      /^(smtp|disabled)$/i.test(env.EMAIL_PROVIDER ?? "disabled"),
      "CONSOLE_EMAIL_PROVIDER",
      "Email uses SMTP or is explicitly unavailable until configured.",
    );
  }
  check(
    "object_storage",
    mediaDisabled || /^(s3|r2|filesystem)$/i.test(env.OBJECT_STORAGE_PROVIDER ?? ""),
    "LOCAL_OBJECT_STORAGE",
    "Media uses private storage and scanning, or file operations are disabled.",
  );
  if (env.OBJECT_STORAGE_PROVIDER?.toLowerCase() === "filesystem") {
    const root = env.OBJECT_STORAGE_FILESYSTEM_ROOT ?? "";
    check("filesystem_root", isAbsolute(root) && resolve(root) !== parse(resolve(root)).root,
      "FILESYSTEM_STORAGE_ROOT_INVALID", "Private filesystem storage has an explicit absolute data directory.");
  }
  check(
    "bucket_visibility",
    env.S3_BUCKET_PUBLIC !== "true",
    "PUBLIC_BUCKET",
    "Object storage is not configured as public.",
  );
  check(
    "malware_scanner",
    mediaDisabled || /^clamav$/i.test(env.MALWARE_SCANNER_PROVIDER ?? ""),
    "NOOP_MALWARE_SCANNER",
    "A production scanner is selected, or file operations are disabled.",
  );
  check(
    "clamav_host",
    mediaDisabled || productionClamAvHost(env.CLAMAV_HOST) ||
      (env.OBJECT_STORAGE_PROVIDER?.toLowerCase() === "filesystem" && env.CLAMAV_HOST === "127.0.0.1"),
    "CLAMAV_HOST_INVALID",
    "ClamAV uses an explicit network host, or loopback for same-server private filesystem storage.",
  );
  check(
    "clamav_port",
    mediaDisabled || validPort(env.CLAMAV_PORT),
    "CLAMAV_PORT_INVALID",
    "ClamAV port is an integer between 1 and 65535.",
  );
  check(
    "clamav_health_timeout",
    mediaDisabled || positiveMilliseconds(env.CLAMAV_HEALTHCHECK_TIMEOUT_MS),
    "CLAMAV_HEALTHCHECK_TIMEOUT_INVALID",
    "ClamAV health checks have a positive timeout.",
  );
  check(
    "clamav_scan_timeout",
    mediaDisabled || positiveMilliseconds(env.CLAMAV_SCAN_TIMEOUT_MS),
    "CLAMAV_SCAN_TIMEOUT_INVALID",
    "ClamAV streaming scans have a positive timeout.",
  );
  check(
    "messaging_provider",
    /^meta$/i.test(env.MESSAGING_PROVIDER_MODE ?? "meta"),
    "FAKE_MESSAGING_PROVIDER",
    "A real messaging provider is configured.",
  );
  check(
    "crm_provider",
    /^bitrix24$/i.test(env.CRM_PROVIDER_MODE ?? "bitrix24"),
    "FAKE_CRM_PROVIDER",
    "A real CRM provider is configured.",
  );
  const publicUrls =
    scope === "worker"
      ? ([["api_public_url", env.API_PUBLIC_URL]] as const)
      : ([
          ["web_public_url", env.WEB_PUBLIC_URL],
          ["api_public_url", env.API_PUBLIC_URL],
          ["webhook_public_url", env.WEBHOOK_PUBLIC_URL],
        ] as const);
  for (const [name, value] of publicUrls)
    check(
      name,
      Boolean(value?.startsWith("https://")),
      `${name.toUpperCase()}_INSECURE`,
      `${name.replaceAll("_", " ")} uses HTTPS.`,
    );
  if (scope === "api") {
    const origins = (env.CORS_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
    check(
      "cors_allowlist",
      origins.length > 0 &&
        origins.every((origin) => {
          try {
            const url = new URL(origin);
            return url.protocol === "https:" && !origin.includes("*");
          } catch {
            return false;
          }
        }),
      "CORS_WILDCARD",
      "CORS is an explicit allowlist.",
    );
    check(
      "secure_cookie",
      env.COOKIE_SECURE === "true",
      "COOKIE_INSECURE",
      "Secure cookies are enabled.",
    );
    check(
      "cookie_same_site",
      env.COOKIE_SAME_SITE !== "none" ||
        (env.COOKIE_SECURE === "true" && Boolean(env.COOKIE_DOMAIN)),
      "COOKIE_SAMESITE_INVALID",
      "SameSite=None is only used with Secure cookies and an explicit domain.",
    );
  }
  check(
    "debug_logging",
    !/^(debug|trace)$/i.test(env.LOG_LEVEL ?? "info"),
    "DEBUG_LOGGING",
    "Debug logging is disabled.",
  );
  check(
    "service_database_url",
    Boolean(env[serviceDatabaseKey]),
    `${serviceDatabaseKey}_MISSING`,
    `${scope} uses its own database credential instead of the shared tooling credential.`,
    env.REQUIRE_SERVICE_DATABASE_URLS === "true" ? "fatal" : "warning",
  );
  check(
    "database_tls",
    databaseTlsRequired(serviceDatabaseUrl),
    "DATABASE_TLS_MISSING",
    "Database transport security is required by the connection URL.",
  );
  const redisUrlProtocol = redisProtocol(env.REDIS_URL);
  check(
    "redis_security",
    Boolean(redisUrlProtocol) &&
      (redisUrlProtocol === "rediss:" ||
        (redisUrlProtocol === "redis:" &&
          env.REDIS_PRIVATE_NETWORK === "true")),
    redisUrlProtocol ? "REDIS_SECURITY_MISSING" : "REDIS_URL_INVALID",
    "Redis URL is valid and uses TLS or a declared private network.",
  );
  if (scope === "api") {
    check(
      "distributed_rate_limit",
      env.DISTRIBUTED_RATE_LIMIT_ENABLED === "true",
      "DISTRIBUTED_RATE_LIMIT_DISABLED",
      "API rate limits use the shared Redis store across replicas.",
      env.REQUIRE_DISTRIBUTED_RATE_LIMIT === "true" ? "fatal" : "warning",
    );
    check(
      "metrics_protection",
      Boolean(env.METRICS_API_KEY && env.METRICS_API_KEY.length >= 24),
      "METRICS_API_KEY_MISSING",
      "Metrics authentication is configured.",
    );
    check(
      "webhook_secret",
      Boolean(
        env.META_WHATSAPP_VERIFY_TOKEN &&
        env.META_WHATSAPP_VERIFY_TOKEN.length >= 16,
      ),
      "WEBHOOK_SIGNING_SECRET_MISSING",
      "Webhook verification secret is configured.",
      env.META_WHATSAPP_VERIFY_TOKEN ? "fatal" : "warning",
    );
    check(
      "meta_app_secret",
      Boolean(
        env.META_WHATSAPP_APP_SECRET &&
        env.META_WHATSAPP_APP_SECRET.length >= 16,
      ),
      "META_APP_SECRET_MISSING",
      "Meta app secret is configured.",
      env.META_WHATSAPP_APP_SECRET ? "fatal" : "warning",
    );
    check(
      "bitrix_webhook_token",
      Boolean(
        (env.BITRIX24_WEBHOOK_TOKEN &&
          env.BITRIX24_WEBHOOK_TOKEN.length >= 16) ||
        (env.BITRIX24_CLIENT_SECRET && env.BITRIX24_CLIENT_SECRET.length >= 16),
      ),
      "BITRIX_WEBHOOK_TOKEN_MISSING",
      "Bitrix callback authentication is configured.",
      env.BITRIX24_WEBHOOK_TOKEN || env.BITRIX24_CLIENT_SECRET
        ? "fatal"
        : "warning",
    );
    check(
      "internal_operations_token",
      Boolean(
        env.INTERNAL_OPERATIONS_TOKEN &&
        env.INTERNAL_OPERATIONS_TOKEN.length >= 24,
      ),
      "INTERNAL_OPERATIONS_TOKEN_MISSING",
      "Internal operations routes have a dedicated token.",
    );
    check(
      "default_admin",
      env.ALLOW_DEVELOPMENT_ADMIN !== "true",
      "DEVELOPMENT_ADMIN_ENABLED",
      "Development administrator bootstrap is disabled.",
    );
    check(
      "cookie_domain",
      !/localhost|\.local$/i.test(env.COOKIE_DOMAIN ?? ""),
      "DEVELOPMENT_COOKIE_DOMAIN",
      "Cookie domain is not a development domain.",
    );
  }
  return { valid: errors.length === 0, errors, warnings, checks };
}
