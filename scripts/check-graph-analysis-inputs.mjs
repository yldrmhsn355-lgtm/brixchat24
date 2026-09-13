import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const graphDir = path.join(root, "graphify-out");
const graphFiles = ["manifest.json", "graph.json"];
const requiredIgnoreRules = [
  "/node_modules",
  "**/.next*/",
  "**/dist/",
  "**/build/",
  "**/coverage/",
  "**/.turbo/",
  "**/tmp/",
  "**/generated/",
  "*.min.js",
  "*.bundle.js",
  "/artifacts/",
  "/test-results/",
  "/playwright-report/",
];
const forbiddenPath =
  /(^|\/)(node_modules|\.next[^/]*|dist|build|coverage|\.turbo|tmp|generated|artifacts|test-results|playwright-report)(\/|$)|\.(min|bundle)\.js$/i;
const pathKeys = new Set([
  "file",
  "files",
  "file_path",
  "filepath",
  "path",
  "paths",
  "source",
  "source_file",
  "source_files",
  "source_location",
]);

function collectPaths(value, key = "", output = []) {
  if (typeof value === "string" && pathKeys.has(key.toLowerCase())) {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, key, output);
  } else if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      collectPaths(childValue, childKey, output);
    }
  }
  return output;
}

const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");
const ignoreLines = gitignore.split(/\r?\n/);
const missingRules = requiredIgnoreRules.filter(
  (rule) => !ignoreLines.includes(rule),
);
if (missingRules.length > 0) {
  console.error(`Graphify ignore rules missing: ${missingRules.join(", ")}`);
  process.exitCode = 1;
}

const availableGraphFiles = graphFiles.filter((filename) =>
  existsSync(path.join(graphDir, filename)),
);

if (availableGraphFiles.length === 0) {
  console.log(
    "Graphify outputs are absent; ignore-rule hygiene is valid and artifact-content inspection was skipped.",
  );
} else if (availableGraphFiles.length !== graphFiles.length) {
  const missingGraphFiles = graphFiles.filter(
    (filename) => !availableGraphFiles.includes(filename),
  );
  console.error(
    `Graphify output is incomplete: ${missingGraphFiles
      .map((filename) => `graphify-out/${filename}`)
      .join(", ")}`,
  );
  process.exitCode = 1;
} else {
  for (const filename of graphFiles) {
    const file = path.join(graphDir, filename);
    const data = JSON.parse(await readFile(file, "utf8"));
    const leaked = [
      ...new Set(
        collectPaths(data)
          .map((item) => item.replaceAll("\\", "/"))
          .filter((item) => forbiddenPath.test(item)),
      ),
    ];
    if (leaked.length > 0) {
      console.error(
        `Generated artifacts leaked into graphify-out/${filename}:\n${leaked
          .slice(0, 20)
          .map((item) => `  - ${item}`)
          .join("\n")}`,
      );
      process.exitCode = 1;
    }
  }
}

if (!process.exitCode) {
  console.log("Graphify input hygiene is valid.");
}
