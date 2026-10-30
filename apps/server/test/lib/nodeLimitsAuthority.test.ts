import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDb, deployments, eq, fanoutTransitions, runMigrations, servers, services, serviceTargets } from '@ninedeploy/db';
import { admitNodeLimits, checkpointNodeLimits } from '../../src/lib/nodeLimitsAuthority.js';
import { readServiceRuntimeOwner, reserveServiceRuntimeOwner } from '../../src/lib/serviceRuntimeOwner.js';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';

let c: ReturnType<typeof createDb>;
const service = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
beforeEach(async () => {
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values([{ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' }, { id: 5, name: 'Target', host: 'target.test', tokenEncrypted: 'fixture' }]);
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, status: 'running', runtimeId: 'web-9', memLimitMb: 64 });
  await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'running' });
});
afterEach(() => c.client?.close());

it('reserves a revision for a stable primary and remote target and tracks their placement', async () => {
  await c.db.insert(serviceTargets).values({ serviceId: 1, serverId: 5, runtimeId: 'web-t5-9' });
  const admission = await admitNodeLimits(c.db, await service());
  expect(admission).toMatchObject({ owner: { kind: 'limits', requestId: expect.stringMatching(/^[a-f0-9]{32}$/) }, watermark: 9,
    targets: [{ serverId: 5, runtimeId: 'web-t5-9' }] });
  await expect(checkpointNodeLimits(c.db, admission!)).resolves.toBeUndefined();
  await c.db.update(serviceTargets).set({ runtimeId: 'web-t5-10' }).where(eq(serviceTargets.serviceId, 1));
  await expect(checkpointNodeLimits(c.db, admission!)).rejects.toThrow(/placement changed/);
});
it.each(['queued', 'building', 'deploying'] as const)('does not take ownership during a %s deployment', async status => {
  await c.db.insert(deployments).values({ id: 10, serviceId: 1, status });
  expect(await admitNodeLimits(c.db, await service())).toBeNull();
  expect(await readServiceRuntimeOwner(c.db, 1)).toBeNull();
});
it('does not interrupt a pending lifecycle operation', async () => {
  await acceptNodeLifecycleIntent(c.db, await service(), 'start');
  const old = await readServiceRuntimeOwner(c.db, 1);
  expect(await admitNodeLimits(c.db, await service())).toBeNull();
  expect(await readServiceRuntimeOwner(c.db, 1)).toEqual(old);
});
it('does not displace unresolved fan-out recovery', async () => {
  await c.db.insert(fanoutTransitions).values({ serviceId: 1, serverId: 5, targetId: 42, deploymentId: 10, primaryRuntimeId: 'web-9',
    previousRuntimeId: 'web-t5-8', candidateRuntimeId: 'web-t5-10', port: 3000 });
  expect(await admitNodeLimits(c.db, await service())).toBeNull();
  expect(await readServiceRuntimeOwner(c.db, 1)).toBeNull();
});
it('rejects a stale limit snapshot before reserving authority', async () => {
  const old = await service(); await c.db.update(services).set({ memLimitMb: 128 }).where(eq(services.id, 1));
  expect(await admitNodeLimits(c.db, old)).toBeNull(); expect(await readServiceRuntimeOwner(c.db, 1)).toBeNull();
});
it('invalidates the checkpoint when a newer runtime owner wins', async () => {
  const admission = (await admitNodeLimits(c.db, await service()))!;
  await reserveServiceRuntimeOwner(c.db, 1, 'deploy', admission.owner, 'b'.repeat(32));
  await expect(checkpointNodeLimits(c.db, admission)).rejects.toThrow(/ownership/);
});
it('does not admit a target whose active generation is unknown', async () => {
  await c.db.insert(serviceTargets).values({ serviceId: 1, serverId: 5, runtimeId: null });
  expect(await admitNodeLimits(c.db, await service())).toBeNull();
  expect(await readServiceRuntimeOwner(c.db, 1)).toBeNull();
});
