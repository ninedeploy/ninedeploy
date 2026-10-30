import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDb, deployments, eq, nodeAutoscaleCapacity, nodeAutoscaleTransitions, runMigrations, servers, services, serviceTargets } from '@ninedeploy/db';
import { admitNodeAutoscale, recoverNodeAutoscaleAdmission } from '../../src/lib/nodeAutoscaleAuthority.js';
import { executeNodeAutoscale, type NodeAutoscaleControllerDeps } from '../../src/lib/nodeAutoscaleController.js';
import { createNodeAutoscaleDecider } from '../../src/lib/nodeAutoscaleDecision.js';
import { createNodeAutoscaleWorker } from '../../src/lib/nodeAutoscaleWorker.js';
import { beginCanary, endCanary } from '../../src/engine/canaryState.js';
import { readServiceRuntimeOwner, reserveServiceRuntimeOwner } from '../../src/lib/serviceRuntimeOwner.js';

let c: ReturnType<typeof createDb>;
const service = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
const transition = async () => (await c.db.select().from(nodeAutoscaleTransitions))[0];
const items = [{ id: 'a'.repeat(64), name: 'web-9', deploymentId: 9, running: true },
  { id: 'b'.repeat(64), name: 'web-9-r2', deploymentId: 9, running: false }];
let calls: string[], readiness: boolean, routingFails: boolean;
const withoutTimeout = <T extends { timeoutMs: number }>(input: T) => { const { timeoutMs: _timeout, ...reply } = input; return reply; };
const deps = (): NodeAutoscaleControllerDeps => ({
  preflight: async () => {},
  fence: async (_node, input) => { calls.push('fence'); return { ...withoutTimeout(input), complete: true }; },
  inventory: async (_node, input) => { calls.push('inventory'); const { expectedNames: _names, ...request } = input; return { ...withoutTimeout(request), complete: true, items }; },
  start: async (_node, input) => { calls.push('start'); const { targets, ...request } = input; return { ...withoutTimeout(request), complete: true, items: targets.map(target => ({ ...target, running: true })) }; },
  stop: async (_node, input) => { calls.push('stop'); const { targets, graceSeconds: _grace, ...request } = input; return { ...withoutTimeout(request), complete: true, items: targets.map(target => ({ ...target, running: false })) }; },
  retire: async (_node, input) => { calls.push('handoff-retire'); const { targets: _targets, graceSeconds: _grace, ...request } = input; return { ...withoutTimeout(request), complete: true, items: [] }; },
  handoff: async (_node, input) => { calls.push('handoff'); return { ...withoutTimeout(input), complete: true }; },
  ready: async () => { calls.push('ready'); return readiness; },
  route: async () => { calls.push('route'); if (routingFails) throw new Error('route unavailable'); },
  drain: async () => { calls.push('drain'); },
});
beforeEach(async () => {
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, status: 'running', runtimeId: 'web-9',
    autoscale: { minReplicas: 1, maxReplicas: 3, metric: 'cpu', target: 70, scaleUpSeconds: 60, scaleDownSeconds: 120 } });
  await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'running' });
  await c.db.insert(nodeAutoscaleCapacity).values({ deploymentId: 9, serviceId: 1, serverId: 4, runtimeId: 'web-9', imageId: `sha256:${'f'.repeat(64)}`,
    targets: ['web-9', 'web-9-r2', 'web-9-r3'].map((name, index) => ({ name, id: ['a', 'b', 'c'][index]!.repeat(64) })) });
  items[1]!.running = false; calls = []; readiness = true; routingFails = false;
});
afterEach(() => { endCanary(1); c.client?.close(); vi.restoreAllMocks(); });

it('holds without sampling when the active generation has no capacity receipt', async () => {
  await c.db.delete(nodeAutoscaleCapacity).where(eq(nodeAutoscaleCapacity.deploymentId, 9));
  const sample = vi.fn();
  const worker = createNodeAutoscaleWorker(c.db, { blocked: () => false, sample });
  expect(await worker.step(await service())).toEqual({ state: 'held', reason: 'node autoscale capacity is not confirmed' });
  expect(sample).not.toHaveBeenCalled();
});

