import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nodeWakeMaintenance, services, settings, eq } from '@ninedeploy/db';
import { servingReceiptFixture } from '../fixtures/servingTrafficReceipt.js';
import { nodeSleepEvidence } from '../fixtures/nodeSleepEvidence.js';
import { admitNodeSleep, admitNodeWake, advanceNodeSleep, bindNodeSleepCatcher, completeNodeSleep, nodeSleepCommand } from '../../src/lib/nodeSleepAuthority.js';
import { claimNodeWakeMaintenance, type NodeWakeMaintenanceClaim } from '../../src/lib/nodeWakeMaintenance.js';
import { executeNodeWakeMaintenance } from '../../src/lib/nodeWakeMaintenanceController.js';
import { nodeWakeMaintenanceRuntime } from '../../src/lib/nodeWakeMaintenanceRuntime.js';
import { nodeWakeKey } from '../../src/lib/nodeWakeKey.js';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';
import { renderDynamicConfig, writeDynamicConfig } from '../../src/engine/proxy.js';
import { prepareNodeCatcherRouting, recordNodeWakeMaintenanceCatcher } from '../../src/lib/nodeWakeMaintenance.js';
import type { NodeCatcherRoutePromotion } from '../../src/lib/nodeCatcherRoutePromotion.js';

const io = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.agent, agentTransportSealed: io.sealed }));
let f: Awaited<ReturnType<typeof servingReceiptFixture>>, claim: NodeWakeMaintenanceClaim, trace: string[], ready: boolean, badAck: boolean, failEnsure: boolean;
let during: ((op: string) => Promise<void>) | undefined;
const service = async () => (await f.c.db.query.services.findFirst())!;
const sleep = async () => (await f.c.db.query.nodeSleepTransitions.findFirst())!;
const maintenance = async () => (await f.c.db.query.nodeWakeMaintenance.findFirst())!;
beforeEach(async () => {
  f = await servingReceiptFixture('file::memory:');
  await f.c.db.update(services).set({ sleepAfterMinutes: 5 }); await nodeWakeKey(f.c.db, 4, true);
  const proof = await nodeSleepEvidence(f.c.db), admission = (await admitNodeSleep(f.c.db, await service(), proof.token))!;
  await advanceNodeSleep(f.c.db, admission, 'accepted', 'fencing');
  await bindNodeSleepCatcher(f.c.db, admission, { id: 'c'.repeat(64), image: `sha256:${'d'.repeat(64)}` });
  for (const [from, to] of [['fencing', 'prepared'], ['prepared', 'routing'], ['routing', 'routed'], ['routed', 'stopping']] as const) await advanceNodeSleep(f.c.db, admission, from, to);
  const row = await sleep();
  await completeNodeSleep(f.c.db, admission, { ...nodeSleepCommand(admission, 'stop'), complete: true,
    items: row.targets.map(({ id, name, deploymentId }) => ({ id, name, deploymentId, running: false })) });
  claim = (await claimNodeWakeMaintenance(f.c.db, 4))!;
  trace = []; ready = true; badAck = false; failEnsure = false; during = undefined;
  io.sealed.mockReset().mockResolvedValue(true); io.agent.mockReset().mockImplementation(async (_db, _node, op, params) => {
    await during?.(op);
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps: ['wake.catcher', 'wake.catcher.prepare', 'docker.readiness', 'proxy.routingAck', 'proxy.orderedWrite'] })}`] };
    if (op === 'wake.catcher.prepare') {
      trace.push('ensure'); if (failEnsure) throw new Error('Catcher reply lost');
      return { exitCode: 0, lines: [`ND-WAKE-CATCHER ${JSON.stringify({ id: 'e'.repeat(64), name: `ninedeploy-wake-g-${'a'.repeat(32)}`, image: `sha256:${'f'.repeat(64)}`, created: true })}`] };
    }
    if (op === 'docker.readiness') {
      expect(params.targets).toEqual([{ id: 'e'.repeat(64), name: `ninedeploy-wake-g-${'a'.repeat(32)}` }]);
      trace.push('ready'); return { exitCode: 0, lines: [`ND-READINESS ${JSON.stringify({ requestId: params.requestId, complete: true,
        items: params.targets.map((target: object) => ({ ...target, status: 'running', health: 'none', restarts: 0, failingStreak: 0, ready })) })}`] };
    }
    if (op === 'proxy.writeConfig') return { exitCode: 0, lines: ['proxy-config x unchanged'] };
    if (op === 'proxy.writeOrderedConfig') {
      trace.push('route'); expect((await sleep()).catcherId).toBe((await maintenance()).phase === 'completed' ? 'e'.repeat(64) : 'c'.repeat(64));
      if ((await service()).status !== 'stopped') {
        expect(params.content).toContain(`http://ninedeploy-wake-g-${'a'.repeat(32)}:8080`);
        expect(params.content).not.toContain('http://ninedeploy-wake:8080');
      }
      return { exitCode: 0, lines: [`ND-PROXY-WRITE ${JSON.stringify({ revision: params.revision, requestId: params.requestId,
        contentHash: createHash('sha256').update(params.content).digest('hex'), complete: true, changed: true })}`] };
    }
    if (op === 'docker.inspect') return { exitCode: 0, lines: ['running'] };
    if (op === 'proxy.confirmRouting') { trace.push('ack'); return { exitCode: 0, lines: [`ND-PROXY-ROUTING ${badAck ? '0'.repeat(64) : createHash('sha256').update(params.content).digest('hex')}`] }; }
    throw new Error(`Unexpected operation ${op}`);
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); f.c.client?.close(); });
const execute = () => executeNodeWakeMaintenance(f.c.db, claim, nodeWakeMaintenanceRuntime(f.c.db));
it('proves catcher readiness and exact ordered routing before atomically rebinding sleeping services', async () => {
  expect(await execute()).toEqual({ state: 'completed', rebound: 1 });
  expect(trace).toEqual(['ensure', 'ready', 'ready', 'ready', 'route', 'ack']);
  expect((await sleep()).catcherId).toBe('e'.repeat(64)); expect((await service()).asleepAt).not.toBeNull();
  expect((await maintenance()).phase).toBe('completed');
  expect((await sleep()).catcherName).toBe(`ninedeploy-wake-g-${'a'.repeat(32)}`);
  expect(await renderDynamicConfig(f.c.db, { serverId: 4 })).toContain(`http://ninedeploy-wake-g-${'a'.repeat(32)}:8080`);
});
it('settles confirmed bindings before the next queued routing write can render a stale backend', async () => {
  let queued: Promise<void> | undefined;
  during = async op => {
    if (op !== 'proxy.confirmRouting') return;
    during = undefined;
    queued = writeDynamicConfig(f.c.db, { requireNode: 4, confirmNodeRouting: true, requireOrderedNode: true });
  };
  expect(await execute()).toEqual({ state: 'completed', rebound: 1 }); await queued;
  const configs = io.agent.mock.calls.filter(call => call[2] === 'proxy.writeOrderedConfig').map(call => call[3].content as string);
  expect(configs).toHaveLength(2);
  expect(configs.every(content => content.includes(`http://ninedeploy-wake-g-${'a'.repeat(32)}:8080`) && !content.includes('http://ninedeploy-wake:8080'))).toBe(true);
});
it('does not settle a late routing acknowledgement after a different worker takes over', async () => {
  let recovered: NodeWakeMaintenanceClaim | undefined;
  during = async op => {
    if (op !== 'proxy.confirmRouting') return;
    during = undefined; await f.c.db.update(nodeWakeMaintenance).set({ leaseUntil: new Date(0) });
    recovered = (await claimNodeWakeMaintenance(f.c.db, 4))!;
  };
  expect(await execute()).toMatchObject({ state: 'held' });
  expect((await sleep()).catcherId).toBe('c'.repeat(64));
  expect((await maintenance()).workerToken).toBe(recovered!.workerToken);
});
it('rejects forged, cross-node and recovered-worker promotion permissions before publishing', async () => {
  const target = { id: 'e'.repeat(64), image: `sha256:${'f'.repeat(64)}`, name: `ninedeploy-wake-g-${'a'.repeat(32)}` };
  await expect(renderDynamicConfig(f.c.db, { serverId: 4, catcherPromotion: {} as NodeCatcherRoutePromotion })).rejects.toThrow(/promotion/);
  await recordNodeWakeMaintenanceCatcher(f.c.db, claim, target);
  const permission = await prepareNodeCatcherRouting(f.c.db, claim);
  await expect(renderDynamicConfig(f.c.db, { serverId: 5, catcherPromotion: permission })).rejects.toThrow(/promotion/);
  await f.c.db.update(nodeWakeMaintenance).set({ leaseUntil: new Date(0) }); await claimNodeWakeMaintenance(f.c.db, 4);
  await expect(renderDynamicConfig(f.c.db, { serverId: 4, catcherPromotion: permission })).rejects.toThrow(/ownership|lease/);
  expect(io.agent).not.toHaveBeenCalled();
});
it('keeps an uncertain ensure held behind the durable admission barrier', async () => {
  failEnsure = true; expect(await execute()).toMatchObject({ state: 'held' });
  expect(trace).toEqual(['ensure']); expect(await maintenance()).toMatchObject({ phase: 'preparing', workerToken: null });
  const row = await sleep(); expect(await admitNodeWake(f.c.db, await service(), { nodeId: 4, token: row.wakeToken, catcherId: row.catcherId!, demandAt: Date.now(), receivedAt: Date.now() })).toBeNull();
});
it('repeats reachability and routing after an unconfirmed write without rebinding prematurely', async () => {
  badAck = true; expect(await execute()).toMatchObject({ state: 'held' });
  expect((await sleep()).catcherId).toBe('c'.repeat(64)); expect((await maintenance()).phase).toBe('routing');
  claim = (await claimNodeWakeMaintenance(f.c.db, 4))!; badAck = false;
  expect(await execute()).toEqual({ state: 'completed', rebound: 1 });
  expect(trace.filter(item => item === 'ready')).toHaveLength(6); expect(trace.filter(item => item === 'ack')).toHaveLength(2);
});
it('does not revive a service superseded by actual Stop during catcher readiness', async () => {
  during = async op => { if (op === 'docker.readiness') { during = undefined; await acceptNodeLifecycleIntent(f.c.db, await service(), 'stop'); } };
  expect(await execute()).toEqual({ state: 'completed', rebound: 0 });
  expect((await service()).status).toBe('stopped'); expect((await sleep()).phase).toBe('superseded');
});
it('does not replace the catcher without its persisted node credential', async () => {
  await f.c.db.delete(settings).where(eq(settings.key, 'node_wake_key_4'));
  expect(await execute()).toMatchObject({ state: 'held' }); expect(trace).toEqual([]);
});
it('a late ensure response cannot settle or release a recovered worker', async () => {
  let recovered: NodeWakeMaintenanceClaim | undefined;
  during = async op => { if (op === 'wake.catcher.prepare') { during = undefined;
    await f.c.db.update(nodeWakeMaintenance).set({ leaseUntil: new Date(0) }); recovered = (await claimNodeWakeMaintenance(f.c.db, 4))!;
  } };
  expect(await execute()).toMatchObject({ state: 'held' });
  expect((await maintenance()).workerToken).toBe(recovered!.workerToken); expect((await sleep()).catcherId).toBe('c'.repeat(64));
  claim = recovered!; expect(await execute()).toEqual({ state: 'completed', rebound: 1 });
});
it('holds an unreachable replacement without publishing or updating sleeping bindings', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); ready = false;
  const pending = execute(); let result: Awaited<ReturnType<typeof execute>> | undefined;
  void pending.then(value => { result = value; });
  for (let i = 0; i < 100 && !result; i++) await vi.advanceTimersByTimeAsync(250);
  expect(result).toBeDefined();
  expect(await pending).toMatchObject({ state: 'held', reason: expect.stringMatching(/readiness/) });
  expect(trace).not.toContain('route'); expect((await sleep()).catcherId).toBe('c'.repeat(64));
  expect(await maintenance()).toMatchObject({ phase: 'preparing', workerToken: null });
});
