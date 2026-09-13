import { spawn } from "node:child_process";
import { readFileSync, createWriteStream } from "node:fs";
import { parseEnv } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const processes = new Set();
let stopping = false;
function start(name, args, env) {
  const log = createWriteStream(
    `C:/ProgramData/Brixchat24/logs/live-${name}.log`,
    { flags: "a" },
  );
  function launch() {
    if (stopping) return;
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.add(child);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on("error", (error) => log.write(error.message + "\n"));
    child.on("close", (code) => {
      processes.delete(child);
      log.write(`Exit ${code}\n`);
      if (!stopping) setTimeout(launch, 5000);
    });
  }
  launch();
}
for (const service of ["api", "worker"]) {
  const env = parseEnv(
    readFileSync(`C:/ProgramData/Brixchat24/live/${service}.env`, "utf8"),
  );
  start(
    service,
    [
      "--import",
      "tsx",
      service === "api" ? "apps/api/src/server.ts" : "apps/worker/src/index.ts",
    ],
    env,
  );
}
start(
  "web",
  [
    "apps/web/node_modules/next/dist/bin/next",
    "start",
    "apps/web",
    "-H",
    "127.0.0.1",
    "-p",
    "3310",
  ],
  {
    NODE_ENV: "production",
    NEXT_PUBLIC_API_URL: "",
    NEXT_PUBLIC_REALTIME_URL: "/api/v1/realtime",
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
    for (const child of processes) child.kill();
  });
