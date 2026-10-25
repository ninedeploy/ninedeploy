import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, services, servers, users, nodeLifecycleIntents, eq } from '@ninedeploy/db';
import { containerLifecycleRequest, type ContainerLifecycleReply } from '@ninedeploy/schemas';
import { acceptNodeLifecycleIntent, claimNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';
import { executeNodeLifecycleIntent, type NodeLifecycleControllerDeps } from '../../src/lib/nodeLifecycleController.js';

let c: ReturnType<typeof createDb>, deps: NodeLifecycleControllerDeps, trace: string[], running: boolean;
const target = { id: 'a'.repeat(64), name: 'web-9' };
const caps = ['docker.lifecycle', 'docker.recovery', 'docker.readiness', 'proxy.routingAck'];
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
        return { exitCode: 0, lines: [`ND-LIFECYCLE ${JSON.stringify({ requestId: request.requestId, serviceId: 1, deploymentId: 9, action: request.action,
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
