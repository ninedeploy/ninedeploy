import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nodeSleepTransitions, nodeWakeMaintenance, servers, services, settings } from '@ninedeploy/db';
import { servingReceiptFixture } from '../fixtures/servingTrafficReceipt.js';
import { nodeSleepEvidence } from '../fixtures/nodeSleepEvidence.js';
import { admitNodeSleep, advanceNodeSleep, bindNodeSleepCatcher, completeNodeSleep, nodeSleepCommand, recoverNodeSleep } from '../../src/lib/nodeSleepAuthority.js';
import { createNodeWakePoller } from '../../src/lib/nodeWakePoller.js';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';
import { renderDynamicConfig } from '../../src/engine/proxy.js';
import type { NodeWakeControllerDeps } from '../../src/lib/nodeWakeController.js';
import { nodeWakeKey } from '../../src/lib/nodeWakeKey.js';
import { prepareNodeWakeCatcher, retireNodeWakeCatcher } from '../../src/lib/nodeWakeCatcherClient.js';
import { createHash } from 'node:crypto';
import { withRoutingAck } from '../../src/lib/proxyRoutingAck.js';
import { settleNodeCatcherRoutePromotion } from '../../src/lib/nodeCatcherRoutePromotion.js';
import { reserveNodeProxyWrite, bindNodeProxyWrite } from '../../src/lib/nodeProxyAuthority.js';

