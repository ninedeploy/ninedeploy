import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, deploymentRuntimeOwners, deployments, eq, servers, serviceRuntimeOwners, services, type Service } from '@ninedeploy/db';
import { claimNodeDeploymentAttempt, createNodeDeploymentAuthority, NodeDeploymentOwnershipLost } from '../../src/lib/nodeDeploymentOwner.js';
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
  it('does not grant a later deployment authority over an unfinished Stop candidate handoff', async () => {
    await c.db.update(services).set({ runtimeId: 'web-8', status: 'running' }).where(eq(services.id, 1));
    const first = await claimNodeDeploymentAttempt(c.db, 9, await service(), '{}');
    expect(first.claimed).toBe(true);
    const stop = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(stop.snapshot.interruptedDeployments).toEqual([{ id: 9 }]);
    await c.db.insert(deployments).values({ id: 11, serviceId: 1, status: 'queued' });
    const stoppedOwner = await readServiceRuntimeOwner(c.db, 1);
    expect((await claimNodeDeploymentAttempt(c.db, 11, await service(), '{}')).claimed).toBe(false);
    expect(await readServiceRuntimeOwner(c.db, 1)).toEqual(stoppedOwner);
    expect((await c.db.query.deployments.findFirst({ where: eq(deployments.id, 11) }))?.status).toBe('queued');
  });
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


describe('node deployment authority boundaries', () => {
  async function admitted() {
    const result = await claimNodeDeploymentAttempt(c.db, 9, await service(), '{}');
    if (!result.claimed) throw Error('Missing admitted owner');
    return { owner: result.owner, guard: createNodeDeploymentAuthority(c.db, result.owner) };
  }
  it('fences SQL at execution time when Stop wins after a successful checkpoint', async () => {
    const { guard } = await admitted(); await guard.check();
    await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(await c.db.update(services).set({ status: 'running', runtimeId: 'obsolete' }).where(guard.fence()).returning()).toEqual([]);
    expect(await c.db.update(deployments).set({ status: 'failed' }).where(guard.fence()).returning()).toEqual([]);
    await expect(guard.check()).rejects.toBeInstanceOf(NodeDeploymentOwnershipLost);
    expect(guard.lost()).toBe(true); expect((await service()).status).toBe('stopped');
    expect((await c.db.query.deployments.findFirst({ where: eq(deployments.id, 9) }))?.status).toBe('cancelled');
  });
  it('permits cleanup under the original owner after cancellation without claiming a new epoch', async () => {
    const { guard, owner } = await admitted();
    await c.db.update(deployments).set({ status: 'cancelled', configSnapshot: '{}' }).where(eq(deployments.id, 9));
    await guard.check(); expect(guard.lost()).toBe(false);
    expect(await c.db.update(services).set({ status: 'idle' }).where(guard.fence()).returning({ id: services.id })).toEqual([{ id: 1 }]);
    expect(await readServiceRuntimeOwner(c.db, 1)).toMatchObject({ epoch: owner.epoch, requestId: owner.requestId });
  });
  it.each(['nonce', 'epoch', 'kind', 'stamp', 'node', 'type', 'orchestrator', 'deleted node', 'deleted deployment'] as const)('refuses changed %s before effects or status writes', async boundary => {
    const { guard, owner } = await admitted(); await guard.check();
    if (boundary === 'nonce') await c.db.update(serviceRuntimeOwners).set({ requestId: 'f'.repeat(32) }).where(eq(serviceRuntimeOwners.serviceId, 1));
    if (boundary === 'epoch') await c.db.update(serviceRuntimeOwners).set({ epoch: owner.epoch + 1 }).where(eq(serviceRuntimeOwners.serviceId, 1));
    if (boundary === 'kind') await c.db.update(serviceRuntimeOwners).set({ kind: 'stop' }).where(eq(serviceRuntimeOwners.serviceId, 1));
    if (boundary === 'stamp') await c.db.delete(deploymentRuntimeOwners).where(eq(deploymentRuntimeOwners.deploymentId, 9));
    if (boundary === 'node') await c.db.update(services).set({ serverId: 5 }).where(eq(services.id, 1));
    if (boundary === 'type') await c.db.update(services).set({ type: 'compose' }).where(eq(services.id, 1));
    if (boundary === 'orchestrator') await c.db.update(services).set({ orchestrator: 'swarm' }).where(eq(services.id, 1));
    if (boundary === 'deleted node') await c.db.delete(servers).where(eq(servers.id, 4));
    if (boundary === 'deleted deployment') await c.db.delete(deployments).where(eq(deployments.id, 9));
    const before = await service();
    expect(await c.db.update(services).set({ status: 'error', runtimeId: 'obsolete' }).where(guard.fence()).returning()).toEqual([]);
    await expect(guard.check()).rejects.toBeInstanceOf(NodeDeploymentOwnershipLost);
    expect(await service()).toEqual(before);
  });
  it('keeps an observed loss terminal even if the old SQL identity is restored', async () => {
    const { guard, owner } = await admitted();
    await c.db.update(serviceRuntimeOwners).set({ requestId: 'f'.repeat(32) }).where(eq(serviceRuntimeOwners.serviceId, 1));
    await expect(guard.check()).rejects.toBeInstanceOf(NodeDeploymentOwnershipLost);
    await c.db.update(serviceRuntimeOwners).set({ requestId: owner.requestId }).where(eq(serviceRuntimeOwners.serviceId, 1));
    await expect(guard.check()).rejects.toBeInstanceOf(NodeDeploymentOwnershipLost);
  });
  it('rejects an in-flight old read after another checkpoint has observed authority loss', async () => {
    const { guard } = await admitted();
    let entered!: () => void, release!: () => void;
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const query = c.db.query.deploymentRuntimeOwners;
    const original = query.findFirst.bind(query);
    const read = vi.spyOn(query, 'findFirst').mockImplementationOnce(options => {
      const result = original(options);
      // Delay delivery of a real completed SQL read, not the ownership decision.
      return result.then(async row => { entered(); await gate; return row; }) as typeof result;
    });
    const pending = guard.check();
    try {
      await arrived;
      await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
      await expect(guard.check()).rejects.toBeInstanceOf(NodeDeploymentOwnershipLost);
      release();
      await expect(pending).rejects.toBeInstanceOf(NodeDeploymentOwnershipLost);
    } finally { release(); await pending.catch(() => undefined); read.mockRestore(); }
  });
  it('captures the owner instead of following a mutable caller object', async () => {
    const { owner, guard } = await admitted(); owner.requestId = 'f'.repeat(32); owner.serverId = 5;
    await guard.check(); expect(guard.lost()).toBe(false);
  });
  it('propagates an unavailable authority read without granting permission', async () => {
    const { guard } = await admitted();
    const read = vi.spyOn(c.db.query.deploymentRuntimeOwners, 'findFirst').mockRejectedValueOnce(Error('Authority unavailable'));
    try { await expect(guard.check()).rejects.toThrow('Authority unavailable'); }
    finally { read.mockRestore(); }
    await guard.check();
  });
  it.each([{ epoch: 0 }, { serverId: -1 }, { serviceId: 1.5 }, { deploymentId: NaN }, { epoch: MAX_RUNTIME_EPOCH + 1 }, { requestId: 'invalid' }])('refuses invalid captured authority: %j', async patch => {
    const { owner } = await admitted();
    expect(() => createNodeDeploymentAuthority(c.db, { ...owner, ...patch })).toThrow('Invalid node deployment authority');
  });
});
