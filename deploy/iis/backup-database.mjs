import { loadEnvFile } from "node:process";
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(root);
loadEnvFile(process.argv[2] ?? ".env.iis");
const database = new URL(process.env.DATABASE_URL);
const backupDirectory = "C:/ProgramData/Brixchat24/backups";
mkdirSync(backupDirectory, { recursive: true });
const databaseName = decodeURIComponent(database.pathname.slice(1));
if (!/^[a-zA-Z0-9_-]+$/.test(databaseName))
  throw new Error("Invalid backup database name");
const timestamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const output = `${backupDirectory}/${databaseName}-${timestamp}.dump`;
const env = {
  ...process.env,
  PGHOST: database.hostname,
  PGPORT: database.port || "5432",
  PGUSER: decodeURIComponent(database.username),
  PGPASSWORD: decodeURIComponent(database.password),
  PGDATABASE: databaseName,
  ...(database.searchParams.get("sslmode")
    ? {
        PGSSLMODE: database.searchParams.get("sslmode"),
        PGSSLROOTCERT: "C:/ProgramData/Brixchat24/pgdata/server.crt",
      }
    : {}),
};
for (const [tool, args] of [
  ["pg_dump", ["--format=custom", "--file", output]],
  ["pg_restore", ["--list", output]],
]) {
  const result = spawnSync(
    `C:/ProgramData/Brixchat24/postgres/pgsql/bin/${tool}.exe`,
    args,
    {
      env,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `${tool} failed: ${result.error?.message ?? result.stderr}`,
    );
}
console.log(
  JSON.stringify({
    backup: output,
    bytes: statSync(output).size,
    archiveListVerified: true,
  }),
);
