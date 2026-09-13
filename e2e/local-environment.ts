import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type WorktreePorts = {
  app?: number;
  db?: number;
  redis?: number;
};

function readWorktreePorts(): WorktreePorts {
  const path = resolve(process.cwd(), ".worktree-ports.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as WorktreePorts;
}

const ports = readWorktreePorts();

export const localComposeEnvironment = {
  ...process.env,
  WEB_PORT: process.env.WEB_PORT ?? String(ports.app ?? 3300),
  API_PORT: process.env.API_PORT ?? "4400",
  POSTGRES_PORT: process.env.POSTGRES_PORT ?? String(ports.db ?? 5434),
  REDIS_PORT: process.env.REDIS_PORT ?? String(ports.redis ?? 6381),
};

export const localWebUrl =
  process.env.E2E_BASE_URL ??
  `http://localhost:${localComposeEnvironment.WEB_PORT}`;
export const localApiUrl =
  process.env.E2E_API_BASE_URL ??
  `http://localhost:${localComposeEnvironment.API_PORT}`;
export const localDatabaseUrl =
  process.env.DATABASE_URL ??
  `postgresql://brixchat:brixchat@localhost:${localComposeEnvironment.POSTGRES_PORT}/brixchat`;
