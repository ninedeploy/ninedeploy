import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { servers, type DB, type GithubApp } from '@ninedeploy/db';
import { GITHUB_RUNNER_DEFAULTS } from '@ninedeploy/schemas';
const h=vi.hoisted(()=>{
  process.env['NINEDEPLOY_MASTER_KEY']='ab'.repeat(32);
  return{capture:vi.fn(async()=>''),agentOp:vi.fn(),githubApi:vi.fn()};
});
vi.mock('../../apps/server/src/lib/exec.js',async orig=>({...await orig<object>(),capture:h.capture}));
vi.mock('../../apps/server/src/lib/agentClient.js',async orig=>({...await orig<object>(),agentOp:h.agentOp}));
vi.mock('../../apps/server/src/lib/agentCapabilities.js',async orig=>({...await orig<object>(),assertNodeCapability:vi.fn(async()=>undefined)}));
vi.mock('../../apps/server/src/lib/githubApp.js',async orig=>({...await orig<object>(),githubApi:h.githubApi,installationToken:vi.fn(async()=> 'synthetic-token')}));
const {resetGithubRunnersForTests,setRunnerConfig,sweepGithubRunners}=await import('../../apps/server/src/lib/githubRunners.js');
const {closeMigratedDb,migratedDb,rsaKeyPair,seedApp,seedInstallation}=await import('../../apps/server/test/lib/githubAppKit.js');
let db:DB;let app:GithubApp;let rows:Record<string,unknown>[];
const CREATED=Date.parse('2026-11-01T00:00:00Z');
const log={info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()} as unknown as FastifyBaseLogger;
beforeEach(async()=>{
  resetGithubRunnersForTests();db=await migratedDb();app=await seedApp(db,rsaKeyPair().privateKey,{events:['workflow_job']});
  await seedInstallation(db,app,{accountType:'User',permissions:{administration:'write'}});
  await db.insert(servers).values({id:9,name:'fixture node',host:'203.0.113.9',port:4600,tokenEncrypted:'synthetic',status:'online'});
  await setRunnerConfig(db,app.id,{...GITHUB_RUNNER_DEFAULTS,enabled:true,serverId:9});
  rows=[{name:`nd-${app.id}-77-abcdef`,state:'running',createdAt:new Date(CREATED).toISOString(),githubAppId:app.id,jobId:77,repo:'acme/api',runnerId:31,scope:'repo:acme/api'}];
  h.capture.mockReset().mockResolvedValue('');h.agentOp.mockReset().mockImplementation(async(_db:unknown,_serverId:number,op:string)=>({exitCode:0,lines:op==='gha.runner.list'?[`ND-GHA-RUNNERS ${JSON.stringify(rows)}`]:[]}));
  h.githubApi.mockReset().mockResolvedValue({status:200,data:{busy:true},headers:new Headers()});
});
afterEach(()=>{closeMigratedDb(db);resetGithubRunnersForTests();});

const stops=()=>h.agentOp.mock.calls.filter(call=>call[2]==='gha.runner.stop').length;
function checked(expected:number){const actual=stops();expect(actual).toBe(expected);console.log('EXPECTED stops:',expected,'ACTUAL:',actual,'FIX VERIFIED');}
for(const state of [undefined,'','unknown','unrecognized','x'.repeat(201)])it(`uncertain state retained (${String(state).slice(0,15)})`,async()=>{
  rows[0]!['state']=state;await sweepGithubRunners(db,log,CREATED+30*60_000);checked(0);expect(h.githubApi).not.toHaveBeenCalled();
});
for(const state of ['created','paused','restarting','removing','exited','dead'])it(`recognized non-running ${state} keeps existing cleanup`,async()=>{
  rows[0]!['state']=state;await sweepGithubRunners(db,log,CREATED+30*60_000);checked(1);expect(h.githubApi).not.toHaveBeenCalled();
});
for(const [description,data,removed] of [['busy',{busy:true},false],['idle',{busy:false},true],['missing',{},false],['null',null,false],['wrong-type',{busy:'false'},false]] as const)it(`running runner busy answer ${description}`,async()=>{
  h.githubApi.mockResolvedValue({status:200,data,headers:new Headers()});await sweepGithubRunners(db,log,CREATED+30*60_000);checked(Number(removed));
});
for(const status of [404,500,0])it(`running runner API error ${status}`,async()=>{
  const {GithubAppError}=await import('../../apps/server/src/lib/githubApp.js');h.githubApi.mockRejectedValue(status?new GithubAppError('synthetic','http',status):new Error('synthetic transport failure'));
  await sweepGithubRunners(db,log,CREATED+30*60_000);checked(Number(status===404));
});
for(const extra of [0,1])it(`idle threshold plus ${extra}ms`,async()=>{
  h.githubApi.mockResolvedValue({status:200,data:{busy:false},headers:new Headers()});await sweepGithubRunners(db,log,CREATED+10*60_000+extra);checked(extra);
});
it('invalid creation time is not evidence of old age',async()=>{
  rows[0]!['createdAt']='invalid';h.githubApi.mockResolvedValue({status:200,data:{busy:false},headers:new Headers()});await sweepGithubRunners(db,log,CREATED+30*60_000);checked(0);
});
it('explicit operator stop remains available for an unknown state',async()=>{
  rows[0]!['state']='unknown';const {stopRunner}=await import('../../apps/server/src/lib/githubRunners.js');
  expect(await stopRunner(db,log,app.id,String(rows[0]!['name']))).toBe(true);checked(1);expect(h.githubApi.mock.calls.filter(call=>call[2]==='DELETE')).toHaveLength(1);
});
it('failed container removal never deregisters a running runner',async()=>{
  const original=h.agentOp.getMockImplementation()!;h.agentOp.mockImplementation(async(...args:unknown[])=>{if(args[2]==='gha.runner.stop')throw new Error('synthetic stop failure');return original(...args);});
  h.githubApi.mockResolvedValue({status:200,data:{busy:false},headers:new Headers()});await sweepGithubRunners(db,log,CREATED+30*60_000);checked(1);expect(h.githubApi.mock.calls.filter(call=>call[2]==='DELETE')).toHaveLength(0);
});
it('a delayed uncertain node snapshot cannot stop a runner now known running',async()=>{
  delete rows[0]!['state'];let enter!:()=>void;let release!:()=>void;let held=false;
  const ready=new Promise<void>(resolve=>{enter=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
  const original=h.agentOp.getMockImplementation()!;
  h.agentOp.mockImplementation(async(...args:unknown[])=>{const response=await original(...args);if(args[2]==='gha.runner.list'&&!held){held=true;enter();await gate;}return response;});
  const pending=sweepGithubRunners(db,log,CREATED+30*60_000);
  try{await ready;expect(stops()).toBe(0);rows[0]!['state']='running';release();await pending;checked(0);}
  finally{release();await pending;}
});
