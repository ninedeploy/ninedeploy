import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDb, deployments, domains, eq, nodeAutoscaleCapacity, runMigrations, servers, services } from '@ninedeploy/db';
import type { ServingTrafficOpen } from '@ninedeploy/schemas';
import { renderDynamicConfig } from '../../src/engine/proxy.js';
import { readNodeServingTrafficSample } from '../../src/lib/nodeServingTrafficSample.js';

let c: ReturnType<typeof createDb>;
const service = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
beforeEach(async () => {
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, status: 'running', runtimeId: 'web-9',
    runtimeReplicas: 2, port: 8080, autoscale: { minReplicas: 1, maxReplicas: 3, metric: 'rps', target: 10, scaleUpSeconds: 60, scaleDownSeconds: 120 } });
  await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'running' });
  await c.db.insert(domains).values({ id: 1, serviceId: 1, hostname: 'web.test', status: 'active' });
  await c.db.insert(nodeAutoscaleCapacity).values({ deploymentId: 9, serviceId: 1, serverId: 4, runtimeId: 'web-9', imageId: `sha256:${'f'.repeat(64)}`,
    targets: ['web-9', 'web-9-r2', 'web-9-r3'].map((name, index) => ({ name, id: ['a', 'b', 'c'][index]!.repeat(64) })) });
});
afterEach(() => { c.client?.close(); vi.restoreAllMocks(); });

it('opens one window on the serving replicas of the prepared capacity, finishes it and always closes it', async () => {
  const opened: ServingTrafficOpen[] = [], close = vi.fn(async () => {});
  const snapshot = { complete: true } as never;
  const open = vi.fn(async (_db: unknown, input: ServingTrafficOpen) => {
    opened.push(input);
    return { receipt: {} as never, sample: vi.fn(), finish: vi.fn(async () => snapshot), close };
  });
  const sample = await readNodeServingTrafficSample(c.db, await service(), { open, durationMs: 1000, now: () => 42 });
  expect(sample).toEqual({ kind: 'serving', serverId: 4, sampledAt: 42, snapshot,
    serving: [{ name: 'web-9', id: 'a'.repeat(64) }, { name: 'web-9-r2', id: 'b'.repeat(64) }] });
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({ purpose: 'autoscale', nodeId: 4, serviceId: 1, deploymentId: 9, slug: 'web', durationMs: 1000,
    routingConfig: await renderDynamicConfig(c.db, { serverId: 4 }),
    serving: [{ name: 'web-9', id: 'a'.repeat(64), port: 8080 }, { name: 'web-9-r2', id: 'b'.repeat(64), port: 8080 }] });
  expect(opened[0]!.requestId).toMatch(/^[a-f0-9]{32}$/);
  expect(close).toHaveBeenCalledTimes(1);
});

it('closes the window when finishing is refused', async () => {
  const close = vi.fn(async () => {});
  const open = vi.fn(async () => ({ receipt: {} as never, sample: vi.fn(), close,
    finish: vi.fn(async () => { throw new Error('Node proxy traffic unavailable: source or observation coverage changed'); }) }));
  await expect(readNodeServingTrafficSample(c.db, await service(), { open, durationMs: 1000 })).rejects.toThrow(/coverage changed/);
  expect(close).toHaveBeenCalledTimes(1);
});

it('refuses without opening a window when the active generation has no matching capacity', async () => {
  const open = vi.fn();
  await c.db.update(nodeAutoscaleCapacity).set({ runtimeId: 'web-8' }).where(eq(nodeAutoscaleCapacity.deploymentId, 9));
  await expect(readNodeServingTrafficSample(c.db, await service(), { open, durationMs: 1000 })).rejects.toThrow(/capacity is not confirmed/);
  await c.db.update(services).set({ orchestrator: 'swarm' }).where(eq(services.id, 1));
  await expect(readNodeServingTrafficSample(c.db, await service(), { open, durationMs: 1000 })).rejects.toThrow(/placement is invalid/);
  await c.db.update(services).set({ orchestrator: null, serverId: null }).where(eq(services.id, 1));
  await expect(readNodeServingTrafficSample(c.db, await service(), { open, durationMs: 1000 })).rejects.toThrow(/placement is invalid/);
  expect(open).not.toHaveBeenCalled();
});

it('refuses a service with no routed domain instead of observing an empty route', async () => {
  const open = vi.fn();
  await c.db.delete(domains).where(eq(domains.id, 1));
  await expect(readNodeServingTrafficSample(c.db, await service(), { open, durationMs: 1000 })).rejects.toThrow(/routed domain/);
  expect(open).not.toHaveBeenCalled();
});
