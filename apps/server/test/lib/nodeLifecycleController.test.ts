import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, services, servers, users, deployments, nodeLifecycleIntents, serviceTargets, fanoutTransitions, eq } from '@ninedeploy/db';
import { containerLifecycleRequest, type ContainerLifecycleReply } from '@ninedeploy/schemas';
import { acceptNodeLifecycleIntent, claimNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';
import { executeNodeLifecycleIntent, type NodeLifecycleControllerDeps } from '../../src/lib/nodeLifecycleController.js';

let c: ReturnType<typeof createDb>, deps: NodeLifecycleControllerDeps, trace: string[], running: boolean;
const target = { id: 'a'.repeat(64), name: 'web-9' };
const caps = ['docker.lifecycle', 'docker.lifecycle.generations', 'docker.lifecycle.creationFence', 'docker.lifecycle.retire', 'docker.recovery', 'docker.readiness', 'proxy.routingAck'];
const service = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
const stored = async () => (await c.db.query.nodeLifecycleIntents.findFirst())!;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); trace = []; running = false;
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(users).values({ id: 1, email: 'operator@example.test', passwordHash: 'fixture', isInstanceOperator: true });
  await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', ownerUserId: 1, serverId: 4, runtimeId: target.name,
    status: 'stopped', runtimeReplicas: 1, port: 3000, healthCheck: 'http-strict', healthTimeoutSeconds: 10 });
  deps = {
    sealed: vi.fn(async () => true),
    route: vi.fn(async () => { trace.push(`route:${(await service()).status}`); }),
    sleep: vi.fn(async ms => { trace.push('drain'); await new Promise(resolve => setTimeout(resolve, ms)); }),
    agent: vi.fn(async (serverId, op, params) => {
      expect(serverId).toBe(4);
      if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps })}`] };
      if (op === 'docker.identity') return { exitCode: 0, lines: [`ND-CONTAINER ${params.name === target.name ? JSON.stringify({ ...target, managed: 'service', serviceId: '1', deploymentId: '9' }) : 'null'}`] };
      if (op === 'docker.lifecycle') {
        const request = containerLifecycleRequest.parse(params);
        trace.push(request.targets.length ? `effect:${request.action}` : 'fence');
        if (request.targets.length) running = request.action === 'start';
        return { exitCode: 0, lines: [`ND-LIFECYCLE ${JSON.stringify({ requestId: request.requestId, serviceId: 1, deploymentId: request.deploymentId, action: request.action,
          revision: request.revision, complete: true, items: request.targets.map(t => ({ ...t, running: request.action === 'start' })) })}`] };
      }
      if (op === 'docker.readiness') {
        trace.push(`readiness:${(await service()).status}`);
        return { exitCode: 0, lines: [`ND-READINESS ${JSON.stringify({ requestId: params.requestId, complete: true, items: [{ ...target, status: running ? 'running' : 'exited', health: 'none', restarts: 0, failingStreak: 0, ready: running }] })}`] };
      }
      throw new Error(`Unexpected operation ${op}`);
    }),
  };
});
afterEach(() => { vi.useRealTimers(); c.client?.close(); });
async function finish<T>(promise: Promise<T>): Promise<T> {
  let done = false; void promise.then(() => { done = true; }, () => { done = true; });
  for (let n = 0; n < 100 && !done; n++) await vi.advanceTimersByTimeAsync(250);
  expect(done).toBe(true); return promise;
}

describe('durable panel node lifecycle execution', () => {
  it('restarts through durable Stop, drain, Start and readiness phases without early publication', async () => {
    running = true; await c.db.update(services).set({ status: 'running' }).where(eq(services.id, 1));
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'restart');
    expect((await service()).status).toBe('stopped');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'completed' });
    expect(trace).toEqual(['fence', 'route:stopped', 'drain', 'effect:stop', 'effect:start',
      'readiness:stopped', 'readiness:stopped', 'readiness:stopped', 'route:deploying']);
    expect((await service()).status).toBe('running');
  });
  it('keeps Start unpublished until all readiness rounds and routing confirmation complete', async () => {
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'start');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toMatchObject({ state: 'completed' });
    expect(trace).toEqual(['effect:start', 'readiness:stopped', 'readiness:stopped', 'readiness:stopped', 'route:deploying']);
    expect((await service()).status).toBe('running'); expect((await stored()).phase).toBe('completed');
  });
  it('fences Stop before discovery and confirms route removal and drain before stopping IDs', async () => {
    running = true; await c.db.update(services).set({ status: 'running' }).where(eq(services.id, 1));
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toMatchObject({ state: 'completed' });
    expect(trace).toEqual(['fence', 'route:stopped', 'drain', 'effect:stop']);
    expect(running).toBe(false); expect((await service()).status).toBe('stopped');
  });
  it('holds Stop after removing routing when an interrupted candidate has not been accounted for', async () => {
    running = true; await c.db.update(services).set({ status: 'running' }).where(eq(services.id, 1));
    await c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'deploying' });
    const original = deps.agent;
    deps.agent = async (...args) => {
      if (args[1] === 'docker.identity' && args[2].name === 'web-10') return { exitCode: 0, lines: ['ND-CONTAINER ' + JSON.stringify({ id: 'b'.repeat(64), name: 'web-10', managed: 'service', serviceId: '1', deploymentId: '10' })] };
      if (args[1] === 'docker.lifecycleRetire') return { exitCode: 1, lines: [] };
      return original(...args);
    };
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect(trace).toEqual(['fence', 'route:stopped', 'drain', 'effect:stop']);
    expect(running).toBe(false);
    expect(await stored()).toMatchObject({ phase: 'applying', reason: expect.stringContaining('lifecycleRetire') });
    expect((await service()).status).toBe('stopped');
  });
  it('fences every pre-Stop deployment before discovering the selected runtime', async () => {
    running = true; await c.db.update(services).set({ status: 'running' }).where(eq(services.id, 1));
    await c.db.insert(deployments).values([{ id: 10, serviceId: 1, status: 'deploying' }, { id: 12, serviceId: 1, status: 'queued' }]);
    const original = deps.agent; const fences: number[] = [];
    deps.agent = async (...args) => {
      if (args[1] === 'docker.lifecycle' && Array.isArray(args[2].targets) && args[2].targets.length === 0) fences.push(Number(args[2].deploymentId));
      return original(...args);
    };
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'completed' });
    expect(fences).toEqual([12]);
  });
  it.each(['docker.lifecycle.creationFence', 'docker.lifecycle.generations', 'docker.lifecycle.retire'])('does not attempt a candidate handoff without %s', async missing => {
    running = true; await c.db.update(services).set({ status: 'running' }).where(eq(services.id, 1));
    await c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'deploying' });
    const original = deps.agent;
    deps.agent = async (...args) => args[1] === 'agent.ping'
      ? { exitCode: 0, lines: ['ND-AGENT ' + JSON.stringify({ version: '0.18.9', caps: caps.filter(cap => cap !== missing) })] }
      : original(...args);
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect(trace).toEqual([]);
    expect((await stored()).reason).toMatch(/agent|update|owner/i);
  });
  it('holds an incomplete persisted candidate inventory before any node effects', async () => {
    running = true; await c.db.update(services).set({ status: 'running' }).where(eq(services.id, 1));
    await c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'deploying' });
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    await c.db.update(nodeLifecycleIntents).set({ snapshot: { ...intent.snapshot, candidateParticipants: [{ serverId: 4, targets: [] }] } })
      .where(eq(nodeLifecycleIntents.id, intent.id));
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect((await stored()).reason).toMatch(/placement.*unconfirmed/i);
    expect(trace).toEqual([]); expect(running).toBe(true);
  });
  it('retains a candidate name owned by a different service instead of stopping it', async () => {
    running = true; await c.db.update(services).set({ status: 'running' }).where(eq(services.id, 1));
    await c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'deploying' });
    const original = deps.agent;
    deps.agent = async (...args) => args[1] === 'docker.identity' && args[2].name === 'web-10'
      ? { exitCode: 0, lines: ['ND-CONTAINER ' + JSON.stringify({ id: 'b'.repeat(64), name: 'web-10', managed: 'service', serviceId: '2', deploymentId: '10' })] }
      : original(...args);
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect((await stored()).reason).toMatch(/ownership.*unconfirmed/i);
    expect(trace).toEqual(['fence']); expect(running).toBe(true);
  });
  it('keeps ordinary Stop compatible with an older agent when no deployment was in flight', async () => {
    running = true; await c.db.update(services).set({ status: 'running' }).where(eq(services.id, 1));
    await c.db.insert(deployments).values({ id: 12, serviceId: 1, status: 'queued' });
    const original = deps.agent;
    deps.agent = async (...args) => args[1] === 'agent.ping'
      ? { exitCode: 0, lines: ['ND-AGENT ' + JSON.stringify({ version: '0.18.9', caps: caps.filter(cap => cap !== 'docker.lifecycle.creationFence') })] }
      : original(...args);
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'completed' });
    expect(running).toBe(false);
  });
  it('holds a missing receipt without restoring running or losing the Stop phase', async () => {
    const original = deps.agent;
    deps.agent = async (...args) => args[1] === 'docker.lifecycle' ? { exitCode: 0, lines: [] } : original(...args);
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toMatchObject({ state: 'held' });
    expect((await stored()).phase).toBe('fencing'); expect((await service()).status).toBe('stopped');
    expect(deps.route).not.toHaveBeenCalled();
  });
  it('keeps unconfirmed Start routing pending and repeats readiness after lease-safe retry', async () => {
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'start');
    vi.mocked(deps.route).mockRejectedValueOnce(new Error('Routing unconfirmed'));
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toMatchObject({ state: 'held' });
    expect((await stored()).phase).toBe('routing'); expect((await service()).status).toBe('deploying');
    await vi.advanceTimersByTimeAsync(121_000);
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toMatchObject({ state: 'completed' });
    expect(trace.filter(s => s === 'effect:start')).toHaveLength(1);
    expect(trace.filter(s => s.startsWith('readiness'))).toHaveLength(6);
  });
  it('does not stop a container while routing removal is unconfirmed', async () => {
    running = true; vi.mocked(deps.route).mockRejectedValue(new Error('Routing unconfirmed'));
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toMatchObject({ state: 'held' });
    expect(trace).toEqual(['fence']); expect(running).toBe(true); expect((await stored()).phase).toBe('routing');
  });
  it('refuses plaintext and owner-disabled execution without any lifecycle effects', async () => {
    vi.mocked(deps.sealed).mockResolvedValue(false);
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toMatchObject({ state: 'held' });
    expect(trace).toEqual([]);
  });
  it('cannot publish an old Start response after a newer Stop intent', async () => {
    const original = deps.agent; let stopId = 0;
    deps.agent = async (...args) => {
      const response = await original(...args);
      if (args[1] === 'docker.lifecycle') stopId = (await acceptNodeLifecycleIntent(c.db, await service(), 'stop')).id;
      return response;
    };
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'start');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toMatchObject({ state: 'superseded' });
    expect(stopId).toBeGreaterThan(intent.id); expect((await service()).status).toBe('stopped');
    expect(deps.route).not.toHaveBeenCalled();
  });

  it('retains an unfinished command when its lease expires during a slow boundary', async () => {
    const original = deps.agent;
    deps.agent = async (...args) => {
      const result = await original(...args);
      if (args[1] === 'docker.lifecycle') vi.setSystemTime(Date.now() + 91_000);
      return result;
    };
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toMatchObject({ state: 'held' });
    expect(await stored()).toMatchObject({ phase: 'fencing', ownerToken: null, leaseUntil: null });
    expect(deps.route).not.toHaveBeenCalled();
  });

  it.each([
    ['request', (r: ContainerLifecycleReply) => { r.requestId = 'b'.repeat(32); }],
    ['service', (r: ContainerLifecycleReply) => { r.serviceId++; }],
    ['deployment', (r: ContainerLifecycleReply) => { r.deploymentId++; }],
    ['revision', (r: ContainerLifecycleReply) => { r.revision++; }],
    ['action', (r: ContainerLifecycleReply) => { r.action = 'stop'; }],
    ['missing target', (r: ContainerLifecycleReply) => { r.items = []; }],
    ['duplicate target', (r: ContainerLifecycleReply) => { r.items.push(r.items[0]!); }],
    ['wrong ID', (r: ContainerLifecycleReply) => { r.items[0]!.id = 'b'.repeat(64); }],
    ['wrong name', (r: ContainerLifecycleReply) => { r.items[0]!.name = 'replacement-9'; }],
    ['wrong state', (r: ContainerLifecycleReply) => { r.items[0]!.running = false; }],
  ] as const)('holds a Start receipt with %s mismatch without publishing it', async (_name, mutate) => {
    const original = deps.agent;
    deps.agent = async (...args) => {
      const result = await original(...args);
      if (args[1] === 'docker.lifecycle') {
        const receipt = JSON.parse(result.lines[0]!.slice(13)) as ContainerLifecycleReply;
        mutate(receipt); return { exitCode: 0, lines: [`ND-LIFECYCLE ${JSON.stringify(receipt)}`] };
      }
      return result;
    };
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'start');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect(await stored()).toMatchObject({ phase: 'applying', targets: [target] });
    expect((await service()).status).toBe('stopped'); expect(deps.route).not.toHaveBeenCalled();
  });

  it.each([
    { managed: null }, { serviceId: '2' }, { deploymentId: '10' }, { name: 'web-9-r2' }, { id: 'short-id' },
  ])('refuses unowned or malformed immutable identity %j before effects', async patch => {
    const original = deps.agent;
    deps.agent = async (...args) => args[1] === 'docker.identity'
      ? { exitCode: 0, lines: [`ND-CONTAINER ${JSON.stringify({ ...target, managed: 'service', serviceId: '1', deploymentId: '9', ...patch })}`] } : original(...args);
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'start');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect(trace).toEqual([]); expect((await stored()).phase).toBe('preparing');
  });

  it('requires the full serving shape without starting missing replicas or stopped capacity', async () => {
    await c.db.update(services).set({ runtimeReplicas: 2, replicas: 4 }).where(eq(services.id, 1));
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'start');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect(trace).toEqual([]); expect((await stored()).reason).toMatch(/web-9-r2.*missing/);
  });

  it('does not treat running containers with failed application readiness as ready', async () => {
    const original = deps.agent;
    deps.agent = async (...args) => {
      const result = await original(...args);
      if (args[1] !== 'docker.readiness') return result;
      const receipt = JSON.parse(result.lines[0]!.slice(13)); receipt.items[0].ready = false;
      return { exitCode: 0, lines: [`ND-READINESS ${JSON.stringify(receipt)}`] };
    };
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'start');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect(await stored()).toMatchObject({ phase: 'readiness', reason: expect.stringContaining('readiness') });
    expect((await service()).status).toBe('stopped'); expect(deps.route).not.toHaveBeenCalled();
  });

  it('keeps a durable Stop authoritative when it arrives during Start routing', async () => {
    deps.route = async () => { await acceptNodeLifecycleIntent(c.db, await service(), 'stop'); };
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'start');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'superseded' });
    expect((await service()).status).toBe('stopped');
    expect((await c.db.query.nodeLifecycleIntents.findFirst({ where: eq(nodeLifecycleIntents.id, intent.id) }))!.phase).toBe('superseded');
  });

  it('does not stop IDs after a new Start supersedes Stop during drain', async () => {
    running = true;
    deps.sleep = async () => { await acceptNodeLifecycleIntent(c.db, await service(), 'start'); };
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'superseded' });
    expect(running).toBe(true); expect(trace).toEqual(['fence', 'route:stopped']);
  });

  it('retries a lost Stop effect receipt with the original immutable payload and repeats routing/drain', async () => {
    running = true; const requests: unknown[] = [], original = deps.agent; let lost = false;
    deps.agent = async (...args) => {
      const result = await original(...args);
      if (args[1] === 'docker.identity' && lost) throw new Error('Recovery must not rediscover a same-name replacement');
      if (args[1] === 'docker.lifecycle' && (args[2].targets as unknown[]).length) {
        requests.push(args[2]);
        if (!lost) { lost = true; throw new Error('Lost response after actual effect'); }
      }
      return result;
    };
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect(await stored()).toMatchObject({ phase: 'applying', targets: [target] });
    await vi.advanceTimersByTimeAsync(121_000);
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'completed' });
    expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
    expect(trace.filter(s => s === 'route:stopped')).toHaveLength(2); expect(trace.filter(s => s === 'drain')).toHaveLength(2);
  });

  it('refuses a live competing lease and never repeats a completed command', async () => {
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    await claimNodeLifecycleIntent(c.db, intent.id);
    expect(await executeNodeLifecycleIntent(c.db, intent.id, deps)).toEqual({ state: 'busy' });
    expect(trace).toEqual([]);
    await vi.advanceTimersByTimeAsync(91_000);
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'completed' });
    const count = trace.length;
    expect(await executeNodeLifecycleIntent(c.db, intent.id, deps)).toEqual({ state: 'completed' }); expect(trace).toHaveLength(count);
  });

  it('does not clear a new owner after the previous owner resumes', async () => {
    let nextOwner: string | null = null;
    deps.route = async () => {
      vi.setSystemTime(Date.now() + 91_000);
      nextOwner = (await claimNodeLifecycleIntent(c.db, (await stored()).id))!.ownerToken;
    };
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'start');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'superseded' });
    expect(nextOwner).toBeTruthy(); expect(await stored()).toMatchObject({ phase: 'routing', ownerToken: nextOwner });
    expect((await service()).status).toBe('deploying');
  });

  it('holds owner-disabled lifecycle capability and preserves its reason without legacy fallback', async () => {
    const original = deps.agent;
    deps.agent = async (...args) => args[1] === 'agent.ping'
      ? { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps: caps.filter(cap => cap !== 'docker.lifecycle') })}`] } : original(...args);
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect((await stored()).reason).toMatch(/owner turned it off/); expect(trace).toEqual([]);
  });
});