const io = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.agent, agentTransportSealed: io.sealed }));
let f: Awaited<ReturnType<typeof servingReceiptFixture>>, pollers: ReturnType<typeof createNodeWakePoller>[];
let mode: 'normal' | 'foreign' | 'truncated' | 'unknown', lostRoute: boolean, failEnsure: boolean, beforeDemand: (() => Promise<void>) | undefined;
let settled: ReturnType<typeof vi.fn>;
const row = async () => (await f.c.db.query.nodeSleepTransitions.findFirst())!;
const service = async () => (await f.c.db.query.services.findFirst())!;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  f = await servingReceiptFixture('file::memory:'); pollers = []; mode = 'normal'; lostRoute = false; failEnsure = false; beforeDemand = undefined;
  settled = vi.fn(async (id: number) => { expect(id).toBe(1); expect(await row()).toMatchObject({ phase: 'completed', fallbackRouting: false }); expect((await service()).asleepAt).toBeNull(); });
  await f.c.db.update(services).set({ sleepAfterMinutes: 5, healthCheck: 'tcp', healthTimeoutSeconds: 10 });
  const proof = await nodeSleepEvidence(f.c.db), admission = (await admitNodeSleep(f.c.db, await service(), proof.token))!;
  await nodeWakeKey(f.c.db, 4, true);
  await advanceNodeSleep(f.c.db, admission, 'accepted', 'fencing');
  await bindNodeSleepCatcher(f.c.db, admission, { id: 'c'.repeat(64), image: `sha256:${'d'.repeat(64)}` });
  for (const [from, to] of [['fencing', 'prepared'], ['prepared', 'routing'], ['routing', 'routed'], ['routed', 'stopping']] as const) await advanceNodeSleep(f.c.db, admission, from, to);
  const sleeping = await row();
  await completeNodeSleep(f.c.db, admission, { ...nodeSleepCommand(admission, 'stop'), complete: true,
    items: sleeping.targets.map(({ id, name, deploymentId }) => ({ id, name, deploymentId, running: false })) });
  io.sealed.mockReset().mockResolvedValue(true); io.agent.mockReset().mockImplementation(async (_db, _node, op, params) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps: ['wake.catcher', 'wake.catcher.inventory', 'wake.catcher.prepare', 'wake.catcher.retire', 'docker.recovery', 'docker.mutations', 'docker.startSet', 'docker.readiness', 'proxy.routingAck', 'proxy.orderedWrite'] })}`] };
    if (op === 'wake.demand') {
      await beforeDemand?.();
      return { exitCode: 0, lines: [`ND-WAKE-CATCHER ${JSON.stringify({ catcherId: (mode === 'foreign' ? 'e' : 'c').repeat(64), startedAt: new Date(Date.now() - 60_000).toISOString(),
        cursorMs: Date.now(), truncated: mode === 'truncated', items: [{ token: mode === 'unknown' ? 'f'.repeat(32) : sleeping.wakeToken, count: 2, lastAt: Date.now() }] })}`] };
    }
    if (op === 'wake.catcher.prepare') {
      if (failEnsure) throw new Error('Catcher reply lost');
      return { exitCode: 0, lines: [`ND-WAKE-CATCHER ${JSON.stringify({ id: 'e'.repeat(64), name: `ninedeploy-wake-g-${'a'.repeat(32)}`, image: `sha256:${'f'.repeat(64)}`, created: true })}`] };
    }
    if (op === 'wake.catcher.retire') return { exitCode: 0, lines: [`ND-WAKE-CATCHER ${JSON.stringify({ ...params.target, fenced: true, removed: true,
      revision: params.revision, requestId: params.requestId, contentHash: createHash('sha256').update(withRoutingAck(params.content)).digest('hex') })}`] };
    if (op === 'docker.runtimeFence') { const { timeoutMs: _timeout, ...request } = params; return { exitCode: 0, lines: [`ND-RUNTIME-FENCE ${JSON.stringify({ ...request, complete: true })}`] }; }
    if (op === 'docker.startSet') return { exitCode: 0, lines: [`ND-STARTED-SET ${JSON.stringify({ requestId: params.requestId, serviceId: params.serviceId, revision: params.revision,
      complete: true, items: params.targets.map((target: object) => ({ ...target, running: true })) })}`] };
    if (op === 'docker.readiness') return { exitCode: 0, lines: [`ND-READINESS ${JSON.stringify({ requestId: params.requestId, complete: true,
      items: params.targets.map((target: object) => ({ ...target, status: 'running', health: 'none', restarts: 0, failingStreak: 0, ready: true })) })}`] };
    throw new Error(`Unexpected operation ${op}`);
  });
});
afterEach(async () => {
  for (const poller of pollers) { const closing = poller.close(); await vi.advanceTimersByTimeAsync(3000); await closing; }
  vi.useRealTimers(); vi.restoreAllMocks(); f.c.client?.close();
});
const operations = (op: string) => io.agent.mock.calls.filter(call => call[2] === op);
function make(onError = vi.fn(), recoverCatchers = false, inventory: () => Promise<Array<{ id: string; name: string; image: string }>> = async () => [], now?: () => number) {
  const poller = createNodeWakePoller(f.c.db, { onError, recoverCatchers, now, settled, maintenanceRuntime: signal => ({ signal,
    inventory,
    sealed: () => io.sealed(), agent: (node, op, params, options) => io.agent(f.c.db, node, op, params, () => undefined, options),
    ensure: (node, key, parent) => prepareNodeWakeCatcher(f.c.db, node, key, parent),
    route: async (serverId, catcherPromotion) => {
      expect(await renderDynamicConfig(f.c.db, { serverId, catcherPromotion })).toContain('service: svc_ninedeploy_node_wake');
      return settleNodeCatcherRoutePromotion(catcherPromotion, serverId);
    },
    retire: async (node, target, verify, parent) => {
      await verify();
      const reply = await retireNodeWakeCatcher(f.c.db, node, target, { revision: 1, requestId: 'd'.repeat(32), content: await renderDynamicConfig(f.c.db, { serverId: node }) }, parent);
      await verify(); return reply;
    },
  }), runtime: signal => ({ signal,
    sealed: () => io.sealed(), agent: (node, op, params, options) => io.agent(f.c.db, node, op, params, () => undefined, options),
    route: async (serverId, promotion, _signal, settle) => {
      // Simulated loaded-route acknowledgement, with the real bound renderer.
      const head = (await reserveNodeProxyWrite(f.c.db, serverId, { adopt: true }))!;
      const output = await renderDynamicConfig(f.c.db, { serverId, wakePromotion: promotion }); expect(output).toContain('service: svc_web_1');
      const bound = await bindNodeProxyWrite(f.c.db, head, withRoutingAck(output));
      if (lostRoute) { lostRoute = false; throw new Error('Routing acknowledgement lost'); }
      await settle(bound);
    },
  }) satisfies NodeWakeControllerDeps }); pollers.push(poller); return poller;
}
async function finish(promise: Promise<void>) {
  let done = false; void promise.finally(() => { done = true; });
  for (let i = 0; i < 160 && !done; i++) await vi.advanceTimersByTimeAsync(250);
  expect(done).toBe(true); await promise;
}
it('collects never-bound catchers with no sleeping cohort without preparing a replacement', async () => {
  await f.c.db.delete(nodeSleepTransitions); await f.c.db.update(services).set({ asleepAt: null });
  const inventory = vi.fn(async () => [{ id: 'e'.repeat(64), name: `ninedeploy-wake-g-${'a'.repeat(32)}`, image: `sha256:${'f'.repeat(64)}` }]);
  const errors = vi.fn(), poller = make(errors, true, inventory);
  await poller.tick(); await finish(poller.settle());
  expect(inventory).toHaveBeenCalledOnce(); expect(operations('wake.catcher.retire')).toHaveLength(1);
  expect(operations('wake.catcher.prepare')).toHaveLength(0); expect(operations('docker.startSet')).toHaveLength(0);
  expect(await f.c.db.query.nodeWakeMaintenance.findFirst()).toMatchObject({ phase: 'completed', catcherId: null });
  expect(errors).not.toHaveBeenCalled();
});
it('resumes captured orphan retirement after a lost removal reply without needing another inventory match', async () => {
  await f.c.db.delete(nodeSleepTransitions); await f.c.db.update(services).set({ asleepAt: null });
  const orphan = { id: 'e'.repeat(64), name: `ninedeploy-wake-g-${'a'.repeat(32)}`, image: `sha256:${'f'.repeat(64)}` };
  const original = io.agent.getMockImplementation()!; let lose = true;
  io.agent.mockImplementation(async (...args) => {
    if (args[2] === 'wake.catcher.retire' && lose) { lose = false; throw new Error('Removal reply lost'); }
    return original(...args);
  });
  const first = make(vi.fn(), true, async () => [orphan]); await first.tick(); await finish(first.settle()); await first.close();
  expect(await f.c.db.query.nodeWakeMaintenance.findFirst()).toMatchObject({ phase: 'collecting', workerToken: null,
    snapshot: [{ catcherId: orphan.id, catcherName: orphan.name, retirementOnly: true }] });
  const second = make(vi.fn(), true); await second.tick(); await finish(second.settle());
  expect(await f.c.db.query.nodeWakeMaintenance.findFirst()).toMatchObject({ phase: 'completed' });
  expect(operations('wake.catcher.retire')).toHaveLength(2); expect(operations('wake.catcher.prepare')).toHaveLength(0);
  expect(operations('wake.catcher.retire').map(call => call[3].target)).toEqual([{ id: orphan.id, name: orphan.name }, { id: orphan.id, name: orphan.name }]);
});
it('drops a stale orphan inventory reply after a replacement worker completes the journal', async () => {
  await f.c.db.delete(nodeSleepTransitions); await f.c.db.update(services).set({ asleepAt: null });
  const entered = Promise.withResolvers<void>(), inventory = Promise.withResolvers<Array<{ id: string; name: string; image: string }>>();
  const first = make(vi.fn(), true, () => { entered.resolve(); return inventory.promise; });
  const oldTick = first.tick(); await entered.promise;
  vi.setSystemTime(Date.now() + 120_001);
  const second = make(vi.fn(), true); await second.tick(); await finish(second.settle());
  inventory.resolve([{ id: 'e'.repeat(64), name: `ninedeploy-wake-g-${'a'.repeat(32)}`, image: `sha256:${'f'.repeat(64)}` }]);
  await oldTick; await first.settle();
  expect(await f.c.db.query.nodeWakeMaintenance.findFirst()).toMatchObject({ phase: 'completed', snapshot: [] });
  expect(operations('wake.catcher.retire')).toHaveLength(0); expect(operations('wake.catcher.prepare')).toHaveLength(0);
});
it('backs off empty orphan inventory and never creates a catcher', async () => {
  await f.c.db.delete(nodeSleepTransitions); await f.c.db.update(services).set({ asleepAt: null });
  let clock = 0; const inventory = vi.fn(async () => []), poller = make(vi.fn(), true, inventory, () => clock);
  await poller.tick(); await poller.tick(); expect(inventory).toHaveBeenCalledOnce();
  clock = 300_000; await poller.tick(); expect(inventory).toHaveBeenCalledTimes(2);
  expect(operations('wake.catcher.prepare')).toHaveLength(0); expect(operations('wake.catcher.retire')).toHaveLength(0);
});
it.each(['disabled', 'missing-key', 'sleeping'] as const)('does not start orphan collection for %s nodes', async condition => {
  if (condition !== 'sleeping') { await f.c.db.delete(nodeSleepTransitions); await f.c.db.update(services).set({ asleepAt: null }); }
  if (condition === 'missing-key') await f.c.db.delete(settings);
  mode = 'unknown'; const inventory = vi.fn(async () => []), poller = make(vi.fn(), condition !== 'disabled', inventory);
  await poller.tick(); expect(inventory).not.toHaveBeenCalled();
  expect(await f.c.db.query.nodeWakeMaintenance.findFirst()).toBeUndefined();
});
it.each(['unsealed', 'old-agent'] as const)('does not install an orphan admission barrier for an %s node', async condition => {
  await f.c.db.delete(nodeSleepTransitions); await f.c.db.update(services).set({ asleepAt: null });
  if (condition === 'unsealed') io.sealed.mockResolvedValue(false);
  else {
    const original = io.agent.getMockImplementation()!;
    io.agent.mockImplementation(async (...args) => args[2] === 'agent.ping'
      ? { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.18.23', caps: ['wake.catcher'] })}`] } : original(...args));
  }
  const inventory = vi.fn(async () => []), poller = make(vi.fn(), true, inventory);
  await poller.tick(); expect(inventory).not.toHaveBeenCalled();
  expect(await f.c.db.query.nodeWakeMaintenance.findFirst()).toBeUndefined();
});
it('gives four demand nodes priority over a pending orphan collection', async () => {
  mode = 'unknown'; const sleeping = await row();
  for (let index = 1; index <= 3; index++) {
    const id = index + 1, serverId = index + 4;
    await f.c.db.insert(servers).values({ id: serverId, name: `Demand ${id}`, host: `demand-${id}.test`, tokenEncrypted: 'fixture' });
    await f.c.db.insert(services).values({ id, name: `Demand ${id}`, slug: `svc${id}`, type: 'docker', serverId, status: 'running',
      runtimeId: `svc${id}-9`, port: 3000, asleepAt: new Date() });
    await f.c.db.insert(nodeSleepTransitions).values({ ...sleeping, serviceId: id, serverId, runtimeId: `svc${id}-9`,
      requestId: String(id).repeat(32), wakeToken: String(id + 5).repeat(32) });
    await nodeWakeKey(f.c.db, serverId, true);
  }
  const serverId = 20, requestId = 'a'.repeat(32), snapshot: [] = [];
  await f.c.db.insert(servers).values({ id: serverId, name: 'Orphan node', host: 'orphan.test', tokenEncrypted: 'fixture' });
  await nodeWakeKey(f.c.db, serverId, true);
  await f.c.db.insert(nodeWakeMaintenance).values({ serverId, generation: 1, requestId, snapshot, phase: 'collecting',
    binding: createHash('sha256').update(JSON.stringify([serverId, 1, requestId, snapshot])).digest('hex') });
  const inventory = vi.fn(async () => []), poller = make(vi.fn(), true, inventory);
  await finish(poller.tick());
  expect(operations('wake.demand')).toHaveLength(4); expect(inventory).not.toHaveBeenCalled();
});
it('polls pinned demand and runs the durable wake without enabling catcher replacement', async () => {
  const poller = make(); await poller.tick(); await finish(poller.settle()); expect((await row()).phase).toBe('completed');
  expect((await service()).asleepAt).toBeNull(); expect(operations('docker.startSet')).toHaveLength(1);
  expect(operations('wake.catcher.ensure')).toHaveLength(0);
  expect(operations('wake.catcher.prepare')).toHaveLength(0);
  await poller.tick(); expect(operations('docker.startSet')).toHaveLength(1);
  expect(settled).toHaveBeenCalledOnce();
});
it.each(['foreign', 'truncated', 'unknown'] as const)('never wakes from %s demand', async kind => {
  mode = kind; const poller = make(); await poller.tick();
  expect((await row()).phase).toBe('asleep'); expect(operations('docker.startSet')).toHaveLength(0);
});
it('backs off refused observations rather than hammering the node every tick', async () => {
  mode = 'truncated'; const errors = vi.fn(), poller = make(errors);
  await poller.tick(); await poller.tick(); await poller.tick();
  expect(operations('wake.demand')).toHaveLength(1); expect(errors).toHaveBeenCalledTimes(1);
});
it.each([3, 4])('polls healthy node demand alongside %i maintenance leases owned by other workers', async count => {
  mode = 'unknown'; // Isolate demand scheduling from application wake execution.
  for (let index = 0; index < count; index++) {
    const serverId = 10 + index, requestId = String(index + 1).repeat(32), snapshot: [] = [];
    await f.c.db.insert(servers).values({ id: serverId, name: `Busy ${index}`, host: `busy-${index}.test`, tokenEncrypted: 'fixture' });
    await f.c.db.insert(nodeWakeMaintenance).values({ serverId, generation: 1, requestId, snapshot, phase: 'preparing',
      binding: createHash('sha256').update(JSON.stringify([serverId, 1, requestId, snapshot])).digest('hex'),
      workerToken: 'a'.repeat(32), leaseUntil: new Date(Date.now() + 120_000) });
  }
  const poller = make(vi.fn(), true);
  await poller.tick(); await finish(poller.settle());
  expect(operations('wake.demand')).toHaveLength(1);
  expect((await row()).phase).toBe('asleep');
  const maintenance = await f.c.db.select().from(nodeWakeMaintenance);
  expect(maintenance).toHaveLength(count);
  expect(maintenance.every(item => item.workerToken === 'a'.repeat(32) && item.phase === 'preparing')).toBe(true);
});
it('a new poller recovers the journal without another demand and never repeats acknowledged Start', async () => {
  lostRoute = true; const first = make(); await first.tick();
  await finish(first.settle()); expect(await row()).toMatchObject({ phase: 'publishing', workerToken: null });
  expect(settled).not.toHaveBeenCalled();
  await first.close(); const reads = operations('wake.demand').length;
  const second = make(); await second.tick(); await finish(second.settle()); expect((await row()).phase).toBe('completed');
  expect(operations('wake.demand')).toHaveLength(reads); expect(operations('docker.startSet')).toHaveLength(1);
  expect(operations('docker.readiness')).toHaveLength(6);
  expect(settled).toHaveBeenCalledOnce();
});
it('refuses stale recovery snapshots without claiming another journal identity', async () => {
  lostRoute = true; const poller = make(); await poller.tick();
  await finish(poller.settle()); expect(await row()).toMatchObject({ phase: 'publishing', workerToken: null });
  const current = await row();
  expect(await recoverNodeSleep(f.c.db, 1, { ...current, requestId: 'f'.repeat(32) })).toBeNull();
  expect((await row()).workerToken).toBeNull();
});
it('does not resurrect a service when explicit Stop arrives while demand is read', async () => {
  beforeDemand = async () => { beforeDemand = undefined; await acceptNodeLifecycleIntent(f.c.db, await service(), 'stop'); };
  const poller = make(); await poller.tick(); await finish(poller.settle());
  expect((await service()).status).toBe('stopped'); expect((await row()).phase).toBe('superseded'); expect(operations('docker.startSet')).toHaveLength(0);
});
it('shares an in-flight node poll and discards its late reply after shutdown', async () => {
  let enter!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  beforeDemand = async () => { enter(); await gate; };
  const poller = make(), first = poller.tick(); await started;
  await poller.tick(); expect(operations('wake.demand')).toHaveLength(1);
  const closing = poller.close(); release(); await Promise.all([first, closing]);
  expect((await row()).phase).toBe('asleep'); expect(operations('docker.startSet')).toHaveLength(0);
  await poller.tick(); expect(operations('wake.demand')).toHaveLength(1);
});
it('opted-in catcher recovery rebinds the pinned source before accepting new demand', async () => {
  mode = 'foreign'; const poller = make(vi.fn(), true);
  await finish(poller.tick()); await finish(poller.settle());
  expect((await row()).catcherId).toBe('e'.repeat(64)); expect((await row()).phase).toBe('asleep');
  expect((await f.c.db.query.nodeWakeMaintenance.findFirst())!.phase).toBe('completed'); expect(operations('docker.startSet')).toHaveLength(0);
  await poller.tick(); await finish(poller.settle());
  expect((await row()).phase).toBe('completed'); expect(operations('docker.startSet')).toHaveLength(1);
});
it('a new poller recovers pending catcher maintenance without needing a new observation', async () => {
  mode = 'foreign'; failEnsure = true; const first = make(vi.fn(), true);
  await finish(first.tick()); expect((await f.c.db.query.nodeWakeMaintenance.findFirst())!.phase).toBe('preparing');
  const reads = operations('wake.demand').length; await first.close(); failEnsure = false;
  const second = make(vi.fn(), true); await finish(second.tick()); await finish(second.settle());
  expect((await f.c.db.query.nodeWakeMaintenance.findFirst())!.phase).toBe('completed');
  expect((await row()).catcherId).toBe('e'.repeat(64)); expect(operations('wake.demand')).toHaveLength(reads);
});
