import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import postgres from '../../packages/database/node_modules/postgres/src/index.js';
const credentials = parseEnv(readFileSync('C:/ProgramData/Brixchat24/live/admin.env','utf8'));
const url = new URL(credentials.DATABASE_URL);
const name = 'brixchat_restore_20260910';
const backup = 'C:/ProgramData/Brixchat24/backups/brixchat_live-2026-09-10T08-32-22-831Z.dump';
const admin = postgres(url.toString(),{max:1,onnotice:()=>{}});
try {
  const found = await admin`SELECT 1 FROM pg_database WHERE datname=${name}`;
  if (found.length) throw new Error('Restore drill database already exists; refusing overwrite');
  await admin.unsafe(`CREATE DATABASE ${name}`);
} finally {await admin.end();}
const env={...process.env,PGHOST:url.hostname,PGPORT:url.port,PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGDATABASE:name,PGSSLMODE:'verify-full',PGSSLROOTCERT:'C:/ProgramData/Brixchat24/pgdata/server.crt'};
const restored=spawnSync('C:/ProgramData/Brixchat24/postgres/pgsql/bin/pg_restore.exe',['--exit-on-error','--dbname',name,backup],{env,windowsHide:true,encoding:'utf8'});
if(restored.status!==0) throw new Error(`Restore failed: ${restored.stderr}`);
url.pathname='/'+name;
const sql=postgres(url.toString(),{max:1,onnotice:()=>{}});
try{
 const tables=await sql`SELECT count(*)::int count FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`;
 const migrations=await sql`SELECT count(*)::int count FROM drizzle.__drizzle_migrations`;
 const tls=await sql`SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()`;
 const organizations=await sql`SELECT count(*)::int count FROM organizations`;
 const users=await sql`SELECT count(*)::int count FROM users`;
 const rls=await sql`SELECT count(*)::int count FROM pg_class WHERE relrowsecurity AND relnamespace='public'::regnamespace`;
 const report={time:new Date().toISOString(),database:name,backup,restored:true,tables:tables[0].count,migrations:migrations[0].count,tls:tls[0].ssl,organizations:organizations[0].count,users:users[0].count,rlsTables:rls[0].count,productionRlsEnforced:false};
 writeFileSync('C:/ProgramData/Brixchat24/backups/restore-drill-20260910.json',JSON.stringify(report,null,2));
 writeFileSync('C:/ProgramData/Brixchat24/live/restore-test.env',`DATABASE_URL=${url.toString()}\nNODE_EXTRA_CA_CERTS=C:/ProgramData/Brixchat24/pgdata/server.crt\n`);
 console.log(JSON.stringify(report));
}finally{await sql.end();}
