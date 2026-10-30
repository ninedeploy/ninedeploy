import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDb, deployments, eq, fanoutTransitions, runMigrations, servers, services, serviceTargets } from '@ninedeploy/db';
import { admitNodeAutoscale, checkpointNodeAutoscale } from '../../src/lib/nodeAutoscaleAuthority.js';
import { readServiceRuntimeOwner, reserveServiceRuntimeOwner } from '../../src/lib/serviceRuntimeOwner.js';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';

let c: ReturnType<typeof createDb>;
const service = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
beforeEach(async () => {
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values([{ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' }, { id: 5, name: 'Target', host: 'target.test', tokenEncrypted: 'fixture' }]);
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, status: 'running', runtimeId: 'web-9',
    autoscale: { minReplicas: 1, maxReplicas: 3, metric: 'cpu', target: 70, scaleUpSeconds: 60, scaleDownSeconds: 120 } });
  await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'running' });
});
afterEach(() => c.client?.close());

it('reserves an ordered scale owner for the observed generation and node placements', async () => {
  await c.db.insert(serviceTargets).values({ serviceId: 1, serverId: 5, runtimeId: 'web-t5-9' });
  const admitted = await admitNodeAutoscale(c.db, await service());
  expect(admitted).toMatchObject({ owner: { kind: 'scale', requestId: expect.stringMatching(/^[a-f0-9]{32}$/) }, watermark: 9,
    targets: [{ serverId: 5, runtimeId: 'web-t5-9' }] });
  await expect(checkpointNodeAutoscale(c.db, admitted!, 1)).resolves.toBeUndefined();
  await c.db.update(serviceTargets).set({ runtimeId: 'web-t5-10' }).where(eq(serviceTargets.serviceId, 1));
  await expect(checkpointNodeAutoscale(c.db, admitted!, 1)).rejects.toThrow(/placement changed/);
});
it.each(['queued', 'building', 'deploying'] as const)('does not displace a %s deployment', async status => {
  await c.db.insert(deployments).values({ id: 10, serviceId: 1, status });
  expect(await admitNodeAutoscale(c.db, await service())).toBeNull();
  expect(await readServiceRuntimeOwner(c.db, 1)).toBeNull();
});
it('does not displace a pending lifecycle command', async () => {
  await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
  const owner = await readServiceRuntimeOwner(c.db, 1);
  expect(await admitNodeAutoscale(c.db, await service())).toBeNull();
  expect(await readServiceRuntimeOwner(c.db, 1)).toEqual(owner);
});
it('does not displace unresolved fan-out recovery', async () => {
  await c.db.insert(fanoutTransitions).values({ serviceId: 1, serverId: 5, targetId: 42, deploymentId: 10, primaryRuntimeId: 'web-9',
    previousRuntimeId: 'web-t5-8', candidateRuntimeId: 'web-t5-10', port: 3000 });
  expect(await admitNodeAutoscale(c.db, await service())).toBeNull();
});
it('refuses stale or sleeping configuration and unknown fan-out generations', async () => {
  const old = await service();
  await c.db.update(services).set({ runtimeReplicas: 2 }).where(eq(services.id, 1));
  expect(await admitNodeAutoscale(c.db, old)).toBeNull();
  await c.db.update(services).set({ asleepAt: new Date() }).where(eq(services.id, 1));
  expect(await admitNodeAutoscale(c.db, await service())).toBeNull();
  await c.db.update(services).set({ asleepAt: null }).where(eq(services.id, 1));
  await c.db.insert(serviceTargets).values({ serviceId: 1, serverId: 5, runtimeId: null });
  expect(await admitNodeAutoscale(c.db, await service())).toBeNull();
});
it('rejects checkpoints after serving count, health configuration or owner changes', async () => {
  const admitted = (await admitNodeAutoscale(c.db, await service()))!;
  await expect(checkpointNodeAutoscale(c.db, admitted, 2)).rejects.toThrow(/runtime/);
  await c.db.update(services).set({ healthPath: '/new' }).where(eq(services.id, 1));
  await expect(checkpointNodeAutoscale(c.db, admitted, 1)).rejects.toThrow(/runtime/);
  await c.db.update(services).set({ healthPath: admitted.service.healthPath }).where(eq(services.id, 1));
  await reserveServiceRuntimeOwner(c.db, 1, 'deploy', admitted.owner, 'b'.repeat(32));
  await expect(checkpointNodeAutoscale(c.db, admitted, 1)).rejects.toThrow(/ownership/);
});
it('stops at the checkpoint when a deployment is queued after admission', async () => {
  const admitted = (await admitNodeAutoscale(c.db, await service()))!;
  await c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'queued' });
  await expect(checkpointNodeAutoscale(c.db, admitted, 1)).rejects.toThrow(/active/);
});
