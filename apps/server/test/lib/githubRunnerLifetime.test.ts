import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { servers, type DB, type GithubApp } from '@ninedeploy/db';
import { GITHUB_RUNNER_DEFAULTS } from '@ninedeploy/schemas';
const h=vi.hoisted(()=>{
  process.env['NINEDEPLOY_MASTER_KEY']='ab'.repeat(32);
  return{capture:vi.fn(async()=>''),agentOp:vi.fn(),githubApi:vi.fn()};
});
vi.mock('../../src/lib/exec.js',async orig=>({...await orig<object>(),capture:h.capture}));
vi.mock('../../src/lib/agentClient.js',async orig=>({...await orig<object>(),agentOp:h.agentOp}));
vi.mock('../../src/lib/agentCapabilities.js',async orig=>({...await orig<object>(),assertNodeCapability:vi.fn(async()=>undefined)}));
vi.mock('../../src/lib/githubApp.js',async orig=>({...await orig<object>(),githubApi:h.githubApi,installationToken:vi.fn(async()=> 'synthetic-token')}));
const {resetGithubRunnersForTests,setRunnerConfig,sweepGithubRunners}=await import('../../src/lib/githubRunners.js');
const {closeMigratedDb,migratedDb,rsaKeyPair,seedApp,seedInstallation}=await import('./githubAppKit.js');
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

for(const [hours,busy,expected] of [[5,true,0],[7,true,0],[24,true,0],[120,true,0],[7,false,1]] as const)it(`self-hosted runner at ${hours}h, busy=${busy}`,async()=>{
  h.githubApi.mockResolvedValue({status:200,data:{busy},headers:new Headers()});await sweepGithubRunners(db,log,CREATED+hours*60*60_000);
  const actual=h.agentOp.mock.calls.filter(call=>call[2]==='gha.runner.stop').length;
  console.log('EXPECTED:',expected,'ACTUAL:',actual);console.log(actual===expected?'PROBLEM NOT REPRODUCED':'PROBLEM CONFIRMED');expect(actual).toBe(expected);
});
