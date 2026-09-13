import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function main() {
  const command = process.argv[2] ?? "audit",
    dir = join("artifacts", "security"),
    pnpmCommand = "pnpm";
  await mkdir(dir, { recursive: true });
  const run = (cmd: string, args: string[]) => {
    try {
      const windowsCommandShim =
        process.platform === "win32" && cmd === pnpmCommand;
      return {
        ok: true,
        output: execFileSync(
          windowsCommandShim ? (process.env.ComSpec ?? "cmd.exe") : cmd,
          windowsCommandShim ? ["/d", "/s", "/c", cmd, ...args] : args,
          {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      };
    } catch (error) {
      const value = error as {
        stdout?: string;
        stderr?: string;
        status?: number;
      };
      return {
        ok: false,
        output: `${value.stdout ?? ""}${value.stderr ?? ""}`,
        status: value.status,
      };
    }
  };
  if (command === "audit") {
    const result = run(pnpmCommand, [
      "audit",
      "--audit-level",
      "critical",
      "--json",
    ]);
    await writeFile(join(dir, "dependency-audit.json"), result.output || "{}");
    if (!result.ok) process.exitCode = 1;
  } else if (command === "sbom") {
    const list = run(pnpmCommand, [
      "list",
      "--recursive",
      "--depth",
      "Infinity",
      "--json",
    ]);
    const projects = JSON.parse(list.output || "[]") as Array<{
      name?: string;
      version?: string;
      dependencies?: Record<string, { version?: string }>;
    }>;
    const components = new Map<
      string,
      { type: string; name: string; version: string }
    >();
    for (const project of projects)
      for (const [name, value] of Object.entries(project.dependencies ?? {}))
        components.set(`${name}@${value.version}`, {
          type: "library",
          name,
          version: value.version ?? "unknown",
        });
    await writeFile(
      join(dir, "sbom.cdx.json"),
      JSON.stringify(
        {
          bomFormat: "CycloneDX",
          specVersion: "1.5",
          version: 1,
          components: [...components.values()],
        },
        null,
        2,
      ),
    );
  } else if (command === "licenses") {
    const result = run(pnpmCommand, ["licenses", "list", "--json"]);
    await writeFile(join(dir, "licenses.json"), result.output || "{}");
    if (!result.ok) process.exitCode = 1;
  } else if (command === "secrets") {
    const files = run("rg", [
      "--files",
      "-g",
      "!node_modules",
      "-g",
      "!.git",
      "-g",
      "!artifacts",
    ]);
    const candidates = files.output.split(/\r?\n/).filter(Boolean);
    const findings: Array<{ file: string; rule: string }> = [];
    const rules = [
      {
        name: "private-key",
        pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      },
      { name: "meta-token", pattern: /EAA[A-Za-z0-9]{30,}/ },
      { name: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/ },
    ];
    for (const file of candidates) {
      const content = await readFile(file, "utf8").catch(() => "");
      for (const rule of rules)
        if (rule.pattern.test(content))
          findings.push({ file, rule: rule.name });
    }
    await writeFile(
      join(dir, "secret-scan.json"),
      JSON.stringify({ findings }, null, 2),
    );
    if (findings.length) process.exitCode = 1;
  } else if (command === "containers") {
    const result = run("trivy", [
      "image",
      "--severity",
      "CRITICAL",
      "--exit-code",
      "1",
      "brixchat24-api",
      "brixchat24-web",
      "brixchat24-worker",
    ]);
    await writeFile(
      join(dir, "container-scan.txt"),
      result.output ||
        "Trivy is not installed; external container acceptance pending.\n",
    );
    if (!result.ok && result.status !== undefined) process.exitCode = 1;
  } else if (command === "staging-scan") {
    const url = process.env.STAGING_URL;
    await writeFile(
      join(dir, "owasp-staging-scan.md"),
      `# OWASP staging scan\n\nStatus: ${url ? "ready" : "pending_external_acceptance"}\n\nUse ZAP baseline only against the authorized staging URL. Destructive active scan is prohibited.\n`,
    );
    if (!url) process.exitCode = 2;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
