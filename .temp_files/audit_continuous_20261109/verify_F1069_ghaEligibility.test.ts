import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { DB, GithubApp, GithubAppInstallation } from '@ninedeploy/db';
import { GITHUB_RUNNER_DEFAULTS } from '@ninedeploy/schemas';
const h = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY']='ab'.repeat(32);
  return { capture:vi.fn<(command:string,args:string[],opts?:unknown)=>Promise<string>>(),githubApi:vi.fn(),full:true };
});
vi.mock('node:fs',async orig=>{const fs=await orig<typeof import('node:fs')>();return {...fs,existsSync:(p:Parameters<typeof fs.existsSync>[0])=>String(p)==='/sys/class/net/nd-gha0'||fs.existsSync(p)};});
vi.mock('../../apps/server/src/lib/exec.js',async orig=>({...await orig<object>(),capture:h.capture}));
vi.mock('../../apps/server/src/lib/githubApp.js',async orig=>({...await orig<object>(),githubApi:h.githubApi,installationToken:vi.fn(async()=> 'synthetic-token')}));
const {drainPending,handleWorkflowJob,resetGithubRunnersForTests,setRunnerConfig}=await import('../../apps/server/src/lib/githubRunners.js');
const {closeMigratedDb,migratedDb,rsaKeyPair,seedApp,seedInstallation}=await import('../../apps/server/test/lib/githubAppKit.js');
let db:DB;let app:GithubApp;let inst:GithubAppInstallation;let jitHook:(()=>Promise<void>)|undefined;
const log={info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()} as unknown as FastifyBaseLogger;
const queued=(id:number,action='queued')=>({action,workflow_job:{id,name:`job-${id}`,labels:['self-hosted','ninedeploy']},repository:{id:5,full_name:'acme/api',private:true}});
const started=()=>h.capture.mock.calls.filter(([,args])=>args[0]==='run').map(([,args])=>Number(args.find(arg=>arg.startsWith('ninedeploy.gha-runner.job='))?.split('=')[1]));
beforeEach(async()=>{
  resetGithubRunnersForTests();jitHook=undefined;h.full=true;h.capture.mockReset();h.githubApi.mockReset();
  db=await migratedDb();app=await seedApp(db,rsaKeyPair().privateKey,{events:['workflow_job']});
  ({inst}=await seedInstallation(db,app,{accountType:'User',permissions:{administration:'write'}}));
  await setRunnerConfig(db,app.id,{...GITHUB_RUNNER_DEFAULTS,enabled:true,maxConcurrent:2});
  h.capture.mockImplementation(async(command,args)=>{
    if(args[0]==='ps')return h.full?[1,2].map(id=>`full-${id}\trunning\t2026-11-01 00:00:00 +0000 UTC\t${app.id}\t${id}\tacme/api\t${id}\trepo:acme/api`).join('\n'):'';
    if(command==='iptables')return '';
    if(args[0]==='network')return args[1]==='inspect'?'false nd-gha0\n':'net1\n';
    return 'synthetic-container\n';
  });
  h.githubApi.mockImplementation(async(_app:unknown,_token:string,method:string,path:string)=>{
    if(method==='POST'&&path.endsWith('/generate-jitconfig')){await jitHook?.();return {status:201,data:{runner:{id:31},encoded_jit_config:'SYNTHETIC_JIT'},headers:new Headers()};}
    return {status:200,data:{},headers:new Headers()};
  });
  await handleWorkflowJob(db,log,app,inst,queued(80));await handleWorkflowJob(db,log,app,inst,queued(81));await drainPending(db,log);
  expect(started()).toEqual([]);h.full=false;
});
afterEach(async()=>{jitHook=undefined;await drainPending(db,log);closeMigratedDb(db);resetGithubRunnersForTests();});