it('starts and verifies scale-up before publishing the new route', async () => {
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const runtime = deps(), ready = runtime.ready, route = runtime.route;
  let probes = 0;
  runtime.ready = async (...args) => { expect((await service()).runtimeReplicas).toBe(++probes === 1 ? 1 : 2); return ready(...args); };
  runtime.route = async (...args) => { expect((await service()).runtimeReplicas).toBe(2); return route(...args); };
  await executeNodeAutoscale(c.db, admission, runtime);
  expect(calls).toEqual(['fence', 'inventory', 'start', 'ready', 'ready', 'route', 'handoff-retire', 'handoff']);
  expect((await service()).runtimeReplicas).toBe(2); expect(await transition()).toBeUndefined();
});
it('finishes the ownership handoff even when a new deploy is queued during it', async () => {
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const runtime = deps(), handoff = runtime.handoff;
  runtime.handoff = async (...args) => {
    await c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'queued' });
    return handoff(...args);
  };
  await executeNodeAutoscale(c.db, admission, runtime);
  expect((await service()).runtimeReplicas).toBe(2);
  expect(await transition()).toBeUndefined();
});
it.each(['up', 'down'] as const)('finishes an already published scale-%s when a deploy is queued during routing', async direction => {
  if (direction === 'down') {
    items[1]!.running = true;
    await c.db.update(services).set({ runtimeReplicas: 2 }).where(eq(services.id, 1));
  }
  const desired = direction === 'up' ? 2 : 1;
  const admission = (await admitNodeAutoscale(c.db, await service(), desired))!;
  const runtime = deps(), route = runtime.route;
  runtime.route = async (...args) => { await route(...args); await c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'queued' }); };
  expect(await executeNodeAutoscale(c.db, admission, runtime)).toBe('completed');
  expect((await service()).runtimeReplicas).toBe(desired);
  expect(await transition()).toBeUndefined();
  expect(calls).toContain('handoff');
});
it('releases node ownership without scaling when a deploy is queued during fencing', async () => {
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const runtime = deps(), fence = runtime.fence; let queued = false;
  runtime.fence = async (...args) => {
    const result = await fence(...args);
    if (!queued) { queued = true; await c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'queued' }); }
    return result;
  };
  expect(await executeNodeAutoscale(c.db, admission, runtime)).toBe('aborted');
  expect((await service()).runtimeReplicas).toBe(1);
  expect(await transition()).toBeUndefined();
  expect(calls).toEqual(['fence', 'fence', 'handoff-retire', 'handoff']);
  expect(calls).not.toContain('start'); expect(calls).not.toContain('route');
});
it('releases node ownership without scaling when the measurement expires during fencing', async () => {
  const now = Date.now();
  const measurement = { serverId: 4, serviceId: 1, deploymentId: 9, sampledAt: now - 89_900, requestId: 'd'.repeat(32),
    targets: [{ name: 'web-9', id: 'a'.repeat(64) }] };
  const admission = (await admitNodeAutoscale(c.db, await service(), 2, measurement))!;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const runtime = deps(), fence = runtime.fence;
    runtime.fence = async (...args) => { const result = await fence(...args); clock.mockReturnValue(now + 200); return result; };
    expect(await executeNodeAutoscale(c.db, admission, runtime)).toBe('aborted');
    expect((await service()).runtimeReplicas).toBe(1); expect(await transition()).toBeUndefined();
    expect(calls).not.toContain('start'); expect(calls).not.toContain('route');
  } finally { clock.mockRestore(); }
});
it('connects an identity-bound measurement decision to durable admission and ordered scale-up', async () => {
  const now = Date.now(), svc = await service(), decider = createNodeAutoscaleDecider();
  const sample = (at: number, request: string, id = 'a'.repeat(64)) => ({ serverId: 4, serviceId: 1, deploymentId: 9,
    sampledAt: at, requestId: request.repeat(32), complete: true, items: [{ id, name: 'web-9', cpuPct: 95,
      cpuLimitMilli: 1000, memBytes: 100, memLimitBytes: 1000, restarts: 0 }] });
  expect(decider.observe(svc, sample(now - 60_000, 'a'), now - 60_000).to).toBeNull();
  const decision = decider.observe(svc, sample(now, 'b'), now);
  expect(decision.to).toBe(2);
  const admission = (await admitNodeAutoscale(c.db, svc, decision.to!, decision.evidence!))!;
  expect((await transition())?.measurement).toEqual(decision.evidence);
  await executeNodeAutoscale(c.db, admission, deps());
  expect(calls).toEqual(['fence', 'inventory', 'start', 'ready', 'ready', 'route', 'handoff-retire', 'handoff']);
  expect((await service()).runtimeReplicas).toBe(2);
});
it('does not start replicas when a measured container was replaced before inventory', async () => {
  const now = Date.now(), svc = await service(), decider = createNodeAutoscaleDecider();
  const sample = (at: number, request: string) => ({ serverId: 4, serviceId: 1, deploymentId: 9, sampledAt: at,
    requestId: request.repeat(32), complete: true, items: [{ id: 'c'.repeat(64), name: 'web-9', cpuPct: 95,
      cpuLimitMilli: 1000, memBytes: 100, memLimitBytes: 1000, restarts: 0 }] });
  decider.observe(svc, sample(now - 60_000, 'a'), now - 60_000);
  const decision = decider.observe(svc, sample(now, 'b'), now);
  const admission = (await admitNodeAutoscale(c.db, svc, decision.to!, decision.evidence!))!;
  await expect(executeNodeAutoscale(c.db, admission, deps())).rejects.toThrow(/measured replica identity changed/);
  expect(calls).toEqual(['fence', 'inventory']);
  expect((await service()).runtimeReplicas).toBe(1);
});
it('runs sampled decisions through durable admission and the controller', async () => {
  const now = Date.now(), svc = await service();
  let time = now - 60_000, request = 0;
  const worker = createNodeAutoscaleWorker(c.db, { blocked: () => false, now: () => time, runtime: () => deps(),
    sample: async () => ({ serverId: 4, serviceId: 1, deploymentId: 9, sampledAt: time,
      requestId: (++request === 1 ? 'a' : 'b').repeat(32), complete: true, items: [{ id: 'a'.repeat(64), name: 'web-9', cpuPct: 95,
        cpuLimitMilli: 1000, memBytes: 100, memLimitBytes: 1000, restarts: 0 }] }) });
  expect((await worker.step(svc)).state).toBe('held');
  time = now;
  expect(await worker.step(svc)).toEqual({ state: 'completed' });
  expect(calls).toEqual(['fence', 'inventory', 'start', 'ready', 'ready', 'route', 'handoff-retire', 'handoff']);
  expect((await service()).runtimeReplicas).toBe(2);
});
it('holds when a conflicting operation starts during sampling', async () => {
  const svc = await service(); let blocked = false;
  const worker = createNodeAutoscaleWorker(c.db, { blocked: () => blocked, runtime: () => deps(), sample: async () => {
    blocked = true;
    return { serverId: 4, serviceId: 1, deploymentId: 9, sampledAt: Date.now(), requestId: 'a'.repeat(32), complete: true,
      items: [{ id: 'a'.repeat(64), name: 'web-9', cpuPct: 95, cpuLimitMilli: 1000, memBytes: 100, memLimitBytes: 1000, restarts: 0 }] };
  } });
  expect((await worker.step(svc)).state).toBe('held');
  expect(await transition()).toBeUndefined();
  expect(calls).toEqual([]);
});
it('does not measure the same node service twice concurrently', async () => {
  const svc = await service();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const worker = createNodeAutoscaleWorker(c.db, { blocked: () => false, runtime: () => deps(), sample: async () => {
    entered(); await pending;
    return { serverId: 4, serviceId: 1, deploymentId: 9, sampledAt: Date.now(), requestId: 'a'.repeat(32), complete: true,
      items: [{ id: 'a'.repeat(64), name: 'web-9', cpuPct: 95, cpuLimitMilli: 1000, memBytes: 100, memLimitBytes: 1000, restarts: 0 }] };
  } });
  const first = worker.step(svc);
  try { await started; expect(await worker.step(svc)).toEqual({ state: 'busy' }); } finally { release(); }
  expect((await first).state).toBe('held');
  expect(calls).toEqual([]);
});
it('preserves a newer runtime owner when ownership changes while sampling', async () => {
  const now = Date.now(), svc = await service(); let time = now - 60_000, count = 0, enter!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const worker = createNodeAutoscaleWorker(c.db, { blocked: () => false, now: () => time, runtime: () => deps(), sample: async () => {
    if (++count === 2) { enter(); await pending; }
    return { serverId: 4, serviceId: 1, deploymentId: 9, sampledAt: time, requestId: (count === 1 ? 'a' : 'b').repeat(32), complete: true,
      items: [{ id: 'a'.repeat(64), name: 'web-9', cpuPct: 95, cpuLimitMilli: 1000, memBytes: 100, memLimitBytes: 1000, restarts: 0 }] };
  } });
  expect((await worker.step(svc)).state).toBe('held'); time = now;
  const result = worker.step(svc);
  let newer: Awaited<ReturnType<typeof reserveServiceRuntimeOwner>> | undefined;
  try { await started; newer = await reserveServiceRuntimeOwner(c.db, 1, 'restart', null, 'c'.repeat(32)); } finally { release(); }
  expect(await result).toMatchObject({ state: 'held', reason: expect.stringMatching(/ownership changed/) });
  expect(await readServiceRuntimeOwner(c.db, 1)).toEqual(newer);
  expect(calls).toEqual([]);
  expect(await transition()).toBeUndefined();
});
it('starts a new decision window when ownership changes between samples', async () => {
  const now = Date.now(), svc = await service(); let time = now - 60_000, count = 0;
  const worker = createNodeAutoscaleWorker(c.db, { blocked: () => false, now: () => time, runtime: () => deps(), sample: async () => ({
    serverId: 4, serviceId: 1, deploymentId: 9, sampledAt: time, requestId: (++count === 1 ? 'a' : 'b').repeat(32), complete: true,
    items: [{ id: 'a'.repeat(64), name: 'web-9', cpuPct: 95, cpuLimitMilli: 1000, memBytes: 100, memLimitBytes: 1000, restarts: 0 }],
  }) });
  expect((await worker.step(svc)).state).toBe('held');
  const newer = await reserveServiceRuntimeOwner(c.db, 1, 'restart', null, 'c'.repeat(32));
  time = now;
  expect((await worker.step(svc)).state).toBe('held');
  expect(await readServiceRuntimeOwner(c.db, 1)).toEqual(newer);
  expect(calls).toEqual([]);
});
it('restarts the decision window after node sampling fails', async () => {
  const now = Date.now(), svc = await service(); let time = now - 60_000, fail = false, count = 0;
  const worker = createNodeAutoscaleWorker(c.db, { blocked: () => false, now: () => time, runtime: () => deps(), sample: async () => {
    if (fail) throw new Error('node offline');
    return { serverId: 4, serviceId: 1, deploymentId: 9, sampledAt: time, requestId: ['a', 'b', 'c'][count++]!.repeat(32), complete: true,
      items: [{ id: 'a'.repeat(64), name: 'web-9', cpuPct: 95, cpuLimitMilli: 1000, memBytes: 100, memLimitBytes: 1000, restarts: 0 }] };
  } });
  expect((await worker.step(svc)).state).toBe('held');
  fail = true; await expect(worker.step(svc)).rejects.toThrow('node offline');
  fail = false; time = now;
  expect((await worker.step(svc)).state).toBe('held');
  expect(calls).toEqual([]);
});
it('recovers a failed readiness check without starting the same set again or routing early', async () => {
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  readiness = false;
  await expect(executeNodeAutoscale(c.db, admission, deps())).rejects.toThrow(/readiness/);
  expect((await transition())?.phase).toBe('started'); expect((await service()).runtimeReplicas).toBe(1); expect(calls).not.toContain('route');
  await c.db.update(nodeAutoscaleTransitions).set({ leaseUntil: new Date(0) }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  const recovered = (await recoverNodeAutoscaleAdmission(c.db, 1))!; readiness = true;
  await executeNodeAutoscale(c.db, recovered, deps());
  expect(calls).toEqual(['fence', 'inventory', 'start', 'ready', 'ready', 'ready', 'route', 'handoff-retire', 'handoff']);
  expect((await service()).runtimeReplicas).toBe(2);
});
it('keeps scale-down containers running until the route is confirmed and drained', async () => {
  items[1]!.running = true;
  await c.db.update(services).set({ runtimeReplicas: 2 }).where(eq(services.id, 1));
  const admission = (await admitNodeAutoscale(c.db, await service(), 1))!; routingFails = true;
  await expect(executeNodeAutoscale(c.db, admission, deps())).rejects.toThrow('route unavailable');
  expect((await transition())?.phase).toBe('routing'); expect(calls).not.toContain('stop'); expect(calls).not.toContain('drain');
  routingFails = false; await executeNodeAutoscale(c.db, admission, deps());
  expect(calls).toEqual(['fence', 'inventory', 'route', 'route', 'drain', 'stop', 'handoff-retire', 'handoff']);
  expect((await service()).runtimeReplicas).toBe(1); expect(await transition()).toBeUndefined();
});
it('replays the same immutable Start request after its receipt is lost', async () => {
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const runtime = deps(), start = runtime.start, sent: unknown[] = []; let lost = true;
  runtime.start = async (node, request) => {
    sent.push(request); const receipt = await start(node, request);
    if (lost) { lost = false; throw new Error('receipt lost'); }
    return receipt;
  };
  await expect(executeNodeAutoscale(c.db, admission, runtime)).rejects.toThrow('receipt lost');
  expect((await transition())?.phase).toBe('prepared'); expect((await service()).runtimeReplicas).toBe(1);
  await c.db.update(nodeAutoscaleTransitions).set({ leaseUntil: new Date(0) }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  await executeNodeAutoscale(c.db, (await recoverNodeAutoscaleAdmission(c.db, 1))!, runtime);
  expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
  expect(calls).toEqual(['fence', 'inventory', 'start', 'start', 'ready', 'ready', 'route', 'handoff-retire', 'handoff']);
});
it('does not publish or route after an incomplete Start receipt', async () => {
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const runtime = deps(), start = runtime.start;
  runtime.start = async (node, request) => ({ ...(await start(node, request) as object), items: [] });
  await expect(executeNodeAutoscale(c.db, admission, runtime)).rejects.toThrow();
  expect((await transition())?.phase).toBe('prepared'); expect((await service()).runtimeReplicas).toBe(1);
  expect(calls).not.toContain('ready'); expect(calls).not.toContain('route');
});
it('never publishes a scale-up when a deploy is queued during readiness', async () => {
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const runtime = deps();
  runtime.ready = async () => { calls.push('ready'); await c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'queued' }); return true; };
  expect(await executeNodeAutoscale(c.db, admission, runtime)).toBe('aborted');
  expect((await service()).runtimeReplicas).toBe(1); expect(calls).not.toContain('route');
  expect(calls).toContain('stop'); expect(calls).toContain('handoff'); expect(await transition()).toBeUndefined();
});
it('never publishes a scale-up when a canary starts during readiness', async () => {
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const runtime = deps();
  runtime.ready = async () => { calls.push('ready'); beginCanary(1, 'web', 10, 2, false, false, { serverId: 4, stableRuntimeId: 'web-9' }); return true; };
  await expect(executeNodeAutoscale(c.db, admission, runtime)).rejects.toThrow(/canary/i);
  expect((await service()).runtimeReplicas).toBe(1);
  expect(calls).not.toContain('route');
});
it('refuses scale admission while a canary already owns routing', async () => {
  beginCanary(1, 'web', 10, 2, false, false, { serverId: 4, stableRuntimeId: 'web-9' });
  expect(await admitNodeAutoscale(c.db, await service(), 2)).toBeNull();
  expect(await transition()).toBeUndefined();
});
it('fences the fan-out node before freezing and changing the primary replicas', async () => {
  await c.db.insert(servers).values({ id: 5, name: 'Target', host: 'target.test', tokenEncrypted: 'fixture' });
  await c.db.insert(serviceTargets).values({ serviceId: 1, serverId: 5, runtimeId: 'web-t5-9' });
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const runtime = deps(), fence = runtime.fence, nodes: number[] = [];
  runtime.fence = async (node, request) => { nodes.push(node); return fence(node, request); };
  await executeNodeAutoscale(c.db, admission, runtime);
  expect(nodes).toEqual([5, 4]); expect(calls).toEqual(['fence', 'fence', 'inventory', 'start', 'ready', 'ready', 'route', 'handoff-retire', 'handoff', 'handoff-retire', 'handoff']);
});
it('preflights every node before fencing any node', async () => {
  await c.db.insert(servers).values({ id: 5, name: 'Target', host: 'target.test', tokenEncrypted: 'fixture' });
  await c.db.insert(serviceTargets).values({ serviceId: 1, serverId: 5, runtimeId: 'web-t5-9' });
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const runtime = deps();
  runtime.preflight = async node => { if (node === 4) throw Error('agent cannot hand off'); };
  await expect(executeNodeAutoscale(c.db, admission, runtime)).rejects.toThrow('agent cannot hand off');
  expect(calls).toEqual([]); expect((await transition())?.phase).toBe('accepted');
});
it('rechecks readiness when retrying an unconfirmed scale-up route', async () => {
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  routingFails = true;
  await expect(executeNodeAutoscale(c.db, admission, deps())).rejects.toThrow('route unavailable');
  expect((await transition())?.phase).toBe('routing');
  readiness = false; routingFails = false;
  await expect(executeNodeAutoscale(c.db, admission, deps())).rejects.toThrow(/readiness/);
  expect(calls.filter(call => call === 'route')).toHaveLength(1);
});
it('does not report success if the persisted decision disappeared', async () => {
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  await c.db.delete(nodeAutoscaleTransitions).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  await expect(executeNodeAutoscale(c.db, admission, deps())).rejects.toThrow(/disappeared/);
  expect(calls).toEqual([]);
});
