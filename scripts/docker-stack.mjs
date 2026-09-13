import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CANONICAL_PROJECT = "brixchat24-live";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const normalizedRoot = repositoryRoot.replaceAll("/", "\\").toLowerCase();

function runDocker(args, options = {}) {
  return spawnSync("docker", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: {
      ...process.env,
      COMPOSE_PROJECT_NAME: CANONICAL_PROJECT,
    },
  });
}

function parseComposeProjects(stdout) {
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function belongsToThisRepository(project) {
  const configFiles = String(project.ConfigFiles ?? "")
    .replaceAll("/", "\\")
    .toLowerCase();
  const name = String(project.Name ?? "").toLowerCase();

  return (
    configFiles.startsWith(normalizedRoot) ||
    configFiles.includes("\\brixchat24-live-") ||
    name.startsWith("brixchat24-") ||
    name === "brixchat24" ||
    name === "brixchat_phase1" ||
    name === "brixchat_phase1_verify"
  );
}

export function findLegacyProjects(projects) {
  return projects.filter(
    (project) =>
      belongsToThisRepository(project) && project.Name !== CANONICAL_PROJECT,
  );
}

function doctor() {
  const result = runDocker(["compose", "ls", "--all", "--format", "json"], {
    capture: true,
  });
  if (result.status !== 0) {
    process.stderr.write(
      result.stderr || "Docker Compose listesi okunamadi.\n",
    );
    return result.status ?? 1;
  }

  const legacy = findLegacyProjects(parseComposeProjects(result.stdout));
  if (legacy.length === 0) {
    console.log(`Docker oturumu temiz: ${CANONICAL_PROJECT}`);
    return 0;
  }

  console.error("Bu repo icin daginik Docker Compose oturumlari bulundu:");
  for (const project of legacy) {
    console.error(
      `- ${project.Name} (${project.Status}): ${project.ConfigFiles}`,
    );
  }
  console.error(
    `Once eski oturumlari volume silmeden kapatin; ardindan ${CANONICAL_PROJECT} yiginini baslatin.`,
  );
  return 2;
}

const [command, ...composeArgs] = process.argv.slice(2);

if (!command || command === "doctor") {
  process.exitCode = doctor();
} else {
  const mutatingCommands = new Set([
    "build",
    "create",
    "restart",
    "run",
    "start",
    "up",
  ]);
  if (mutatingCommands.has(command)) {
    const status = doctor();
    if (status !== 0) process.exit(status);
  }

  const result = runDocker([
    "compose",
    "--project-name",
    CANONICAL_PROJECT,
    "--file",
    resolve(repositoryRoot, "docker-compose.yml"),
    command,
    ...composeArgs,
  ]);
  process.exitCode = result.status ?? 1;
}
