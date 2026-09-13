import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const service = process.argv[2];
if (!['api','worker','web'].includes(service)) throw new Error('Unknown service');
const env = parseEnv(readFileSync(`C:/ProgramData/Brixchat24/live/${service}.env`, 'utf8'));
const args = service === 'web'
  ? ['--max-old-space-size=1536', 'apps/web/node_modules/next/dist/bin/next', 'start','apps/web','-H','127.0.0.1','-p','3310']
  : ['--max-old-space-size=1024','--import','tsx',service === 'api' ? 'apps/api/src/server.ts' : 'apps/worker/src/index.ts'];
const child = spawn(process.execPath,args,{cwd:root,env:{...process.env,...env},stdio:'inherit',windowsHide:true});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>process.exit(code ?? 1));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
