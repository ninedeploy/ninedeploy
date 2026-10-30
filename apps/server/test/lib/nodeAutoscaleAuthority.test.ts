import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDb, deployments, eq, fanoutTransitions, nodeAutoscaleCapacity, nodeAutoscaleTransitions, runMigrations, servers, services, serviceTargets } from '@ninedeploy/db';
import { admitNodeAutoscale, checkpointNodeAutoscale, commitNodeAutoscaleReplicas, recoverNodeAutoscaleAdmission, freezeNodeAutoscaleInventory, nodeAutoscaleFence } from '../../src/lib/nodeAutoscaleAuthority.js';
import { readServiceRuntimeOwner, reserveServiceRuntimeOwner } from '../../src/lib/serviceRuntimeOwner.js';
import * as runtimeOwner from '../../src/lib/serviceRuntimeOwner.js';
import { beginCanary, endCanary } from '../../src/engine/canaryState.js';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';

let c: ReturnType<typeof createDb>;
const service = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
beforeEach(async () => {
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values([{ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' }, { id: 5, name: 'Target', host: 'target.test', tokenEncrypted: 'fixture' }]);
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, status: 'running', runtimeId: 'web-9',
    autoscale: { minReplicas: 1, maxReplicas: 3, metric: 'cpu', target: 70, scaleUpSeconds: 60, scaleDownSeconds: 120 } });
  await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'running' });
  await c.db.insert(nodeAutoscaleCapacity).values({ deploymentId: 9, serviceId: 1, serverId: 4, runtimeId: 'web-9', imageId: `sha256:${'f'.repeat(64)}`,
    targets: ['web-9', 'web-9-r2', 'web-9-r3'].map((name, index) => ({ name, id: ['a', 'b', 'c'][index]!.repeat(64) })) });
});
afterEach(() => { endCanary(1); vi.restoreAllMocks(); c.client?.close(); });

it('refuses to adopt a replacement spare whose ID differs from the deployment receipt', async () => {
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const { timeoutMs: _timeout, ...fence } = nodeAutoscaleFence(admission);
  const items = [{ id: 'a'.repeat(64), name: 'web-9', deploymentId: 9, running: true },
    { id: 'c'.repeat(64), name: 'web-9-r2', deploymentId: 9, running: false }];
  await expect(freezeNodeAutoscaleInventory(c.db, admission, { ...fence, complete: true, items })).rejects.toThrow(/capacity.*identity/i);
  expect((await c.db.select().from(nodeAutoscaleTransitions))[0]?.replicaInventory).toBeNull();
});
it('does not reserve scale ownership without a complete capacity receipt', async () => {
  await c.db.delete(nodeAutoscaleCapacity).where(eq(nodeAutoscaleCapacity.deploymentId, 9));
  expect(await admitNodeAutoscale(c.db, await service(), 2)).toBeNull();
  expect(await readServiceRuntimeOwner(c.db, 1)).toBeNull();
  expect(await c.db.select().from(nodeAutoscaleTransitions)).toEqual([]);
});
it('rejects checkpoints when the stored capacity changes after inventory is frozen', async () => {
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const { timeoutMs: _timeout, ...fence } = nodeAutoscaleFence(admission);
  const items = [{ id: 'a'.repeat(64), name: 'web-9', deploymentId: 9, running: true },
    { id: 'b'.repeat(64), name: 'web-9-r2', deploymentId: 9, running: false }];
  await freezeNodeAutoscaleInventory(c.db, admission, { ...fence, complete: true, items });
  await c.db.update(nodeAutoscaleCapacity).set({ targets: [{ name: 'web-9', id: 'a'.repeat(64) }, { name: 'web-9-r2', id: 'c'.repeat(64) }] });
  await expect(checkpointNodeAutoscale(c.db, admission, 1)).rejects.toThrow(/capacity identity/);
});

