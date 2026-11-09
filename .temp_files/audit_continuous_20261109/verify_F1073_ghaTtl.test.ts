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
afterEach(()=>{jitHook=undefined;resetGithubRunnersForTests();closeMigratedDb(db);vi.useRealTimers();});

const {runnerStatus}=await import('../../apps/server/src/lib/githubRunners.js');

const DAY=24*60*60_000;
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};}
async function clockNear(){const deadlines=(await runnerStatus(db,app)).pending.map(p=>Date.parse(p.queuedAt)+DAY);const deadline=Math.max(...deadlines);vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(deadline-60_000);return deadline;}
async function checked(expected:number[]){const actual=started();expect(actual).toEqual(expected);expect((await runnerStatus(db,app)).pending).toEqual([]);console.log('EXPECTED:',expected,'ACTUAL:',actual,'FIX VERIFIED');}
for(const delta of [-30_000,0,60_000])it(`JIT completion deadline delta ${delta}`,async()=>{
  const deadline=await clockNear();const entered=gate();const blocked=gate();let first=true;jitHook=async()=>{if(first){first=false;entered.release();await blocked.promise;}};const pending=drainPending(db,log);
  try{await entered.promise;vi.setSystemTime(deadline+delta);blocked.release();await pending;await checked(delta>0?[80]:[80,81]);}finally{blocked.release();await pending;}
});
for(const outcome of ['queued','missing','error'])it(`expiration while online status ${outcome} waits`,async()=>{
  const deadline=await clockNear();const entered=gate();const blocked=gate();let first=true;
  h.githubApi.mockImplementation(async(_a:unknown,_t:string,method:string,path:string)=>{
    if(method==='GET'&&path.includes('/actions/jobs/')){if(first){first=false;entered.release();await blocked.promise;}if(outcome==='error')throw new Error('synthetic read failure');return{status:200,data:outcome==='queued'?{status:'queued'}:{},headers:new Headers()};}
    if(method==='POST'&&path.endsWith('/generate-jitconfig'))return{status:201,data:{runner:{id:31},encoded_jit_config:'SYNTHETIC_JIT'},headers:new Headers()};return{status:200,data:{},headers:new Headers()};
  });
  const pending=drainPending(db,log,{recheck:true});try{await entered.promise;vi.setSystemTime(deadline+1000);blocked.release();await pending;await checked([]);}finally{blocked.release();await pending;}
});
it('expiration while host enumeration waits cannot use its earlier now snapshot',async()=>{
  const deadline=await clockNear();const entered=gate();const blocked=gate();const original=h.capture.getMockImplementation()!;let first=true;
  h.capture.mockImplementation(async(command,args,opts)=>{const response=await original(command,args,opts);if(args[0]==='ps'&&first){first=false;entered.release();await blocked.promise;}return response;});
  const pending=drainPending(db,log);try{await entered.promise;vi.setSystemTime(deadline+1000);blocked.release();await pending;await checked([]);}finally{blocked.release();await pending;}
});
it('expiration while the final settings read waits is checked after it resumes',async()=>{
  const deadline=await clockNear();const entered=gate();const blocked=gate();const read=gate();const releaseRead=gate();let first=true;let spy:{mockRestore():void}|undefined;
  jitHook=async()=>{if(first){first=false;entered.release();await blocked.promise;}};const pending=drainPending(db,log);
  try{await entered.promise;const original=db.query.settings.findFirst.bind(db.query.settings);spy=vi.spyOn(db.query.settings,'findFirst').mockImplementationOnce(((...args:Parameters<typeof original>)=>(async()=>{const row=await original(...args);read.release();await releaseRead.promise;return row;})()) as typeof original);
    blocked.release();await read.promise;vi.setSystemTime(deadline+1000);releaseRead.release();await pending;await checked([80]);
  }finally{blocked.release();releaseRead.release();await pending;spy?.mockRestore();}
});
it('expired middle entry consumes no slot ahead of a fresh queued job',async()=>{
  const deadline=await clockNear();h.full=true;await handleWorkflowJob(db,log,app,inst,queued(82));await drainPending(db,log);h.full=false;
  const entered=gate();const blocked=gate();let first=true;jitHook=async()=>{if(first){first=false;entered.release();await blocked.promise;}};const pending=drainPending(db,log);
  try{await entered.promise;vi.setSystemTime(deadline+60_000);blocked.release();await pending;await checked([80,82]);}finally{blocked.release();await pending;}
});
it('entries expired before drain retain the initial prune behavior',async()=>{const deadline=await clockNear();vi.setSystemTime(deadline+1000);await drainPending(db,log);await checked([]);});
