#!/usr/bin/env node
// Public node canary acceptance on isolated panel/node daemons. Keeps owned proof artifacts.
// Usage: node scripts/smoke-node-canary.mjs --image=<candidate> [--proof=<output directory>]
// Optional focused modes: --lifecycle-only, --replica-databases-only, --initial-stop-only, --mixed-agent-only, --autoscale-only, --autoscale-database-only.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { smokePublicNodeLifecycle } from './lib/smoke-public-node-lifecycle.mjs';
import { smokeNodeReplicaDatabases } from './lib/smoke-node-replica-databases.mjs';
import { smokeNodeAutoscale } from './lib/smoke-node-autoscale.mjs';
import { nodeReplicaDatabaseApp } from './fixtures/node-replica-database-app.mjs';
const lifecycleOnly=process.argv.includes('--lifecycle-only');
const replicaDatabasesOnly=process.argv.includes('--replica-databases-only');
const initialStopOnly=process.argv.includes('--initial-stop-only');
const mixedAgentOnly=process.argv.includes('--mixed-agent-only');
const autoscaleOnly=process.argv.includes('--autoscale-only');
const autoscaleDatabaseOnly=process.argv.includes('--autoscale-database-only');
const sqlFixture=replicaDatabasesOnly||autoscaleDatabaseOnly;
assert.ok([lifecycleOnly,replicaDatabasesOnly,initialStopOnly,mixedAgentOnly,autoscaleOnly,autoscaleDatabaseOnly].filter(Boolean).length<=1,'Select one focused smoke mode');
const image=process.argv.find(arg=>arg.startsWith('--image='))?.slice(8);
assert.ok(image&&/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image),'Pass --image=<built NineDeploy image>');
const agentImage=mixedAgentOnly?'ghcr.io/ninedeploy/ninedeploy:v0.18.10':image;
const proof=resolve(process.argv.find(arg=>arg.startsWith('--proof='))?.slice(8)??('.temp_files/node-canary-'+randomBytes(6).toString('hex')));
mkdirSync(proof,{recursive:true});
const AGENT_IMAGE_REPO='ghcr.io/ninedeploy/ninedeploy';
const suffix=randomBytes(4).toString('hex'),label=`node-canary-${suffix}`;
const net=`nd-node-canary-net-${suffix}`,daemon=`nd-node-canary-docker-${suffix}`,panel=`nd-node-canary-panel-${suffix}`,volume=`nd-node-canary-data-${suffix}`;
const panelDaemon=`nd-node-canary-paneldocker-${suffix}`,agentVolume=`nd-node-canary-agentdata-${suffix}`,agentHome="/var/lib/ninedeploy-agent";
const containers=[];let token,baseUrl,serviceId,networkCreated=false,volumeCreated=false,agentVolumeCreated=false;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function docker(args,{allowFailure=false,...opts}={}){const r=spawnSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:16<<20,...opts});if(!allowFailure)assert.equal(r.status,0,`${args.slice(0,3)}: ${r.stderr}`);return{...r,out:(r.stdout??'').trim()};}
const inner=(args,opts)=>docker(['exec',daemon,'docker',...args],opts);
const primary=(args,opts)=>docker(['exec',panelDaemon,'docker',...args],opts);
function run(name,args){containers.push(name);return docker(['run','-d','--name',name,'--label',`ninedeploy.proof=${label}`,...args]);}
async function until(fn,description,ms=90000){const end=Date.now()+ms;while(Date.now()<end){const r=await fn();if(r)return r;await pause(500);}throw Error(`Timed out: ${description}`);}
async function api(path,{method='GET',body,raw=false,expectedStatus}={}){
 const timeout=method==='POST'&&(path.endsWith('/runtime-recovery')||path==='/v1/databases')?90_000:15_000;
 let r;
 try{r=await fetch(baseUrl+path,{method,headers:{...(token?{authorization:`Bearer ${token}`}:{ }),...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});}
 catch(error){throw new Error(`${method} ${path} did not complete within its request budget`,{cause:error});}
 const text=await r.text();if(expectedStatus!==undefined)assert.equal(r.status,expectedStatus,`${method} ${path}: ${text.slice(0,1200)}`);else assert.ok(r.ok,`${method} ${path}: ${r.status} ${text.slice(0,1200)}`);return raw?text:text?JSON.parse(text):null;
}
async function seed(){const images=[...new Set(['node:26-slim',image,agentImage,'busybox:1.36','registry:2'])];const save=spawn('docker',['save',...images],{windowsHide:true,stdio:['ignore','pipe','pipe']}),load=spawn('docker',['exec','-i',daemon,'docker','load'],{windowsHide:true,stdio:['pipe','pipe','pipe']});save.stdout.pipe(load.stdin);save.stderr.resume();load.stdout.resume();load.stderr.resume();await Promise.all([save,load].map(p=>new Promise((r,j)=>{const timer=setTimeout(()=>{p.kill();j(Error('image transfer deadline'));},180000);p.on('error',j);p.on('close',c=>{clearTimeout(timer);c===0?r():j(Error(`image transfer ${c}`));});})));}
const service=async id=>{const r=await api(`/v1/services/${id}`);return r.service??r;};
const rows=id=>api(`/v1/services/${id}/deploys`);
const log=(id,dep)=>api(`/v1/services/${id}/deploys/${dep}/logs/download`,{raw:true});
async function success(id,dep){return until(async()=>{const row=(await rows(id)).find(r=>r.id===dep);if(row?.status==='failed')throw Error(await log(id,dep));if(row?.status!=='running')return false;return (await log(id,dep)).includes('✓ Deployment successful')?row:false;},`successful deployment ${dep}`,180000);}
try{
 console.log('Preparing isolated Docker daemon');
 docker(['network','create','--label',`ninedeploy.proof=${label}`,net]);networkCreated=true;
 docker(['volume','create','--label',`ninedeploy.proof=${label}`,volume]);volumeCreated=true;
 docker(['volume','create','--label',`ninedeploy.proof=${label}`,agentVolume]);agentVolumeCreated=true;
 run(daemon,['--network',net,'--privileged','-v',`${agentVolume}:${agentHome}`,'-e','DOCKER_TLS_CERTDIR=','docker:28-dind']);
 run(panelDaemon,['--network',net,'--privileged','-v',`${volume}:/data`,'-e','DOCKER_TLS_CERTDIR=','docker:28-dind']);
 await until(()=>docker(['exec',panelDaemon,'docker','info'],{allowFailure:true}).status===0,'Panel Docker daemon');
 await until(()=>inner(['info'],{allowFailure:true}).status===0,'Docker daemon');
 for(const required of new Set(['node:26-slim',image,agentImage,'busybox:1.36','registry:2']))if(docker(['image','inspect',required],{allowFailure:true}).status!==0)docker(['pull',required]);
 await seed();console.log('Lightweight HTTP fixture base loaded');
 const fixtureImage=`127.0.0.1:5000/nd-readiness-app:${suffix}`;
 inner(["run","-d","--name","nd-owned-registry","-p","127.0.0.1:5000:5000","registry:2"]);
 await until(()=>docker(["exec",daemon,"wget","-qO-","-T","2","http://127.0.0.1:5000/v2/"],{allowFailure:true}).status===0,"owned node registry");
 const code="const fs=require('node:fs');require('node:http').createServer((q,r)=>{const ready=(process.env.NEEDS_READINESS!=='1'||fs.existsSync('/tmp/nd-ready'))&&(!fs.existsSync('/tmp/nd-unready')||fs.readFileSync('/tmp/nd-unready','utf8')!=='1');const business=q.url!=='/ready'&&process.env.FAIL_BUSINESS==='1';r.statusCode=!ready||business?503:200;r.end(!ready?'booting':(process.env.RELEASE_LABEL||'old')"+(autoscaleOnly?"+':'+require('node:os').hostname()":"")+");}).listen(8080,'0.0.0.0')";
 docker(['exec','-i',daemon,'sh','-c','mkdir -p /tmp/readiness-fixture; cat > /tmp/readiness-fixture/Dockerfile'],{input:`FROM node:26-slim\nHEALTHCHECK NONE\nEXPOSE 8080\n${sqlFixture?'COPY app.cjs /app.cjs\n':''}CMD ${JSON.stringify(sqlFixture?['node','/app.cjs']:['node','-e',code])}\n`});
 if(sqlFixture)docker(['exec','-i',daemon,'sh','-c','cat > /tmp/readiness-fixture/app.cjs'],{input:nodeReplicaDatabaseApp()});
 inner(['build','-t',fixtureImage,'/tmp/readiness-fixture']);inner(['push',fixtureImage]);
 const saving=spawn('docker',['exec',daemon,'docker','save',fixtureImage],{windowsHide:true,stdio:['ignore','pipe','pipe']}),loading=spawn('docker',['exec','-i',panelDaemon,'docker','load'],{windowsHide:true,stdio:['pipe','pipe','pipe']});saving.stdout.pipe(loading.stdin);saving.stderr.resume();loading.stdout.resume();loading.stderr.resume();await Promise.all([saving,loading].map(p=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{p.kill();reject(Error('fixture image transfer deadline'));},180000);p.on('error',reject);p.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('fixture image transfer '+code));});})));
 primary(['run','-d','--name','nd-owned-registry','-p','127.0.0.1:5000:5000','registry:2']);await until(()=>docker(['exec',panelDaemon,'wget','-qO-','-T','2','http://127.0.0.1:5000/v2/'],{allowFailure:true}).status===0,'owned primary registry');primary(['push',fixtureImage]);
 const setup=randomBytes(24).toString('hex');
 run(panel,['--network',net,'--user','0','-p','127.0.0.1::3000','-v',`${volume}:/data`,'-e',`DOCKER_HOST=tcp://${panelDaemon}:2375`,'-e',`NINEDEPLOY_MASTER_KEY=${randomBytes(32).toString('hex')}`,'-e',`NINEDEPLOY_JWT_SECRET=${randomBytes(32).toString('hex')}`,'-e',`NINEDEPLOY_SETUP_TOKEN=${setup}`,'-e','NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1','-e','NINEDEPLOY_WILDCARD_DOMAIN=readiness.test',image]);
 baseUrl=`http://127.0.0.1:${docker(['port',panel,'3000/tcp']).out.split(':').at(-1)}`;
 await until(async()=>{try{return(await fetch(baseUrl+'/health',{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}},'panel health',180000);
 token=(await api('/v1/auth/register',{method:'POST',body:{email:'readiness@example.test',password:'Readiness-fixture-only-2026!',name:'Readiness proof',setupToken:setup}})).tokens.accessToken;
 const nodeIp=docker(['inspect',daemon,'--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}']).out;
 const registration=await api('/v1/servers',{method:'POST',body:{name:'Owned node routing proof',host:nodeIp,port:4600}});
 assert.ok(registration.id);assert.match(registration.tokenSha256,/^[a-f0-9]{64}$/);
 assert.ok(registration.agentCommand?.startsWith('docker run '));const args=registration.agentCommand.split(' ').slice(1);const imageSlot=args.findIndex(arg=>arg.startsWith(AGENT_IMAGE_REPO+':'));assert.ok(imageSlot>0);args[imageSlot]=agentImage;args.splice(imageSlot,0,'--label','ninedeploy.proof='+label,'-e','NINEDEPLOY_AGENT_PROXY_TRAFFIC=on');inner(args);assert.equal(inner(['inspect','ninedeploy-agent','--format','{{.HostConfig.NetworkMode}}']).out,'bridge');
 await until(async()=>{try{return(await api(`/v1/servers/${registration.id}/test`,{method:'POST'})).ok;}catch{return false;}},'sealed agent enrollment');
 const nodes=await api('/v1/servers');assert.ok(nodes.find(n=>n.id===registration.id)?.agent?.capabilities.includes('docker.readiness'));

 console.log('Panel and sealed agent enrolled; public canary lifecycle begins');
 const results=[];
 const created=await api('/v1/services',{method:'POST',body:{name:'R1 node canary',type:'docker',image:fixtureImage,port:8080,serverId:registration.id}});
 const id=created.id??created.service?.id;
 serviceId=id;
 await api('/v1/services/'+id,{method:'PATCH',body:{healthCheck:'http-strict',healthPath:'/ready',healthTimeoutSeconds:60}});
 if(lifecycleOnly||replicaDatabasesOnly)await api('/v1/services/'+id,{method:'PATCH',body:{replicas:2}});
 let replicaDatabase;
 if(sqlFixture){
   replicaDatabase=await api('/v1/databases',{method:'POST',body:{name:'R2 replica PostgreSQL',engine:'postgres',serverId:registration.id}});
   assert.ok(replicaDatabase.id);assert.equal(replicaDatabase.status,'running');
   await api(`/v1/services/${id}/attachments`,{method:'POST',body:{databaseId:replicaDatabase.id,envAlias:'DATABASE_URL'}});
 }
 const readyEnv=initialStopOnly||mixedAgentOnly?await api('/v1/services/'+id+'/env',{method:'POST',body:{key:'NEEDS_READINESS',value:'1'}}):null;
 const first=(await api('/v1/services/'+id+'/deploys',{method:'POST',body:{}})).deploymentId;
 if(mixedAgentOnly){
   const slug=(await service(id)).slug,name=`${slug}-${first}`;
   await until(async()=>{const row=(await rows(id)).find(item=>item.id===first);if(row?.status==='failed')throw Error(await log(id,first));return inner(['inspect',name,'--format','{{.State.Running}}'],{allowFailure:true}).out==='true'&&(await log(id,first)).includes('Running healthcheck');},'old agent unready runtime',180000);
   await api(`/v1/services/${id}/stop`,{method:'POST'});
   const held=await until(async()=>{const command=(await api(`/v1/services/${id}/lifecycle`)).command;return command?.reason?command:false;},'old agent held Stop',90000);
   assert.match(held.reason,/update.*0\.18\.11/i);assert.equal(held.phase,'fencing');
   assert.equal(inner(['inspect',name,'--format','{{.State.Running}}']).out,'true');
   assert.equal((await rows(id)).find(item=>item.id===first)?.status,'cancelled');
   results.push({case:'old-agent-initial-stop-held',agentImage,passed:true});
   writeFileSync(proof+'/runtime-result.json',JSON.stringify({realPublicApi:true,realWorker:true,standardBridgeAgent:true,mixedAgentOnly:true,cases:results,publicDnsTls:'NOT RUN',publication:false},null,2));
   console.log(JSON.stringify(results[0]));
 } else if(initialStopOnly){
   const slug=(await service(id)).slug;
   async function stopUnready(dep){
     const name=`${slug}-${dep}`;
     await until(async()=>{const row=(await rows(id)).find(item=>item.id===dep);if(row?.status==='failed')throw Error(await log(id,dep));return inner(['inspect',name,'--format','{{.State.Running}}'],{allowFailure:true}).out==='true'&&(await log(id,dep)).includes('Running healthcheck');},`unready initial runtime ${dep}`,180000);
     await api(`/v1/services/${id}/stop`,{method:'POST'});
     await until(async()=>{const command=(await api(`/v1/services/${id}/lifecycle`)).command;if(command?.phase==='completed')return true;if(command?.reason)throw Error(`Initial Stop held: ${command.reason}`);return false;},`initial Stop ${dep}`,90000);
     assert.equal((await rows(id)).find(item=>item.id===dep)?.status,'cancelled');
     assert.equal(inner(['inspect',name,'--format','{{.State.Running}}'],{allowFailure:true}).out,'false');
   }
   await stopUnready(first);
   const second=(await api(`/v1/services/${id}/deploys`,{method:'POST',body:{}})).deploymentId;
   await stopUnready(second);
   assert.ok(readyEnv?.id);
   await api(`/v1/services/${id}/env/${readyEnv.id}`,{method:'PATCH',body:{key:'NEEDS_READINESS',value:'0'}});
   const final=(await api(`/v1/services/${id}/deploys`,{method:'POST',body:{}})).deploymentId;
   await success(id,final);
   assert.equal((await service(id)).status,'running');
   results.push({case:'initial-stop-redeploy-twice',first,second,final,passed:true});
   writeFileSync(proof+'/runtime-result.json',JSON.stringify({realPublicApi:true,realWorker:true,standardBridgeAgent:true,initialStopOnly:true,cases:results,publicDnsTls:'NOT RUN',publication:false},null,2));
   console.log(JSON.stringify(results[0]));
 } else {
 if(replicaDatabasesOnly){
   const slug=(await service(id)).slug,names=[`${slug}-${first}`,`${slug}-${first}-r2`];
   await until(async()=>{const job=(await rows(id)).find(row=>row.id===first);if(job?.status==='failed')throw Error(await log(id,first));return names.every(name=>inner(['inspect',name,'--format','{{.State.Running}}'],{allowFailure:true}).out==='true')&&(await log(id,first)).includes('Running healthcheck');},'SQL fixture containers and completed bridge attachment',120_000);
   const initial=names.map(name=>({name,networks:Object.keys(JSON.parse(inner(['inspect',name,'--format','{{json .NetworkSettings.Networks}}']).out)),sql:JSON.parse(inner(['exec',name,'node','-e',"fetch('http://127.0.0.1:8080/ready').then(async r=>console.log(JSON.stringify({status:r.status,...await r.json()})))"]).out)}));
   writeFileSync(proof+'/initial-sql.json',JSON.stringify(initial,null,2));console.log(JSON.stringify({initialSql:initial}));
 }
 await success(id,first);
 const domain=(await api('/v1/services/'+id+'/domains'))[0];assert.ok(domain?.hostname);
 const state=()=>api(`/v1/services/${id}/canary`);
 const recovery=()=>api(`/v1/services/${id}/runtime-recovery`);
 const cfg=steps=>({steps,stepSeconds:30,minRequests:20,maxErrorRate:5,maxP95Ms:null});
 const alive=runtime=>inner(['inspect',runtime,'--format','{{.State.Running}}'],{allowFailure:true}).out==='true';
 const absent=runtime=>inner(['inspect',runtime],{allowFailure:true}).status!==0;
 const identity=runtime=>inner(['inspect',runtime,'--format','{{.Id}}']).out;
 const envIds=new Map();
 const env=async(key,value)=>{
   const existing=envIds.get(key);
   const row=await api(`/v1/services/${id}/env${existing?'/'+existing:''}`,{method:existing?'PATCH':'POST',body:{key,value}});
   assert.ok(Number.isSafeInteger(row.id));envIds.set(key,row.id);return row;
 };
 const report=entry=>{results.push(entry);writeFileSync(proof+'/cases.json',JSON.stringify(results,null,2));console.log(JSON.stringify(entry));};
 async function cleared(){
   await until(async()=>{const r=await recovery();if(!r.entry)return true;if(!r.entry.busy)await api(`/v1/services/${id}/runtime-recovery`,{method:'POST'});return false;},'safe journal closure',180000);
 }
 async function startCase(name,{steps=[50],hold=false,business=false}={}){
   await cleared();
   const old=await service(id),oldId=identity(old.runtimeId);
   const oldLabel=inner(['inspect',old.runtimeId,'--format','{{range .Config.Env}}{{println .}}{{end}}']).out.split('\n').find(x=>x.startsWith('RELEASE_LABEL='))?.slice(14)??'old';
   await api(`/v1/services/${id}`,{method:'PATCH',body:{canary:cfg(steps)}});
   await env('RELEASE_LABEL',name);await env('NEEDS_READINESS',hold?'1':'0');await env('FAIL_BUSINESS',business?'1':'0');
   const trafficCode="const http=require('node:http');const records=[];let stopped=false;async function tick(){if(stopped)return;try{records.push(await new Promise((resolve,reject)=>{const q=http.request({hostname:'ninedeploy-proxy',port:80,path:'/',headers:{host:"+JSON.stringify(domain.hostname)+"}},r=>{let body='';r.on('data',c=>body+=c);r.on('end',()=>resolve({at:Date.now(),status:r.statusCode,body}));});q.setTimeout(1500,()=>q.destroy(Error('timeout')));q.on('error',reject);q.end();}));}catch(e){records.push({at:Date.now(),error:e.message});}setTimeout(tick,50);}process.on('SIGTERM',()=>{stopped=true;require('node:fs').writeFileSync('/tmp/r1-traffic.json',JSON.stringify(records));process.exit(0);});tick();";
   const client='nd-r1-traffic-'+name+'-'+suffix;
   inner(['run','-d','--name',client,'--network','ninedeploy','--entrypoint','node',fixtureImage,'-e',trafficCode]);
   const dep=(await api(`/v1/services/${id}/deploys`,{method:'POST',body:{}})).deploymentId,candidate=old.slug+'-'+dep;
   return {name,old,oldId,oldLabel,dep,candidate,client};
 }
 async function candidate(c){
   await until(async()=>{if(alive(c.candidate))return true;const row=(await rows(id)).find(r=>r.id===c.dep);if(row?.status==='failed')throw Error(await log(id,c.dep));return false;},'candidate '+c.name,120000);
   c.candidateId=identity(c.candidate);
 }
 async function measured(c){
   await candidate(c);
   return until(async()=>{const s=await state();if(s.active&&s.deploymentId===c.dep&&s.step===1&&/stage:CANARY:running.*Step 1/.test(await log(id,c.dep)))return s;const row=(await rows(id)).find(r=>r.id===c.dep);if(['failed','cancelled'].includes(row?.status))throw Error(await log(id,c.dep));return false;},'measured canary '+c.name,120000);
 }
 async function traffic(c,allowBusiness=false){
   inner(['stop','-t','5',c.client]);
   // DinD mounts /tmp itself; the outer archive API cannot see that tmpfs.
   // Read the nested archive from the live daemon namespace instead.
   const payload=docker(['exec',daemon,'sh','-c','set -eo pipefail; docker cp "$1:/tmp/r1-traffic.json" - | tar -xOf -','sh',c.client]).out;
   const records=JSON.parse(payload);writeFileSync(resolve(proof,c.name+'-traffic.json'),payload);
   assert.ok(records.length>=20);assert.equal(records.filter(r=>r.error||(r.status!==200&&!(allowBusiness&&r.status===503&&r.body===c.name))).length,0);
   if(allowBusiness){assert.ok(records.some(r=>r.status===503&&r.body===c.name));assert.ok(records.some(r=>r.status===200&&r.body===c.oldLabel));}
   return {requests:records.length,errors:records.filter(r=>r.error||r.status!==200).length,intentionallyInjected5xx:allowBusiness};
 }
 async function stable(c){
   assert.equal((await service(id)).runtimeId,c.old.runtimeId);assert.ok(alive(c.oldId));assert.ok(absent(c.candidateId??c.candidate));
   const code="const http=require('node:http');(async()=>{for(let i=0;i<100;i++){const r=await new Promise((resolve,reject)=>{const q=http.request({hostname:'ninedeploy-proxy',port:80,path:'/',headers:{host:"+JSON.stringify(domain.hostname)+"}},r=>{let body='';r.on('data',c=>body+=c);r.on('end',()=>resolve({status:r.statusCode,body}));});q.setTimeout(2000,()=>q.destroy(Error('timeout')));q.on('error',reject);q.end();});if(r.status!==200||r.body!=="+JSON.stringify(c.oldLabel)+")throw Error(JSON.stringify(r));}console.log('100 stable requests passed');})().catch(e=>{console.error(e.message);process.exitCode=1;});";
   assert.match(inner(['run','--rm','--network','ninedeploy','--entrypoint','node',fixtureImage,'-e',code]).out,/100 stable requests passed/);
 }
 async function rejected(c,pattern){
   await until(async()=>{const row=(await rows(id)).find(r=>r.id===c.dep);if(row?.status==='running')throw Error('Rejected candidate was promoted');return row?.status==='failed';},'rejected '+c.name,120000);
   const text=await log(id,c.dep);assert.match(text,pattern);writeFileSync(proof+'/'+c.name+'-deploy.log',text);
   await cleared();await stable(c);
 }
 async function restartAgent(enabled){
   inner(['rm','-f','ninedeploy-agent']);const next=[...args];const opt=next.indexOf('NINEDEPLOY_AGENT_PROXY_TRAFFIC=on');assert.ok(opt>=0);next[opt]='NINEDEPLOY_AGENT_PROXY_TRAFFIC='+(enabled?'on':'off');inner(next);
   await until(async()=>{try{return(await api(`/v1/servers/${registration.id}/test`,{method:'POST'})).ok;}catch{return false;}},'agent restart',30000);
 }
 const generation=()=>{
   const output=inner(['exec','ninedeploy-proxy','sh','-c',"wget -qSO- -T 2 --header 'Host: ninedeploy-routing.invalid' http://127.0.0.1/api/rawdata 2>&1"]).out;
   const value=/X-NineDeploy-Generation:\s*([a-f0-9]{64})/i.exec(output)?.[1];assert.ok(value);return value;
 };

 if(autoscaleOnly||autoscaleDatabaseOnly){
   await smokeNodeAutoscale({api,inner,id,fixtureImage,service,domain,until,report,cleared,success,database:replicaDatabase,
     scaleSettled:()=>docker(['exec',panel,'node','--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.env.NINEDEPLOY_DB_PATH,{readOnly:true});console.log(d.prepare('SELECT count(*) AS n FROM node_autoscale_transitions WHERE service_id=?').get(${id}).n);d.close();`],{allowFailure:true}).out==='0',
     saveTraffic:records=>writeFileSync(resolve(proof,'autoscale-traffic.json'),JSON.stringify(records))});
 }else if(replicaDatabasesOnly){
   await smokeNodeReplicaDatabases({api,inner,id,first,fixtureImage,service,domain,database:replicaDatabase,until,pause,report,cleared,env});
 }else if(lifecycleOnly){
   await smokePublicNodeLifecycle({api,inner,docker,panel,args,id,first,fixtureImage,service,domain,until,pause,report,cleared,
     updatePanelUrl:()=>{baseUrl='http://127.0.0.1:'+docker(['port',panel,'3000/tcp']).out.split(':').at(-1);}});
 }else{
 // Hold a real 503 readiness response, then exercise a harmless concurrent domain refresh.
 {
   const c=await startCase('healthy',{hold:true});await candidate(c);
   assert.equal(inner(['exec',c.candidate,'node','-e',"fetch('http://127.0.0.1:8080/ready').then(r=>console.log(r.status))"]).out,'503');
   await pause(4000);assert.equal((await state()).active,false);assert.equal((await service(id)).runtimeId,c.old.runtimeId);assert.ok(alive(c.oldId));
   inner(['exec',c.candidate,'node','-e',"require('node:fs').writeFileSync('/tmp/nd-ready','ready')"]);
   const s=await measured(c),before=generation();
   await api(`/v1/services/${id}/domains/${domain.id}`,{method:'PATCH',body:{ssl:domain.ssl}});
   assert.equal(generation(),before);
   await success(id,c.dep);assert.ok(Date.now()-Date.parse(s.stepStartedAt)>=30000);assert.equal((await service(id)).runtimeId,c.candidate);assert.ok(absent(c.oldId));
   await cleared();report({case:c.name,realApiWorker:true,http503Held:true,ordinaryRefreshPreservedGeneration:true,elapsedMs:Date.now()-Date.parse(s.stepStartedAt),...await traffic(c)});
 }
 // Readiness remains 200 while actual business responses are rejected by measured traffic.
 {
   const c=await startCase('business-failure',{business:true});await measured(c);
   assert.equal(inner(['exec',c.candidate,'node','-e',"fetch('http://127.0.0.1:8080/ready').then(r=>console.log(r.status))"]).out,'200');
   await rejected(c,/requests failed|5xx/);report({case:c.name,measuredRollback:true,stableAfterRollback:100,...await traffic(c,true)});
 }
 // An early promote request must still finish and pass the current measured window.
 {
   const c=await startCase('promoted',{steps:[25,50]}),s=await measured(c);
   await api(`/v1/services/${id}/deploys/${c.dep}/canary/promote`,{method:'POST'});await pause(3000);
   assert.notEqual((await service(id)).runtimeId,c.candidate);assert.ok((await state()).active);
   await success(id,c.dep);const text=await log(id,c.dep);assert.match(text,/waits for the current measured step/);assert.doesNotMatch(text,/stage:CANARY:running.*Step 2/);
   assert.ok(Date.now()-Date.parse(s.stepStartedAt)>=30000);assert.ok(absent(c.oldId));await cleared();
   report({case:c.name,fullMeasuredStep:true,remainingStepSkipped:true,elapsedMs:Date.now()-Date.parse(s.stepStartedAt),...await traffic(c)});
 }
 // A changed loaded generation invalidates the old measurement and rolls back safely.
 {
   const c=await startCase('changed-generation');await measured(c);
   const before=generation();
   await api(`/v1/services/${id}/domains/${domain.id}`,{method:'PATCH',body:{headers:JSON.stringify([{name:'X-R1-Proof',value:'changed'}])}});
   assert.notEqual(generation(),before,'The fixture must actually load a different generation');
   await rejected(c,/observation unavailable|traffic unavailable|not confirmed/i);report({case:c.name,staleVerdictRefused:true,stableAfterRollback:100,...await traffic(c)});
 }
 // Unconfirmed rollback must retain both immutable generations until safe reconciliation.
 {
   const c=await startCase('unknown-rollback');await measured(c);
   const blocker='http:\n  routers:\n    r1-block-confirmation:\n      rule: "Host(`ninedeploy-routing.invalid`) && Path(`/api/rawdata`)"\n      entryPoints: [web]\n      priority: 2000000\n      service: noop@internal\n';
   const path=agentHome+'/.agent-proxy/dynamic/owned-r1-confirmation-blocker.yml';
   docker(['exec','-i',daemon,'sh','-c','cat > "$1"','sh',path],{input:blocker});await pause(2500);
   await until(async()=> (await rows(id)).find(row=>row.id===c.dep)?.status==='failed','unconfirmed rollback retains generations',120000);
   assert.ok(alive(c.oldId));assert.ok(alive(c.candidateId));assert.ok((await recovery()).entry);
   const text=await log(id,c.dep);assert.match(text,/rollback.*not confirmed|both runtime generations|both generations/i);
   writeFileSync(proof+'/'+c.name+'-deploy.log',text);
   docker(['exec',daemon,'rm','-f',path]);await cleared();await stable(c);
   report({case:c.name,bothImmutableGenerationsRetained:true,confirmedRecoveryBeforeRetirement:true,stableAfterRecovery:100,...await traffic(c)});
 }
 // Agent restart loses the observation epoch; no old measurement can be accepted.
 {
   const c=await startCase('lost-source');await measured(c);await restartAgent(false);
   await rejected(c,/observation|traffic|agent/i);report({case:c.name,sourceLossRejected:true,stableAfterRollback:100,...await traffic(c)});await restartAgent(true);
 }
 // Explicit cancellation during readiness must remove only the candidate.
 {
   const c=await startCase('cancel-readiness',{hold:true});await candidate(c);
   await api(`/v1/services/${id}/deploys/${c.dep}/cancel`,{method:'POST'});
   await until(()=>absent(c.candidate),'cancelled unready candidate removed',30000);await cleared();await stable(c);
   assert.equal((await rows(id)).find(r=>r.id===c.dep)?.status,'cancelled');report({case:c.name,cancellationPreserved:true,stableAfterRollback:100,...await traffic(c)});
 }
 // Cancellation after the split has actually loaded must restore the previous route.
 {
   const c=await startCase('cancel-active');await measured(c);await api(`/v1/services/${id}/deploys/${c.dep}/cancel`,{method:'POST'});
   await until(()=>absent(c.candidate),'cancelled measured candidate removed',60000);await cleared();await stable(c);
   assert.equal((await rows(id)).find(r=>r.id===c.dep)?.status,'cancelled');report({case:c.name,confirmedRollback:true,stableAfterRollback:100,...await traffic(c)});
 }
 // Disabled node-owner opt-in refuses the deploy before any new container exists.
 {
   await restartAgent(false);const c=await startCase('owner-disabled');
   await rejected(c,/proxy traffic|observe|canary|Update the node agent/i);assert.ok(absent(c.candidate));
   report({case:c.name,noCandidateStarted:true,stableAfterRefusal:100,...await traffic(c)});await restartAgent(true);
 }
 // A killed panel must recover the durable stable intent, without replaying an in-memory canary.
 {
   const c=await startCase('panel-crash');await measured(c);const before=await recovery();assert.equal(before.entry.desiredRuntimeId,c.old.runtimeId);
   const crashAt=Date.now();docker(['kill',panel]);docker(['start',panel]);
   baseUrl='http://127.0.0.1:'+docker(['port',panel,'3000/tcp']).out.split(':').at(-1);
   await until(async()=>{try{return(await fetch(baseUrl+'/health',{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}},'panel crash restart',90000);
   assert.equal((await state()).active,false);assert.ok(alive(c.oldId));assert.ok(alive(c.candidateId));
   const after=await recovery();assert.ok(after.entry.interrupted);assert.ok(after.entry.busy);
   const retry=await api(`/v1/services/${id}/runtime-recovery`,{method:'POST'});assert.equal(retry.recovered,0);assert.ok(retry.entry.busy);
   await until(async()=>!(await recovery()).entry,'automatic crashed canary recovery',240000);
   await stable(c);assert.equal((await rows(id)).find(r=>r.id===c.dep)?.status,'failed');
   report({case:c.name,hardCrash:true,activeLeaseNotStolen:true,automaticStableRecovery:true,elapsedMs:Date.now()-crashAt,stableAfterRecovery:100,...await traffic(c)});
 }
 // Stop is intentionally an outage; finish traffic sampling before the explicit stop.
 {
   const c=await startCase('explicit-stop');await measured(c);const sampled=await traffic(c);
   await api(`/v1/services/${id}/stop`,{method:'POST'});
   await until(()=>absent(c.candidate),'stopped candidate removed',60000);await cleared();await pause(6000);
   assert.equal((await service(id)).status,'stopped');assert.equal(alive(c.oldId),false);
   assert.equal((await rows(id)).find(r=>r.id===c.dep)?.status,'cancelled');
   report({case:c.name,stopRemainedAuthoritative:true,noAutomaticRevival:true,trafficSamplingEndsBeforeStop:true,...sampled});
 }
 }
 const result={realPublicApi:true,realWorker:true,standardBridgeAgent:true,ownerOptIn:true,lifecycleOnly,replicaDatabasesOnly,autoscaleOnly,autoscaleDatabaseOnly,cases:results,requests:results.reduce((n,r)=>n+(r.requests??0),0),unexpected502:0,publicDnsTls:'NOT RUN; isolated Host-header HTTP fixtures',publication:false};
 writeFileSync(proof+'/runtime-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }
}catch(e){
 try{
   if(serviceId&&baseUrl&&token){
     const service=await api(`/v1/services/${serviceId}`),deployments=await api(`/v1/services/${serviceId}/deploys`),lifecycle=await api(`/v1/services/${serviceId}/lifecycle`);
     writeFileSync(proof+'/failure-state.json',JSON.stringify({
       serviceStatus:(service.service??service).status,
       deployments:deployments.map(({id,status})=>({id,status})),
       lifecycle:lifecycle.command?{id:lifecycle.command.id,action:lifecycle.command.action,phase:lifecycle.command.phase}:null,
     },null,2));
   }
 }catch{/* Diagnostics must never hide the original failure. */}
 try{
   if(docker(['inspect',daemon,'--format','{{index .Config.Labels "ninedeploy.proof"}}'],{allowFailure:true}).out===label){
     if((autoscaleOnly||autoscaleDatabaseOnly)&&serviceId){
       const trace=inner(['exec',`nd-autoscale-client-${serviceId}`,'node','-e',"fetch('http://127.0.0.1:8091/snapshot').then(r=>r.text()).then(console.log)"],{allowFailure:true});
       if(trace.status===0)writeFileSync(resolve(proof,'autoscale-failure-traffic.json'),trace.stdout);
     }
     const clients=inner(['ps','-a','--filter','name=nd-r1-traffic-','--format','{{.Names}}'],{allowFailure:true}).out.split('\n').filter(name=>/^[a-z0-9-]+$/.test(name)&&name.endsWith('-'+suffix)).slice(0,16);
     for(const name of clients){
       inner(['stop','-t','5',name],{allowFailure:true});
       const records=docker(['exec',daemon,'sh','-c','set -eo pipefail; docker cp "$1:/tmp/r1-traffic.json" - | tar -xOf -','sh',name],{allowFailure:true});
       if(records.status===0)writeFileSync(resolve(proof,name+'-failure-traffic.json'),records.stdout);
     }
   }
 }catch{/* Preserve the original failure even if diagnostics cannot be collected. */}
 for(const name of containers){if(docker(['inspect',name],{allowFailure:true}).status===0){const r=docker(['logs','--tail','120',name],{allowFailure:true});writeFileSync(proof+'/'+name+'.log',`${r.stdout}\n${r.stderr}`);}}
 const proxyLog=inner(['logs','--tail','100','ninedeploy-proxy'],{allowFailure:true});writeFileSync(proof+'/traefik.log',`${proxyLog.stdout}\n${proxyLog.stderr}`);const inspect=inner(['ps','-a','--format','{{.Names}} {{.Status}}'],{allowFailure:true});writeFileSync(proof+'/inner-containers.log',`${inspect.stdout}\n${inspect.stderr}`);throw e;
}
finally{
 const removed=[];for(const name of [...containers].reverse()){const owned=docker(['inspect',name,'--format','{{index .Config.Labels "ninedeploy.proof"}}'],{allowFailure:true});if(owned.out===label){docker(['rm','-fv',name]);removed.push(name);}}
 if(agentVolumeCreated){assert.equal(docker(['volume','inspect',agentVolume,'--format','{{index .Labels "ninedeploy.proof"}}']).out,label);docker(['volume','rm',agentVolume]);}
 if(volumeCreated){assert.equal(docker(['volume','inspect',volume,'--format','{{index .Labels "ninedeploy.proof"}}']).out,label);docker(['volume','rm',volume]);}
 if(networkCreated){assert.equal(docker(['network','inspect',net,'--format','{{index .Labels "ninedeploy.proof"}}']).out,label);docker(['network','rm',net]);}
 writeFileSync(proof+'/runtime-cleanup.json',JSON.stringify({removed,volumeRemoved:volumeCreated,agentVolumeRemoved:agentVolumeCreated,networkRemoved:networkCreated},null,2));
}
