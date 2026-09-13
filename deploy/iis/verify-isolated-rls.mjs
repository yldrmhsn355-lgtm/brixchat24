import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import postgres from '../../packages/database/node_modules/postgres/src/index.js';
const env=parseEnv(readFileSync('C:/ProgramData/Brixchat24/live/restore-test.env','utf8'));
if(new URL(env.DATABASE_URL).pathname !== '/brixchat_restore_20260910') throw new Error('Test database required');
const sql=postgres(env.DATABASE_URL,{max:1});
try{
 await sql.begin(async tx=>{
  const a=crypto.randomUUID(),b=crypto.randomUUID();
  await tx`INSERT INTO organizations(id,name,slug) VALUES(${a},'Isolation A',${a}),(${b},'Isolation B',${b})`;
  await tx`INSERT INTO contacts(organization_id,first_name,normalized_phone) VALUES(${a},'A','905550000001'),(${b},'B','905550000002')`;
  await tx`SET LOCAL ROLE brixchat_app_scoped`;
  await tx`SELECT set_config('app.organization_id',${a},true)`;
  const rows=await tx`SELECT organization_id FROM contacts`;
  if(rows.length!==1 || rows[0].organization_id!==a) throw new Error('Tenant read isolation failed');
  let denied=false;
  try { await tx.savepoint(async sp=>{
    await sp`INSERT INTO contacts(organization_id,first_name,normalized_phone) VALUES(${b},'Cross tenant','905550000003')`;
  }); } catch(error) { if(error.code==='42501') denied=true; else throw error; }
  if(!denied) throw new Error('Cross tenant insert unexpectedly allowed');
  console.log('Restored database: scoped-role read isolation and cross-tenant write denial passed. Live API owner-role limitation remains.');
 });
}finally{await sql.end();}
