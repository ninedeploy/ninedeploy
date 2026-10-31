import { expect, it } from 'vitest';
import { createDb, runMigrations, services, servers, users, deployments, nodeLifecycleIntents, eq } from '@ninedeploy/db';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';
import { claimNodeDeploymentAttempt } from '../../src/lib/nodeDeploymentOwner.js';
import { beginNodeDeploymentPreparation } from '../../src/lib/nodeDeploymentPreparation.js';

it.each(['web-9', null])('includes failed node preparation when stopping runtime %s', async runtimeId => {
  const c = createDb({ url: 'file::memory:' });
  try {
    await c.ready; await runMigrations(c.db);
    await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
    await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, runtimeId, status: 'running' });
    await c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'queued' });
    const service = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
    const admitted = await claimNodeDeploymentAttempt(c.db, 10, await service(), '{}');
    if (!admitted.claimed) throw Error('Missing deployment authority');
    await beginNodeDeploymentPreparation(c.db, admitted.owner, { runtimeId: 'web-10', imageId: `sha256:${'f'.repeat(64)}`, serving: 1, capacity: 2 });
    await c.db.update(deployments).set({ status: 'failed' }).where(eq(deployments.id, 10));
    const intent = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(intent.snapshot.interruptedDeployments).toEqual([{ id: 10 }]);
    if (runtimeId) expect(intent.snapshot.candidateParticipants?.[0]?.targets).toContainEqual({ name: 'web-10-r2', deploymentId: 10 });
    else expect(intent.snapshot.unselected?.participants[0]?.expectedNames).toContain('web-10-r2');
  } finally { c.client?.close(); }
});

it.each(['web-9', null])('records in-flight deployment identities for Stop with selected runtime %s', async runtimeId => {
  const c = createDb({ url: 'file::memory:' });
  try {
    await c.ready; await runMigrations(c.db);
    await c.db.insert(users).values({ id: 1, email: 'node-stop-fixture@example.test', passwordHash: 'fixture', isInstanceOperator: true });
    await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
    await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', ownerUserId: 1, serverId: 4, runtimeId,
      status: runtimeId ? 'running' : 'deploying', port: 3000 });
    await c.db.insert(deployments).values([
      { id: 9, serviceId: 1, status: 'running' }, { id: 10, serviceId: 1, status: 'building' },
      { id: 11, serviceId: 1, status: 'deploying' }, { id: 12, serviceId: 1, status: 'queued' },
    ]);
    const service = (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
    const intent = await acceptNodeLifecycleIntent(c.db, service, 'stop');
    expect(intent.snapshot).toMatchObject({ interruptedDeployments: [{ id: 10 }, { id: 11 }], creationFenceDeploymentId: 12 });
    const persisted = await c.db.query.nodeLifecycleIntents.findFirst({ where: eq(nodeLifecycleIntents.id, intent.id) });
    expect(persisted?.snapshot).toMatchObject({ interruptedDeployments: [{ id: 10 }, { id: 11 }], creationFenceDeploymentId: 12 });
    expect((await c.db.select().from(deployments)).filter(row => row.id >= 10).map(row => row.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  } finally { c.client?.close(); }
});

it('preserves an unfinished Stop handoff through repeated Stop and refuses Start until resolved', async () => {
  const c = createDb({ url: 'file::memory:' });
  try {
    await c.ready; await runMigrations(c.db);
    await c.db.insert(users).values({ id: 1, email: 'node-stop-retry@example.test', passwordHash: 'fixture', isInstanceOperator: true });
    await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
    await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', ownerUserId: 1, serverId: 4, runtimeId: 'web-9', status: 'running' });
    await c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'deploying' });
    const service = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
    await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    const retry = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(retry.snapshot.interruptedDeployments).toEqual([{ id: 10 }]);
    expect(retry.snapshot.creationFenceDeploymentId).toBe(10);
    await expect(acceptNodeLifecycleIntent(c.db, await service(), 'start')).rejects.toThrow(/candidate|handoff/i);
    expect((await service()).status).toBe('stopped');
  } finally { c.client?.close(); }
});

it('fences a deleted higher deployment ID that could still have a delayed agent request', async () => {
  const c = createDb({ url: 'file::memory:' });
  try {
    await c.ready; await runMigrations(c.db);
    await c.db.insert(users).values({ id: 1, email: 'node-stop-sequence@example.test', passwordHash: 'fixture', isInstanceOperator: true });
    await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
    await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', ownerUserId: 1, serverId: 4, runtimeId: 'web-9', status: 'running' });
    await c.db.insert(deployments).values([{ id: 10, serviceId: 1, status: 'deploying' }, { id: 25, serviceId: 1, status: 'cancelled' }]);
    await c.db.delete(deployments).where(eq(deployments.id, 25));
    const service = (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
    const intent = await acceptNodeLifecycleIntent(c.db, service, 'stop');
    expect(intent.snapshot.creationFenceDeploymentId).toBe(25);
    expect(intent.snapshot.interruptedDeployments).toEqual([{ id: 10 }]);
  } finally { c.client?.close(); }
});
