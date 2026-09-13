import { readFileSync, writeFileSync } from 'node:fs';
const credentials=JSON.parse(readFileSync('C:/ProgramData/Brixchat24/live/bootstrap.json','utf8'));
const api='https://api.brixchat24.com';
const origin='https://brixchat24.com';
const results=[];
const login=await fetch(api+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({email:'hsnyldrm-590@hotmail.com',password:credentials.ownerPassword})});
const body=await login.json();
results.push({check:'login',status:login.status,cors:login.headers.get('access-control-allow-origin'),secureCookie:login.headers.getSetCookie().some(v=>/; Secure/i.test(v))});
if(login.status!==200 || !body.data?.accessToken) throw new Error('Live login failed');
const token=body.data.accessToken;
for(const path of ['/api/v1/auth/me','/api/v1/channels','/api/v1/conversations','/api/v1/billing/overview','/api/v1/ai/settings','/api/v1/campaigns','/api/v1/campaigns/options']){
 const response=await fetch(api+path,{headers:{authorization:`Bearer ${token}`,origin}});
 results.push({check:path,status:response.status});
 await response.arrayBuffer();
}
const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
const refresh=await fetch(api+'/api/v1/auth/refresh',{method:'POST',headers:{'content-type':'application/json',origin,cookie},body:'{}'});
results.push({check:'refresh',status:refresh.status});
await refresh.arrayBuffer();
const cors=await fetch(api+'/api/v1/auth/me',{method:'OPTIONS',headers:{origin:'https://untrusted.example','access-control-request-method':'GET'}});
results.push({check:'untrusted-origin',status:cors.status,allowed:cors.headers.has('access-control-allow-origin')});
for(const url of [origin+'/login',origin+'/app/campaigns',api+'/health',api+'/health/ready','http://127.0.0.1:4110/health']){
 const r=await fetch(url);results.push({check:url,status:r.status,...(url.includes('/health')?{details:await r.json()}:{})});
}
writeFileSync('C:/ProgramData/Brixchat24/logs/live-verification.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results));
