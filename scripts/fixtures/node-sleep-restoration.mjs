// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Owned hosted fixture outside Turbo.
import assert from 'node:assert/strict';
import { createSealedRoutingFault } from '/tmp/smoke-sealed-routing-fault.mjs';
import { writeFileSync, existsSync } from 'node:fs';
import { createDb, services, servers, nodeSleepTransitions, eq } from '/app/packages/db/dist/index.js';
import { config } from '/app/apps/server/dist/config.js';
import { decrypt, sha256 } from '/app/apps/server/dist/lib/crypto.js';
import { open } from '/app/apps/server/dist/lib/agentSeal.js';
import { createNodeIdleScheduler } from '/app/apps/server/dist/lib/nodeIdleScheduler.js';
import { openServiceNodeIdleWatch } from '/app/apps/server/dist/lib/nodeIdleWatchService.js';
import { admitNodeSleep } from '/app/apps/server/dist/lib/nodeSleepAuthority.js';
import { executeNodeSleep } from '/app/apps/server/dist/lib/nodeSleepController.js';
import { nodeSleepRuntime } from '/app/apps/server/dist/lib/nodeSleepRuntime.js';
import { writeDynamicConfig } from '/app/apps/server/dist/engine/proxy.js';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.match(process.env.DOCKER_HOST ?? '', /^tcp:\/\/nd-node-canary-paneldocker-[a-f0-9]+:2375$/);
const id = Number(process.argv[2]); assert.ok(Number.isSafeInteger(id) && id > 0);
const marker = `/tmp/nd-sleep-restoration-${id}`;
const c = createDb({ url: config.dbUrl }); await c.ready;
const get = () => c.db.query.services.findFirst({ where: eq(services.id, id) });
const service = await get(); assert.ok(service?.serverId);
const server = await c.db.query.servers.findFirst({ where: eq(servers.id, service.serverId) }); assert.ok(server);
const shared = sha256(decrypt(server.tokenEncrypted));
const errors = [], mutations = []; let scheduler, phase = 'observe';
const fault = createSealedRoutingFault({ server, decode: envelope => open(shared, envelope),
  onMutation: op => mutations.push(op), onError: error => errors.push(error) });
const forwarder = fault.server;
try {
  await new Promise((resolve, reject) => { forwarder.once('error', reject); forwarder.listen(0, '127.0.0.1', resolve); });
  await c.db.update(servers).set({ host: '127.0.0.1', port: forwarder.address().port }).where(eq(servers.id, server.id));
  scheduler = createNodeIdleScheduler({ load: () => c.db.select().from(services).where(eq(services.id, id)),
    open: (row, signal) => openServiceNodeIdleWatch(c.db, row, signal), onError: error => errors.push(error.name) });
  const started = Date.now();
  for (const deadline = Date.now() + 420_000; ;) {
    await scheduler.tick();
    if (scheduler.status(await get())?.idleSatisfied) break;
    assert.ok(Date.now() < deadline, 'Real idle coverage did not qualify');
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
  const current = await get(), status = scheduler.status(current), evidence = scheduler.takeEvidence(current);
  assert.ok(evidence && status.idleMs >= 300_000 && Date.now() - started >= 300_000);
  phase = 'admit'; const admission = await admitNodeSleep(c.db, current, evidence); assert.ok(admission);
  await scheduler.close(); scheduler = undefined;
  // Start the observer only after genuine idle admission. Closing the scheduler
  // before consuming its evidence would correctly invalidate that evidence.
  phase = 'handshake'; writeFileSync(`${marker}.ready`, 'ready');
  for (const deadline = Date.now() + 15_000; !existsSync(`${marker}.go`);) {
    assert.ok(Date.now() < deadline, 'Traffic observer handshake expired');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  fault.arm(); phase = 'restore';
  const result = await executeNodeSleep(c.db, admission, nodeSleepRuntime(c.db));
  assert.equal(result.state, 'aborted', 'Lost pre-Stop acknowledgement did not restore the application');
  const { dropped, routingHash } = fault.receipt();
  assert.equal(dropped, true, 'No real loaded-routing acknowledgement was dropped');
  assert.equal(mutations.length, 0, 'Pre-Stop failure issued a runtime Stop/Start');
  const journal = await c.db.query.nodeSleepTransitions.findFirst({ where: eq(nodeSleepTransitions.serviceId, id) });
  assert.equal(journal.phase, 'completed'); assert.equal(journal.fallbackRouting, false); assert.equal((await get()).asleepAt, null);
  phase = 'ordinary-writer';
  await writeDynamicConfig(c.db, { requireNode: server.id, confirmNodeRouting: true, requireOrderedNode: true });
  assert.equal(errors.length, 0, 'Sealed forwarding or idle observation failed');
  console.log(JSON.stringify({ realIdle: true, observedIdleMs: status.idleMs, wallMs: Date.now() - started,
    realSealedAgent: true, loadedRoutingAckDropped: true, routingHash, noRuntimeMutations: true,
    state: result.state, journalPhase: journal.phase, fallbackRouting: journal.fallbackRouting,
    ordinaryWriterConfirmed: true, immutableTargets: journal.targets.map(({ id, name }) => ({ id, name })) }));
} catch (error) {
  console.error(JSON.stringify({ failed: true, phase, dropped: fault.receipt().dropped, mutationCount: mutations.length, errorType: error.name,
    message: error.name === 'AssertionError' ? error.message : 'Restoration runtime step failed' })); process.exitCode = 1;
} finally {
  await scheduler?.close();
  await c.db.update(servers).set({ host: server.host, port: server.port }).where(eq(servers.id, server.id));
  forwarder.closeAllConnections(); await new Promise(resolve => forwarder.close(resolve)); c.client?.close();
}
