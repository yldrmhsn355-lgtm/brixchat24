import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";
import postgres from "../../packages/database/node_modules/postgres/src/index.js";

const backupRoot = resolve("C:/ProgramData/Brixchat24/backups");
const input = resolve(process.argv[2] ?? "");
if (!input.startsWith(backupRoot + sep) || !/^live-media-\d{8}-\d{6}$/.test(basename(input)))
  throw new Error("COMBINED_BACKUP_PATH_INVALID");
const manifestPath = resolve(input, "manifest.json");
if (!existsSync(manifestPath)) throw new Error("COMBINED_BACKUP_MANIFEST_REQUIRED");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const databaseArchive = resolve(manifest.database?.backup ?? "");
if (!databaseArchive.startsWith(backupRoot + sep) || !databaseArchive.endsWith(".dump") || !manifest.database?.archiveListVerified)
  throw new Error("DATABASE_ARCHIVE_INVALID");
const databaseName = `brixchat_restore_media_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
const destinationRoot = resolve("C:/ProgramData/Brixchat24/restore-drills", databaseName);
const mediaSource = resolve(input, "media");
const mediaDestination = resolve(destinationRoot, "media");
mkdirSync(mediaDestination, { recursive: true });

function listFiles(root) {
  const files = [];
  function visit(folder) {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const path = resolve(folder, item.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error("RESTORE_LINK_REJECTED");
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) files.push(path);
      else throw new Error("RESTORE_SPECIAL_FILE_REJECTED");
    }
  }
  visit(root);
  return files;
}
const expectedMedia = Array.isArray(manifest.mediaFiles) ? manifest.mediaFiles : [];
const sourceFiles = listFiles(mediaSource);
if (sourceFiles.length !== expectedMedia.length) throw new Error("MEDIA_MANIFEST_COUNT_MISMATCH");
for (const expected of expectedMedia) {
  const source = resolve(mediaSource, expected.path);
  if (!source.startsWith(mediaSource + sep) || !existsSync(source)) throw new Error("MEDIA_MANIFEST_PATH_INVALID");
  const bytes = readFileSync(source);
  const hash = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  if (bytes.length !== expected.bytes || hash !== String(expected.sha256).toUpperCase()) throw new Error("MEDIA_BACKUP_HASH_MISMATCH");
  const target = resolve(mediaDestination, expected.path);
  if (!target.startsWith(mediaDestination + sep)) throw new Error("MEDIA_RESTORE_PATH_INVALID");
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { errorOnExist: true, force: false });
  const restoredHash = createHash("sha256").update(readFileSync(target)).digest("hex").toUpperCase();
  if (restoredHash !== hash) throw new Error("MEDIA_RESTORE_HASH_MISMATCH");
}

const credentials = parseEnv(readFileSync("C:/ProgramData/Brixchat24/live/admin.env", "utf8"));
const url = new URL(credentials.DATABASE_URL);
const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
try {
  if ((await admin`SELECT 1 FROM pg_database WHERE datname=${databaseName}`).length) throw new Error("RESTORE_DATABASE_ALREADY_EXISTS");
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
} finally { await admin.end(); }
const restoreEnv = { ...process.env, PGHOST: url.hostname, PGPORT: url.port, PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: databaseName, PGSSLMODE: "verify-full",
  PGSSLROOTCERT: "C:/ProgramData/Brixchat24/pgdata/server.crt" };
const restored = spawnSync("C:/ProgramData/Brixchat24/postgres/pgsql/bin/pg_restore.exe",
  ["--exit-on-error", "--dbname", databaseName, databaseArchive], { env: restoreEnv, windowsHide: true, encoding: "utf8" });
if (restored.status !== 0) throw new Error(`DATABASE_RESTORE_FAILED:${restored.stderr}`);
url.pathname = "/" + databaseName;
const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
let databaseEvidence;
try {
  const [tables] = await sql`SELECT count(*)::int count FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`;
  const [migrations] = await sql`SELECT count(*)::int count FROM drizzle.__drizzle_migrations`;
  const [organizations] = await sql`SELECT count(*)::int count FROM organizations`;
  const [users] = await sql`SELECT count(*)::int count FROM users`;
  const [rls] = await sql`SELECT count(*)::int count FROM pg_class WHERE relrowsecurity AND relnamespace='public'::regnamespace`;
  const [tls] = await sql`SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()`;
  databaseEvidence = { tables: tables.count, migrations: migrations.count, organizations: organizations.count,
    users: users.count, rlsTables: rls.count, tls: tls.ssl };
  if (tables.count < 150 || migrations.count !== 49 || !tls.ssl) throw new Error("DATABASE_RESTORE_CONTENT_INVALID");
} finally { await sql.end(); }
const report = { completedAt: new Date().toISOString(), source: input, database: databaseName, databaseRestored: true,
  databaseEvidence, mediaDestination, mediaFilesRestored: expectedMedia.length, mediaHashesVerified: true };
writeFileSync(resolve(destinationRoot, "restore-report.json"), JSON.stringify(report, null, 2));
writeFileSync("C:/ProgramData/Brixchat24/backups/combined-restore-drill-latest.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
