import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {randomBytes} from 'node:crypto';
import postgres from '../../packages/database/node_modules/postgres/src/index.js';
const env=parseEnv(readFileSync('C:/ProgramData/Brixchat24/live/restore-test.env','utf8'));
const url=new URL(env.DATABASE_URL);
if(url.pathname!=='/brixchat_restore_20260910')throw new Error('ISOLATED_DATABASE_REQUIRED');
const destination='C:/ProgramData/Brixchat24/live/scoped-test.env';
if(existsSync(destination)){console.log('Existing scoped test credentials retained');process.exit(0);}
const sql=postgres(url.toString(),{onnotice:()=>{}});
try{
 const password=randomBytes(24).toString('hex');
 const role='brixchat_scoped_acceptance';
 await sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE brixchat_app_scoped`);
 url.username=role;url.password=password;
 writeFileSync(destination,`DATABASE_URL=${env.DATABASE_URL}\nAPI_SCOPED_TEST_DATABASE_URL=${url.toString()}\nSCOPED_ROUTER_TEST_DATABASE_URL=${env.DATABASE_URL}\nNODE_EXTRA_CA_CERTS=C:/ProgramData/Brixchat24/pgdata/server.crt\n`);
 console.log('Scoped acceptance role created for isolated tests');
}finally{await sql.end();}
