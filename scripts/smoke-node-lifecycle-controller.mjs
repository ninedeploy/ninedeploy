// Durable panel command execution against real SQLite, sealed agent HTTP and Traefik.
// Public lifecycle endpoints are a separate acceptance gate.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const image = process.argv.find(arg => arg.startsWith('--image='))?.slice(8);
assert.ok(image && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image), 'Pass --image=<built NineDeploy image>');
const proof = resolve(process.argv.find(arg => arg.startsWith('--proof='))?.slice(8) ?? `.temp_files/node-lifecycle-controller-${randomBytes(6).toString('hex')}`);
mkdirSync(proof, { recursive: true });
const owner = `panel-lifecycle-${randomBytes(5).toString('hex')}`, daemon = `nd-${owner}-daemon`, volume = `nd-${owner}-home`;
const home = '/var/lib/ninedeploy-agent', cases = [], runners = [], jobs = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const cli = args => spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 45_000, maxBuffer: 4 << 20 });
const checked = args => { const r = cli(args); assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim(); };
const inner = args => checked(['exec', daemon, 'docker', ...args]);
const states = () => ['web-9', 'web-9-r2', 'web-9-r3'].map(name => inner(['inspect', name, '--format', '{{.State.Status}}']));
const report = result => { cases.push(result); writeFileSync(`${proof}/controller-runtime-cases.json`, JSON.stringify({ image, cases }, null, 2)); console.log(JSON.stringify(result)); };
const program = `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createDb, runMigrations, servers, services, domains, nodeLifecycleIntents, eq, desc } from '/app/packages/db/dist/index.js';
import { buildAgentApp } from '/app/apps/server/dist/agentApp.js';
import { agentRoutes } from '/app/apps/server/dist/agent.js';
import { agentOp, agentTransportSealed } from '/app/apps/server/dist/lib/agentClient.js';
import { encrypt, sha256 } from '/app/apps/server/dist/lib/crypto.js';
import { renderStaticConfig, writeDynamicConfig } from '/app/apps/server/dist/engine/proxy.js';
import { withRoutingAck } from '/app/apps/server/dist/lib/proxyRoutingAck.js';
import { acceptNodeLifecycleIntent } from '/app/apps/server/dist/lib/nodeLifecycleIntent.js';
import { executeNodeLifecycleIntent } from '/app/apps/server/dist/lib/nodeLifecycleController.js';
const mode = process.env.PROOF_MODE;
const c = createDb({url:'file:/var/lib/ninedeploy-agent/panel.sqlite'}); await c.ready; await runMigrations(c.db);
const app = await buildAgentApp(); await app.register(agentRoutes, {tokenHash:sha256('isolated-proof-only'),nonceFile:'/var/lib/ninedeploy-agent/seen-nonces'});
await app.listen({host:'127.0.0.1',port:0});
const port = app.server.address().port;
await c.db.insert(servers).values({id:4,name:'Isolated node',host:'127.0.0.1',port,tokenEncrypted:encrypt('isolated-proof-only')})
  .onConflictDoUpdate({target:servers.id,set:{port}});
const svc = async () => (await c.db.query.services.findFirst({where:eq(services.id,1)}));
const trace = []; let routeAckAt = 0;
const response = () => new Promise((resolve,reject) => {
  const q = request({host:'127.0.0.1',port:80,path:'/',headers:{host:'lifecycle.test'}}, r => { r.resume(); r.on('end',()=>resolve(r.statusCode)); });
  q.setTimeout(3000,()=>q.destroy(Error('Owned routing request deadline'))); q.on('error',reject); q.end();
});
try {
  if (mode === 'setup') {
    await c.db.insert(services).values({id:1,name:'Web',slug:'web',type:'docker',status:'stopped',serverId:4,runtimeId:'web-9',runtimeReplicas:2,replicas:3,port:8080,healthCheck:'http-strict',healthPath:'/',healthTimeoutSeconds:10});
    await c.db.insert(domains).values({id:1,serviceId:1,hostname:'lifecycle.test',status:'active',ssl:false});
    await agentOp(c.db,4,'proxy.writeConfig',{kind:'static',content:renderStaticConfig(null)},()=>{});
    await agentOp(c.db,4,'proxy.writeConfig',{kind:'dynamic',content:withRoutingAck('http: {}\\n')},()=>{});
    console.log('RESULT '+JSON.stringify({setup:true}));
  } else {
    if (mode === 'bad-health') await c.db.update(services).set({healthPath:'/missing'}).where(eq(services.id,1));
    if (mode === 'crash-start') await c.db.update(services).set({healthPath:'/'}).where(eq(services.id,1));
    const row = mode === 'resume' || mode === 'old' ? (await c.db.select().from(nodeLifecycleIntents).orderBy(desc(nodeLifecycleIntents.id)).limit(mode === 'old' ? 2 : 1)).at(mode === 'old' ? 1 : 0)
      : await acceptNodeLifecycleIntent(c.db,await svc(),mode === 'stop' ? 'stop' : 'start');
    const result = await executeNodeLifecycleIntent(c.db,row.id,{
      sealed: id => agentTransportSealed(c.db,id),
      agent: async (id,op,params,options) => {
        if (op === 'docker.lifecycle' && params.action === 'stop' && params.targets.length) {
          assert.equal(await response(),404,'Stop must remove the actual route before effects');
          assert.ok(Date.now()-routeAckAt>=1950,'Stop must finish drain after the actual routing acknowledgement');
        }
        const r = await agentOp(c.db,id,op,params,()=>{},options);
        if (op === 'docker.lifecycle') trace.push({op,action:params.action,revision:params.revision,targets:params.targets});
        if (op === 'docker.readiness') trace.push({op,status:(await svc()).status,items:JSON.parse(r.lines.find(l=>l.startsWith('ND-READINESS ')).slice(13)).items});
        if (mode === 'crash-start' && op === 'docker.lifecycle' && params.action === 'start') {
          writeFileSync('/var/lib/ninedeploy-agent/start-effect-entered',JSON.stringify({id:row.id,status:(await svc()).status}));
          await new Promise(()=>{});
        }
        return r;
      },
      route: async (service,signal) => {
        await writeDynamicConfig(c.db,{requireNode:service.serverId,confirmNodeRouting:true,confirmServiceId:service.id,signal});
        const status = await response(); assert.equal(status,service.status==='stopped'?404:200);
        trace.push({op:'routing-ack',status:service.status,httpStatus:status}); routeAckAt=Date.now();
        if (mode==='lost-route') throw Error('Injected response loss after the real routing acknowledgement');
      },
      sleep: ms => new Promise(resolve=>setTimeout(resolve,ms)),
    });
    const stored = await c.db.query.nodeLifecycleIntents.findFirst({where:eq(nodeLifecycleIntents.id,row.id)});
    console.log('RESULT '+JSON.stringify({result,id:row.id,phase:stored.phase,reason:stored.reason,nextAttemptAt:stored.nextAttemptAt.getTime(),status:(await svc()).status,trace}));
  }
} finally { await app.close(); c.client.close(); }
`;
writeFileSync(`${proof}/controller-program.mjs`, program);
function args(mode) {
  const runner = `nd-${owner}-${mode}-${runners.length}`; runners.push(runner);
  return {runner,args:['run','--rm','--name',runner,'--label',`ninedeploy.proof=${owner}`,'--network',`container:${daemon}`,'--user','0','--no-healthcheck',
    '-v',`${volume}:${home}`,'-v',`${resolve(proof,'controller-program.mjs')}:/proof/controller.mjs:ro`,'-w',home,
    '-e','NODE_ENV=test','-e',`NINEDEPLOY_DATA_DIR=${home}/panel-data`,'-e',`NINEDEPLOY_DB_PATH=${home}/panel.sqlite`,
    '-e','DOCKER_HOST=tcp://127.0.0.1:2375','-e',`PROOF_MODE=${mode}`,'--entrypoint','node',image,'/proof/controller.mjs']};
}
function parse(r,mode) {
  writeFileSync(`${proof}/runtime-${mode}-${Date.now()}.log`, `${r.stdout??''}\n${r.stderr??''}`);
  assert.equal(r.status,0,r.stderr||r.stdout);
  const lines=(r.stdout??'').split('\n').filter(l=>l.startsWith('RESULT ')); assert.equal(lines.length,1,r.stdout);
  return JSON.parse(lines[0].slice(7));
}
function run(mode) { return parse(cli(args(mode).args),mode); }
try {
  checked(['image','inspect',image]);
  for (const img of ['busybox:1.36','docker:28-dind','traefik:v3.1']) if (cli(['image','inspect',img]).status !== 0) checked(['pull',img]);
  checked(['volume','create','--label',`ninedeploy.proof=${owner}`,volume]);
  checked(['run','-d','--name',daemon,'--label',`ninedeploy.proof=${owner}`,'--privileged','--network','none','-v',`${volume}:${home}`,
    '-e','DOCKER_TLS_CERTDIR=','docker:28-dind','dockerd','--host=unix:///var/run/docker.sock','--host=tcp://127.0.0.1:2375','--tls=false']);
  const until = Date.now()+30_000;
  while(cli(['exec',daemon,'docker','info']).status!==0) { assert.ok(Date.now()<until); await pause(250); }
  checked(['save','-o',`${proof}/fixtures.tar`,'busybox:1.36','traefik:v3.1']);
  checked(['cp',`${proof}/fixtures.tar`,`${daemon}:/root/fixtures.tar`]); inner(['load','-i','/root/fixtures.tar']); inner(['network','create','ninedeploy']);
  for (const name of ['web-9','web-9-r2','web-9-r3']) inner(['create','--name',name,'--network','ninedeploy','--label','ninedeploy.managed=service','--label','ninedeploy.service=1','--label','ninedeploy.deployment=9',
    'busybox:1.36','sh','-c','mkdir -p /www; echo ready > /www/index.html; exec httpd -f -p 8080 -h /www']);
  run('setup');
  inner(['run','-d','--name','ninedeploy-proxy','--network','ninedeploy','-p','80:80','-p','443:443','-v',`${home}/.agent-proxy:/etc/traefik:ro`,'traefik:v3.1']);
  const started = run('start'); assert.equal(started.result.state,'completed'); assert.equal(started.status,'running'); assert.deepEqual(states(),['running','running','created']);
  assert.equal(started.trace.filter(t=>t.op==='docker.readiness').length,3); assert.ok(started.trace.filter(t=>t.op==='docker.readiness').every(t=>t.status==='stopped'&&t.items.length===2&&t.items.every(i=>i.ready)));
  report({name:'real-sealed-start-two-replicas-three-readiness-rounds-and-confirmed-traefik',passed:true});
  const stopped = run('stop'); assert.equal(stopped.result.state,'completed'); assert.deepEqual(states(),['exited','exited','created']);
  assert.deepEqual(stopped.trace.map(t=>t.op==='docker.lifecycle'?(t.targets.length?'stop':'fence'):t.op),['fence','routing-ack','stop']);
  report({name:'real-stop-route-removal-ack-drain-before-immutable-effects',passed:true});
  const bad = run('bad-health'); assert.equal(bad.result.state,'held'); assert.equal(bad.phase,'readiness'); assert.equal(bad.status,'stopped'); assert.ok(!bad.trace.some(t=>t.op==='routing-ack'));
  assert.deepEqual(states(),['running','running','created']); run('stop');
  report({name:'real-http-404-readiness-never-publishes-a-running-container',passed:true});
  const crashArgs=args('crash-start'), child=spawn('docker',crashArgs.args,{windowsHide:true,stdio:['ignore','pipe','pipe']}); child.stdout.resume(); child.stderr.resume();
  const job = new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code));}); jobs.push(job);
  const barrier = Date.now()+30_000;
  while(cli(['exec',crashArgs.runner,'test','-f',`${home}/start-effect-entered`]).status!==0) {assert.ok(Date.now()<barrier,'Start effect barrier');await pause(200);}
  assert.deepEqual(states(),['running','running','created']);
  checked(['kill','--signal','KILL',crashArgs.runner]); assert.notEqual(await job,0);
  const finalStop=run('stop'); assert.equal(finalStop.result.state,'completed'); assert.deepEqual(states(),['exited','exited','created']);
  const old=run('old'); assert.equal(old.result.state,'superseded'); assert.equal(old.status,'stopped'); assert.equal(old.trace.length,0);
  report({name:'hard-panel-agent-process-kill-after-start-cannot-resurrect-after-new-stop',passed:true});
  const lost=run('lost-route'); assert.equal(lost.result.state,'held'); assert.equal(lost.phase,'routing'); assert.equal(lost.status,'deploying');
  report({name:'lost-confirmed-routing-response-retains-command-for-recovery',passed:true});
  console.log(JSON.stringify({waitingForPersistedRetryAt:lost.nextAttemptAt}));
  while(Date.now()<lost.nextAttemptAt+1000) await pause(Math.min(1000,lost.nextAttemptAt+1000-Date.now()));
  const resumed=run('resume'); assert.equal(resumed.id,lost.id); assert.equal(resumed.result.state,'completed');
  assert.equal(resumed.trace.filter(t=>t.op==='docker.readiness').length,3); assert.ok(!resumed.trace.some(t=>t.op==='docker.lifecycle'));
  report({name:'new-process-recovers-same-durable-routing-phase-after-real-backoff',passed:true});
  run('stop');
  writeFileSync(`${proof}/controller-runtime-cases.json`,JSON.stringify({image,cases,realDocker:true,sealedHttp:true,realTraefik:true,realSqlite:true,isolatedNodeDaemon:true,publicLifecycleApi:false},null,2));
} finally {
  for(const runner of runners) {const r=cli(['inspect',runner,'--format','{{index .Config.Labels "ninedeploy.proof"}}']);if(r.status===0){assert.equal(r.stdout.trim(),owner);checked(['rm','-fv',runner]);}}
  await Promise.allSettled(jobs);
  rmSync(`${proof}/fixtures.tar`, { force: true });
  const d=cli(['inspect',daemon,'--format','{{index .Config.Labels "ninedeploy.proof"}}']);if(d.status===0){assert.equal(d.stdout.trim(),owner);checked(['rm','-fv',daemon]);}
  const v=cli(['volume','inspect',volume,'--format','{{index .Labels "ninedeploy.proof"}}']);if(v.status===0){assert.equal(v.stdout.trim(),owner);checked(['volume','rm',volume]);}
}
