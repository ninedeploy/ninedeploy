// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Owned hosted fixture outside Turbo.
import assert from 'node:assert/strict';
import { createDb, services, nodeSleepTransitions, eq } from '/app/packages/db/dist/index.js';
import { config } from '/app/apps/server/dist/config.js';
import { createNodeIdleScheduler } from '/app/apps/server/dist/lib/nodeIdleScheduler.js';
import { openServiceNodeIdleWatch } from '/app/apps/server/dist/lib/nodeIdleWatchService.js';
import { admitNodeSleep } from '/app/apps/server/dist/lib/nodeSleepAuthority.js';
import { executeNodeSleep } from '/app/apps/server/dist/lib/nodeSleepController.js';
import { nodeSleepRuntime } from '/app/apps/server/dist/lib/nodeSleepRuntime.js';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.match(process.env.DOCKER_HOST ?? '', /^tcp:\/\/nd-node-canary-paneldocker-[a-f0-9]+:2375$/);
const id = Number(process.argv[2]); assert.ok(Number.isSafeInteger(id) && id > 0);
const c = createDb({ url: config.dbUrl }); await c.ready;
const get = () => c.db.query.services.findFirst({ where: eq(services.id, id) });
const errors = []; let scheduler, phase = 'observe';
try {
  scheduler = createNodeIdleScheduler({ load: () => c.db.select().from(services).where(eq(services.id, id)),
    open: (service, signal) => openServiceNodeIdleWatch(c.db, service, signal), onError: error => errors.push(error.name) });
  const started = Date.now();
  for (const deadline = Date.now() + 420_000; ;) {
    await scheduler.tick();
    if (scheduler.status(await get())?.idleSatisfied) break;
    assert.ok(Date.now() < deadline, 'Real public-panel idle coverage did not qualify');
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
  const service = await get(), status = scheduler.status(service), evidence = scheduler.takeEvidence(service);
  assert.ok(evidence, 'Fresh idle evidence is unavailable');
  assert.ok(status.idleMs >= 300_000 && Date.now() - started >= 300_000, 'The real five-minute idle window was not observed');
  phase = 'admit'; const admission = await admitNodeSleep(c.db, service, evidence); assert.ok(admission, 'Real idle admission was refused');
  await scheduler.close(); scheduler = undefined;
  phase = 'sleep'; const result = await executeNodeSleep(c.db, admission, nodeSleepRuntime(c.db));
  assert.equal(result.state, 'asleep', 'Ordered sleep did not complete');
  const journal = await c.db.query.nodeSleepTransitions.findFirst({ where: eq(nodeSleepTransitions.serviceId, id) });
  assert.equal(journal?.phase, 'asleep', 'Sleep journal was not settled'); assert.ok((await get()).asleepAt, 'Asleep marker is absent');
  assert.equal(errors.length, 0, 'Idle observation had errors');
  console.log(JSON.stringify({ realIdle: true, observedIdleMs: status.idleMs, wallMs: Date.now() - started,
    state: result.state, immutableTargets: journal.targets.map(({ id, name }) => ({ id, name })), privateFactoryAdmission: true }));
} catch (error) {
  // Never emit raw SQL bindings, encrypted node tokens, wake keys or nonces.
  console.error(JSON.stringify({ failed: true, phase, errorType: error.name,
    message: error.name === 'AssertionError' ? error.message : 'Runtime observation or sleep step failed' }));
  process.exitCode = 1;
} finally { await scheduler?.close(); c.client?.close(); }
