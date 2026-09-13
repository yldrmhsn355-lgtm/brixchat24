import { loadEnvFile } from "node:process";
import { parseEnv } from "node:util";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createDatabase } from "../../packages/database/src/index";
import { hashPassword } from "../../packages/auth/src/index";

async function main() {
  loadEnvFile(".env.iis");
  const directory = "C:/ProgramData/Brixchat24/live";
  mkdirSync(directory, { recursive: true });
  const secretsPath = `${directory}/bootstrap.json`;
  const secrets = existsSync(secretsPath)
    ? JSON.parse(readFileSync(secretsPath, "utf8"))
    : {
        api: randomBytes(32).toString("hex"),
        worker: randomBytes(32).toString("hex"),
        ownerPassword: `Bx!${randomBytes(24).toString("base64url")}9a`,
      };
  if (!existsSync(secretsPath))
    writeFileSync(secretsPath, JSON.stringify(secrets, null, 2));
  const { client: admin } = createDatabase(process.env.DATABASE_URL!);
  for (const [role, password, bypass] of [
    ["brixchat_live_api", secrets.api, false],
    ["brixchat_live_worker", secrets.worker, true],
  ] as const) {
    if (!(await admin`SELECT 1 FROM pg_roles WHERE rolname=${role}`).length)
      await admin.unsafe(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ${bypass ? "BYPASSRLS" : "NOBYPASSRLS"} PASSWORD '${password}'`,
      );
  }
  if (
    !(await admin`SELECT 1 FROM pg_database WHERE datname='brixchat_live'`)
      .length
  )
    await admin.unsafe("CREATE DATABASE brixchat_live");
  const migrationUrl = new URL(process.env.DATABASE_URL!);
  migrationUrl.pathname = "/brixchat_live";
  migrationUrl.search = "?sslmode=verify-full";
  const migrate = spawnSync(
    process.execPath,
    ["--import", "tsx", "packages/database/src/migrate.ts"],
    {
      env: {
        ...process.env,
        DATABASE_URL: migrationUrl.toString(),
        NODE_EXTRA_CA_CERTS: "C:/ProgramData/Brixchat24/pgdata/server.crt",
      },
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (migrate.status !== 0) throw new Error(migrate.stderr);
  const { client: live } = createDatabase(migrationUrl.toString());
  await live.unsafe(
    "GRANT CONNECT ON DATABASE brixchat_live TO brixchat_live_api, brixchat_live_worker",
  );
  await live.unsafe(
    "GRANT USAGE ON SCHEMA public TO brixchat_live_api, brixchat_live_worker",
  );
  // Existing repositories use owner-based tenant filtering; do not activate the
  // scoped RLS role until all repository paths support transaction tenant scope.
  const tables =
    await live`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
  for (const { tablename } of tables)
    await live.unsafe(
      `ALTER TABLE public."${String(tablename).replaceAll('"', '""')}" OWNER TO brixchat_live_api`,
    );
  await live.unsafe(
    "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO brixchat_live_worker",
  );
  await live.unsafe(
    "GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO brixchat_live_api, brixchat_live_worker",
  );
  const email = "hsnyldrm-590@hotmail.com";
  if (!(await live`SELECT id FROM users WHERE email=${email}`).length) {
    const passwordHash = await hashPassword(secrets.ownerPassword);
    await live.begin(async (tx) => {
      const [user] =
        await tx`INSERT INTO users(email,full_name,password_hash,email_verified_at,is_platform_admin) VALUES(${email},'Yönetici',${passwordHash},now(),true) RETURNING id`;
      await tx`INSERT INTO user_credentials(user_id,password_hash) VALUES(${user!.id},${passwordHash})`;
      const [org] =
        await tx`INSERT INTO organizations(name,slug) VALUES('Brixchat24','brixchat24') RETURNING id`;
      await tx`INSERT INTO organization_members(organization_id,user_id,role) VALUES(${org!.id},${user!.id},'owner')`;
      await tx`INSERT INTO organization_entitlements(organization_id,plan_id,trial_status,trial_started_at,trial_ends_at) SELECT ${org!.id},id,'active',now(),now()+interval '30 days' FROM plans WHERE code='trial' LIMIT 1`;
    });
  }
  const draft = parseEnv(readFileSync(".env.iis.production", "utf8"));
  const common = {
    ...draft,
    NODE_ENV: "production",
    APP_ENV: "production",
    EMAIL_PROVIDER: "disabled",
    OBJECT_STORAGE_PROVIDER: "disabled",
    MALWARE_SCANNER_PROVIDER: "disabled",
    MESSAGING_PROVIDER_MODE: "meta",
    CRM_PROVIDER_MODE: "bitrix24",
    WHATSAPP_WEB_ENABLED: "true",
    NODE_EXTRA_CA_CERTS: "C:/ProgramData/Brixchat24/pgdata/server.crt",
    API_PUBLIC_URL: "https://brixchat24.com",
    WORKER_HEALTH_PORT: "4110",
    WORKER_HEALTH_HOST: "127.0.0.1",
  };
  delete (common as Record<string, string>).API_DATABASE_URL;
  delete (common as Record<string, string>).WORKER_DATABASE_URL;
  const urlFor = (role: string, password: string) => {
    const url = new URL(migrationUrl);
    url.username = role;
    url.password = password;
    return url.toString();
  };
  const writeEnv = (file: string, values: Record<string, string>) =>
    writeFileSync(
      `${directory}/${file}`,
      Object.entries(values)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") + "\n",
    );
  writeEnv("api.env", {
    ...common,
    API_DATABASE_URL: urlFor("brixchat_live_api", secrets.api),
    PORT: "4410",
    HOST: "127.0.0.1",
  });
  const worker = {
    ...common,
    PORT: "4110",
    WORKER_DATABASE_URL: urlFor("brixchat_live_worker", secrets.worker),
  } as Record<string, string>;
  for (const key of [
    "JWT_ACCESS_SECRET",
    "JWT_REFRESH_SECRET",
    "INTERNAL_OPERATIONS_TOKEN",
    "METRICS_API_KEY",
    "BOOTSTRAP_OWNER_EMAIL",
  ])
    delete worker[key];
  writeEnv("worker.env", worker);
  writeEnv("admin.env", {
    DATABASE_URL: migrationUrl.toString(),
    NODE_EXTRA_CA_CERTS: common.NODE_EXTRA_CA_CERTS,
  });
  await live.end();
  await admin.end();
  console.log(
    "Live database, separate service credentials and owner account prepared. Credentials are in the protected live directory.",
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
