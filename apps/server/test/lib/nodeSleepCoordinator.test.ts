import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { services, nodeSleepTransitions, eq } from '@ninedeploy/db';
import { servingReceiptFixture } from '../fixtures/servingTrafficReceipt.js';
import { nodeSleepEvidence } from '../fixtures/nodeSleepEvidence.js';
import { admitNodeSleep, advanceNodeSleep, holdNodeSleep } from '../../src/lib/nodeSleepAuthority.js';
import { createNodeSleepCoordinator } from '../../src/lib/nodeSleepCoordinator.js';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';

const io = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.agent, agentTransportSealed: io.sealed }));
let f: Awaited<ReturnType<typeof servingReceiptFixture>>, coordinators: ReturnType<typeof createNodeSleepCoordinator>[];
let lostStop: boolean, during: ((op: string) => Promise<void>) | undefined;
const service = async () => (await f.c.db.query.services.findFirst())!;
const row = () => f.c.db.query.nodeSleepTransitions.findFirst();
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  f = await servingReceiptFixture('file::memory:'); coordinators = []; lostStop = false; during = undefined;
  await f.c.db.update(services).set({ sleepAfterMinutes: 5, healthCheck: 'tcp', healthTimeoutSeconds: 10 });
  io.sealed.mockReset().mockResolvedValue(true);
  io.agent.mockReset().mockImplementation(async (_db, _node, op, params) => {
    await during?.(op);
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps: ['docker.mutations', 'docker.readiness', 'proxy.routingAck', 'proxy.orderedWrite', 'wake.catcher.prepare'] })}`] };
    if (op === 'docker.runtimeFence') {
      const { timeoutMs: _timeout, ...request } = params;
      return { exitCode: 0, lines: [`ND-RUNTIME-FENCE ${JSON.stringify({ ...request, complete: true })}`] };
    }
    if (op === 'wake.catcher.prepare') {
      return { exitCode: 0, lines: [`ND-WAKE-CATCHER ${JSON.stringify({ id: 'c'.repeat(64), name: `ninedeploy-wake-g-${'b'.repeat(32)}`, image: `sha256:${'d'.repeat(64)}`, created: false })}`] };
    }
    if (op === 'docker.readiness') return { exitCode: 0, lines: [`ND-READINESS ${JSON.stringify({ requestId: params.requestId, complete: true,
      items: params.targets.map((target: object) => ({ ...target, status: 'running', health: 'none', restarts: 0, failingStreak: 0, ready: true })) })}`] };
    if (op === 'proxy.writeConfig') return { exitCode: 0, lines: ['proxy-config x unchanged'] };
    if (op === 'proxy.writeOrderedConfig') return { exitCode: 0, lines: [`ND-PROXY-WRITE ${JSON.stringify({ revision: params.revision, requestId: params.requestId,
      contentHash: createHash('sha256').update(params.content).digest('hex'), complete: true, changed: true })}`] };
    if (op === 'docker.inspect') return { exitCode: 0, lines: ['running'] };
    if (op === 'proxy.confirmRouting') return { exitCode: 0, lines: [`ND-PROXY-ROUTING ${createHash('sha256').update(params.content).digest('hex')}`] };
    if (op === 'docker.stopSet') {
      if (lostStop) { lostStop = false; throw new Error('Stop acknowledgement lost'); }
      return { exitCode: 0, lines: [`ND-STOPPED-SET ${JSON.stringify({ requestId: params.requestId, serviceId: params.serviceId, revision: params.revision, complete: true,
        items: params.targets.map((target: object) => ({ ...target, running: false })) })}`] };
    }
    throw new Error(`Unexpected agent operation ${op}`);
  });
});
async function finish<T>(promise: Promise<T>): Promise<T> {
  if (!vi.isFakeTimers()) return promise;
  let done = false; void promise.then(() => { done = true; }, () => { done = true; });
  for (let n = 0; n < 160 && !done; n++) await vi.advanceTimersByTimeAsync(250);
  expect(done).toBe(true); return promise;
}
afterEach(async () => {
  for (const coordinator of coordinators) await finish(coordinator.close());
  vi.useRealTimers(); vi.restoreAllMocks(); f.c.client?.close();
});
function make(idle = { takeEvidence: vi.fn() }, onError = vi.fn()) {
  const coordinator = createNodeSleepCoordinator(f.c.db, { idle, onError, now: Date.now }); coordinators.push(coordinator); return coordinator;
}
const ops = (op: string) => io.agent.mock.calls.filter(call => call[2] === op);

it('starts a sleep only with genuine scheduler-issued authority and does not repeat completed Stop', async () => {
  vi.useRealTimers();
  const proof = await nodeSleepEvidence(f.c.db), idle = { takeEvidence: vi.fn(() => proof.token) }, coordinator = make(idle);
  await coordinator.tick(); await finish(coordinator.settle());
  expect(await row()).toMatchObject({ action: 'sleep', phase: 'asleep' }); expect((await service()).asleepAt).not.toBeNull();
  expect(ops('docker.stopSet')).toHaveLength(1);
  await coordinator.tick(); await finish(coordinator.settle()); expect(ops('docker.stopSet')).toHaveLength(1);
});
it('does not substitute elapsed time or an arbitrary object for an opaque idle proof', async () => {
  const coordinator = make({ takeEvidence: vi.fn(() => ({ idleMs: 300_000 })) });
  await coordinator.tick(); await finish(coordinator.settle());
  expect(await row()).toBeUndefined(); expect(io.agent).not.toHaveBeenCalled();
});
it.each([{ serverId: null }, { type: 'compose' as const }, { status: 'stopped' as const }, { asleepAt: new Date() },
  { sleepAfterMinutes: null }, { orchestrator: 'swarm' as const }, { runtimeId: null }, { port: null }])('does not consume idle authority for an ineligible placement: %j', async patch => {
  const proof = await nodeSleepEvidence(f.c.db); await f.c.db.update(services).set(patch);
  const idle = { takeEvidence: vi.fn(() => proof.token) }, coordinator = make(idle);
  await coordinator.tick(); await coordinator.settle();
  expect(idle.takeEvidence).not.toHaveBeenCalled(); expect(io.agent).not.toHaveBeenCalled(); expect(await row()).toBeUndefined();
});
it('recovers a lost Stop acknowledgement with the same durable command without new idle evidence', async () => {
  vi.useRealTimers();
  lostStop = true;
  const proof = await nodeSleepEvidence(f.c.db), first = make({ takeEvidence: vi.fn(() => proof.token) });
  await first.tick(); await finish(first.settle());
  const held = (await row())!; expect(held).toMatchObject({ phase: 'stopping', workerToken: null });
  const command = ops('docker.stopSet')[0]![3];
  await first.tick(); await first.tick(); await first.settle();
  expect(ops('docker.stopSet'), 'a held command must back off instead of hammering the node').toHaveLength(1);
  await first.close();
  const idle = { takeEvidence: vi.fn() }, second = make(idle);
  await second.tick(); await finish(second.settle());
  expect(await row()).toMatchObject({ phase: 'asleep', requestId: held.requestId }); expect(idle.takeEvidence).not.toHaveBeenCalled();
  expect(ops('docker.stopSet')).toHaveLength(2); expect(ops('docker.stopSet')[1]![3]).toEqual(command);
});
it('does not take over another worker lease and expires unpublished idle rather than stopping later', async () => {
  const proof = await nodeSleepEvidence(f.c.db), admission = (await admitNodeSleep(f.c.db, await service(), proof.token))!;
  const idle = { takeEvidence: vi.fn() }, coordinator = make(idle);
  await coordinator.tick(); await coordinator.settle(); expect(io.agent).not.toHaveBeenCalled(); expect(idle.takeEvidence).not.toHaveBeenCalled();
  await holdNodeSleep(f.c.db, admission, 'worker ended before fencing');
  vi.setSystemTime(Date.now() + 30_001);
  await coordinator.tick(); await coordinator.settle();
  expect(await row()).toMatchObject({ phase: 'superseded', reason: 'unpublished idle evidence expired' });
  expect(io.agent).not.toHaveBeenCalled();
});
it('explicit Stop supersedes an in-flight coordinator before it can stop the old captured runtime', async () => {
  const proof = await nodeSleepEvidence(f.c.db);
  during = async op => {
    if (op === 'wake.catcher.prepare') { during = undefined; await acceptNodeLifecycleIntent(f.c.db, await service(), 'stop'); }
  };
  const coordinator = make({ takeEvidence: vi.fn(() => proof.token) });
  await coordinator.tick(); await finish(coordinator.settle());
  expect(await row()).toMatchObject({ phase: 'superseded' }); expect(ops('docker.stopSet')).toHaveLength(0);
});
it('closes an in-flight pre-routing step without issuing Stop or retaining fallback authority', async () => {
  const proof = await nodeSleepEvidence(f.c.db); let enter!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  during = async op => { if (op === 'wake.catcher.prepare') { enter(); await gate; } };
  const idle = { takeEvidence: vi.fn(() => proof.token) }, coordinator = make(idle);
  await coordinator.tick(); await started;
  await coordinator.tick(); expect(idle.takeEvidence).toHaveBeenCalledOnce();
  const closing = coordinator.close(); release(); await finish(closing);
  expect(await row()).toMatchObject({ phase: 'completed', fallbackRouting: false, workerToken: null }); expect(ops('docker.stopSet')).toHaveLength(0);
  await coordinator.tick(); expect(idle.takeEvidence).toHaveBeenCalledOnce();
});
it('never dispatches wake journals through the sleep controller', async () => {
  const proof = await nodeSleepEvidence(f.c.db), admission = (await admitNodeSleep(f.c.db, await service(), proof.token))!;
  await advanceNodeSleep(f.c.db, admission, 'accepted', 'fencing');
  await f.c.db.update(nodeSleepTransitions).set({ action: 'wake', workerToken: null, leaseUntil: null }).where(eq(nodeSleepTransitions.serviceId, 1));
  const coordinator = make(); await coordinator.tick(); await coordinator.settle();
  expect(io.agent).not.toHaveBeenCalled(); expect(await row()).toMatchObject({ action: 'wake', phase: 'fencing' });
});

it('a new coordinator restores a shutdown during fallback routing without resuming the old idle Stop', async () => {
  vi.useRealTimers();
  const proof = await nodeSleepEvidence(f.c.db); let enter!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  during = async op => { if (op === 'proxy.confirmRouting') { enter(); await gate; } };
  const first = make({ takeEvidence: vi.fn(() => proof.token) });
  await first.tick(); await started;
  const closing = first.close(); release(); await closing;
  expect(await row()).toMatchObject({ phase: 'restoring', fallbackRouting: true, workerToken: null });
  expect(ops('docker.stopSet')).toHaveLength(0);
  during = undefined; const idle = { takeEvidence: vi.fn() }, second = make(idle);
  await second.tick(); await second.settle();
  expect(await row()).toMatchObject({ phase: 'completed', fallbackRouting: false }); expect((await service()).asleepAt).toBeNull();
  expect(idle.takeEvidence).not.toHaveBeenCalled(); expect(ops('docker.stopSet')).toHaveLength(0);
});
