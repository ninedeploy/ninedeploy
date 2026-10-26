import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, deploymentRuntimeOwners, deployments, eq, servers, serviceRuntimeOwners, services, type Service } from '@ninedeploy/db';
import { claimNodeDeploymentAttempt } from '../../src/lib/nodeDeploymentOwner.js';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';
import { readServiceRuntimeOwner, MAX_RUNTIME_EPOCH } from '../../src/lib/serviceRuntimeOwner.js';

let c: ReturnType<typeof createDb>;
const service = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
beforeEach(async () => {
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values([{ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' }, { id: 5, name: 'Other', host: 'other.test', tokenEncrypted: 'fixture' }]);
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, status: 'idle' });
  await c.db.insert(deployments).values([{ id: 9, serviceId: 1, status: 'queued' }, { id: 10, serviceId: 1, status: 'queued' }]);
});
afterEach(() => c.client!.close());

describe('durable node deployment admission', () => {
  it('does not grant queued successors authority and preserves the active predecessor', async () => {
    expect(await readServiceRuntimeOwner(c.db, 1)).toBeNull();
    expect(await c.db.select().from(deploymentRuntimeOwners)).toEqual([]);
    const first = await claimNodeDeploymentAttempt(c.db, 9, await service(), '{"build":"first"}');
    expect(first.claimed).toBe(true); if (!first.claimed) throw Error('Missing admitted owner');
    expect(first.owner).toMatchObject({ deploymentId: 9, serviceId: 1, serverId: 4, epoch: 1, requestId: expect.stringMatching(/^[a-f0-9]{32}$/) });
    expect((await service()).status).toBe('deploying');
    expect(await claimNodeDeploymentAttempt(c.db, 10, await service(), '{}')).toEqual({ claimed: false, reason: 'not_claimable' });
    expect(await readServiceRuntimeOwner(c.db, 1)).toMatchObject({ epoch: first.owner.epoch, requestId: first.owner.requestId, kind: 'deploy' });
    expect((await c.db.query.deployments.findFirst({ where: eq(deployments.id, 10) }))?.status).toBe('queued');
    expect(await c.db.select().from(deploymentRuntimeOwners)).toEqual([first.owner]);
    await c.db.update(deployments).set({ status: 'running' }).where(eq(deployments.id, 9));
    const next = await claimNodeDeploymentAttempt(c.db, 10, await service(), '{}');
    expect(next.claimed).toBe(true); if (!next.claimed) throw Error('Missing successor owner');
    expect(next.owner.epoch).toBeGreaterThan(first.owner.epoch); expect(next.owner.requestId).not.toBe(first.owner.requestId);
  });

  it('reuses its immutable stamp while configuration snapshots are rewritten', async () => {
    const first = await claimNodeDeploymentAttempt(c.db, 9, await service(), '{"build":"first"}');
    await c.db.update(deployments).set({ configSnapshot: '{"managedEnv":{}}' }).where(eq(deployments.id, 9));
    expect(await claimNodeDeploymentAttempt(c.db, 9, await service(), '{"build":"retry"}')).toEqual(first);
    expect(await c.db.select().from(deploymentRuntimeOwners)).toHaveLength(1);
    expect((await c.db.query.deployments.findFirst({ where: eq(deployments.id, 9) }))?.configSnapshot).toBe('{"build":"retry"}');
  });

  it('never lets a cancelled deployment reserve authority again after Stop or a newer deployment', async () => {
    const first = await claimNodeDeploymentAttempt(c.db, 9, await service(), '{}');
    const stopped = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    const stopOwner = await readServiceRuntimeOwner(c.db, 1);
    expect(await claimNodeDeploymentAttempt(c.db, 9, await service(), '{}')).toEqual({ claimed: false, reason: 'owner_changed' });
    expect(await readServiceRuntimeOwner(c.db, 1)).toEqual(stopOwner); expect((await service()).status).toBe('stopped');
    expect(stopped.action).toBe('stop');
    await c.db.insert(deployments).values({ id: 11, serviceId: 1, status: 'queued' });
    const newer = await claimNodeDeploymentAttempt(c.db, 11, await service(), '{}');
    expect(newer.claimed).toBe(true); if (!newer.claimed) throw Error('Missing newer owner');
    expect(newer.owner.epoch).toBeGreaterThan(stopOwner!.epoch);
    await c.db.update(deployments).set({ status: 'building' }).where(eq(deployments.id, 9));
    expect(await claimNodeDeploymentAttempt(c.db, 9, await service(), '{}')).toEqual({ claimed: false, reason: 'owner_changed' });
    expect(await c.db.query.deploymentRuntimeOwners.findFirst({ where: eq(deploymentRuntimeOwners.deploymentId, 9) })).toEqual(first.claimed ? first.owner : undefined);
    expect(await readServiceRuntimeOwner(c.db, 1)).toMatchObject({ requestId: newer.owner.requestId, epoch: newer.owner.epoch });
  });

  it.each(['running', 'failed', 'cancelled', 'superseded', 'deploying', 'awaiting_ci', 'awaiting_approval'] as const)('refuses non-claimable %s rows without reserving an owner', async status => {
    await c.db.update(deployments).set({ status }).where(eq(deployments.id, 9));
    expect(await claimNodeDeploymentAttempt(c.db, 9, await service(), '{}')).toEqual({ claimed: false, reason: 'not_claimable' });
    expect(await readServiceRuntimeOwner(c.db, 1)).toBeNull(); expect(await c.db.select().from(deploymentRuntimeOwners)).toEqual([]);
    expect((await service()).status).toBe('idle');
  });

  it('rolls back claim status, snapshot and authority if the private stamp cannot be stored', async () => {
    await c.client!.execute("CREATE TRIGGER reject_stamp BEFORE INSERT ON deployment_runtime_owners BEGIN SELECT RAISE(ABORT,'proof stamp rejection'); END");
    await expect(claimNodeDeploymentAttempt(c.db, 9, await service(), '{}')).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/proof stamp rejection/) }) });
    expect(await readServiceRuntimeOwner(c.db, 1)).toBeNull(); expect((await service()).status).toBe('idle');
    expect(await c.db.query.deployments.findFirst({ where: eq(deployments.id, 9) })).toMatchObject({ status: 'queued', configSnapshot: null, startedAt: null });
  });

  it('rolls back the claim when the shared revision space is exhausted', async () => {
    await c.db.insert(serviceRuntimeOwners).values({ serviceId: 1, epoch: MAX_RUNTIME_EPOCH, kind: 'legacy', requestId: null });
    await expect(claimNodeDeploymentAttempt(c.db, 9, await service(), '{}')).rejects.toThrow(/capacity exceeded/);
    expect(await c.db.query.deployments.findFirst({ where: eq(deployments.id, 9) })).toMatchObject({ status: 'queued', configSnapshot: null, startedAt: null });
    expect((await service()).status).toBe('idle'); expect(await c.db.select().from(deploymentRuntimeOwners)).toEqual([]);
  });

  it('retains the original stamp when its node is removed or the service moves', async () => {
    const first = await claimNodeDeploymentAttempt(c.db, 9, await service(), '{}'), original = await service();
    await c.db.delete(servers).where(eq(servers.id, 4));
    expect(await claimNodeDeploymentAttempt(c.db, 9, original, '{}')).toEqual({ claimed: false, reason: 'placement_changed' });
    await c.db.update(services).set({ serverId: 5 }).where(eq(services.id, 1));
    expect(await claimNodeDeploymentAttempt(c.db, 9, await service(), '{}')).toEqual({ claimed: false, reason: 'owner_changed' });
    expect(await c.db.query.deploymentRuntimeOwners.findFirst()).toEqual(first.claimed ? first.owner : undefined);
  });

  it('does not claim another service deployment or invent a missing deployment', async () => {
    await c.db.insert(services).values({ id: 2, name: 'Other', slug: 'other', type: 'docker', serverId: 4 });
    await c.db.insert(deployments).values({ id: 12, serviceId: 2 });
    for (const id of [12, 999]) expect(await claimNodeDeploymentAttempt(c.db, id, await service(), '{}')).toEqual({ claimed: false, reason: 'not_claimable' });
    expect(await readServiceRuntimeOwner(c.db, 1)).toBeNull();
  });

  it.each([{ serverId: null }, { orchestrator: 'swarm' }, { type: 'pm2' }])('requires a real plain Docker node placement: %j', async patch => {
    await expect(claimNodeDeploymentAttempt(c.db, 9, { ...await service(), ...patch } as Service, '{}')).rejects.toThrow(/plain Docker/);
    expect(await readServiceRuntimeOwner(c.db, 1)).toBeNull();
  });
});
