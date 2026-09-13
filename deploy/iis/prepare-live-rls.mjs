import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {randomBytes} from 'node:crypto';
import postgres from '../../packages/database/node_modules/postgres/src/index.js';
const directory='C:/ProgramData/Brixchat24/live';
const adminEnv=parseEnv(readFileSync(directory+'/admin.env','utf8'));
if(new URL(adminEnv.DATABASE_URL).pathname!=='/brixchat_live')throw new Error('Unexpected production database');
const apiPath=directory+'/api.env';
const apiText=readFileSync(apiPath,'utf8');
const api=parseEnv(apiText);
const role='brixchat_live_scoped';
const secretPath=directory+'/scoped-role.json';
const sql=postgres(adminEnv.DATABASE_URL,{onnotice:()=>{}});
try{
 let password;
 const existing=await sql`SELECT 1 FROM pg_roles WHERE rolname=${role}`;
 if(existing.length){
   if(!existsSync(secretPath))throw new Error('Existing scoped role has no managed secret; refusing rotation');
   password=JSON.parse(readFileSync(secretPath,'utf8')).password;
 }else{
   password=randomBytes(32).toString('hex');
   await sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE brixchat_app_scoped`);
   writeFileSync(secretPath,JSON.stringify({password}));
 }
 await sql.unsafe(`GRANT CONNECT ON DATABASE brixchat_live TO ${role}`);
 const scoped=new URL(api.API_DATABASE_URL || api.DATABASE_URL);
 scoped.username=role;scoped.password=password;
 const line='API_SCOPED_DATABASE_URL='+scoped.toString();
 const updated=/^API_SCOPED_DATABASE_URL=.*$/m.test(apiText)?apiText.replace(/^API_SCOPED_DATABASE_URL=.*$/m,line):apiText.trimEnd()+'\n'+line+'\n';
 writeFileSync(apiPath,updated);
 console.log('Production scoped login configured; existing application secrets retained.');
}finally{await sql.end();}
