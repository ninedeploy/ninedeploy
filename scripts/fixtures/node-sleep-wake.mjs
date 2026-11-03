// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Isolated hosted fixture outside Turbo.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { createDb, runMigrations, services, deployments, domains, servers } from '/app/packages/db/dist/index.js';
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
import { sampleApplication } from '/fixture/sample.mjs';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
const mode = process.argv[2]; assert.ok(['setup', 'journey', 'resume'].includes(mode));
const token = process.env.ND_PROOF_TOKEN; assert.match(token ?? '', /^[a-f0-9]{64}$/);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms)), exec = promisify(execFile);
const docker = async args => (await exec('docker', args, { timeout: 15_000, maxBuffer: 65_536 })).stdout.trim();
const c = createDb({ url: 'file:/fixture/panel.db' }); await c.ready; await runMigrations(c.db);
const app = await buildAgentApp(); await app.register(agentRoutes, { tokenHash: sha256(token), nonceFile: '/fixture/nonces' });
await app.listen({ host: '127.0.0.1', port: 8899 });
let scheduler, poller;
const service = () => c.db.query.services.findFirst(), journal = () => c.db.query.nodeSleepTransitions.findFirst();
const save = (name, value) => writeFileSync(`/proof/${name}.json`, JSON.stringify(value));
try {
  if (mode === 'setup') {
    await c.db.insert(servers).values({ id: 4, name: 'Owned node', host: '127.0.0.1', port: 8899, tokenEncrypted: encrypt(token) });
    await c.db.insert(services).values({ id: 1, name: 'Real sleeping application', slug: 'web', type: 'docker', serverId: 4,
      status: 'running', runtimeId: 'web-9', port: 3000, sleepAfterMinutes: 5, healthCheck: 'http-strict', healthPath: '/ready', healthTimeoutSeconds: 10 });
    await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'running' });
    await c.db.insert(domains).values({ serviceId: 1, hostname: 'sleep.invalid', status: 'active', ssl: false });
    mkdirSync('/fixture/.agent-proxy/dynamic', { recursive: true });
    writeFileSync('/fixture/.agent-proxy/dynamic/ninedeploy.yml', withRoutingAck(await renderDynamicConfig(c.db, { serverId: 4 })));
    writeFileSync('/fixture/.agent-proxy/traefik.yml', renderStaticConfig(await getAcmeEmail(c.db), await getDnsConfig(c.db)));
  } else if (mode === 'journey') {
    const cases = [], errors = [];
    const passed = (name, details = {}) => { cases.push({ name, passed: true, ...details }); save('progress', { cases }); };
    await writeDynamicConfig(c.db, { requireNode: 4, confirmNodeRouting: true, requireOrderedNode: true });
    assert.equal((await sampleApplication()).application, true);
    const appId = await docker(['inspect', '--format', '{{.Id}}', 'web-9']);
    scheduler = createNodeIdleScheduler({ load: () => c.db.select().from(services), open: (selected, signal) => openServiceNodeIdleWatch(c.db, selected, signal),
      onError: error => errors.push(String(error).slice(0, 512)) });
    // Positive traffic must reset the actual observer before a quiet interval can qualify.
    await scheduler.tick(); assert.equal((await sampleApplication()).application, true); await pause(2000); await scheduler.tick();
    assert.deepEqual({ idleMs: scheduler.status(await service())?.idleMs, satisfied: scheduler.status(await service())?.idleSatisfied }, { idleMs: 0, satisfied: false });
    passed('real-serving-request-resets-idle-coverage');
    const idleStarted = Date.now();
    for (const deadline = Date.now() + 420_000; ;) {
      await scheduler.tick();
      const status = scheduler.status(await service()); save('idle-status', { at: Date.now(), status, errors });
      if (status?.idleSatisfied) break;
      assert.ok(Date.now() < deadline, `Real idle deadline: ${JSON.stringify({ status, errors })}`); await pause(10_000);
    }
    const selected = await service(), status = scheduler.status(selected), evidence = scheduler.takeEvidence(selected);
    assert.ok(evidence); assert.ok(status.idleMs >= 300_000); assert.ok(Date.now() - idleStarted >= 300_000);
    const admission = await admitNodeSleep(c.db, selected, evidence); assert.ok(admission);
    await scheduler.close(); scheduler = undefined;
    passed('real-five-minute-idle-admits-sleep', { observedIdleMs: status.idleMs, wallMs: Date.now() - idleStarted });
    writeFileSync('/proof/idle-complete', ''); await pause(1000);
    const slept = await executeNodeSleep(c.db, admission, nodeSleepRuntime(c.db));
    assert.equal(slept.state, 'asleep', JSON.stringify(slept));
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
    save('journey', { complete: true, seededDormantJournal: false, realSealedHttp: true, cases, errors,
      controllerPid: prior.controllerPid, resumedPid: process.pid, completedAt: Date.now() });
    await pause(1500);
  }
} finally { await scheduler?.close(); await poller?.close(); await app.close(); c.client?.close(); }