const base={...GITHUB_RUNNER_DEFAULTS,enabled:true,maxConcurrent:2};
function assertStarts(expected:number[]){const actual=started();expect(actual).toEqual(expected);console.log('EXPECTED:',expected,'ACTUAL:',actual,'FIX VERIFIED');}
async function queueExtra(id:number,over:Record<string,unknown>={}){h.full=true;await handleWorkflowJob(db,log,app,inst,{...queued(id),...over});await drainPending(db,log);h.full=false;}
async function removeInitial(){await handleWorkflowJob(db,log,app,inst,queued(80,'completed'));await handleWorkflowJob(db,log,app,inst,queued(81,'completed'));}
it('denied repositories consume no slot before an allowed later repository',async()=>{
  await queueExtra(82,{repository:{id:6,full_name:'acme/web',private:true}});
  await setRunnerConfig(db,app.id,{...base,maxConcurrent:1,repositories:['acme/web']});await drainPending(db,log);assertStarts([82]);
});
it('removed labels consume no slot before a still-matching later job',async()=>{
  await setRunnerConfig(db,app.id,{...base,labels:['ninedeploy','new-scope']});
  await queueExtra(82,{workflow_job:{id:82,name:'new-label-job',labels:['self-hosted','new-scope']}});
  await setRunnerConfig(db,app.id,{...base,maxConcurrent:1,labels:['new-scope']});await drainPending(db,log);assertStarts([82]);
});
it('public restriction drops the public entry and preserves a private job behind it',async()=>{
  await removeInitial();await setRunnerConfig(db,app.id,{...base,allowPublicRepos:true});
  await queueExtra(82,{repository:{id:5,full_name:'acme/api',private:false}});await queueExtra(83);
  await setRunnerConfig(db,app.id,{...base,maxConcurrent:1,allowPublicRepos:false});await drainPending(db,log);assertStarts([83]);
});
it('case-insensitive repository matches remain eligible',async()=>{
  await setRunnerConfig(db,app.id,{...base,repositories:['ACME/API']});await drainPending(db,log);assertStarts([80,81]);
});
it('adding runner labels preserves old matching queued work',async()=>{
  await setRunnerConfig(db,app.id,{...base,labels:['ninedeploy','extra']});await drainPending(db,log);assertStarts([80,81]);
});
it('public work remains eligible when explicitly allowed',async()=>{
  await removeInitial();await setRunnerConfig(db,app.id,{...base,allowPublicRepos:true});await queueExtra(82,{repository:{id:5,full_name:'acme/api',private:false}});
  await drainPending(db,log);assertStarts([82]);
});
it('pending status response keeps its four public fields',async()=>{
  const {runnerStatus}=await import('../../apps/server/src/lib/githubRunners.js');const status=await runnerStatus(db,app);
  expect(status.pending).toHaveLength(2);for(const item of status.pending)expect(Object.keys(item).sort()).toEqual(['jobId','jobName','queuedAt','repo']);console.log('FIX VERIFIED: wire fields unchanged');
});
it('pending metadata does not alias the original payload label array',async()=>{
  await removeInitial();h.full=true;const body=queued(84);await handleWorkflowJob(db,log,app,inst,body);await drainPending(db,log);
  body.workflow_job.labels.splice(0,body.workflow_job.labels.length,'wrong-label');body.repository.private=false;h.full=false;
  await drainPending(db,log);assertStarts([84]);
});
it('policy changed during an admitted start filters the deferred entry on a fresh pass',async()=>{
  let enter!:()=>void;let release!:()=>void;let first=true;
  const ready=new Promise<void>(resolve=>{enter=resolve;});const blocked=new Promise<void>(resolve=>{release=resolve;});
  jitHook=async()=>{if(first){first=false;enter();await blocked;}};const pending=drainPending(db,log);
  try{await ready;await setRunnerConfig(db,app.id,{...base,repositories:['other/repo']});release();await pending;assertStarts([80]);await drainPending(db,log);assertStarts([80]);}
  finally{release();await pending;}
});
