import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { services } from '@ninedeploy/db';
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

const io = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.agent, agentTransportSealed: io.sealed }));
let f: Awaited<ReturnType<typeof servingReceiptFixture>>, pollers: ReturnType<typeof createNodeWakePoller>[];
let mode: 'normal' | 'foreign' | 'truncated' | 'unknown', lostRoute: boolean, failEnsure: boolean, beforeDemand: (() => Promise<void>) | undefined;
const row = async () => (await f.c.db.query.nodeSleepTransitions.findFirst())!;
const service = async () => (await f.c.db.query.services.findFirst())!;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  f = await servingReceiptFixture('file::memory:'); pollers = []; mode = 'normal'; lostRoute = false; failEnsure = false; beforeDemand = undefined;
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
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps: ['wake.catcher', 'wake.catcher.prepare', 'wake.catcher.retire', 'docker.recovery', 'docker.mutations', 'docker.startSet', 'docker.readiness', 'proxy.routingAck', 'proxy.orderedWrite'] })}`] };
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
function make(onError = vi.fn(), recoverCatchers = false) {
  const poller = createNodeWakePoller(f.c.db, { onError, recoverCatchers, maintenanceRuntime: signal => ({ signal,
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
    route: async (serverId, promotion) => {
      // Simulated loaded-route acknowledgement, with the real bound renderer.
      const output = await renderDynamicConfig(f.c.db, { serverId, wakePromotion: promotion }); expect(output).toContain('service: svc_web_1');
      if (lostRoute) { lostRoute = false; throw new Error('Routing acknowledgement lost'); }
    },
  }) satisfies NodeWakeControllerDeps }); pollers.push(poller); return poller;
}
async function finish(promise: Promise<void>) {
  let done = false; void promise.finally(() => { done = true; });
  for (let i = 0; i < 160 && !done; i++) await vi.advanceTimersByTimeAsync(250);
  expect(done).toBe(true); await promise;
}
it('polls pinned demand and runs the durable wake without enabling catcher replacement', async () => {
  const poller = make(); await poller.tick(); await finish(poller.settle()); expect((await row()).phase).toBe('completed');
  expect((await service()).asleepAt).toBeNull(); expect(operations('docker.startSet')).toHaveLength(1);
  expect(operations('wake.catcher.ensure')).toHaveLength(0);
  expect(operations('wake.catcher.prepare')).toHaveLength(0);
  await poller.tick(); expect(operations('docker.startSet')).toHaveLength(1);
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
it('a new poller recovers the journal without another demand and never repeats acknowledged Start', async () => {
  lostRoute = true; const first = make(); await first.tick();
  await finish(first.settle()); expect(await row()).toMatchObject({ phase: 'publishing', workerToken: null });
  await first.close(); const reads = operations('wake.demand').length;
  const second = make(); await second.tick(); await finish(second.settle()); expect((await row()).phase).toBe('completed');
  expect(operations('wake.demand')).toHaveLength(reads); expect(operations('docker.startSet')).toHaveLength(1);
  expect(operations('docker.readiness')).toHaveLength(6);
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