it('refuses a desired count below the configured minimum without taking ownership', async () => {
  await c.db.update(services).set({ runtimeReplicas: 3,
    autoscale: { minReplicas: 2, maxReplicas: 3, metric: 'cpu', target: 70, scaleUpSeconds: 60, scaleDownSeconds: 120 } }).where(eq(services.id, 1));
  expect(await admitNodeAutoscale(c.db, await service(), 1)).toBeNull();
  expect(await readServiceRuntimeOwner(c.db, 1)).toBeNull();
  expect(await c.db.select().from(nodeAutoscaleTransitions)).toEqual([]);
  expect(await admitNodeAutoscale(c.db, await service(), 2)).not.toBeNull();
});
it('rolls back a reserved scale owner if a canary starts before admission commits', async () => {
  const prior = await reserveServiceRuntimeOwner(c.db, 1, 'deploy', null, 'c'.repeat(32));
  const original = runtimeOwner.reserveServiceRuntimeOwnerInTransaction;
  vi.spyOn(runtimeOwner, 'reserveServiceRuntimeOwnerInTransaction').mockImplementation(async (...args) => {
    const owner = await original(...args);
    beginCanary(1, 'web', 10, 2, false, false, { serverId: 4, stableRuntimeId: 'web-9' });
    return owner;
  });
  await expect(admitNodeAutoscale(c.db, await service(), 2)).rejects.toThrow(/canary/i);
  expect(await readServiceRuntimeOwner(c.db, 1)).toEqual(prior);
  expect(await c.db.select().from(nodeAutoscaleTransitions)).toEqual([]);
});
it('refuses to recover a stored decision below the configured minimum', async () => {
  await c.db.update(services).set({ runtimeReplicas: 3,
    autoscale: { minReplicas: 2, maxReplicas: 3, metric: 'cpu', target: 70, scaleUpSeconds: 60, scaleDownSeconds: 120 } }).where(eq(services.id, 1));
  expect(await admitNodeAutoscale(c.db, await service(), 2)).not.toBeNull();
  await c.db.update(nodeAutoscaleTransitions).set({ toReplicas: 1, leaseUntil: new Date(0) }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  await expect(recoverNodeAutoscaleAdmission(c.db, 1)).rejects.toThrow(/outside configured bounds/);
  expect((await service()).runtimeReplicas).toBe(3);
});
it('can restore the original count when the minimum was raised above it', async () => {
  await c.db.update(services).set({ runtimeReplicas: 1,
    autoscale: { minReplicas: 2, maxReplicas: 3, metric: 'cpu', target: 70, scaleUpSeconds: 60, scaleDownSeconds: 120 } }).where(eq(services.id, 1));
  const admitted = (await admitNodeAutoscale(c.db, await service(), 2))!;
  await commitNodeAutoscaleReplicas(c.db, admitted, 1, 2);
  await commitNodeAutoscaleReplicas(c.db, admitted, 2, 1);
  expect((await service()).runtimeReplicas).toBe(1);
});
it('reserves an ordered scale owner for the observed generation and node placements', async () => {
  await c.db.insert(serviceTargets).values({ serviceId: 1, serverId: 5, runtimeId: 'web-t5-9' });
  const admitted = await admitNodeAutoscale(c.db, await service(), 2);
  expect(admitted).toMatchObject({ owner: { kind: 'scale', requestId: expect.stringMatching(/^[a-f0-9]{32}$/) }, watermark: 9,
    desiredReplicas: 2, targets: [{ serverId: 5, runtimeId: 'web-t5-9' }] });
  expect(await c.db.select().from(nodeAutoscaleTransitions)).toMatchObject([{ serviceId: 1, ownerEpoch: admitted!.owner.epoch,
    requestId: admitted!.owner.requestId, serverId: 4, runtimeId: 'web-9', fromReplicas: 1, toReplicas: 2, watermark: 9,
    phase: 'accepted', targets: [{ serverId: 5, runtimeId: 'web-t5-9' }] }]);
  expect(await admitNodeAutoscale(c.db, await service(), 3)).toBeNull();
  await expect(checkpointNodeAutoscale(c.db, admitted!, 1)).resolves.toBeUndefined();
  await c.db.update(serviceTargets).set({ runtimeId: 'web-t5-10' }).where(eq(serviceTargets.serviceId, 1));
  await expect(checkpointNodeAutoscale(c.db, admitted!, 1)).rejects.toThrow(/placement changed/);
});
it.each(['queued', 'building', 'deploying'] as const)('does not displace a %s deployment', async status => {
  await c.db.insert(deployments).values({ id: 10, serviceId: 1, status });
  expect(await admitNodeAutoscale(c.db, await service(), 2)).toBeNull();
  expect(await readServiceRuntimeOwner(c.db, 1)).toBeNull();
});
it('does not displace a pending lifecycle command', async () => {
  await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
  const owner = await readServiceRuntimeOwner(c.db, 1);
  expect(await admitNodeAutoscale(c.db, await service(), 2)).toBeNull();
  expect(await readServiceRuntimeOwner(c.db, 1)).toEqual(owner);
});
it('does not displace unresolved fan-out recovery', async () => {
  await c.db.insert(fanoutTransitions).values({ serviceId: 1, serverId: 5, targetId: 42, deploymentId: 10, primaryRuntimeId: 'web-9',
    previousRuntimeId: 'web-t5-8', candidateRuntimeId: 'web-t5-10', port: 3000 });
  expect(await admitNodeAutoscale(c.db, await service(), 2)).toBeNull();
});
it('refuses stale or sleeping configuration and unknown fan-out generations', async () => {
  const old = await service();
  await c.db.update(services).set({ runtimeReplicas: 2 }).where(eq(services.id, 1));
  expect(await admitNodeAutoscale(c.db, old, 2)).toBeNull();
  await c.db.update(services).set({ asleepAt: new Date() }).where(eq(services.id, 1));
  expect(await admitNodeAutoscale(c.db, await service(), 3)).toBeNull();
  await c.db.update(services).set({ asleepAt: null }).where(eq(services.id, 1));
  await c.db.insert(serviceTargets).values({ serviceId: 1, serverId: 5, runtimeId: null });
  expect(await admitNodeAutoscale(c.db, await service(), 3)).toBeNull();
});
it('rejects checkpoints after serving count, health configuration or owner changes', async () => {
  const admitted = (await admitNodeAutoscale(c.db, await service(), 2))!;
  await expect(checkpointNodeAutoscale(c.db, admitted, 2)).rejects.toThrow(/runtime/);
  await c.db.update(services).set({ healthPath: '/new' }).where(eq(services.id, 1));
  await expect(checkpointNodeAutoscale(c.db, admitted, 1)).rejects.toThrow(/runtime/);
  await c.db.update(services).set({ healthPath: admitted.service.healthPath }).where(eq(services.id, 1));
  await reserveServiceRuntimeOwner(c.db, 1, 'deploy', admitted.owner, 'b'.repeat(32));
  await expect(checkpointNodeAutoscale(c.db, admitted, 1)).rejects.toThrow(/ownership/);
});
it('stops at the checkpoint when a deployment is queued after admission', async () => {
  const admitted = (await admitNodeAutoscale(c.db, await service(), 2))!;
  await c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'queued' });
  await expect(checkpointNodeAutoscale(c.db, admitted, 1)).rejects.toThrow(/active/);
});
it('commits a serving count under the same owner and rejects stale or out-of-capacity writes', async () => {
  const admitted = (await admitNodeAutoscale(c.db, await service(), 2))!;
  await commitNodeAutoscaleReplicas(c.db, admitted, 1, 2);
  expect((await service()).runtimeReplicas).toBe(2);
  await expect(checkpointNodeAutoscale(c.db, admitted, 2)).resolves.toBeUndefined();
  await expect(commitNodeAutoscaleReplicas(c.db, admitted, 1, 3)).rejects.toThrow(/runtime/);
  await expect(commitNodeAutoscaleReplicas(c.db, admitted, 2, 4)).rejects.toThrow(/count/);
  await expect(commitNodeAutoscaleReplicas(c.db, admitted, 2, 0)).rejects.toThrow(/count/);
  expect((await service()).runtimeReplicas).toBe(2);
});
it('does not write a count after a new deployment or owner arrives', async () => {
  const admitted = (await admitNodeAutoscale(c.db, await service(), 2))!;
  await c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'queued' });
  await expect(commitNodeAutoscaleReplicas(c.db, admitted, 1, 2)).rejects.toThrow(/active/);
  expect((await service()).runtimeReplicas).toBe(1);
  await c.db.update(deployments).set({ status: 'cancelled' }).where(eq(deployments.id, 10));
  await reserveServiceRuntimeOwner(c.db, 1, 'deploy', admitted.owner, 'b'.repeat(32));
  await expect(commitNodeAutoscaleReplicas(c.db, admitted, 1, 2)).rejects.toThrow(/ownership/);
  expect((await service()).runtimeReplicas).toBe(1);
});
it('can restore the original serving count when the configured maximum was lowered', async () => {
  await c.db.update(services).set({ runtimeReplicas: 3,
    autoscale: { minReplicas: 1, maxReplicas: 2, metric: 'cpu', target: 70, scaleUpSeconds: 60, scaleDownSeconds: 120 } }).where(eq(services.id, 1));
  const admitted = (await admitNodeAutoscale(c.db, await service(), 2))!;
  await commitNodeAutoscaleReplicas(c.db, admitted, 3, 2);
  await commitNodeAutoscaleReplicas(c.db, admitted, 2, 3);
  expect((await service()).runtimeReplicas).toBe(3);
});
it('recovers the same decision after its serving count changes and refuses changed health settings', async () => {
  const admitted = (await admitNodeAutoscale(c.db, await service(), 2))!;
  await commitNodeAutoscaleReplicas(c.db, admitted, 1, 2);
  await c.db.update(nodeAutoscaleTransitions).set({ leaseUntil: new Date(0) }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  const recovered = await recoverNodeAutoscaleAdmission(c.db, 1);
  expect(recovered).toMatchObject({ owner: admitted.owner, watermark: admitted.watermark, desiredReplicas: 2,
    targets: admitted.targets, service: { id: 1, runtimeId: 'web-9', runtimeReplicas: 1 } });
  await checkpointNodeAutoscale(c.db, recovered!, 2);
  await c.db.update(nodeAutoscaleTransitions).set({ leaseUntil: new Date(0) }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  await c.db.update(services).set({ healthTimeoutSeconds: 42 }).where(eq(services.id, 1));
  await expect(recoverNodeAutoscaleAdmission(c.db, 1)).rejects.toThrow(/changed/);
});
it('holds legacy or non-accepted decisions instead of guessing their authority on recovery', async () => {
  expect(await recoverNodeAutoscaleAdmission(c.db, 1)).toBeNull();
  const admitted = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const original = (await c.db.select().from(nodeAutoscaleTransitions))[0]!;
  await c.db.update(nodeAutoscaleTransitions).set({ configuration: '', leaseUntil: new Date(0) }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  await expect(recoverNodeAutoscaleAdmission(c.db, 1)).rejects.toThrow(/configuration/);
  await c.db.update(nodeAutoscaleTransitions).set({ configuration: original.configuration, phase: 'held' }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  await expect(recoverNodeAutoscaleAdmission(c.db, 1)).rejects.toThrow(/transition changed/);
  await c.db.update(nodeAutoscaleTransitions).set({ leaseUntil: new Date(Date.now() + 60_000) }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  await expect(checkpointNodeAutoscale(c.db, admitted, 1)).rejects.toThrow(/transition changed/);
});
it('allows one recovery claimant after expiry and rejects the previous worker', async () => {
  const first = (await admitNodeAutoscale(c.db, await service(), 2))!;
  expect(await recoverNodeAutoscaleAdmission(c.db, 1)).toBeNull();
  await c.db.update(nodeAutoscaleTransitions).set({ leaseUntil: new Date(0) }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  await expect(checkpointNodeAutoscale(c.db, first, 1)).rejects.toThrow(/lease/);
  const recovered = (await recoverNodeAutoscaleAdmission(c.db, 1))!;
  expect(recovered.workerToken).not.toBe(first.workerToken);
  expect(await recoverNodeAutoscaleAdmission(c.db, 1)).toBeNull();
  await expect(checkpointNodeAutoscale(c.db, first, 1)).rejects.toThrow(/lease/);
  await expect(commitNodeAutoscaleReplicas(c.db, first, 1, 2)).rejects.toThrow(/lease/);
  await expect(commitNodeAutoscaleReplicas(c.db, recovered, 1, 2)).resolves.toBeUndefined();
});
it('freezes the complete selected generation as immutable targets before scaling', async () => {
  const admitted = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const fence = nodeAutoscaleFence(admitted);
  const items = [{ id: 'a'.repeat(64), name: 'web-9', deploymentId: 9, running: true },
    { id: 'b'.repeat(64), name: 'web-9-r2', deploymentId: 9, running: false }];
  const receipt = { ...fence, complete: true as const, items };
  const { timeoutMs: _timeout, ...reply } = receipt;
  await freezeNodeAutoscaleInventory(c.db, admitted, reply);
  expect((await c.db.select().from(nodeAutoscaleTransitions))[0]!.replicaInventory).toEqual(items);
  await freezeNodeAutoscaleInventory(c.db, admitted, reply);
  await expect(freezeNodeAutoscaleInventory(c.db, admitted, { ...reply, items: [items[0]!, { ...items[1]!, id: 'c'.repeat(64) }] })).rejects.toThrow(/inventory changed|capacity identity/);
});
it('persists measured identities across recovery and rejects replaced serving containers', async () => {
  await c.db.update(nodeAutoscaleCapacity).set({ targets: [{ name: 'web-9', id: 'a'.repeat(64) }, { name: 'web-9-r2', id: 'c'.repeat(64) }] });
  const measurement = { serverId: 4, serviceId: 1, deploymentId: 9, sampledAt: Date.now(), requestId: 'd'.repeat(32),
    targets: [{ name: 'web-9', id: 'a'.repeat(64) }] };
  const admitted = (await admitNodeAutoscale(c.db, await service(), 2, measurement))!;
  expect((await c.db.select().from(nodeAutoscaleTransitions))[0]!.measurement).toEqual(measurement);
  await c.db.update(nodeAutoscaleTransitions).set({ leaseUntil: new Date(0) }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  const recovered = (await recoverNodeAutoscaleAdmission(c.db, 1))!;
  expect(recovered.measurement).toEqual(measurement);
  const { timeoutMs: _timeout, ...fence } = nodeAutoscaleFence(recovered);
  const items = [{ id: 'b'.repeat(64), name: 'web-9', deploymentId: 9, running: true },
    { id: 'c'.repeat(64), name: 'web-9-r2', deploymentId: 9, running: false }];
  await expect(freezeNodeAutoscaleInventory(c.db, recovered, { ...fence, complete: true, items })).rejects.toThrow(/measured replica identity changed/);
  expect((await c.db.select().from(nodeAutoscaleTransitions))[0]!.replicaInventory).toBeNull();
  await freezeNodeAutoscaleInventory(c.db, recovered, { ...fence, complete: true, items: [{ ...items[0]!, id: 'a'.repeat(64) }, items[1]!] });
  expect((await c.db.select().from(nodeAutoscaleTransitions))[0]!.replicaInventory).toHaveLength(2);
});
it('refuses stale or foreign measurement before reserving runtime ownership', async () => {
  const measurement = { serverId: 4, serviceId: 1, deploymentId: 9, sampledAt: Date.now(), requestId: 'd'.repeat(32),
    targets: [{ name: 'web-9', id: 'a'.repeat(64) }] };
  for (const change of [{ serverId: 5 }, { serviceId: 2 }, { deploymentId: 8 }, { sampledAt: Date.now() - 100_000 },
    { sampledAt: Date.now() + 100_000 }, { targets: [] }, { targets: [{ name: 'web-9', id: 'bad' }] }]) {
    expect(await admitNodeAutoscale(c.db, await service(), 2, { ...measurement, ...change })).toBeNull();
  }
  expect(await readServiceRuntimeOwner(c.db, 1)).toBeNull();
});
it('does not replace a runtime owner newer than the measured owner', async () => {
  const measurement = { serverId: 4, serviceId: 1, deploymentId: 9, sampledAt: Date.now(), requestId: 'd'.repeat(32),
    targets: [{ name: 'web-9', id: 'a'.repeat(64) }] };
  const newer = await reserveServiceRuntimeOwner(c.db, 1, 'restart', null, 'c'.repeat(32));
  expect(await admitNodeAutoscale(c.db, await service(), 2, measurement, null)).toBeNull();
  expect(await readServiceRuntimeOwner(c.db, 1)).toEqual(newer);
  expect(await c.db.select().from(nodeAutoscaleTransitions)).toEqual([]);
});
it('refuses to freeze inventory if the decision sample expires after admission', async () => {
  const now = Date.now();
  const measurement = { serverId: 4, serviceId: 1, deploymentId: 9, sampledAt: now - 89_900, requestId: 'd'.repeat(32),
    targets: [{ name: 'web-9', id: 'a'.repeat(64) }] };
  const admitted = (await admitNodeAutoscale(c.db, await service(), 2, measurement))!;
  const { timeoutMs: _timeout, ...fence } = nodeAutoscaleFence(admitted);
  const items = [{ id: 'a'.repeat(64), name: 'web-9', deploymentId: 9, running: true },
    { id: 'b'.repeat(64), name: 'web-9-r2', deploymentId: 9, running: false }];
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 200);
  try {
    await expect(freezeNodeAutoscaleInventory(c.db, admitted, { ...fence, complete: true, items })).rejects.toThrow(/measurement.*expired/i);
    expect((await c.db.select().from(nodeAutoscaleTransitions))[0]!.replicaInventory).toBeNull();
  } finally { clock.mockRestore(); }
});
it('refuses incomplete, wrongly owned, or already running scale-up capacity', async () => {
  const admitted = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const { timeoutMs: _timeout, ...fence } = nodeAutoscaleFence(admitted);
  const primary = { id: 'a'.repeat(64), name: 'web-9', deploymentId: 9, running: true };
  const spare = { id: 'b'.repeat(64), name: 'web-9-r2', deploymentId: 9, running: false };
  for (const items of [[primary], [primary, { ...spare, deploymentId: 8 }], [primary, { ...spare, running: true }],
    [{ ...primary, running: false }, spare], [primary, { ...spare, id: primary.id }]]) {
    await expect(freezeNodeAutoscaleInventory(c.db, admitted, { ...fence, complete: true, items })).rejects.toThrow();
  }
  expect((await c.db.select().from(nodeAutoscaleTransitions))[0]!.replicaInventory).toBeNull();
});
it('freezes every routed replica for scale-down and rejects foreign fence evidence', async () => {
  await c.db.update(nodeAutoscaleCapacity).set({ targets: ['web-9', 'web-9-r2', 'web-9-r3'].map((name, index) => ({ name, id: String(index + 1).repeat(64) })) });
  await c.db.update(services).set({ runtimeReplicas: 3 }).where(eq(services.id, 1));
  const admitted = (await admitNodeAutoscale(c.db, await service(), 1))!;
  const { timeoutMs: _timeout, ...fence } = nodeAutoscaleFence(admitted);
  const items = ['web-9', 'web-9-r2', 'web-9-r3'].map((name, index) => ({ id: String(index + 1).repeat(64), name, deploymentId: 9, running: true }));
  const reply = { ...fence, complete: true as const, items };
  for (const change of [{ requestId: 'f'.repeat(32) }, { revision: fence.revision + 1 }, { deploymentWatermark: fence.deploymentWatermark + 1 }]) {
    await expect(freezeNodeAutoscaleInventory(c.db, admitted, { ...reply, ...change })).rejects.toThrow(/fence/);
  }
  await freezeNodeAutoscaleInventory(c.db, admitted, reply);
  expect((await c.db.select().from(nodeAutoscaleTransitions))[0]!.replicaInventory).toEqual(items);
  await reserveServiceRuntimeOwner(c.db, 1, 'deploy', admitted.owner, 'b'.repeat(32));
  await expect(freezeNodeAutoscaleInventory(c.db, admitted, reply)).rejects.toThrow(/ownership/);
});
it('refuses effects if the durable transition disappears or changes', async () => {
  const admitted = (await admitNodeAutoscale(c.db, await service(), 2))!;
  await c.db.update(nodeAutoscaleTransitions).set({ toReplicas: 3 }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  await expect(commitNodeAutoscaleReplicas(c.db, admitted, 1, 2)).rejects.toThrow(/transition changed/);
  await c.db.delete(nodeAutoscaleTransitions).where(eq(nodeAutoscaleTransitions.serviceId, 1));
  await expect(checkpointNodeAutoscale(c.db, admitted, 1)).rejects.toThrow(/transition changed/);
  expect((await service()).runtimeReplicas).toBe(1);
});
it('refuses an unchanged or out-of-range scale decision without reserving an owner', async () => {
  for (const count of [0, 1, 4, 1.5]) expect(await admitNodeAutoscale(c.db, await service(), count)).toBeNull();
  for (const count of [0, 11]) {
    await c.db.update(services).set({ runtimeReplicas: count }).where(eq(services.id, 1));
    expect(await admitNodeAutoscale(c.db, await service(), 2)).toBeNull();
  }
  expect(await readServiceRuntimeOwner(c.db, 1)).toBeNull();
  expect(await c.db.select().from(nodeAutoscaleTransitions)).toEqual([]);
});
