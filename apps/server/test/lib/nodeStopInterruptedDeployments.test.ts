import { expect, it } from 'vitest';
import { createDb, runMigrations, services, servers, users, deployments, nodeLifecycleIntents, eq } from '@ninedeploy/db';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';

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
    expect(intent.snapshot).toMatchObject({ interruptedDeployments: [{ id: 10 }, { id: 11 }] });
    const persisted = await c.db.query.nodeLifecycleIntents.findFirst({ where: eq(nodeLifecycleIntents.id, intent.id) });
    expect(persisted?.snapshot).toMatchObject({ interruptedDeployments: [{ id: 10 }, { id: 11 }] });
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
    await expect(acceptNodeLifecycleIntent(c.db, await service(), 'start')).rejects.toThrow(/candidate|handoff/i);
    expect((await service()).status).toBe('stopped');
  } finally { c.client?.close(); }
});
