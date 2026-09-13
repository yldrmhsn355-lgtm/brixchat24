import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";
import { validateProductionConfig } from "../../packages/integrations/src/secrets/index";
const root = "C:/ProgramData/Brixchat24";
const release = "20260910-media";
for (const service of ["API", "Worker"]) {
  const xml = readFileSync(`${root}/services/Brixchat24-${service}.xml`, "utf8");
  if (!xml.includes(`releases\\${release}`)) throw new Error("MEDIA_RELEASE_MUST_BE_PROMOTED_FIRST");
}
if (!existsSync(`${root}/media`)) throw new Error("PRIVATE_MEDIA_DIRECTORY_REQUIRED");
const values = { OBJECT_STORAGE_PROVIDER: "filesystem", OBJECT_STORAGE_FILESYSTEM_ROOT: `${root}/media`,
  MALWARE_SCANNER_PROVIDER: "clamav", CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: "3311",
  CLAMAV_HEALTHCHECK_TIMEOUT_MS: "2000", CLAMAV_SCAN_TIMEOUT_MS: "30000" };
const pending = ["api", "worker"].map(service => {
  const path = `${root}/live/${service}.env`;
  const original = readFileSync(path, "utf8");
  const proposed = { ...parseEnv(original), ...values };
  const check = validateProductionConfig(proposed, { scope: service as "api" | "worker" });
  if (!check.valid) throw new Error(`CONFIGURATION_REJECTED:${service}:${check.errors.join(",")}`);
  const lines = original.split(/\r?\n/).filter(line => !Object.keys(values).some(key => line.startsWith(key + "=")));
  const updated = lines.join("\n") + "\n" + Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
  return { path, original, updated, service };
});
const stamp = Date.now();
const restart = () => execFileSync("powershell.exe", ["-NoProfile", "-Command", "Restart-Service Brixchat24-API; Restart-Service Brixchat24-Worker"], { windowsHide: true, stdio: "pipe", timeout: 120000 });
for (const item of pending) copyFileSync(item.path, `${root}/backups/${item.service}-before-media-${stamp}.env`);
try {
  for (const item of pending) writeFileSync(item.path, item.updated);
  restart();
  let ready = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      const api = await (await fetch("http://127.0.0.1:4410/health/ready", { signal: AbortSignal.timeout(3000) })).json();
      const response = await fetch("http://127.0.0.1:4110/health", { signal: AbortSignal.timeout(3000) });
      const worker = await response.json();
      ready = api.dependencies?.objectStorage?.healthy === true && api.dependencies?.malwareScanner?.healthy === true &&
        api.dependencies?.postgresql === "ok" && api.dependencies?.redis?.healthy === true && response.status === 200 &&
        worker.dependencies?.objectStorage?.healthy === true && worker.dependencies?.malwareScanner?.healthy === true && worker.dependencies?.workerLoop?.healthy === true;
      if (ready) break;
    } catch { /* Startup is bounded by the retry limit. */ }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!ready) throw new Error("MEDIA_READINESS_FAILED");
  writeFileSync(`${root}/logs/media-activation.json`, JSON.stringify({ at: new Date().toISOString(), release, storage: "filesystem", scanner: "clamav", ready }, null, 2));
  console.log("Private filesystem storage and ClamAV enabled; API and worker readiness verified.");
} catch (error) {
  for (const item of pending) writeFileSync(item.path, item.original);
  restart();
  throw error;
}
