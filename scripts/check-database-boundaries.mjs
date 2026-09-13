import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "apps", "api", "src");
const baselinePath = path.join(
  root,
  "docs",
  "architecture",
  "database-boundary-baseline.json",
);

const toProjectPath = (absolutePath) =>
  path.relative(root, absolutePath).split(path.sep).join("/");

async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listTypeScriptFiles(entryPath);
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".ts") ||
        entry.name.endsWith(".test.ts")
      ) {
        return [];
      }
      return [entryPath];
    }),
  );
  return files.flat();
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const files = await listTypeScriptFiles(sourceRoot);
const currentCounts = new Map();
const currentDatabaseClientImports = new Set();

for (const file of files) {
  const source = await readFile(file, "utf8");
  const projectPath = toProjectPath(file);
  const directSqlAwaitCount = source.match(/\bawait\s+sql\b/g)?.length ?? 0;

  if (directSqlAwaitCount > 0)
    currentCounts.set(projectPath, directSqlAwaitCount);
  if (
    /import\s+type\s*{[^}]*\bDatabaseClient\b[^}]*}\s+from\s+["']@brixchat\/database["']/.test(
      source,
    )
  ) {
    currentDatabaseClientImports.add(projectPath);
  }
}

const errors = [];
const improvements = [];
const expectedCounts = baseline.directSqlAwaitCounts;

for (const [file, count] of currentCounts) {
  const ceiling = expectedCounts[file];
  if (ceiling === undefined) {
    errors.push(
      `${file}: ${count} new direct SQL await(s); add a repository instead`,
    );
  } else if (count > ceiling) {
    errors.push(
      `${file}: direct SQL awaits increased from ${ceiling} to ${count}`,
    );
  } else if (count < ceiling) {
    improvements.push(`${file}: ${ceiling} -> ${count}; lower the baseline`);
  }
}

for (const [file, ceiling] of Object.entries(expectedCounts)) {
  if (!currentCounts.has(file)) {
    if (!files.some((candidate) => toProjectPath(candidate) === file)) {
      errors.push(`${file}: baseline references a missing source file`);
    } else if (ceiling > 0) {
      improvements.push(
        `${file}: ${ceiling} -> 0; remove it from the baseline`,
      );
    }
  }
}

const allowedImports = new Set(baseline.allowedDatabaseClientImports);
for (const file of currentDatabaseClientImports) {
  if (!allowedImports.has(file)) {
    errors.push(`${file}: new DatabaseClient import in the API layer`);
  }
}
for (const file of allowedImports) {
  if (!currentDatabaseClientImports.has(file)) {
    improvements.push(
      `${file}: DatabaseClient import removed; lower the baseline`,
    );
  }
}

const total = [...currentCounts.values()].reduce(
  (sum, count) => sum + count,
  0,
);
console.log(
  `Database boundary: ${total} direct SQL awaits across ${currentCounts.size} API files; ` +
    `${currentDatabaseClientImports.size} transitional DatabaseClient imports.`,
);

if (improvements.length > 0) {
  console.log("Baseline improvements detected:");
  for (const improvement of improvements) console.log(`  - ${improvement}`);
}

if (errors.length > 0) {
  console.error("Database boundary check failed:");
  for (const error of errors) console.error(`  - ${error}`);
  console.error(
    "Move database work into packages/database repositories; do not raise the baseline.",
  );
  process.exitCode = 1;
} else {
  console.log("Database boundary check passed.");
}
