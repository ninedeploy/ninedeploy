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

beforeEach(()=>{
  const original=h.capture.getMockImplementation()!;
  h.capture.mockImplementation(async(command,args,opts)=>{
    if(args[0]==='ps'&&!h.full)return started().map(id=>`live-${id}\trunning\t2026-11-01 00:00:00 +0000 UTC\t${app.id}\t${id}\tacme/api\t${id}\trepo:acme/api`).join('\n');
    return original(command,args,opts);
  });
});

function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};}
function assertStarts(expected:number[]){const actual=started();expect(actual).toEqual(expected);console.log('EXPECTED:',expected,'ACTUAL:',actual,'FIX VERIFIED');}
const base={...GITHUB_RUNNER_DEFAULTS,enabled:true,maxConcurrent:2};
for(const mode of ['same','disabled','capacity','increase','cpus','memory'] as const)it(`JIT config change ${mode} retains work for a fresh pass`,async()=>{
  const entered=gate();const blocked=gate();let first=true;
  jitHook=async()=>{if(first){first=false;entered.release();await blocked.promise;}};
  const pending=drainPending(db,log);
  const changed={...base,...(mode==='disabled'?{enabled:false}:mode==='capacity'?{maxConcurrent:1}:mode==='increase'?{maxConcurrent:3}:mode==='cpus'?{cpus:4}:mode==='memory'?{memoryMb:8192}:{})};
  try{
    await entered.promise;await setRunnerConfig(db,app.id,changed);blocked.release();await pending;
    assertStarts(mode==='same'?[80,81]:[80]);
    if(mode!=='same'){
      if(mode==='capacity'){await drainPending(db,log);assertStarts([80]);}
      const resume={...changed,enabled:true,maxConcurrent:2};await setRunnerConfig(db,app.id,resume);await drainPending(db,log);assertStarts([80,81]);
      const second=h.capture.mock.calls.filter(([,args])=>args[0]==='run')[1]![1];
      expect(second[second.indexOf('--cpus')+1]).toBe(String(resume.cpus));expect(second[second.indexOf('--memory')+1]).toBe(`${resume.memoryMb}m`);
    }
  }finally{blocked.release();await pending;}
});
for(const enabled of [false,true])it(`online status query observes config drift (enabled=${enabled})`,async()=>{
  const entered=gate();const blocked=gate();let first=true;
  h.githubApi.mockImplementation(async(_app:unknown,_token:string,method:string,path:string)=>{
    if(method==='GET'&&path.includes('/actions/jobs/')){if(first){first=false;entered.release();await blocked.promise;}return{status:200,data:{status:'queued'},headers:new Headers()};}
    if(method==='POST'&&path.endsWith('/generate-jitconfig'))return{status:201,data:{runner:{id:31},encoded_jit_config:'SYNTHETIC_JIT'},headers:new Headers()};
    return{status:200,data:{},headers:new Headers()};
  });
  const pending=drainPending(db,log,{recheck:true});
  try{await entered.promise;await setRunnerConfig(db,app.id,{...base,enabled,maxConcurrent:1});blocked.release();await pending;assertStarts([]);await setRunnerConfig(db,app.id,base);await drainPending(db,log);assertStarts([80,81]);}
  finally{blocked.release();await pending;}
});
it('a settings read captured before a completed update cannot approve the old batch',async()=>{
  const entered=gate();const blocked=gate();const read=gate();const releaseRead=gate();let first=true;
  jitHook=async()=>{if(first){first=false;entered.release();await blocked.promise;}};
  const pending=drainPending(db,log);let spy:{mockRestore():void}|undefined;
  try{
    await entered.promise;const original=db.query.settings.findFirst.bind(db.query.settings);
    spy=vi.spyOn(db.query.settings,'findFirst').mockImplementationOnce(((...args:Parameters<typeof original>)=>(async()=>{const row=await original(...args);read.release();await releaseRead.promise;return row;})()) as typeof original);
    blocked.release();await read.promise;await setRunnerConfig(db,app.id,{...base,enabled:false});releaseRead.release();await pending;
    console.log('EXPECTED: [80]; ACTUAL:',started());console.log(started().length===1?'FIX VERIFIED':'PROBLEM CONFIRMED');expect(started()).toEqual([80]);
  }finally{blocked.release();releaseRead.release();await pending;spy?.mockRestore();}
});
