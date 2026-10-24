#!/usr/bin/env node
// Real database client smoke: isolated Docker daemons and disposable databases only.
// node scripts/smoke-database-clients.mjs --image=<candidate> [--case=postgres|engines] [--engine=keydb]
import {resolve} from 'node:path';
import {postgresClientProof} from './fixtures/database-client-postgres.mjs';
import {otherDatabaseClientProof} from './fixtures/database-client-engines.mjs';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const image=process.argv.find(a=>a.startsWith('--image='))?.slice(8), selectedCase=process.argv.find(a=>a.startsWith('--case='))?.slice(7)??'all';
assert.ok(image,'Pass --image=<built candidate>');assert.match(image,/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/,'Use a Docker image reference');assert.ok(['all','postgres','engines'].includes(selectedCase),'Unknown smoke case');
const proof=resolve('.temp_files','database-client-smoke-'+randomBytes(6).toString('hex'));
mkdirSync(proof,{recursive:true});
const suffix=randomBytes(4).toString('hex'),label='node-volume-tools-'+suffix,net='nd-vtools-net-'+suffix,manager='nd-vtools-manager-'+suffix,worker='nd-vtools-worker-'+suffix,panel='nd-vtools-panel-'+suffix,agent='nd-vtools-agent-'+suffix,data='nd-vtools-data-'+suffix,agentData='nd-vtools-agentdata-'+suffix;
const containers=[],volumes=[];let network=false,baseUrl,token,registration;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function docker(args,{allow=false,...opts}={}){const r=spawnSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:16<<20,...opts});if(!allow)assert.equal(r.status,0,args.slice(0,3).join(' ')+': '+r.stderr);return{...r,out:(r.stdout??'').trim()};}
const m=(args,opts)=>docker(['exec',manager,'docker',...args],opts),w=(args,opts)=>docker(['exec',worker,'docker',...args],opts);
function run(name,args){containers.push(name);return docker(['run','-d','--name',name,'--label','ninedeploy.proof='+label,...args]);}
async function until(fn,why,ms=180000){const end=Date.now()+ms;while(Date.now()<end){const result=await fn();if(result)return result;await pause(250);}throw Error('Deadline '+why);}
async function request(path,{method='GET',body,allow=false}={}){const r=await fetch(baseUrl+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(150000)});const text=await r.text(),value=text?JSON.parse(text):null;if(!allow)assert.ok(r.ok,method+' '+path+': '+r.status+' '+text.slice(0,1000));return{status:r.status,body:value};}
const api=async(path,options)=>(await request(path,options)).body;
const pass='Owned-volume-fixture-only-2026!';
function startAgent(targetImage=image,disabled=false){run(agent,['--network','container:'+worker,'--user','0:0','-v',agentData+':/var/lib/ninedeploy-agent','-w','/var/lib/ninedeploy-agent','-e','NINEDEPLOY_AGENT=1','-e','NINEDEPLOY_AGENT_PORT=4600','-e','NINEDEPLOY_AGENT_TOKEN='+registration.tokenSha256,'-e','DOCKER_HOST=tcp://127.0.0.1:2375',...(disabled?['-e','NINEDEPLOY_AGENT_DATABASE_CLIENTS=off']:[]),targetImage,'node','/app/apps/server/dist/agent.js']);}
function replaceAgent(targetImage,disabled=false){assert.equal(docker(['inspect',agent,'--format','{{index .Config.Labels "ninedeploy.proof"}}']).out,label);docker(['rm','-fv',agent]);startAgent(targetImage,disabled);}
async function connected(){await until(async()=>{try{return(await api('/v1/servers/'+registration.id+'/test',{method:'POST'})).ok;}catch{return false;}},'sealed agent');}
try{
 docker(['network','create','--label','ninedeploy.proof='+label,net]);network=true;
 for(const volume of [data,agentData]){docker(['volume','create','--label','ninedeploy.proof='+label,volume]);volumes.push(volume);}
 run(manager,['--network',net,'--privileged','-v',data+':/data','-e','DOCKER_TLS_CERTDIR=','docker:28-dind']);
 run(worker,['--network',net,'--privileged','-v',agentData+':/var/lib/ninedeploy-agent','-e','DOCKER_TLS_CERTDIR=','docker:28-dind']);
 await until(()=>m(['info'],{allow:true}).status===0&&w(['info'],{allow:true}).status===0,'two independent daemons');
 const workerIp=docker(['inspect',worker,'--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}']).out,setup=randomBytes(24).toString('hex');
 run(panel,['--network',net,'--user','0','-p','127.0.0.1::3000','-v',data+':/data','-e','DOCKER_HOST=tcp://'+manager+':2375','-e','NINEDEPLOY_MASTER_KEY='+randomBytes(32).toString('hex'),'-e','NINEDEPLOY_JWT_SECRET='+randomBytes(32).toString('hex'),'-e','NINEDEPLOY_SETUP_TOKEN='+setup,'-e','NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1',image]);
 baseUrl='http://127.0.0.1:'+docker(['port',panel,'3000/tcp']).out.split(':').at(-1);
 await until(async()=>{try{return(await fetch(baseUrl+'/health',{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}},'panel');
 token=(await api('/v1/auth/register',{method:'POST',body:{email:'client@example.test',password:pass,name:'Node database client proof',setupToken:setup}})).tokens.accessToken;
 registration=await api('/v1/servers',{method:'POST',body:{name:'Owned client node',host:workerIp,port:4600}});startAgent(selectedCase==='engines'?image:'ghcr.io/ninedeploy/ninedeploy:v0.17.1');await connected();
 const context={api,request,m,w,docker,until,pause,replaceAgent,connected,baseUrl,token,registration,image,proof,label,suffix,panel,agent,manager,worker},results={};
 if(selectedCase!=='engines')results.postgres=await postgresClientProof(context);
 if(selectedCase!=='postgres')results.otherEngines=await otherDatabaseClientProof(context);
 const result={allRequestedPassed:true,fullEngineSetChecked:selectedCase==='all'&&!process.argv.some(a=>a.startsWith('--engine=')),nodeRuntime:docker(['exec',panel,'node','--version']).out,results,releaseReady:false};
 writeFileSync(proof+'/runtime-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify({proof,...result}));
}catch(error){for(const name of containers){const r=docker(['logs','--tail','80',name],{allow:true});writeFileSync(proof+'/'+name+'.log',(r.stdout??'')+'\n'+(r.stderr??''));}throw error;
}finally{const removed=[];for(const name of [...containers].reverse()){const owner=docker(['inspect',name,'--format','{{index .Config.Labels "ninedeploy.proof"}}'],{allow:true});if(owner.status===0&&owner.out===label){docker(['rm','-fv',name]);removed.push(name);}}for(const volume of volumes){assert.equal(docker(['volume','inspect',volume,'--format','{{index .Labels "ninedeploy.proof"}}']).out,label);docker(['volume','rm',volume]);}if(network){assert.equal(docker(['network','inspect',net,'--format','{{index .Labels "ninedeploy.proof"}}']).out,label);docker(['network','rm',net]);}writeFileSync(proof+'/runtime-cleanup.json',JSON.stringify({removed,volumes,networkRemoved:network},null,2));}
