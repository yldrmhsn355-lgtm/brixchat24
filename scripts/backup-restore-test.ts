import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const runCompose = (args: string[], input?: string) =>
  execFileSync("docker", ["compose", ...args], {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });

function createDump(): {
  dump: string;
  sourceEnvironment: "local" | "production";
  sourceReadOnlyDump: boolean;
} {
  if (process.env.BACKUP_SOURCE_ENVIRONMENT !== "production")
    return {
      dump: runCompose([
        "exec",
        "-T",
        "postgres",
        "pg_dump",
        "-U",
        "brixchat",
        "-d",
        "brixchat",
        "--no-owner",
        "--no-privileges",
      ]),
      sourceEnvironment: "local",
      sourceReadOnlyDump: true,
    };

  if (
    process.env.PRODUCTION_BACKUP_ACCEPTANCE_CONFIRM !== "READ_ONLY_DUMP"
  )
    throw Object.assign(
      new Error("Production backup acceptance requires explicit confirmation"),
      { code: "PRODUCTION_BACKUP_CONFIRMATION_REQUIRED" },
    );
  if (!process.env.BACKUP_SOURCE_DATABASE_URL)
    throw Object.assign(new Error("Production database URL is missing"), {
      code: "PRODUCTION_BACKUP_SOURCE_MISSING",
    });
  return {
    dump: execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-e",
        "BACKUP_SOURCE_DATABASE_URL",
        "postgres:17-alpine",
        "sh",
        "-eu",
        "-c",
        'exec pg_dump --dbname="$BACKUP_SOURCE_DATABASE_URL" --schema=public --schema=drizzle --exclude-extension="*" --no-owner --no-privileges',
      ],
      {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
    sourceEnvironment: "production",
    sourceReadOnlyDump: true,
  };
}

async function main() {
  await mkdir("artifacts/recovery", { recursive: true });
  const startedAt = Date.now();
  const temporaryDatabase = `brixchat_restore_${Date.now()}`;
  let status = "failed";
  let rowCount = 0;
  let migrationCount = 0;
  let dumpSha256: string | undefined;
  let sourceEnvironment: "local" | "production" =
    process.env.BACKUP_SOURCE_ENVIRONMENT === "production"
      ? "production"
      : "local";
  let sourceReadOnlyDump = false;
  let temporaryDatabaseRemoved = false;
  let errorCode: string | undefined;
  try {
    const source = createDump();
    sourceEnvironment = source.sourceEnvironment;
    sourceReadOnlyDump = source.sourceReadOnlyDump;
    dumpSha256 = createHash("sha256").update(source.dump).digest("hex");
    const restorableDump =
      sourceEnvironment === "production"
        ? source.dump.replace(
            /^CREATE SCHEMA public;\r?\n/m,
            "-- public schema pre-created for pg_trgm\n",
          )
        : source.dump;
    runCompose([
      "exec",
      "-T",
      "postgres",
      "createdb",
      "-U",
      "brixchat",
      temporaryDatabase,
    ]);
    try {
      runCompose([
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "brixchat",
        "-d",
        temporaryDatabase,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sourceEnvironment === "production"
          ? "DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE SCHEMA IF NOT EXISTS extensions; CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions"
          : "DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public",
      ]);
      runCompose(
        [
          "exec",
          "-T",
          "postgres",
          "psql",
          "-U",
          "brixchat",
          "-d",
          temporaryDatabase,
          "-v",
          "ON_ERROR_STOP=1",
        ],
        restorableDump,
      );
      rowCount = Number(
        runCompose([
          "exec",
          "-T",
          "postgres",
          "psql",
          "-U",
          "brixchat",
          "-d",
          temporaryDatabase,
          "-Atc",
          "SELECT count(*) FROM organizations",
        ]).trim(),
      );
      migrationCount = Number(
        runCompose([
          "exec",
          "-T",
          "postgres",
          "psql",
          "-U",
          "brixchat",
          "-d",
          temporaryDatabase,
          "-Atc",
          "SELECT count(*) FROM drizzle.__drizzle_migrations",
        ]).trim(),
      );
      status =
        Number.isFinite(rowCount) &&
        rowCount > 0 &&
        Number.isFinite(migrationCount) &&
        migrationCount > 0
          ? "pass"
          : "failed";
    } finally {
      runCompose([
        "exec",
        "-T",
        "postgres",
        "dropdb",
        "-U",
        "brixchat",
        "--if-exists",
        temporaryDatabase,
      ]);
      temporaryDatabaseRemoved = true;
    }
  } catch (reason) {
    const candidate =
      typeof reason === "object" && reason !== null
        ? Reflect.get(reason, "code")
        : undefined;
    errorCode =
      typeof candidate === "string"
        ? candidate
        : "BACKUP_RESTORE_ACCEPTANCE_FAILED";
  }
  const report = {
    status,
    sourceEnvironment,
    sourceReadOnlyDump,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    dumpSha256,
    restoredOrganizationRows: rowCount,
    restoredMigrationRows: migrationCount,
    temporaryDatabaseRemoved,
    errorCode,
  };
  await writeFile(
    "artifacts/recovery/backup-restore-report.json",
    JSON.stringify(report, null, 2),
  );
  process.stdout.write(JSON.stringify(report) + "\n");
  if (status !== "pass") process.exitCode = 1;
}

void main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      status: "failed",
      errorCode:
        typeof error?.code === "string"
          ? error.code
          : "BACKUP_RESTORE_ACCEPTANCE_FAILED",
    }) + "\n",
  );
  process.exitCode = 1;
});
