// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Isolated hosted fixture outside Turbo.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { createDb, runMigrations, services, deployments, domains, servers, eq } from '/app/packages/db/dist/index.js';
import { buildAgentApp } from '/app/apps/server/dist/agentApp.js';
import { agentRoutes } from '/app/apps/server/dist/agent.js';
import { encrypt, sha256 } from '/app/apps/server/dist/lib/crypto.js';
import { renderDynamicConfig, renderStaticConfig, getAcmeEmail, getDnsConfig, writeDynamicConfig } from '/app/apps/server/dist/engine/proxy.js';
import { withRoutingAck } from '/app/apps/server/dist/lib/proxyRoutingAck.js';
import { createNodeIdleScheduler } from '/app/apps/server/dist/lib/nodeIdleScheduler.js';
import { openServiceNodeIdleWatch } from '/app/apps/server/dist/lib/nodeIdleWatchService.js';
import { admitNodeSleep } from '/app/apps/server/dist/lib/nodeSleepAuthority.js';
import { executeNodeSleep } from '/app/apps/server/dist/lib/nodeSleepController.js';
import { nodeSleepRuntime } from '/app/apps/server/dist/lib/nodeSleepRuntime.js';
import { createNodeWakePoller } from '/app/apps/server/dist/lib/nodeWakePoller.js';
import { readNodeWakeDemand } from '/app/apps/server/dist/lib/nodeWakeCatcherClient.js';
import { agentOp } from '/app/apps/server/dist/lib/agentClient.js';
import { parseAgentCapabilities } from '/app/apps/server/dist/lib/agentCapabilities.js';
import { hashBasicAuthEntry } from '/app/apps/server/dist/lib/htpasswd.js';
import { acceptNodeLifecycleIntent } from '/app/apps/server/dist/lib/nodeLifecycleIntent.js';
import { executeNodeLifecycleIntent } from '/app/apps/server/dist/lib/nodeLifecycleController.js';
import { nodeLifecycleRuntime } from '/app/apps/server/dist/lib/nodeLifecycleRuntime.js';
import { sampleApplication } from '/fixture/sample.mjs';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
const mode = process.argv[2]; assert.ok(['setup', 'journey', 'resume'].includes(mode));
const token = process.env.ND_PROOF_TOKEN; assert.match(token ?? '', /^[a-f0-9]{64}$/);
const basicAuth = process.env.ND_PROOF_BASIC_AUTH; assert.match(basicAuth ?? '', /^[a-f0-9]{48}$/);
const authorized = { host: 'secure.sleep.invalid', authorization: `Basic ${Buffer.from(`proof:${basicAuth}`).toString('base64')}` };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms)), exec = promisify(execFile);
const docker = async args => (await exec('docker', args, { timeout: 15_000, maxBuffer: 65_536 })).stdout.trim();
const c = createDb({ url: 'file:/fixture/panel.db' }); await c.ready; await runMigrations(c.db);
const app = await buildAgentApp(); await app.register(agentRoutes, { tokenHash: sha256(token), nonceFile: '/fixture/nonces' });
await app.listen({ host: '127.0.0.1', port: 8899 });
let scheduler, poller;
const service = (id = 1) => c.db.query.services.findFirst({ where: eq(services.id, id) });
const journal = (id = 1) => c.db.query.nodeSleepTransitions.findFirst({ where: eq(services.id, id) });
const save = (name, value) => writeFileSync(`/proof/${name}.json`, JSON.stringify(value));
try {
  if (mode === 'setup') {
    await c.db.insert(servers).values({ id: 4, name: 'Owned node', host: '127.0.0.1', port: 8899, tokenEncrypted: encrypt(token) });
    await c.db.insert(services).values([{ id: 1, name: 'Real sleeping application', slug: 'web', runtimeId: 'web-9' },
      { id: 2, name: 'Protected sleeping application', slug: 'secure', runtimeId: 'secure-10' }].map(row => ({ ...row, type: 'docker', serverId: 4,
        status: 'running', port: 3000, sleepAfterMinutes: 5, healthCheck: 'http-strict', healthPath: '/ready', healthTimeoutSeconds: 10 })));
    await c.db.insert(deployments).values([{ id: 9, serviceId: 1, status: 'running' }, { id: 10, serviceId: 2, status: 'running' }]);
    await c.db.insert(domains).values([{ serviceId: 1, hostname: 'sleep.invalid', status: 'active', ssl: false },
      { serviceId: 2, hostname: authorized.host, status: 'active', ssl: false, basicAuth: JSON.stringify([hashBasicAuthEntry(`proof:${basicAuth}`)]) },
      { serviceId: 2, hostname: 'blocked.sleep.invalid', status: 'active', ssl: false, ipAllowlist: '203.0.113.0/24' }]);
    mkdirSync('/fixture/.agent-proxy/dynamic', { recursive: true });
    writeFileSync('/fixture/.agent-proxy/dynamic/ninedeploy.yml', withRoutingAck(await renderDynamicConfig(c.db, { serverId: 4 })));
    writeFileSync('/fixture/.agent-proxy/traefik.yml', renderStaticConfig(await getAcmeEmail(c.db), await getDnsConfig(c.db)));
  } else if (mode === 'journey') {
    const cases = [], errors = [];
    const passed = (name, details = {}) => { cases.push({ name, passed: true, ...details }); save('progress', { cases }); };
    await writeDynamicConfig(c.db, { requireNode: 4, confirmNodeRouting: true, requireOrderedNode: true });
    assert.equal((await sampleApplication()).application, true);
    assert.equal((await sampleApplication(authorized)).application, true);
    const appId = await docker(['inspect', '--format', '{{.Id}}', 'web-9']);
    const secureId = await docker(['inspect', '--format', '{{.Id}}', 'secure-10']);
    const capabilities = async () => {
      const reply = await agentOp(c.db, 4, 'agent.ping', {}, () => undefined); assert.equal(reply.exitCode, 0);
      return parseAgentCapabilities(reply.lines).caps;
    };
    assert.equal((await capabilities()).has('proxy.idleWatch'), true);
    process.env.NINEDEPLOY_AGENT_PROXY_TRAFFIC = 'off';
    try {
      assert.equal((await capabilities()).has('proxy.idleWatch'), false);
      // A development image still carrying the previous release version can
      // correctly refuse via its upgrade message rather than an opt-in hint.
      await assert.rejects(openServiceNodeIdleWatch(c.db, await service(), new AbortController().signal), error => error instanceof Error &&
        error.message.startsWith('Node proxy traffic unavailable:') && error.message.includes('cannot observe continuous node idle coverage'));
      assert.equal(await journal(), undefined); assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', appId]), 'true');
      passed('agent-opt-out-refuses-idle-without-runtime-effects', { advertisedBefore: true, advertisedDuring: false, operationRefused: true });
    } finally { process.env.NINEDEPLOY_AGENT_PROXY_TRAFFIC = 'on'; }
    assert.equal((await capabilities()).has('proxy.idleWatch'), true);
    scheduler = createNodeIdleScheduler({ load: () => c.db.select().from(services), open: (selected, signal) => openServiceNodeIdleWatch(c.db, selected, signal),
      onError: error => errors.push(String(error).slice(0, 512)) });
    // Positive traffic must reset the actual observer before a quiet interval can qualify.
    await scheduler.tick(); assert.equal((await sampleApplication()).application, true); await pause(2000); await scheduler.tick();
    assert.deepEqual({ idleMs: scheduler.status(await service())?.idleMs, satisfied: scheduler.status(await service())?.idleSatisfied }, { idleMs: 0, satisfied: false });
    passed('real-serving-request-resets-idle-coverage');
    const idleStarted = Date.now();
    for (const deadline = Date.now() + 420_000; ;) {
      await scheduler.tick();
      const status = scheduler.status(await service()), secureStatus = scheduler.status(await service(2)); save('idle-status', { at: Date.now(), status, secureStatus, errors });
      if (status?.idleSatisfied && secureStatus?.idleSatisfied) break;
      assert.ok(Date.now() < deadline, `Real idle deadline: ${JSON.stringify({ status, secureStatus, errors })}`); await pause(10_000);
    }
    const selected = await service(), status = scheduler.status(selected), evidence = scheduler.takeEvidence(selected);
    assert.ok(evidence); assert.ok(status.idleMs >= 300_000); assert.ok(Date.now() - idleStarted >= 300_000);
    const admission = await admitNodeSleep(c.db, selected, evidence); assert.ok(admission);
    const secure = await service(2), secureEvidence = scheduler.takeEvidence(secure), secureStatus = scheduler.status(secure);
    assert.ok(secureEvidence); assert.ok(secureStatus.idleMs >= 300_000);
    const secureAdmission = await admitNodeSleep(c.db, secure, secureEvidence); assert.ok(secureAdmission);
    await scheduler.close(); scheduler = undefined;
    passed('real-five-minute-idle-admits-sleep', { observedIdleMs: status.idleMs, secureIdleMs: secureStatus.idleMs, wallMs: Date.now() - idleStarted });
    writeFileSync('/proof/idle-complete', ''); await pause(1000);
    const [slept, secureSlept] = await Promise.all([
      executeNodeSleep(c.db, admission, nodeSleepRuntime(c.db)), executeNodeSleep(c.db, secureAdmission, nodeSleepRuntime(c.db)),
    ]);
    assert.equal(slept.state, 'asleep', JSON.stringify(slept)); assert.equal(secureSlept.state, 'asleep', JSON.stringify(secureSlept));
    assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', secureId]), 'false');
    assert.equal((await sampleApplication({ host: authorized.host })).status, 401);
    assert.equal((await sampleApplication({ host: 'blocked.sleep.invalid' })).status, 403);
    await pause(1200);
    const secureSleep = await journal(2);
    const demand = await readNodeWakeDemand(c.db, 4, secureSleep.catcherId, Math.max(0, Date.now() - 60_000), undefined, secureSleep.catcherName);
    assert.equal(demand.items.some(item => item.token === secureSleep.wakeToken), false);
    assert.equal((await journal(2)).phase, 'asleep'); assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', secureId]), 'false');
    passed('basic-auth-and-ip-denials-do-not-record-demand-or-wake');
    assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', appId]), 'false');
    assert.ok((await service()).asleepAt); assert.equal((await journal()).phase, 'asleep');
    assert.equal((await sampleApplication()).waking, true);
    passed('real-immutable-application-stopped-behind-confirmed-catcher', { appId });
    // Readiness fails after a successful real Start. The fallback must remain selected.
    writeFileSync('/fixture/app-state/block-ready', ''); const heldFrom = Date.now();
    const options = { onError: error => errors.push(String(error).slice(0, 512)) };
    poller = createNodeWakePoller(c.db, options); await poller.tick(); await poller.settle();
    assert.equal((await journal()).phase, 'readiness'); assert.equal((await journal()).fallbackRouting, true);
    assert.ok((await service()).asleepAt); assert.equal((await sampleApplication()).waking, true);
    assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', appId]), 'true');
    assert.equal((await journal(2)).phase, 'asleep'); assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', secureId]), 'false');
    const boots = readFileSync('/fixture/app-state/boots', 'utf8').trim().split('\n').length; assert.equal(boots, 2);
    passed('http-readiness-failure-retains-waking-page-after-real-start', { from: heldFrom, to: Date.now() });
    save('journey-held', { cases, errors, appId, boots, controllerPid: process.pid });
  } else {
    // A fresh Node process and HTTP agent reopen the persisted readiness phase.
    const prior = JSON.parse(readFileSync('/proof/journey-held.json', 'utf8'));
    assert.notEqual(process.pid, prior.controllerPid); assert.equal((await journal()).phase, 'readiness');
    const { cases, errors, boots } = prior;
    const passed = name => cases.push({ name, passed: true });
    unlinkSync('/fixture/app-state/block-ready');
    poller = createNodeWakePoller(c.db, { onError: error => errors.push(String(error).slice(0, 512)) }); await poller.tick(); await poller.settle();
    assert.equal((await journal()).phase, 'completed'); assert.equal((await journal()).fallbackRouting, false);
    assert.equal((await service()).asleepAt, null); assert.equal((await sampleApplication()).application, true);
    assert.equal(readFileSync('/fixture/app-state/boots', 'utf8').trim().split('\n').length, boots);
    passed('process-restart-wake-recovery-publishes-ready-app-without-repeated-start');
    await writeDynamicConfig(c.db, { requireNode: 4, confirmNodeRouting: true, requireOrderedNode: true });
    assert.equal((await sampleApplication()).application, true);
    passed('ordinary-followup-write-keeps-ready-application');
    // An authenticated visitor can request wake, but a real Stop supersedes it
    // while the application is still returning failed strict HTTP readiness.
    writeFileSync('/fixture/secure-state/block-ready', '');
    if (existsSync('/fixture/secure-state/ready-probed')) unlinkSync('/fixture/secure-state/ready-probed');
    assert.equal((await sampleApplication(authorized)).waking, true);
    await poller.close(); poller = createNodeWakePoller(c.db, { onError: error => errors.push(String(error).slice(0, 512)) });
    await poller.tick();
    for (const deadline = Date.now() + 15_000; !existsSync('/fixture/secure-state/ready-probed'); ) {
      assert.ok(Date.now() < deadline, 'Authenticated wake never reached HTTP readiness'); await pause(50);
    }
    assert.equal((await journal(2)).action, 'wake'); assert.equal((await journal(2)).phase, 'readiness');
    assert.equal((await sampleApplication(authorized)).waking, true);
    const stop = await acceptNodeLifecycleIntent(c.db, await service(2), 'stop');
    const stopResult = await executeNodeLifecycleIntent(c.db, stop.id, nodeLifecycleRuntime(c.db)); assert.equal(stopResult.state, 'completed', JSON.stringify(stopResult));
    await poller.settle();
    assert.equal((await service(2)).status, 'stopped'); assert.equal((await journal(2)).phase, 'superseded');
    assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', 'secure-10']), 'false');
    assert.equal(readFileSync('/fixture/secure-state/boots', 'utf8').trim().split('\n').length, 2);
    assert.equal((await sampleApplication(authorized)).status, 404);
    await poller.close(); poller = createNodeWakePoller(c.db); await poller.tick(); await poller.settle();
    assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', 'secure-10']), 'false');
    assert.equal((await sampleApplication()).application, true);
    passed('authenticated-demand-starts-wake-but-inflight-stop-prevents-resurrection');
    save('journey', { complete: true, seededDormantJournal: false, realSealedHttp: true, cases, errors,
      controllerPid: prior.controllerPid, resumedPid: process.pid, completedAt: Date.now() });
    await pause(1500);
  }
} finally { await scheduler?.close(); await poller?.close(); await app.close(); c.client?.close(); }
