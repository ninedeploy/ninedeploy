import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDb, deployments, eq, nodeAutoscaleCapacity, nodeAutoscaleTransitions, runMigrations, servers, services } from '@ninedeploy/db';
import { admitNodeAutoscale, checkpointNodeAutoscale } from '../../src/lib/nodeAutoscaleAuthority.js';
import { reconcileNodeAutoscale } from '../../src/lib/nodeAutoscaleRecovery.js';
import type { NodeAutoscaleControllerDeps } from '../../src/lib/nodeAutoscaleController.js';
import { reserveServiceRuntimeOwner } from '../../src/lib/serviceRuntimeOwner.js';

let c: ReturnType<typeof createDb>, calls: string[], ready: boolean;
const service = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
const items = [{ id: 'a'.repeat(64), name: 'web-9', deploymentId: 9, running: true }, { id: 'b'.repeat(64), name: 'web-9-r2', deploymentId: 9, running: false }];
const withoutTimeout = <T extends { timeoutMs: number }>(input: T) => { const { timeoutMs: _timeout, ...reply } = input; return reply; };
const runtime = (): NodeAutoscaleControllerDeps => ({
  preflight: async () => {},
  fence: async (_node, input) => ({ ...withoutTimeout(input), complete: true }),
  inventory: async (_node, input) => { const { expectedNames: _names, ...request } = input; return { ...withoutTimeout(request), complete: true, items }; },
  start: async (_node, input) => { calls.push('start'); const { targets, ...request } = input; return { ...withoutTimeout(request), complete: true, items: targets.map(target => ({ ...target, running: true })) }; },
  stop: async () => { throw new Error('unexpected stop'); },
  retire: async (_node, input) => { const { targets: _targets, graceSeconds: _grace, ...request } = input; return { ...withoutTimeout(request), complete: true, items: [] }; },
  handoff: async (_node, input) => ({ ...withoutTimeout(input), complete: true }),
  ready: async () => { calls.push('ready'); return ready; }, route: async () => { calls.push('route'); }, drain: async () => {},
});
beforeEach(async () => {
  calls = []; ready = true; c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, status: 'running', runtimeId: 'web-9',
    autoscale: { minReplicas: 1, maxReplicas: 3, metric: 'cpu', target: 70, scaleUpSeconds: 60, scaleDownSeconds: 120 } });
  await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'running' });
  await c.db.insert(nodeAutoscaleCapacity).values({ deploymentId: 9, serviceId: 1, serverId: 4, runtimeId: 'web-9', imageId: `sha256:${'f'.repeat(64)}`,
    targets: items.map(({ id, name }) => ({ id, name })) });
});
afterEach(() => c.client?.close());