async function installFanout() {
  await c.db.insert(servers).values({ id: 5, name: 'Fan-out', host: 'fanout.test', tokenEncrypted: 'fixture' });
  await c.db.insert(serviceTargets).values({ id: 42, serviceId: 1, serverId: 5, runtimeId: 'web-t5-7', status: 'running' });
  const child = { id: 'c'.repeat(64), name: 'web-t5-7' };
  const state = { running: true, ready: true, offline: false, lostEffect: false, identity: child, readiness: 0 };
  const requests: ReturnType<typeof containerLifecycleRequest.parse>[] = [];
  const original = deps.agent;
  deps.agent = async (...args) => {
    if (args[0] !== 5) return original(...args);
    if (state.offline) throw Error('Fan-out node offline');
    const [, op, params] = args;
    if (op === 'agent.ping') return { exitCode: 0, lines: ['ND-AGENT ' + JSON.stringify({ version: '0.19.0', caps })] };
    if (op === 'docker.identity') return { exitCode: 0, lines: ['ND-CONTAINER ' + JSON.stringify(params.name === child.name
      ? { ...state.identity, managed: 'service', serviceId: '1', deploymentId: '7' } : null)] };
    if (op === 'docker.lifecycle') {
      const request = containerLifecycleRequest.parse(params); requests.push(request);
      expect(request.deploymentId).toBe(7);
      if (request.targets.length) {
        expect(request.targets).toEqual([child]);
        state.running = request.action === 'start'; trace.push('fanout:' + request.action);
        if (state.lostEffect) { state.lostEffect = false; throw Error('Lost fan-out effect receipt'); }
      }
      return { exitCode: 0, lines: ['ND-LIFECYCLE ' + JSON.stringify({ ...request, targets: undefined, timeoutMs: undefined, complete: true,
        items: request.targets.map(item => ({ ...item, running: state.running })) })] };
    }
    if (op === 'docker.readiness') {
      state.readiness++; trace.push('fanout:readiness:' + (await service()).status);
      return { exitCode: 0, lines: ['ND-READINESS ' + JSON.stringify({ requestId: params.requestId, complete: true,
        items: [{ ...child, status: state.running ? 'running' : 'exited', health: 'none', restarts: 0, failingStreak: 0, ready: state.running && state.ready }] })] };
    }
    throw Error('Unexpected fan-out operation ' + op);
  };
  return { child, state, requests };
}

