import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { eq, services, type Service } from '@ninedeploy/db';
import { servingReceiptFixture } from '../fixtures/servingTrafficReceipt.js';
import { nodeSleepEvidence } from '../fixtures/nodeSleepEvidence.js';
import { admitNodeSleep, admitNodeWake, advanceNodeSleep, bindNodeSleepCatcher, completeNodeSleep, nodeSleepCommand, recoverNodeSleep, type NodeSleepAdmission } from '../../src/lib/nodeSleepAuthority.js';
import { executeNodeWake, type NodeWakeControllerDeps } from '../../src/lib/nodeWakeController.js';
import { reserveServiceRuntimeOwner } from '../../src/lib/serviceRuntimeOwner.js';
import { nodeWakeKey } from '../../src/lib/nodeWakeKey.js';
import { renderDynamicConfig, writeDynamicConfig } from '../../src/engine/proxy.js';
import { nodeWakeRuntime } from '../../src/lib/nodeWakeRuntime.js';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';
import { reserveNodeProxyWrite, bindNodeProxyWrite } from '../../src/lib/nodeProxyAuthority.js';
import { withRoutingAck } from '../../src/lib/proxyRoutingAck.js';

const transport = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: transport.agent, agentTransportSealed: transport.sealed }));

let f: Awaited<ReturnType<typeof servingReceiptFixture>>, deps: NodeWakeControllerDeps, trace: string[], wake: NodeSleepAdmission;
let healthy: boolean, portReady: boolean, badStart: boolean, lostStart: boolean, lostRoute: boolean, caps: string[];
let during: ((op: string) => Promise<void>) | undefined;
const service = async () => (await f.c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
const journal = async () => (await f.c.db.query.nodeSleepTransitions.findFirst())!;
async function setup(mode: Service['healthCheck'] = 'tcp', healthPath = '/') {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  f = await servingReceiptFixture('file::memory:');
  await f.c.db.update(services).set({ sleepAfterMinutes: 5, healthCheck: mode, healthPath, healthTimeoutSeconds: 10 });
  const proof = await nodeSleepEvidence(f.c.db), sleep = (await admitNodeSleep(f.c.db, await service(), proof.token))!;
  await nodeWakeKey(f.c.db, 4, true);
  await advanceNodeSleep(f.c.db, sleep, 'accepted', 'fencing');
  await bindNodeSleepCatcher(f.c.db, sleep, { id: 'c'.repeat(64), image: `sha256:${'d'.repeat(64)}` });
  for (const [from, to] of [['fencing', 'prepared'], ['prepared', 'routing'], ['routing', 'routed'], ['routed', 'stopping']] as const) await advanceNodeSleep(f.c.db, sleep, from, to);
  const row = await journal();
  await completeNodeSleep(f.c.db, sleep, { ...nodeSleepCommand(sleep, 'stop'), complete: true,
    items: row.targets.map(({ id, name, deploymentId }) => ({ id, name, deploymentId, running: false })) });
  wake = (await admitNodeWake(f.c.db, await service(), { nodeId: 4, token: row.wakeToken, catcherId: row.catcherId!, receivedAt: Date.now(), demandAt: Date.now() }))!;
  trace = []; healthy = true; portReady = true; badStart = false; lostStart = false; lostRoute = false; during = undefined;
  caps = ['docker.mutations', 'docker.startSet', 'docker.readiness', 'proxy.routingAck', 'proxy.orderedWrite', 'wake.catcher'];
  deps = {
    sealed: vi.fn(async () => true),
    agent: vi.fn(async (nodeId, op, params) => {
      expect(nodeId).toBe(4); await during?.(op);
      if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps })}`] };
      if (op === 'docker.runtimeFence') {
        trace.push('fence'); const { timeoutMs: _timeout, ...request } = params;
        return { exitCode: 0, lines: [`ND-RUNTIME-FENCE ${JSON.stringify({ ...request, complete: true })}`] };
      }
      if (op === 'docker.startSet') {
        trace.push('start'); if (lostStart) { lostStart = false; throw new Error('Start reply lost'); }
        const targets = (params.targets as { id: string; name: string; deploymentId: number }[]).map(target => ({ ...target, ...(badStart ? { id: 'f'.repeat(64) } : {}), running: true }));
        return { exitCode: 0, lines: [`ND-STARTED-SET ${JSON.stringify({ requestId: params.requestId, serviceId: params.serviceId, revision: params.revision, complete: true, items: targets })}`] };
      }
      if (op === 'docker.readiness') {
        trace.push(`ready:${params.mode}`);
        return { exitCode: 0, lines: [`ND-READINESS ${JSON.stringify({ requestId: params.requestId, complete: true,
          items: (params.targets as { id: string; name: string }[]).map(target => ({ ...target, status: 'running', health: 'healthy', restarts: 0, failingStreak: 0, ready: healthy && (params.mode !== 'tcp' || portReady) })) })}`] };
      }
      throw new Error(`Unexpected operation ${op}`);
    }),
    route: vi.fn(async (nodeId, promotion, _signal, settle) => {
      expect((await service()).asleepAt).not.toBeNull();
      const head = (await reserveNodeProxyWrite(f.c.db, nodeId, { adopt: true }))!;
      const output = await renderDynamicConfig(f.c.db, { serverId: nodeId, wakePromotion: promotion });
      const bound = await bindNodeProxyWrite(f.c.db, head, withRoutingAck(output));
      expect(output).toContain('service: svc_web_1'); trace.push('route'); await during?.('route');
      if (lostRoute) { lostRoute = false; throw new Error('Routing acknowledgement lost'); }
      await settle(bound);
    }),
  };
}
beforeEach(() => setup());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); f.c.client?.close(); });
async function finish<T>(promise: Promise<T>): Promise<T> {
  let done = false; void promise.then(() => { done = true; }, () => { done = true; });
  for (let n = 0; n < 100 && !done; n++) await vi.advanceTimersByTimeAsync(250);
  expect(done).toBe(true); return promise;
}
it('fences and starts immutable targets, then requires three stable readiness samples and confirmed app routing', async () => {
  expect(await finish(executeNodeWake(f.c.db, wake, deps))).toEqual({ state: 'completed' });
  expect(trace).toEqual(['fence', 'start', 'ready:tcp', 'ready:tcp', 'ready:tcp', 'route']);
  expect((await service()).asleepAt).toBeNull(); expect(await journal()).toMatchObject({ phase: 'completed', fallbackRouting: false, workerToken: null });
  const request = vi.mocked(deps.agent).mock.calls.find(call => call[1] === 'docker.startSet')![2];
  expect(request.targets).toEqual([{ id: 'a'.repeat(64), name: 'web-9', deploymentId: 9 }]);
});
it('keeps an unready application behind the catcher without declaring wake complete', async () => {
  healthy = false;
  expect(await finish(executeNodeWake(f.c.db, wake, deps))).toMatchObject({ state: 'held', reason: expect.stringMatching(/readiness/) });
  expect(deps.route).not.toHaveBeenCalled(); expect((await service()).asleepAt).not.toBeNull();
  expect(await journal()).toMatchObject({ phase: 'readiness', fallbackRouting: true, workerToken: null });
});
it('recovers an unconfirmed route with fresh readiness and no repeated Start', async () => {
  lostRoute = true; expect(await finish(executeNodeWake(f.c.db, wake, deps))).toMatchObject({ state: 'held' });
  expect((await journal()).phase).toBe('publishing');
  const recovered = (await recoverNodeSleep(f.c.db, 1))!;
  expect(await finish(executeNodeWake(f.c.db, recovered, deps))).toEqual({ state: 'completed' });
  expect(trace.filter(item => item === 'start')).toHaveLength(1);
  expect(trace.filter(item => item === 'ready:tcp')).toHaveLength(6);
  expect(trace.filter(item => item === 'route')).toHaveLength(2);
});
it('retries a lost Start reply with the identical command and target set', async () => {
  lostStart = true; expect(await finish(executeNodeWake(f.c.db, wake, deps))).toMatchObject({ state: 'held' });
  expect((await journal()).phase).toBe('starting');
  const recovered = (await recoverNodeSleep(f.c.db, 1))!;
  expect(await finish(executeNodeWake(f.c.db, recovered, deps))).toEqual({ state: 'completed' });
  const requests = vi.mocked(deps.agent).mock.calls.filter(call => call[1] === 'docker.startSet').map(call => call[2]);
  expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
});
it('does not enter readiness on a foreign Start receipt', async () => {
  badStart = true; expect(await finish(executeNodeWake(f.c.db, wake, deps))).toMatchObject({ state: 'held' });
  expect(trace).toEqual(['fence', 'start']); expect((await journal()).phase).toBe('starting');
});
it.each(['docker.startSet', 'docker.readiness', 'route'])('a newer Stop supersedes wake during %s without clearing asleep state', async op => {
  during = async current => { if (current === op) { during = undefined; await reserveServiceRuntimeOwner(f.c.db, 1, 'stop', wake.owner); } };
  expect(await finish(executeNodeWake(f.c.db, wake, deps))).toEqual({ state: 'superseded' });
  expect((await service()).asleepAt).not.toBeNull(); expect(await journal()).toMatchObject({ phase: 'superseded', fallbackRouting: true });
  if (op !== 'route') expect(deps.route).not.toHaveBeenCalled();
});
it('requires the sealed mutation, readiness and ordered routing capabilities before starting', async () => {
  caps = ['docker.readiness'];
  expect(await finish(executeNodeWake(f.c.db, wake, deps))).toMatchObject({ state: 'held' });
  expect(trace).toEqual([]); expect((await journal()).phase).toBe('accepted');
});
it.each(['http', 'running', 'command'] as const)('requires application TCP reachability after the configured %s policy', async mode => {
  f.c.client?.close(); await setup(mode);
  expect(await finish(executeNodeWake(f.c.db, wake, deps))).toEqual({ state: 'completed' });
  expect(trace.filter(item => item.startsWith('ready:'))).toEqual([`ready:${mode === 'http' ? 'auto' : mode}`, `ready:${mode === 'http' ? 'auto' : mode}`, `ready:${mode === 'http' ? 'auto' : mode}`, 'ready:tcp', 'ready:tcp', 'ready:tcp']);
});
it('does not route a running application whose port is still closed', async () => {
  f.c.client?.close(); await setup('running'); portReady = false;
  expect(await finish(executeNodeWake(f.c.db, wake, deps))).toMatchObject({ state: 'held', reason: expect.stringMatching(/readiness/) });
  expect(trace.filter(item => item === 'ready:running')).toHaveLength(3);
  expect(trace.some(item => item === 'ready:tcp')).toBe(true); expect(deps.route).not.toHaveBeenCalled();
  expect((await service()).asleepAt).not.toBeNull();
});
it('a recovered worker excludes its predecessor without releasing the new lease', async () => {
  lostRoute = true; await finish(executeNodeWake(f.c.db, wake, deps));
  const recovered = (await recoverNodeSleep(f.c.db, 1))!;
  expect(await finish(executeNodeWake(f.c.db, wake, deps))).toMatchObject({ state: 'held' });
  expect((await journal()).workerToken).toBe(recovered.workerToken);
  expect(await finish(executeNodeWake(f.c.db, recovered, deps))).toEqual({ state: 'completed' });
});
it('uses strict HTTP readiness with the configured path and query before publishing', async () => {
  f.c.client?.close(); await setup('http-strict', '/ready?check=1');
  expect(await finish(executeNodeWake(f.c.db, wake, deps))).toEqual({ state: 'completed' });
  const samples = vi.mocked(deps.agent).mock.calls.filter(call => call[1] === 'docker.readiness');
  expect(samples).toHaveLength(3); expect(samples.every(call => call[2].mode === 'http-strict' && call[2].path === '/ready?check=1')).toBe(true);
});
it('does not start after cancellation or when the transport is unsealed', async () => {
  vi.mocked(deps.sealed).mockResolvedValue(false);
  expect(await finish(executeNodeWake(f.c.db, wake, deps))).toMatchObject({ state: 'held' });
  expect(trace).toEqual([]);
  const recovered = (await recoverNodeSleep(f.c.db, 1))!, abort = new AbortController(); abort.abort(new Error('cancelled'));
  expect(await finish(executeNodeWake(f.c.db, recovered, { ...deps, signal: abort.signal }))).toMatchObject({ state: 'held', reason: 'cancelled' });
  expect(trace).toEqual([]);
});
it('honors the actual explicit Stop admission arriving during readiness', async () => {
  during = async op => { if (op === 'docker.readiness') { during = undefined; await acceptNodeLifecycleIntent(f.c.db, await service(), 'stop'); } };
  expect(await finish(executeNodeWake(f.c.db, wake, deps))).toEqual({ state: 'superseded' });
  expect(deps.route).not.toHaveBeenCalled(); expect((await service()).status).toBe('stopped');
  expect((await f.c.db.query.nodeLifecycleIntents.findFirst())!.action).toBe('stop');
  expect((await journal()).phase).toBe('superseded');
});
it('uses the production runtime through queued rendering, ordered proxy writes and exact loaded-route acknowledgement', async () => {
  // Queued publication dynamically imports the node proxy. Exercise that real
  // module/I/O path on the real clock, outside the bounded fake-time driver.
  vi.useRealTimers();
  transport.sealed.mockReset().mockResolvedValue(true); transport.agent.mockReset().mockImplementation(async (_db, node, op, params, _sink, options) => {
    if (op === 'proxy.writeConfig') return { exitCode: 0, lines: ['proxy-config x unchanged'] };
    if (op === 'proxy.writeOrderedConfig') {
      expect((await service()).asleepAt).not.toBeNull(); expect(params.content).toContain('service: svc_web_1'); trace.push('ordered-write');
      return { exitCode: 0, lines: [`ND-PROXY-WRITE ${JSON.stringify({ revision: params.revision, requestId: params.requestId,
        contentHash: createHash('sha256').update(params.content).digest('hex'), complete: true, changed: true })}`] };
    }
    if (op === 'docker.inspect') return { exitCode: 0, lines: ['running'] };
    if (op === 'proxy.confirmRouting') { trace.push('ack'); return { exitCode: 0, lines: [`ND-PROXY-ROUTING ${createHash('sha256').update(params.content).digest('hex')}`] }; }
    return deps.agent(node, op, params, options);
  });
  expect(await executeNodeWake(f.c.db, wake, nodeWakeRuntime(f.c.db))).toEqual({ state: 'completed' });
  expect(trace).toEqual(['fence', 'start', 'ready:tcp', 'ready:tcp', 'ready:tcp', 'ordered-write', 'ack']);
  expect((await service()).asleepAt).toBeNull();
});
it('settles wake state before the next queued writer can restore the catcher route', async () => {
  vi.useRealTimers(); const written: string[] = []; let queued: Promise<void> | undefined;
  transport.sealed.mockReset().mockResolvedValue(true); transport.agent.mockReset().mockImplementation(async (_db, node, op, params, _sink, options) => {
    if (op === 'proxy.writeConfig') return { exitCode: 0, lines: ['proxy-config x unchanged'] };
    if (op === 'proxy.writeOrderedConfig') {
      written.push(params.content);
      return { exitCode: 0, lines: [`ND-PROXY-WRITE ${JSON.stringify({ revision: params.revision, requestId: params.requestId,
        contentHash: createHash('sha256').update(params.content).digest('hex'), complete: true, changed: true })}`] };
    }
    if (op === 'docker.inspect') return { exitCode: 0, lines: ['running'] };
    if (op === 'proxy.confirmRouting') {
      if (!queued) queued = writeDynamicConfig(f.c.db, { requireNode: node, confirmNodeRouting: true, requireOrderedNode: true });
      return { exitCode: 0, lines: [`ND-PROXY-ROUTING ${createHash('sha256').update(params.content).digest('hex')}`] };
    }
    return deps.agent(node, op, params, options);
  });
  const runtime = nodeWakeRuntime(f.c.db);
  expect(await executeNodeWake(f.c.db, wake, { ...runtime, route: async (...args) => {
    await runtime.route(...args); await queued;
  } })).toEqual({ state: 'completed' });
  expect(written).toHaveLength(2);
  expect(written[0]!.includes('http://ninedeploy-wake:8080'), 'ready-app publication control').toBe(false);
  expect(written[1]!.includes('http://ninedeploy-wake:8080'), 'a queued writer must not leave a completed wake on the catcher').toBe(false);
});
it.each([false, true])('retains fallback when a newer external writer reserves before settlement (bound=%s)', async bound => {
  const route = deps.route;
  deps.route = async (node, promotion, signal, settle) => route(node, promotion, signal, async authority => {
    const newer = (await reserveNodeProxyWrite(f.c.db, node, { adopt: true }))!;
    if (bound) {
      const fallback = await renderDynamicConfig(f.c.db, { serverId: node });
      expect(fallback).toContain('http://ninedeploy-wake:8080');
      await bindNodeProxyWrite(f.c.db, newer, withRoutingAck(fallback));
    }
    await settle(authority);
  });
  expect(await finish(executeNodeWake(f.c.db, wake, deps))).toMatchObject({ state: 'held', reason: expect.stringMatching(/superseded/) });
  expect((await service()).asleepAt).not.toBeNull();
  expect(await journal()).toMatchObject({ phase: 'publishing', fallbackRouting: true, workerToken: null });
  deps.route = route;
  const recovered = (await recoverNodeSleep(f.c.db, 1))!;
  expect(await finish(executeNodeWake(f.c.db, recovered, deps))).toEqual({ state: 'completed' });
  expect(trace.filter(item => item === 'start')).toHaveLength(1);
  expect((await service()).asleepAt).toBeNull();
});
