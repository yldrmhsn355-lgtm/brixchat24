import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getPnpmInvocation } from "./pnpm-invocation";
async function main() {
const mode = process.argv[2] ?? "check",
  dir = join("artifacts", "recovery");
await mkdir(dir, { recursive: true });
const files = (await readdir(join("packages", "database", "migrations")))
    .filter((x) => x.endsWith(".sql"))
    .sort(),
  dangerous: Array<{ file: string; pattern: string }> = [];
for (const file of files) {
  const sql = await readFile(
    join("packages", "database", "migrations", file),
    "utf8",
  );
  for (const pattern of [
    /DROP\s+(TABLE|DATABASE|SCHEMA)/i,
    /TRUNCATE\s+/i,
    /ALTER\s+TABLE.+DROP\s+COLUMN/i,
  ])
    if (pattern.test(sql)) dangerous.push({ file, pattern: pattern.source });
}
const report = {
  generatedAt: new Date().toISOString(),
  migrationCount: files.length,
  dangerous,
  status: dangerous.length ? "blocked" : "pass",
};
await writeFile(
  join(dir, "migration-safety-report.json"),
  JSON.stringify(report, null, 2),
);
if (dangerous.length) process.exit(1);
if (mode === "production") {
  if (
    process.env.PRODUCTION_MIGRATION_CONFIRM !== "APPLY" ||
    process.env.BACKUP_VERIFIED !== "true"
  )
    throw new Error(
      "Production migration requires PRODUCTION_MIGRATION_CONFIRM=APPLY and BACKUP_VERIFIED=true",
    );
  const invocation = getPnpmInvocation(["db:migrate"]);
  execFileSync(invocation.command, invocation.args, { stdio: "inherit" });
}
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
