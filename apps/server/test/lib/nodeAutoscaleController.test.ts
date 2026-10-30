import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDb, deployments, eq, nodeAutoscaleTransitions, runMigrations, servers, services, serviceTargets } from '@ninedeploy/db';
import { admitNodeAutoscale, recoverNodeAutoscaleAdmission } from '../../src/lib/nodeAutoscaleAuthority.js';
import { executeNodeAutoscale, type NodeAutoscaleControllerDeps } from '../../src/lib/nodeAutoscaleController.js';

let c: ReturnType<typeof createDb>;
const service = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
const transition = async () => (await c.db.select().from(nodeAutoscaleTransitions))[0];
const items = [{ id: 'a'.repeat(64), name: 'web-9', deploymentId: 9, running: true },
  { id: 'b'.repeat(64), name: 'web-9-r2', deploymentId: 9, running: false }];
let calls: string[], readiness: boolean, routingFails: boolean;
const withoutTimeout = <T extends { timeoutMs: number }>(input: T) => { const { timeoutMs: _timeout, ...reply } = input; return reply; };
const deps = (): NodeAutoscaleControllerDeps => ({
  fence: async (_node, input) => { calls.push('fence'); return { ...withoutTimeout(input), complete: true }; },
  inventory: async (_node, input) => { calls.push('inventory'); const { expectedNames: _names, ...request } = input; return { ...withoutTimeout(request), complete: true, items }; },
  start: async (_node, input) => { calls.push('start'); const { targets, ...request } = input; return { ...withoutTimeout(request), complete: true, items: targets.map(target => ({ ...target, running: true })) }; },
  stop: async (_node, input) => { calls.push('stop'); const { targets, graceSeconds: _grace, ...request } = input; return { ...withoutTimeout(request), complete: true, items: targets.map(target => ({ ...target, running: false })) }; },
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
  items[1]!.running = false; calls = []; readiness = true; routingFails = false;
});
afterEach(() => { c.client?.close(); vi.restoreAllMocks(); });

it('starts and verifies scale-up before publishing the new route', async () => {
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const runtime = deps(), ready = runtime.ready, route = runtime.route;
  let probes = 0;
  runtime.ready = async (...args) => { expect((await service()).runtimeReplicas).toBe(++probes === 1 ? 1 : 2); return ready(...args); };
  runtime.route = async (...args) => { expect((await service()).runtimeReplicas).toBe(2); return route(...args); };
  await executeNodeAutoscale(c.db, admission, runtime);
  expect(calls).toEqual(['fence', 'inventory', 'start', 'ready', 'ready', 'route']);
  expect((await service()).runtimeReplicas).toBe(2); expect(await transition()).toBeUndefined();
});
it('recovers a failed readiness check without starting the same set again or routing early', async () => {
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  readiness = false;
  await expect(executeNodeAutoscale(c.db, admission, deps())).rejects.toThrow(/readiness/);
  expect((await transition())?.phase).toBe('started'); expect((await service()).runtimeReplicas).toBe(1); expect(calls).not.toContain('route');
  await c.db.update(nodeAutoscaleTransitions).set({ leaseUntil: new Date(0) }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  const recovered = (await recoverNodeAutoscaleAdmission(c.db, 1))!; readiness = true;
  await executeNodeAutoscale(c.db, recovered, deps());
  expect(calls).toEqual(['fence', 'inventory', 'start', 'ready', 'ready', 'ready', 'route']);
  expect((await service()).runtimeReplicas).toBe(2);
});
it('keeps scale-down containers running until the route is confirmed and drained', async () => {
  items[1]!.running = true;
  await c.db.update(services).set({ runtimeReplicas: 2 }).where(eq(services.id, 1));
  const admission = (await admitNodeAutoscale(c.db, await service(), 1))!; routingFails = true;
  await expect(executeNodeAutoscale(c.db, admission, deps())).rejects.toThrow('route unavailable');
  expect((await transition())?.phase).toBe('routing'); expect(calls).not.toContain('stop'); expect(calls).not.toContain('drain');
  routingFails = false; await executeNodeAutoscale(c.db, admission, deps());
  expect(calls).toEqual(['fence', 'inventory', 'route', 'route', 'drain', 'stop']);
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
  expect(calls).toEqual(['fence', 'inventory', 'start', 'start', 'ready', 'ready', 'route']);
});
it('does not publish or route after an incomplete Start receipt', async () => {
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const runtime = deps(), start = runtime.start;
  runtime.start = async (node, request) => ({ ...(await start(node, request) as object), items: [] });
  await expect(executeNodeAutoscale(c.db, admission, runtime)).rejects.toThrow();
  expect((await transition())?.phase).toBe('prepared'); expect((await service()).runtimeReplicas).toBe(1);
  expect(calls).not.toContain('ready'); expect(calls).not.toContain('route');
});
it('fences the fan-out node before freezing and changing the primary replicas', async () => {
  await c.db.insert(servers).values({ id: 5, name: 'Target', host: 'target.test', tokenEncrypted: 'fixture' });
  await c.db.insert(serviceTargets).values({ serviceId: 1, serverId: 5, runtimeId: 'web-t5-9' });
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const runtime = deps(), fence = runtime.fence, nodes: number[] = [];
  runtime.fence = async (node, request) => { nodes.push(node); return fence(node, request); };
  await executeNodeAutoscale(c.db, admission, runtime);
  expect(nodes).toEqual([5, 4]); expect(calls).toEqual(['fence', 'fence', 'inventory', 'start', 'ready', 'ready', 'route']);
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
