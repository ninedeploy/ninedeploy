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
afterEach(()=>{jitHook=undefined;resetGithubRunnersForTests();closeMigratedDb(db);});

const {runnerStatus}=await import('../../apps/server/src/lib/githubRunners.js');

beforeEach(()=>{const original=h.capture.getMockImplementation()!;h.capture.mockImplementation(async(command,args,opts)=>args[0]==='ps'&&!h.full?started().map(id=>`live-${id}\trunning\t2026-11-01 00:00:00 +0000 UTC\t${app.id}\t${id}\tacme/api\t${id}\trepo:acme/api`).join('\n'):original(command,args,opts));});
function installStatus(statusFor:(id:number)=>Promise<unknown>){h.githubApi.mockImplementation(async(_a:unknown,_t:string,method:string,path:string)=>{
  if(method==='GET'&&path.includes('/actions/jobs/'))return{status:200,data:await statusFor(Number(path.split('/').at(-1))),headers:new Headers()};
  if(method==='POST'&&path.endsWith('/generate-jitconfig'))return{status:201,data:{runner:{id:31},encoded_jit_config:'SYNTHETIC_JIT'},headers:new Headers()};return{status:200,data:{},headers:new Headers()};
});}
async function checked(runs:number[],pending:number[]){const actual=started();const waiting=(await runnerStatus(db,app)).pending.map(p=>p.jobId);expect(actual).toEqual(runs);expect(waiting).toEqual(pending);console.log('EXPECTED:',runs,pending,'ACTUAL:',actual,waiting,'FIX VERIFIED');}
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};}
for(const status of ['queued','in_progress','completed'])it(`confirmed state ${status}`,async()=>{installStatus(async()=>({status}));await drainPending(db,log,{recheck:true});await checked(status==='queued'?[80,81]:[],[]);});
for(const [name,data] of [['absent',{}],['null',null],['invalid-type',{status:17}],['unrecognized',{status:'future-state'}]] as const)it(`unknown response ${name} remains pending`,async()=>{installStatus(async()=>data);await drainPending(db,log,{recheck:true});await checked([],[80,81]);});
it('failed lookup retries without losing or prematurely starting work',async()=>{installStatus(async()=>{throw new Error('synthetic lookup error');});await drainPending(db,log,{recheck:true});await checked([],[80,81]);installStatus(async()=>({status:'queued'}));await drainPending(db,log,{recheck:true});await checked([80,81],[]);});
it('unknown first job consumes no slot ahead of a verified second job',async()=>{await setRunnerConfig(db,app.id,{...GITHUB_RUNNER_DEFAULTS,enabled:true,maxConcurrent:1});installStatus(async id=>id===80?{}:{status:'queued'});await drainPending(db,log,{recheck:true});await checked([81],[80]);});
it('a late unknown response cannot resurrect a completed pending owner',async()=>{const entered=gate();const blocked=gate();let first=true;installStatus(async()=>{if(first){first=false;entered.release();await blocked.promise;return{};}return{status:'queued'};});const pending=drainPending(db,log,{recheck:true});try{await entered.promise;await handleWorkflowJob(db,log,app,inst,queued(80,'completed'));blocked.release();await pending;await checked([81],[]);}finally{blocked.release();await pending;}});
it('another queued webhook cannot bypass uncertainty from the prior sweep',async()=>{installStatus(async()=>{throw new Error('synthetic lookup error');});await drainPending(db,log,{recheck:true});await checked([],[80,81]);await handleWorkflowJob(db,log,app,inst,queued(82));await drainPending(db,log);console.log('EXPECTED new webhook starts [82]; ACTUAL:',started());if(started().some(id=>id===80||id===81))console.log('PROBLEM CONFIRMED');await checked([82],[80,81]);});
it('uncertainty survives a configuration drift break before the next drain',async()=>{const entered=gate();const blocked=gate();let first=true;installStatus(async()=>{if(first){first=false;entered.release();await blocked.promise;}return{};});const pending=drainPending(db,log,{recheck:true});try{await entered.promise;await setRunnerConfig(db,app.id,{...GITHUB_RUNNER_DEFAULTS,enabled:true,maxConcurrent:2,cpus:4});blocked.release();await pending;await checked([],[80,81]);await drainPending(db,log);console.log('EXPECTED only previously unqueried job81; ACTUAL:',started());if(started().includes(80))console.log('PROBLEM CONFIRMED');await checked([81],[80]);}finally{blocked.release();await pending;}});
it('a locally suspended installation drops waiting jobs without remote queries',async()=>{await db.$client.execute('UPDATE github_app_installations SET suspended_at=1800000000');installStatus(async()=>{throw new Error('must not query');});await drainPending(db,log,{recheck:true});await checked([],[]);expect(h.githubApi.mock.calls.some(c=>c[2]==='GET'&&String(c[3]).includes('/actions/jobs/'))).toBe(false);});
