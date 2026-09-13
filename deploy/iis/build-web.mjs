import { loadEnvFile } from 'node:process';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(root);
loadEnvFile('.env.iis');
const result = spawnSync(process.execPath, ['apps/web/node_modules/next/dist/bin/next', 'build', 'apps/web'], {
  cwd: root, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
