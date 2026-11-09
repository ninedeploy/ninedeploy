import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { servers, type DB, type GithubApp } from '@ninedeploy/db';
import { GITHUB_RUNNER_DEFAULTS } from '@ninedeploy/schemas';
const h=vi.hoisted(()=>{
  process.env['NINEDEPLOY_MASTER_KEY']='ab'.repeat(32);
  return{capture:vi.fn<(command:string,args:string[],opts?:unknown)=>Promise<string>>(),agentOp:vi.fn(),githubApi:vi.fn()};
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


async function target(kind:'node'|'panel'){
  if(kind==='panel'){
    await setRunnerConfig(db,app.id,{...GITHUB_RUNNER_DEFAULTS,enabled:true,serverId:null});
    h.capture.mockImplementation(async(_command,args)=>args[0]==='ps'?`${rows[0]!['name']}\t${rows[0]!['state']}\t2026-11-01 00:00:00 +0000 UTC\t${app.id}\t77\tacme/api\t31\trepo:acme/api`:'');
  }
}
const removals=()=>h.agentOp.mock.calls.filter(c=>c[2]==='gha.runner.stop').length+h.capture.mock.calls.filter(([,args])=>args[0]==='rm').length;
function checked(expected:number){const actual=removals();expect(actual).toBe(expected);console.log('EXPECTED:',expected,'ACTUAL:',actual,'FIX VERIFIED');}
for(const kind of ['node','panel'] as const){
  for(const hours of [7,24,120])it(`${kind}: busy runner retained at ${hours}h`,async()=>{
    await target(kind);h.githubApi.mockResolvedValue({status:200,data:{busy:true},headers:new Headers()});await sweepGithubRunners(db,log,CREATED+hours*60*60_000);checked(0);expect(h.githubApi.mock.calls.some(c=>c[2]==='GET')).toBe(true);
  });
  for(const hours of [7,144])it(`${kind}: confirmed idle removed at ${hours}h`,async()=>{
    await target(kind);h.githubApi.mockResolvedValue({status:200,data:{busy:false},headers:new Headers()});await sweepGithubRunners(db,log,CREATED+hours*60*60_000);checked(1);
  });
  for(const hours of [7,144])it(`${kind}: unknown busy retained at ${hours}h`,async()=>{
    await target(kind);h.githubApi.mockResolvedValue({status:200,data:{},headers:new Headers()});await sweepGithubRunners(db,log,CREATED+hours*60*60_000);checked(0);
  });
  it(`${kind}: confirmed missing registration is cleaned at24h`,async()=>{
    await target(kind);const {GithubAppError}=await import('../../apps/server/src/lib/githubApp.js');h.githubApi.mockRejectedValue(new GithubAppError('synthetic missing','not_found',404));await sweepGithubRunners(db,log,CREATED+24*60*60_000);checked(1);
  });
  it(`${kind}: network failure does not authorize age deletion`,async()=>{
    await target(kind);h.githubApi.mockRejectedValue(new Error('synthetic network failure'));await sweepGithubRunners(db,log,CREATED+7*60*60_000);checked(0);
  });
  it(`${kind}: delayed busy answer gates all old-container removal`,async()=>{
    await target(kind);let enter!:()=>void;let release!:()=>void;
    const ready=new Promise<void>(resolve=>{enter=resolve;});const blocked=new Promise<void>(resolve=>{release=resolve;});
    h.githubApi.mockImplementation(async(_a:unknown,_t:string,method:string)=>{if(method==='GET'){enter();await blocked;}return{status:200,data:{busy:true},headers:new Headers()};});
    const pending=sweepGithubRunners(db,log,CREATED+24*60*60_000);
    try{await Promise.race([ready,pending.then(()=>{throw new Error('busy gate bypassed');})]);checked(0);release();await pending;checked(0);}
    finally{release();await pending;}
  });
  it(`${kind}: explicit operator stop remains available for an old busy runner`,async()=>{
    await target(kind);const {stopRunner}=await import('../../apps/server/src/lib/githubRunners.js');expect(await stopRunner(db,log,app.id,String(rows[0]!['name']))).toBe(true);checked(1);
  });
  it(`${kind}: exited cleanup remains available for an old runner`,async()=>{
    rows[0]!['state']='exited';await target(kind);await sweepGithubRunners(db,log,CREATED+24*60*60_000);checked(1);
  });
}
