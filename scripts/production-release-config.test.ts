import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFile(path, "utf8");

describe("production release configuration", () => {
  it("runs CI for the repository default branch", async () => {
    expect(await source(".github/workflows/ci.yml")).toMatch(
      /branches:\s*\[(?:[^\]]*\bmaster\b[^\]]*)\]/,
    );
  });

  it("builds and health-checks every application service", async () => {
    const compose = await source("docker-compose.production.yml");
    for (const dockerfile of [
      "apps/api/Dockerfile",
      "apps/worker/Dockerfile",
      "apps/web/Dockerfile",
    ]) {
      expect(compose).toContain(`dockerfile: ${dockerfile}`);
    }
    expect(compose.match(/healthcheck:/g)).toHaveLength(3);
  });

  it("does not write a local media directory for remote storage", async () => {
    const entrypoint = await source("docker-entrypoint.sh");
    expect(entrypoint).toContain("${OBJECT_STORAGE_PROVIDER:-local}");
    expect(entrypoint).toContain(
      "${OBJECT_STORAGE_LOCAL_PATH:-/data/media}",
    );
  });
});
