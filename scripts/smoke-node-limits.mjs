#!/usr/bin/env node
// Public API acceptance on two isolated Docker nodes. Usage: node scripts/smoke-node-limits.mjs --image=<candidate> [--proof=<directory>]
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const image=process.argv.find(arg=>arg.startsWith('--image='))?.slice(8);
assert.ok(image&&/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image),'Pass --image=<built NineDeploy image>');
const dir=resolve(process.argv.find(arg=>arg.startsWith('--proof='))?.slice(8)??('.temp_files/node-limits-'+randomBytes(6).toString('hex')));
mkdirSync(dir,{recursive:true});
const label='nd-limits-fanout-'+randomBytes(5).toString('hex'), net=label+'-net', node=label+'-node', node2=label+'-node2', panelDocker=label+'-paneldocker', panel=label+'-panel', data=label+'-data', agentData=label+'-agentdata', agentData2=label+'-agentdata2';
const containers=[]; let hasNet=false,hasData=false,hasAgentData=false,hasAgentData2=false,base,token;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function docker(args,allow=false,options={}){const r=spawnSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:16<<20,...options});if(!allow)assert.equal(r.status,0,r.stderr||r.stdout||r.error?.message);return {...r,out:(r.stdout??'').trim()};}
const inside=(args,allow=false)=>docker(['exec',node,'docker',...args],allow);
const inside2=(args,allow=false)=>docker(['exec',node2,'docker',...args],allow);
const run=(name,args)=>{containers.push(name);return docker(['run','-d','--name',name,'--label','ninedeploy.proof='+label,...args]);};
async function until(fn,desc,ms=90000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await pause(500);}throw new Error('Timed out: '+desc);}
async function api(path,method='GET',body){const r=await fetch(base+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(120000)});const text=await r.text();assert.ok(r.ok,method+' '+path+': '+r.status+' '+text.slice(0,1000));return text?JSON.parse(text):null;}
async function transfer(destination,images){const a=spawn('docker',['save',...images],{windowsHide:true,stdio:['ignore','pipe','pipe']}),b=spawn('docker',['exec','-i',destination,'docker','load'],{windowsHide:true,stdio:['pipe','pipe','pipe']});a.stdout.pipe(b.stdin);a.stderr.resume();b.stdout.resume();b.stderr.resume();await Promise.all([a,b].map(p=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{p.kill();reject(Error('image transfer timed out'));},180000);p.on('error',reject);p.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('image transfer '+code));});})));}
async function transferFixture(fixture){const a=spawn('docker',['exec',node,'docker','save',fixture],{windowsHide:true,stdio:['ignore','pipe','pipe']}),b=spawn('docker',['exec','-i',node2,'docker','load'],{windowsHide:true,stdio:['pipe','pipe','pipe']});a.stdout.pipe(b.stdin);a.stderr.resume();b.stdout.resume();b.stderr.resume();await Promise.all([a,b].map(p=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{p.kill();reject(Error('fixture transfer timed out'));},180000);p.on('error',reject);p.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('fixture transfer '+code));});})));}
try{
  assert.equal(docker(['image','inspect',image],true).status,0,'Candidate image must already exist locally');
  for(const required of ['node:26-slim','registry:2','docker:28-dind'])if(docker(['image','inspect',required],true).status!==0)docker(['pull',required]);
  docker(['network','create','--label','ninedeploy.proof='+label,net]);hasNet=true;
  docker(['volume','create','--label','ninedeploy.proof='+label,data]);hasData=true;
  docker(['volume','create','--label','ninedeploy.proof='+label,agentData]);hasAgentData=true;
  docker(['volume','create','--label','ninedeploy.proof='+label,agentData2]);hasAgentData2=true;
  run(node,['--network',net,'--privileged','-v',agentData+':/var/lib/ninedeploy-agent','-e','DOCKER_TLS_CERTDIR=','docker:28-dind']);
  run(node2,['--network',net,'--privileged','-v',agentData2+':/var/lib/ninedeploy-agent','-e','DOCKER_TLS_CERTDIR=','docker:28-dind']);
  run(panelDocker,['--network',net,'--privileged','-v',data+':/data','-e','DOCKER_TLS_CERTDIR=','docker:28-dind']);
  await until(()=>inside(['info'],true).status===0,'isolated node Docker');
  await until(()=>inside2(['info'],true).status===0,'second isolated node Docker');
  await until(()=>docker(['exec',panelDocker,'docker','info'],true).status===0,'isolated panel Docker');
  console.log('Loading candidate image onto both isolated Docker nodes');
  await transfer(node,['node:26-slim','registry:2',image]); await transfer(node2,['registry:2',image]);
  const fixture='127.0.0.1:5000/nd-limits-app:'+label;
  inside(['run','-d','--name','nd-owned-registry','-p','127.0.0.1:5000:5000','registry:2']);
  await until(()=>docker(['exec',node,'wget','-qO-','-T','2','http://127.0.0.1:5000/v2/'],true).status===0,'fixture registry');
  const app="require('node:http').createServer((q,r)=>{r.statusCode=200;r.end('ready')}).listen(8080,'0.0.0.0')";
  docker(['exec','-i',node,'sh','-c','mkdir -p /tmp/nd-fixture; cat > /tmp/nd-fixture/Dockerfile'],false,{input:'FROM node:26-slim\nHEALTHCHECK NONE\nEXPOSE 8080\nCMD '+JSON.stringify(['node','-e',app])+'\n'});
  inside(['build','-t',fixture,'/tmp/nd-fixture']);inside(['push',fixture]);
  await transferFixture(fixture);
  inside2(['run','-d','--name','nd-owned-registry','-p','127.0.0.1:5000:5000','registry:2']);
  await until(()=>docker(['exec',node2,'wget','-qO-','-T','2','http://127.0.0.1:5000/v2/'],true).status===0,'second fixture registry');
  inside2(['push',fixture]);
  console.log('Starting panel and enrolling both sealed agents');
  const setup=randomBytes(24).toString('hex');
  run(panel,['--network',net,'--user','0','-p','127.0.0.1::3000','-v',data+':/data','-e','DOCKER_HOST=tcp://'+panelDocker+':2375',
    '-e','NINEDEPLOY_MASTER_KEY='+randomBytes(32).toString('hex'),'-e','NINEDEPLOY_JWT_SECRET='+randomBytes(32).toString('hex'),'-e','NINEDEPLOY_SETUP_TOKEN='+setup,
    '-e','NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1','-e','NINEDEPLOY_WILDCARD_DOMAIN=readiness.test',image]);
  base='http://127.0.0.1:'+docker(['port',panel,'3000/tcp']).out.split(':').at(-1);
  await until(async()=>{try{return(await fetch(base+'/health',{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}},'panel health',180000);
  token=(await api('/v1/auth/register','POST',{email:'limits@example.test',password:'Limits-fixture-only-2026!',name:'Limits proof',setupToken:setup})).tokens.accessToken;
  const address=docker(['inspect',node,'--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}']).out;
  const registration=await api('/v1/servers','POST',{name:'Isolated limits node',host:address,port:4600});
  const args=registration.agentCommand.split(' ').slice(1),slot=args.findIndex(arg=>arg.startsWith('ghcr.io/ninedeploy/ninedeploy:'));assert.ok(slot>0);args[slot]=image;
  args.splice(slot,0,'--label','ninedeploy.proof='+label);inside(args);
  await until(async()=>{try{return(await api('/v1/servers/'+registration.id+'/test','POST')).ok;}catch{return false;}},'sealed agent enrollment');
  const address2=docker(['inspect',node2,'--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}']).out;
  const registration2=await api('/v1/servers','POST',{name:'Second isolated limits node',host:address2,port:4600});
  const args2=registration2.agentCommand.split(' ').slice(1),slot2=args2.findIndex(arg=>arg.startsWith('ghcr.io/ninedeploy/ninedeploy:'));assert.ok(slot2>0);args2[slot2]=image;
  args2.splice(slot2,0,'--label','ninedeploy.proof='+label);inside2(args2);
  await until(async()=>{try{return(await api('/v1/servers/'+registration2.id+'/test','POST')).ok;}catch{return false;}},'second sealed agent enrollment');
  const created=await api('/v1/services','POST',{name:'Node limit acceptance',type:'docker',image:fixture,port:8080,serverId:registration.id}),id=created.id??created.service.id;
  await api('/v1/services/'+id,'PATCH',{replicas:2,healthCheck:'http-strict',healthPath:'/',healthTimeoutSeconds:60});
  await api('/v1/services/'+id+'/targets','PATCH',{serverIds:[registration2.id]});
  console.log('Deploying two primary replicas and one fan-out replica');
  const deploy=(await api('/v1/services/'+id+'/deploys','POST',{})).deploymentId;
  await until(async()=>{const rows=await api('/v1/services/'+id+'/deploys');const row=rows.find(x=>x.id===deploy);if(row?.status==='failed')throw Error('fixture deployment failed');return row?.status==='running';},'service deployment',180000);
  const svc=(await api('/v1/services/'+id)).service??await api('/v1/services/'+id),names=[svc.runtimeId,svc.runtimeId+'-r2'];
  for(const name of names)assert.equal(inside(['inspect',name,'--format','{{.State.Running}}']).out,'true');
  const targetName=svc.slug+'-t'+registration2.id+'-'+deploy;
  await until(()=>inside2(['inspect',targetName,'--format','{{.State.Running}}'],true).out==='true','target replica',90000);
  await until(async()=>{const state=await api('/v1/services/'+id+'/targets');const recovery=await api('/v1/services/'+id+'/targets/recovery');
    return state.targets.some(target=>target.serverId===registration2.id&&target.runtimeId===targetName&&target.status==='running')&&recovery.entries.length===0;},'target promotion and recovery completion',90000);
  // Match the panel form, which submits blank unlimited fields as null.
  const answer=await api('/v1/services/'+id+'/limits','PATCH',{cpuShares:null,cpuLimitMilli:null,memLimitMb:64});
  assert.equal(answer.liveApplied,true,JSON.stringify(answer));
  for(const name of names)assert.equal(Number(inside(['inspect',name,'--format','{{.HostConfig.Memory}}']).out),64*1048576);
  assert.equal(Number(inside2(['inspect',targetName,'--format','{{.HostConfig.Memory}}']).out),64*1048576);
  const result={realPublicApi:true,realWorker:true,sealedAgents:2,realDockerDaemons:2,replicas:3,liveApplied:true,publicDnsTls:'NOT RUN',passed:true};
  writeFileSync(dir+'/fanout-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
  const removed=[];for(const name of [...containers].reverse()){const r=docker(['inspect',name,'--format','{{index .Config.Labels "ninedeploy.proof"}}'],true);if(r.out===label){docker(['rm','-fv',name]);removed.push(name);}}
  for(const [name,created] of [[agentData2,hasAgentData2],[agentData,hasAgentData],[data,hasData]])if(created){assert.equal(docker(['volume','inspect',name,'--format','{{index .Labels "ninedeploy.proof"}}']).out,label);docker(['volume','rm',name]);}
  if(hasNet){assert.equal(docker(['network','inspect',net,'--format','{{index .Labels "ninedeploy.proof"}}']).out,label);docker(['network','rm',net]);}
  writeFileSync(dir+'/fanout-cleanup.json',JSON.stringify({removed,ownedContainersRemaining:docker(['ps','-aq','--filter','label=ninedeploy.proof='+label]).out},null,2));
}