describe('multi-node durable lifecycle', () => {
  it.each(['start', 'stop', 'restart'] as const)('requires every node for %s and binds each generation independently', async action => {
    const fanout = await installFanout();
    const routes: Array<{ serverId: number | undefined; status: string }> = [];
    deps.route = vi.fn(async (service, _signal, serverId) => {
      routes.push({ serverId, status: service.status });
      if (service.status !== 'stopped') {
        expect(fanout.state.readiness).toBeGreaterThanOrEqual(3);
        expect(running).toBe(true); expect(fanout.state.running).toBe(true);
      }
    });
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), action);
    expect(intent.snapshot.fanout).toEqual([{ targetId: 42, serverId: 5, runtimeId: 'web-t5-7' }]);
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'completed' });
    expect(running).toBe(action !== 'stop'); expect(fanout.state.running).toBe(action !== 'stop');
    expect(routes).toEqual(action === 'restart' ? [
      { serverId: 4, status: 'stopped' }, { serverId: 5, status: 'stopped' }, { serverId: 4, status: 'deploying' }, { serverId: 5, status: 'deploying' },
    ] : [{ serverId: 4, status: action === 'stop' ? 'stopped' : 'deploying' }, { serverId: 5, status: action === 'stop' ? 'stopped' : 'deploying' }]);
    expect((await stored()).targets).toContainEqual({ ...fanout.child, serverId: 5 });
    expect((await c.db.query.serviceTargets.findFirst())!.status).toBe(action === 'stop' ? 'idle' : 'running');
    if (action !== 'stop') expect(fanout.state.readiness).toBe(3);
  });

  it('holds an offline fan-out participant without declaring Stop completed', async () => {
    const fanout = await installFanout(); fanout.state.offline = true;
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect((await stored()).reason).toMatch(/Fan-out node offline/);
    expect((await stored()).phase).toBe('fencing'); expect(trace).toEqual([]);
    expect((await service()).status).toBe('stopped'); expect(fanout.state.running).toBe(true);
  });

  it('retries lost fan-out effects against captured IDs instead of rediscovering a reused name', async () => {
    const fanout = await installFanout(); fanout.state.lostEffect = true;
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect((await stored()).phase).toBe('applying');
    fanout.state.identity = { ...fanout.child, id: 'd'.repeat(64) };
    await vi.advanceTimersByTimeAsync(121_000);
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'completed' });
    const effects = fanout.requests.filter(request => request.targets.length);
    expect(effects).toHaveLength(2); expect(effects[0]).toEqual(effects[1]);
    expect(fanout.state.running).toBe(false);
  });

  it('does not publish Start when only the primary is ready', async () => {
    const fanout = await installFanout(); fanout.state.ready = false;
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'start');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect((await stored()).phase).toBe('readiness'); expect((await service()).status).toBe('stopped');
    expect(deps.route).not.toHaveBeenCalled(); expect(running).toBe(true);
    expect(trace.filter(item => item.startsWith('readiness:'))).toHaveLength(3);
  });

  it('holds lost fan-out routing acknowledgement and rechecks every node on recovery', async () => {
    const fanout = await installFanout(); let refuse = true;
    deps.route = vi.fn(async (_service, _signal, serverId) => { if (serverId === 5 && refuse) throw Error('Fan-out routing unconfirmed'); });
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'start');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect((await stored()).phase).toBe('routing'); expect((await service()).status).toBe('deploying');
    refuse = false; await vi.advanceTimersByTimeAsync(121_000);
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'completed' });
    expect(fanout.state.readiness).toBe(6);
    expect(fanout.requests.filter(request => request.targets.length)).toHaveLength(1);
  });

  it.each(['replace', 'remove', 'add'] as const)('supersedes a command when its accepted placement changes: %s', async change => {
    await installFanout();
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    if (change === 'replace') await c.db.update(serviceTargets).set({ runtimeId: 'web-t5-10' }).where(eq(serviceTargets.id, 42));
    if (change === 'remove') await c.db.delete(serviceTargets).where(eq(serviceTargets.id, 42));
    if (change === 'add') {
      await c.db.insert(servers).values({ id: 6, name: 'New node', host: 'new.test', tokenEncrypted: 'fixture' });
      await c.db.insert(serviceTargets).values({ serviceId: 1, serverId: 6, runtimeId: 'web-t6-9' });
    }
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'superseded' });
    expect(trace).toEqual([]); expect(deps.route).not.toHaveBeenCalled();
  });

  it('holds an older primary-only journal when fan-out runtimes exist', async () => {
    await installFanout();
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    await c.db.update(nodeLifecycleIntents).set({ snapshot: { ...intent.snapshot, fanout: undefined } }).where(eq(nodeLifecycleIntents.id, intent.id));
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect((await stored()).reason).toMatch(/no accepted fan-out placement/); expect(trace).toEqual([]);
  });

  it('retains unresolved fan-out generations instead of completing against only the serving row', async () => {
    await installFanout();
    await c.db.insert(fanoutTransitions).values({ serviceId: 1, serverId: 5, targetId: 42, deploymentId: 10, primaryRuntimeId: 'web-9',
      previousRuntimeId: 'web-t5-7', candidateRuntimeId: 'web-t5-10', port: 3000 });
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect((await stored()).reason).toMatch(/generation recovery must settle/); expect(trace).toEqual([]);
    expect(await c.db.select().from(fanoutTransitions)).toHaveLength(1);
  });

  it('prevents an old fan-out Start callback from publishing after a newer Stop', async () => {
    const fanout = await installFanout(); const original = deps.agent; let nextId = 0;
    deps.agent = async (...args) => {
      const result = await original(...args);
      if (args[0] === 5 && args[1] === 'docker.lifecycle' && args[2].action === 'start') {
        nextId = (await acceptNodeLifecycleIntent(c.db, await service(), 'stop')).id;
      }
      return result;
    };
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'start');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'superseded' });
    expect(deps.route).not.toHaveBeenCalled(); expect(nextId).toBeGreaterThan(intent.id);
    deps.agent = original;
    expect(await finish(executeNodeLifecycleIntent(c.db, nextId, deps))).toEqual({ state: 'completed' });
    expect(fanout.state.running).toBe(false); expect(running).toBe(false);
    expect((await service()).status).toBe('stopped');
  });
});


