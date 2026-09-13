import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import postgres from 'postgres';
const env=parseEnv(readFileSync('C:/ProgramData/Brixchat24/live/api.env','utf8'));
if(!env.API_DATABASE_URL) throw new Error('Database configuration missing');
const sql=postgres(env.API_DATABASE_URL,{max:1,onnotice:()=>{}});
const access=Object.fromEntries(readFileSync('C:/ProgramData/Brixchat24/live/admin-access.txt','utf8').split(/\r?\n/).map(line=>{const i=line.search(/[:=]/);return [line.slice(0,i).trim(),line.slice(i+1).trim()];}));
const origin='https://api.brixchat24.com';
try {
  const login=await fetch(origin+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:access['E-posta'],password:access['Parola']})});
  const auth=await login.json() as {data?:{accessToken:string}};
  if(!login.ok||!auth.data?.accessToken) throw new Error(`Login ${login.status}`);
  const headers={authorization:`Bearer ${auth.data.accessToken}`};
  const rows=await sql`SELECT DISTINCT ON (attachment_type) id,attachment_type FROM message_attachments WHERE processing_status='stored' AND scan_status='clean' AND deleted_at IS NULL ORDER BY attachment_type,stored_at DESC`;
  const playback=[];
  for(const row of rows) {
    const signed=await fetch(`${origin}/api/v1/attachments/${row.id}/download-url`,{method:'POST',headers});
    if(!signed.ok) throw new Error(`Sign ${signed.status}`);
    const result=await signed.json() as {data:{url:string}};
    const range=await fetch(result.data.url,{headers:{range:'bytes=0-15'}});
    const bytes=await range.arrayBuffer();
    const download=new URL(result.data.url); download.searchParams.set('download','1');
    const forced=await fetch(download,{headers:{range:'bytes=0-0'}}); await forced.arrayBuffer();
    playback.push({type:row.attachment_type,status:range.status,length:bytes.byteLength,contentType:range.headers.get('content-type'),range:range.headers.get('content-range'),downloadDisposition:forced.headers.get('content-disposition')?.startsWith('attachment')});
    if(range.status!==206 || bytes.byteLength!==16 || !forced.headers.get('content-disposition')?.startsWith('attachment')) throw new Error('Playback contract failed');
  }
  const failed=await sql`SELECT id FROM message_attachments WHERE processing_status='failed' AND last_error_code='MEDIA_OBJECT_CLEANUP_FAILED' AND deleted_at IS NULL`;
  let requeued=0;
  if(process.env.RETRY_FAILED_MEDIA==='1') {
    if(failed.length>1) throw new Error('Unexpected recovery scope');
    for(const row of failed) {
      const response=await fetch(`${origin}/api/v1/attachments/${row.id}/retry`,{method:'POST',headers});
      if(!response.ok) throw new Error(`Recovery request ${response.status}`);
      requeued++;
    }
  }
  const channel=await sql`SELECT s.status,c.connection_status,c.health_state,now()-s.last_heartbeat_at AS heartbeat_age FROM whatsapp_web_sessions s JOIN channels c ON c.id=s.channel_id WHERE c.deleted_at IS NULL`;
  const report={checkedAt:new Date().toISOString(),playback,requeued,channel};
  writeFileSync('artifacts/chat-media-live.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally {await sql.end();}
