import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { services } from '@ninedeploy/db';
import { servingReceiptFixture } from '../fixtures/servingTrafficReceipt.js';
import { nodeSleepEvidence } from '../fixtures/nodeSleepEvidence.js';
import { admitNodeSleep, recoverNodeSleep, type NodeSleepAdmission } from '../../src/lib/nodeSleepAuthority.js';
import { executeNodeSleep, type NodeSleepControllerDeps } from '../../src/lib/nodeSleepController.js';
import { reserveServiceRuntimeOwner } from '../../src/lib/serviceRuntimeOwner.js';
import { renderDynamicConfig } from '../../src/engine/proxy.js';
import { nodeSleepRuntime } from '../../src/lib/nodeSleepRuntime.js';

const transport = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: transport.agent, agentTransportSealed: transport.sealed }));

let f: Awaited<ReturnType<typeof servingReceiptFixture>>, admission: NodeSleepAdmission, deps: NodeSleepControllerDeps;
let trace: string[], catcherReady: boolean, appReady: boolean, loseRoute: boolean, loseStop: boolean, stopped: boolean;
let during: ((op: string) => Promise<void>) | undefined;
const service = async () => (await f.c.db.query.services.findFirst())!;
const journal = async () => (await f.c.db.query.nodeSleepTransitions.findFirst())!;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  f = await servingReceiptFixture('file::memory:'); await f.c.db.update(services).set({ sleepAfterMinutes: 5, healthCheck: 'tcp', healthTimeoutSeconds: 10 });
  const proof = await nodeSleepEvidence(f.c.db); admission = (await admitNodeSleep(f.c.db, await service(), proof.token))!;
  trace = []; catcherReady = true; appReady = true; loseRoute = false; loseStop = false; stopped = false; during = undefined;
  deps = {
    sealed: vi.fn(async () => true),
    agent: vi.fn(async (node, op, params) => {
      expect(node).toBe(4); await during?.(op);
      if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps: ['docker.mutations', 'docker.readiness', 'proxy.routingAck', 'proxy.orderedWrite', 'wake.catcher.prepare'] })}`] };
      if (op === 'docker.runtimeFence') { trace.push('fence'); const { timeoutMs: _timeout, ...request } = params; return { exitCode: 0, lines: [`ND-RUNTIME-FENCE ${JSON.stringify({ ...request, complete: true })}`] }; }
      if (op === 'wake.catcher.prepare') { trace.push('ensure'); expect(params.key).toMatch(/^[a-f0-9]{64}$/); return { exitCode: 0, lines: [`ND-WAKE-CATCHER ${JSON.stringify({ id: 'c'.repeat(64), name: `ninedeploy-wake-g-${'b'.repeat(32)}`, image: `sha256:${'d'.repeat(64)}`, created: false })}`] }; }
      if (op === 'docker.readiness') {
        const catcher = (params.targets as { name: string }[])[0]!.name.startsWith('ninedeploy-wake'); trace.push(catcher ? 'catcher-ready' : 'app-ready');
        return { exitCode: 0, lines: [`ND-READINESS ${JSON.stringify({ requestId: params.requestId, complete: true,
          items: (params.targets as { id: string; name: string }[]).map(target => ({ ...target, status: 'running', health: 'none', restarts: 0, failingStreak: 0, ready: catcher ? catcherReady : appReady })) })}`] };
      }
      if (op === 'docker.stopSet') {
        trace.push('stop'); stopped = true; if (loseStop) { loseStop = false; throw new Error('Stop reply lost'); }
        return { exitCode: 0, lines: [`ND-STOPPED-SET ${JSON.stringify({ requestId: params.requestId, serviceId: params.serviceId, revision: params.revision, complete: true,
          items: (params.targets as { id: string; name: string; deploymentId: number }[]).map(target => ({ ...target, running: false })) })}`] };
      }
      throw new Error(`Unexpected operation ${op}`);
    }),
    route: vi.fn(async (node, promotion) => {
      const output = await renderDynamicConfig(f.c.db, { serverId: node, ...(promotion ? { wakePromotion: promotion } : {}) });
      trace.push(promotion ? 'route:app' : 'route:catcher');
      const router = output.split('    web_1:\n')[1]!.split(/\n {4}\S/)[0];
      expect(router).toContain(`service: ${promotion ? 'svc_web_1' : 'svc_ninedeploy_node_wake'}`);
      await during?.('route');
      if (!promotion && loseRoute) { loseRoute = false; throw new Error('Catcher routing acknowledgement lost'); }
    }),
    drain: vi.fn(async () => { trace.push('drain'); await during?.('drain'); await new Promise(resolve => setTimeout(resolve, 2000)); }),
  };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); f.c.client?.close(); });
async function finish<T>(promise: Promise<T>): Promise<T> {
  let done = false; void promise.then(() => { done = true; }, () => { done = true; });
  for (let n = 0; n < 160 && !done; n++) await vi.advanceTimersByTimeAsync(250);
  expect(done).toBe(true); return promise;
}
it('confirms a reachable catcher, fallback routing and drain before stopping captured immutable IDs', async () => {
  expect(await finish(executeNodeSleep(f.c.db, admission, deps))).toEqual({ state: 'asleep' });
  expect(trace.slice(0, 2)).toEqual(['fence', 'ensure']); expect(trace.at(-1)).toBe('stop');
  expect(trace.indexOf('route:catcher')).toBeLessThan(trace.indexOf('drain'));
  expect(trace.filter(item => item === 'catcher-ready')).toHaveLength(9);
  expect((await service()).asleepAt).not.toBeNull(); expect(await journal()).toMatchObject({ phase: 'asleep', fallbackRouting: true, workerToken: null });
  const stop = vi.mocked(deps.agent).mock.calls.find(call => call[1] === 'docker.stopSet')![2];
  expect(stop.targets).toEqual([{ id: 'a'.repeat(64), name: 'web-9', deploymentId: 9 }]);
});
it('does not publish or stop if the catcher cannot accept connections', async () => {
  catcherReady = false;
  expect(await finish(executeNodeSleep(f.c.db, admission, deps))).toMatchObject({ state: 'aborted' });
  expect(deps.route).not.toHaveBeenCalled(); expect(stopped).toBe(false); expect((await service()).asleepAt).toBeNull();
});
it('restores ready app routing after an uncertain catcher route without issuing Stop', async () => {
  loseRoute = true;
  expect(await finish(executeNodeSleep(f.c.db, admission, deps))).toMatchObject({ state: 'aborted' });
  expect(trace.slice(-4)).toEqual(['app-ready', 'app-ready', 'app-ready', 'route:app']);
  expect(stopped).toBe(false); expect((await service()).asleepAt).toBeNull(); expect(await journal()).toMatchObject({ phase: 'completed', fallbackRouting: false });
});
it('recovers failed restoration by restoring the app, never resuming the obsolete idle decision', async () => {
  loseRoute = true; appReady = false;
  expect(await finish(executeNodeSleep(f.c.db, admission, deps))).toMatchObject({ state: 'held' });
  expect(await journal()).toMatchObject({ phase: 'restoring', fallbackRouting: true, workerToken: null });
  vi.setSystemTime(Date.now() + 60_000); appReady = true;
  const recovered = (await recoverNodeSleep(f.c.db, 1))!;
  expect(await finish(executeNodeSleep(f.c.db, recovered, deps))).toEqual({ state: 'aborted' });
  expect(stopped).toBe(false); expect(trace.at(-1)).toBe('route:app');
});
it('refuses to stop after the idle decision expires during drain and restores app routing', async () => {
  during = async op => { if (op === 'drain') vi.setSystemTime(Date.now() + 30_001); };
  expect(await finish(executeNodeSleep(f.c.db, admission, deps))).toMatchObject({ state: 'aborted' });
  expect(stopped).toBe(false); expect(trace.at(-1)).toBe('route:app');
});
it('restores app routing if sleep is disabled during catcher publication', async () => {
  during = async op => { if (op === 'route') { during = undefined; await f.c.db.update(services).set({ sleepAfterMinutes: null }); } };
  expect(await finish(executeNodeSleep(f.c.db, admission, deps))).toMatchObject({ state: 'aborted' });
  expect(stopped).toBe(false); expect(trace.at(-1)).toBe('route:app'); expect((await service()).asleepAt).toBeNull();
  expect(await journal()).toMatchObject({ phase: 'completed', fallbackRouting: false });
});
it('reconfirms fallback routing and repeats the identical Stop after a lost receipt', async () => {
  loseStop = true; expect(await finish(executeNodeSleep(f.c.db, admission, deps))).toMatchObject({ state: 'held' });
  expect(stopped).toBe(true); expect((await service()).asleepAt).toBeNull(); expect((await journal()).phase).toBe('stopping');
  vi.setSystemTime(Date.now() + 60_000);
  const recovered = (await recoverNodeSleep(f.c.db, 1))!;
  expect(await finish(executeNodeSleep(f.c.db, recovered, deps))).toEqual({ state: 'asleep' });
  const requests = vi.mocked(deps.agent).mock.calls.filter(call => call[1] === 'docker.stopSet').map(call => call[2]);
  expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
});
it.each(['route', 'drain', 'docker.stopSet'])('a newer deploy supersedes sleep during %s', async op => {
  during = async current => { if (current === op) { during = undefined; await reserveServiceRuntimeOwner(f.c.db, 1, 'deploy', admission.owner); } };
  expect(await finish(executeNodeSleep(f.c.db, admission, deps))).toEqual({ state: 'superseded' });
  expect((await service()).asleepAt).toBeNull(); if (op !== 'docker.stopSet') expect(stopped).toBe(false);
});
it('cancels an unpublished stale sleep without touching the node', async () => {
  vi.setSystemTime(Date.now() + 30_001);
  expect(await finish(executeNodeSleep(f.c.db, admission, deps))).toMatchObject({ state: 'aborted' });
  expect(deps.agent).not.toHaveBeenCalled(); expect(stopped).toBe(false);
});
it('uses the production adapter to confirm ordered catcher routing before the immutable Stop', async () => {
  vi.useRealTimers();
  transport.sealed.mockReset().mockResolvedValue(true); transport.agent.mockReset().mockImplementation(async (_db, node, op, params, _sink, options) => {
    if (op === 'proxy.writeConfig') return { exitCode: 0, lines: ['proxy-config x unchanged'] };
    if (op === 'proxy.writeOrderedConfig') {
      expect(stopped).toBe(false); expect(params.content).toContain('service: svc_ninedeploy_node_wake'); trace.push('ordered-write');
      return { exitCode: 0, lines: [`ND-PROXY-WRITE ${JSON.stringify({ revision: params.revision, requestId: params.requestId,
        contentHash: createHash('sha256').update(params.content).digest('hex'), complete: true, changed: true })}`] };
    }
    if (op === 'docker.inspect') return { exitCode: 0, lines: ['running'] };
    if (op === 'proxy.confirmRouting') { trace.push('ack'); return { exitCode: 0, lines: [`ND-PROXY-ROUTING ${createHash('sha256').update(params.content).digest('hex')}`] }; }
    return deps.agent(node, op, params, options);
  });
  expect(await executeNodeSleep(f.c.db, admission, nodeSleepRuntime(f.c.db))).toEqual({ state: 'asleep' });
  expect(trace.indexOf('ordered-write')).toBeLessThan(trace.indexOf('stop'));
  expect(trace.lastIndexOf('ack')).toBeLessThan(trace.indexOf('stop')); expect((await service()).asleepAt).not.toBeNull();
});
