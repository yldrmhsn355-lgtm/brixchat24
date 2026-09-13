import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = ["app", "components", "lib"];
const SOURCE_EXTENSIONS = new Set([".css", ".js", ".jsx", ".ts", ".tsx"]);
const MOJIBAKE_PATTERNS = [
  /\uFFFD/u,
  /\u00C3[\u0080-\u00BF]/u,
  /\u00C4[\u00B0\u00B1\u0178\u017E]/u,
  /\u00C5[\u0178\u017E]/u,
  /\u00E2(?:\u20AC|[\u0080-\u00BF])/u,
  /\u00EF[\u0080-\u00BF]/u,
  /\u00F0\u0178/u,
];

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(path);
      const extension = entry.name.slice(entry.name.lastIndexOf("."));
      return SOURCE_EXTENSIONS.has(extension) ? [path] : [];
    }),
  );
  return files.flat();
}

describe("web source encoding", () => {
  it("does not contain replacement characters or known mojibake", async () => {
    const root = process.cwd();
    const files = (
      await Promise.all(
        SOURCE_ROOTS.map((directory) =>
          collectSourceFiles(join(root, directory)),
        ),
      )
    ).flat();
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (MOJIBAKE_PATTERNS.some((pattern) => pattern.test(source))) {
        offenders.push(relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  }, 15_000);
});