describe('fan-out lifecycle refusal boundaries', () => {
  it('refuses an unsealed child before any container effect', async () => {
    await installFanout(); deps.sealed = async id => id !== 5;
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect((await stored()).reason).toMatch(/#5.*unencrypted transport/); expect(trace).toEqual([]);
  });
  it('holds an unidentifiable target generation without effects', async () => {
    await installFanout(); await c.db.update(serviceTargets).set({ runtimeId: 'legacy-runtime' });
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect((await stored()).reason).toMatch(/managed deployment identity/); expect(trace).toEqual([]);
  });
  it('includes idle configured placements in the snapshot without inventing a runtime', async () => {
    const fanout = await installFanout(); await c.db.update(serviceTargets).set({ runtimeId: null, status: 'idle' });
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(intent.snapshot.fanout).toEqual([{ targetId: 42, serverId: 5, runtimeId: null }]);
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'completed' });
    expect(fanout.requests).toEqual([]); expect(trace).toEqual(['fence', 'route:stopped', 'drain', 'effect:stop']);
  });
  it('rejects corrupt placement that duplicates the primary node before acceptance', async () => {
    await installFanout(); await c.db.update(serviceTargets).set({ serverId: 4 });
    await expect(acceptNodeLifecycleIntent(c.db, await service(), 'stop')).rejects.toThrow(/duplicates the primary/);
    expect(await c.db.select().from(nodeLifecycleIntents)).toEqual([]); expect(trace).toEqual([]);
  });
  it('retains the command after a child returns an effect receipt for another generation', async () => {
    await installFanout(); const original = deps.agent;
    deps.agent = async (...args) => {
      const result = await original(...args);
      if (args[0] === 5 && args[1] === 'docker.lifecycle' && (args[2].targets as unknown[]).length) {
        result.lines = result.lines.map(line => line.replace('"deploymentId":7', '"deploymentId":99'));
      }
      return result;
    };
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
    expect((await stored()).phase).toBe('applying'); expect((await stored()).reason).toMatch(/receipt identity/);
  });
});


it('refuses target generation annotations that were not present in the accepted request', async () => {
  const original = deps.agent;
  deps.agent = async (...args) => {
    const result = await original(...args);
    if (args[1] === 'docker.lifecycle' && (args[2].targets as unknown[]).length) {
      result.lines = result.lines.map(line => {
        const receipt = JSON.parse(line.slice(13));
        receipt.items = receipt.items.map((item: Record<string, unknown>) => ({ ...item, deploymentId: 10 }));
        return 'ND-LIFECYCLE ' + JSON.stringify(receipt);
      });
    }
    return result;
  };
  const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
  expect(await finish(executeNodeLifecycleIntent(c.db, intent.id, deps))).toEqual({ state: 'held' });
  expect((await stored()).reason).toMatch(/receipt identity/);
  expect((await stored()).phase).toBe('applying');
  expect((await service()).status).toBe('stopped');
});