it('does not steal a live lease, then resumes an expired decision exactly once', async () => {
  const first = (await admitNodeAutoscale(c.db, await service(), 2))!;
  expect(await reconcileNodeAutoscale(c.db, { runtime })).toEqual([]);
  await c.db.update(nodeAutoscaleTransitions).set({ leaseUntil: new Date(0) }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  expect(await reconcileNodeAutoscale(c.db, { runtime })).toEqual([{ serviceId: 1, state: 'completed' }]);
  expect((await service()).runtimeReplicas).toBe(2); expect(calls).toEqual(['start', 'ready', 'ready', 'route']);
  await expect(checkpointNodeAutoscale(c.db, first, 2)).rejects.toThrow();
  expect(await reconcileNodeAutoscale(c.db, { runtime })).toEqual([]);
});
it('retains failed work until its lease expires and continues from the recorded phase', async () => {
  await admitNodeAutoscale(c.db, await service(), 2);
  await c.db.update(nodeAutoscaleTransitions).set({ leaseUntil: new Date(0) }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  ready = false;
  expect(await reconcileNodeAutoscale(c.db, { runtime })).toEqual([{ serviceId: 1, state: 'failed' }]);
  expect((await c.db.select().from(nodeAutoscaleTransitions))[0]?.phase).toBe('started');
  expect(await reconcileNodeAutoscale(c.db, { runtime })).toEqual([]);
  await c.db.update(nodeAutoscaleTransitions).set({ leaseUntil: new Date(0) }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  ready = true;
  expect(await reconcileNodeAutoscale(c.db, { runtime })).toEqual([{ serviceId: 1, state: 'completed' }]);
  expect(calls).toEqual(['start', 'ready', 'ready', 'ready', 'route']);
});
it('leaves held records and cancelled workers untouched', async () => {
  await admitNodeAutoscale(c.db, await service(), 2);
  await c.db.update(nodeAutoscaleTransitions).set({ phase: 'held', leaseUntil: new Date(0) }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  expect(await reconcileNodeAutoscale(c.db, { runtime })).toEqual([]);
  const abort = new AbortController(); abort.abort(new Error('stopped'));
  await expect(reconcileNodeAutoscale(c.db, { runtime, signal: abort.signal })).rejects.toThrow('stopped');
  expect(calls).toEqual([]);
});
it('defers an unclaimable stale owner without reviving its expired worker', async () => {
  const first = (await admitNodeAutoscale(c.db, await service(), 2))!;
  await c.db.update(nodeAutoscaleTransitions).set({ leaseUntil: new Date(0) }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  await reserveServiceRuntimeOwner(c.db, 1, 'deploy', first.owner, 'c'.repeat(32));
  expect(await reconcileNodeAutoscale(c.db, { runtime })).toEqual([{ serviceId: 1, state: 'failed' }]);
  const row = (await c.db.select().from(nodeAutoscaleTransitions))[0]!;
  expect(row.workerToken).toBeNull(); expect(row.leaseUntil!.getTime()).toBeGreaterThan(Date.now());
  expect(await reconcileNodeAutoscale(c.db, { runtime })).toEqual([]);
  await expect(checkpointNodeAutoscale(c.db, first, 1)).rejects.toThrow();
});
it('discards an expired accepted measurement before effects and permits a fresh decision', async () => {
  const measurement = { serverId: 4, serviceId: 1, deploymentId: 9, sampledAt: Date.now(), requestId: 'd'.repeat(32),
    targets: [{ name: 'web-9', id: 'a'.repeat(64) }] };
  expect(await admitNodeAutoscale(c.db, await service(), 2, measurement)).not.toBeNull();
  await c.db.update(nodeAutoscaleTransitions).set({ measurement: { ...measurement, sampledAt: Date.now() - 100_000 }, leaseUntil: new Date(0) })
    .where(eq(nodeAutoscaleTransitions.serviceId, 1));
  expect(await reconcileNodeAutoscale(c.db, { runtime })).toEqual([{ serviceId: 1, state: 'discarded' }]);
  expect(calls).toEqual([]);
  expect((await service()).runtimeReplicas).toBe(1);
  expect(await c.db.select().from(nodeAutoscaleTransitions)).toEqual([]);
  expect(await admitNodeAutoscale(c.db, await service(), 2, { ...measurement, sampledAt: Date.now() })).not.toBeNull();
});
it('continues a started transition even if its original sample is now old', async () => {
  const measurement = { serverId: 4, serviceId: 1, deploymentId: 9, sampledAt: Date.now(), requestId: 'd'.repeat(32),
    targets: [{ name: 'web-9', id: 'a'.repeat(64) }] };
  await admitNodeAutoscale(c.db, await service(), 2, measurement);
  await c.db.update(nodeAutoscaleTransitions).set({ measurement: { ...measurement, sampledAt: Date.now() - 100_000 }, phase: 'started',
    replicaInventory: items, leaseUntil: new Date(0) }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  expect(await reconcileNodeAutoscale(c.db, { runtime })).toEqual([{ serviceId: 1, state: 'completed' }]);
  expect(calls).toEqual(['ready', 'ready', 'route']);
  expect((await service()).runtimeReplicas).toBe(2);
});
