import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync, renameSync } from 'node:fs';
const folder='C:/ProgramData/Brixchat24/logs';
const checks=[];
for(const [name,url] of [['web','https://brixchat24.com/login'],['api','https://api.brixchat24.com/health/ready'],['worker','http://127.0.0.1:4110/health']]){
 try{
  const response=await fetch(url,{signal:AbortSignal.timeout(10000)});
  const body=name==='web'?null:await response.json();
  const dependencies=body?.dependencies;
  const coreHealthy=name==='web'?response.status===200:name==='api'?dependencies?.postgresql==='ok'&&dependencies?.redis?.healthy===true:dependencies?.postgresql?.healthy===true&&dependencies?.redis?.healthy===true&&dependencies?.workerLoop?.healthy===true;
  checks.push({name,status:response.status,coreHealthy,capabilityStatus:body?.status??'ok'});
 }catch{checks.push({name,coreHealthy:false,status:'unreachable'});}
}
const status=checks.every(c=>c.coreHealthy)?'core-ready':'failure';
const fingerprint=JSON.stringify({status,checks});
const path=folder+'/health-current.json';
let previous;
try{previous=JSON.parse(readFileSync(path,'utf8')).fingerprint;}catch{}
const report={checkedAt:new Date().toISOString(),status,checks,fingerprint};
writeFileSync(path,JSON.stringify(report,null,2));
if(previous!==fingerprint){
 const log=folder+'/health-events.log';
 if(existsSync(log)&&statSync(log).size>1024*1024){
   const backup=log+'.'+Date.now();renameSync(log,backup);
 }
 appendFileSync(log,JSON.stringify(report)+'\n');
}
console.log(JSON.stringify({status,checks}));
process.exitCode=status==='failure'?1:0;
