import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFile(path, "utf8");

describe("canonical local Docker stack", () => {
  it("pins Compose to one stable project name", async () => {
    const compose = await source("docker-compose.yml");
    const envExample = await source(".env.example");

    expect(compose).toMatch(/^name: brixchat24-live$/m);
    expect(envExample).toMatch(/^COMPOSE_PROJECT_NAME=brixchat24-live$/m);
  });

  it("routes package commands through the guarded wrapper", async () => {
    const packageJson = JSON.parse(await source("package.json")) as {
      scripts: Record<string, string>;
    };

    for (const command of [
      "docker:doctor",
      "docker:up:infra",
      "docker:up",
      "docker:down",
      "docker:ps",
      "docker:logs",
    ]) {
      expect(packageJson.scripts[command]).toContain(
        "scripts/docker-stack.mjs",
      );
    }
  });

  it("checks for legacy projects before starting the stack", async () => {
    const wrapper = await source("scripts/docker-stack.mjs");

    expect(wrapper).toContain(
      'export const CANONICAL_PROJECT = "brixchat24-live"',
    );
    expect(wrapper).toContain('"compose", "ls", "--all", "--format", "json"');
    expect(wrapper).toContain('"up",');
    expect(wrapper).not.toContain('down", "--volumes"');
  });
});
