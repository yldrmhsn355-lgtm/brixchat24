// Run by Windows Task Scheduler. Local IIS environment, no external providers.
import { spawn } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { createWriteStream, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(root);
loadEnvFile(resolve(root, '.env.iis'));
const runtime = JSON.parse(readFileSync('C:/ProgramData/Brixchat24/runtime.json', 'utf8'));
const children = new Set();
let stopping = false;
function supervise(name, executable, args, env = {}) {
  const log = createWriteStream(`C:/ProgramData/Brixchat24/logs/${name}.log`, { flags: 'a' });
  function start() {
    if (stopping) return;
    log.write(`\n${new Date().toISOString()} Starting ${name}\n`);
    const child = spawn(executable, args, {
      cwd: root, env: { ...process.env, ...env }, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('error', error => log.write(`${error.message}\n`));
    child.on('close', code => {
      children.delete(child);
      log.write(`Exited ${code}; retrying in 5 seconds\n`);
      if (!stopping) setTimeout(start, 5000);
    });
  }
  start();
}
// Redis is owned by the Brixchat24-Redis Windows service.
supervise('api', process.execPath, ['--import', 'tsx', 'apps/api/src/server.ts'], { HOST: '127.0.0.1', PORT: '4400' });
supervise('worker', process.execPath, ['--import', 'tsx', 'apps/worker/src/index.ts'], { WORKER_HEALTH_HOST: '127.0.0.1' });
supervise('web', process.execPath, ['apps/web/node_modules/next/dist/bin/next', 'start', 'apps/web', '-H', '127.0.0.1', '-p', '3300'], { NODE_ENV: 'production' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopping = true;
  for (const child of children) child.kill();
});
