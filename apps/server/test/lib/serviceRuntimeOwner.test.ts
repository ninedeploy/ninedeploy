import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, deployments, eq, fanoutTransitions, nodeLifecycleIntents, runMigrations, runtimeMutationKinds, servers, services, serviceRuntimeOwners } from '@ninedeploy/db';
import { acceptNodeLifecycleIntent, checkpointNodeLifecycleIntent, claimNodeLifecycleIntent, nodeLifecycleWireRevision, retryNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';
import { publicNodeLifecycle } from '../../src/lib/nodeLifecycleRuntime.js';
import { MAX_RUNTIME_EPOCH, readServiceRuntimeOwner, reserveServiceRuntimeOwner, sameRuntimeOwner, serviceRuntimeRevision } from '../../src/lib/serviceRuntimeOwner.js';
import { beginNodeDeploymentPreparation } from '../../src/lib/nodeDeploymentPreparation.js';
import { claimNodeDeploymentAttempt } from '../../src/lib/nodeDeploymentOwner.js';

let c: ReturnType<typeof createDb>;
const nonce = (n: number) => n.toString(16).padStart(32, '0');
const service = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
beforeEach(async () => {
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
  await c.db.insert(services).values([{ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, runtimeId: 'web-9', status: 'stopped' },
    { id: 2, name: 'Other', slug: 'other', type: 'docker', serverId: 4, runtimeId: 'other-8', status: 'running' }]);
});
afterEach(() => c.client?.close());

describe('shared service runtime authority', () => {
  it('does not let unrelated mutations supersede an unresolved node preparation', async () => {
    await c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'queued' });
    const admitted = await claimNodeDeploymentAttempt(c.db, 10, await service(), '{}');
    if (!admitted.claimed) throw Error('Missing deployment authority');
    await beginNodeDeploymentPreparation(c.db, admitted.owner, { runtimeId: 'web-10', imageId: `sha256:${'f'.repeat(64)}`, serving: 1, capacity: 2 });
    await c.db.update(deployments).set({ status: 'failed' }).where(eq(deployments.id, 10));
    const owner = (await readServiceRuntimeOwner(c.db, 1))!;
    for (const kind of runtimeMutationKinds.filter(value => value !== 'stop')) {
      await expect(reserveServiceRuntimeOwner(c.db, 1, kind, owner, nonce(100))).rejects.toMatchObject({ code: 'node_preparation_pending' });
    }
    expect(await readServiceRuntimeOwner(c.db, 1)).toEqual(owner);
    expect(await reserveServiceRuntimeOwner(c.db, 1, 'deploy', owner, owner.requestId!)).toEqual(owner);
    expect(await reserveServiceRuntimeOwner(c.db, 2, 'scale', null, nonce(101))).toMatchObject({ kind: 'scale' });
  });
  it.each(runtimeMutationKinds)('reserves the declared %s kind without changing service state', async kind => {
    const before = await service();
    expect(await reserveServiceRuntimeOwner(c.db, 1, kind, null, nonce(1))).toMatchObject({ kind, requestId: nonce(1) });
    expect(await service()).toEqual(before);
  });

  it('advances one authority across different mutators and replays the same reservation without advancing it', async () => {
    const deploy = await reserveServiceRuntimeOwner(c.db, 1, 'deploy', null, nonce(1));
    const scale = await reserveServiceRuntimeOwner(c.db, 1, 'scale', deploy, nonce(2));
    expect(scale.epoch).toBeGreaterThan(deploy.epoch);
    expect(await reserveServiceRuntimeOwner(c.db, 1, 'scale', deploy, nonce(2))).toEqual(scale);
    expect(await c.db.select().from(serviceRuntimeOwners)).toHaveLength(1);
    expect(serviceRuntimeRevision(deploy.epoch, 3)).toBeLessThan(serviceRuntimeRevision(scale.epoch, 0));
  });

  it('refuses a delayed job whose captured authority was replaced, even if service placement and status did not change', async () => {
    const before = await service();
    const original = await reserveServiceRuntimeOwner(c.db, 1, 'deploy', null, nonce(1));
    const current = await reserveServiceRuntimeOwner(c.db, 1, 'wake', original, nonce(2));
    await expect(reserveServiceRuntimeOwner(c.db, 1, 'deploy', original, nonce(3))).rejects.toMatchObject({ statusCode: 409, code: 'runtime_owner_superseded' });
    expect(await readServiceRuntimeOwner(c.db, 1)).toEqual(current);
    expect(await service()).toEqual(before);
  });

  it('cannot reuse a request for another mutation kind or another service authority', async () => {
    const first = await reserveServiceRuntimeOwner(c.db, 1, 'deploy', null, nonce(1));
    await expect(reserveServiceRuntimeOwner(c.db, 1, 'sleep', first, nonce(1))).rejects.toMatchObject({ code: 'runtime_owner_superseded' });
    await expect(reserveServiceRuntimeOwner(c.db, 2, 'deploy', first, nonce(2))).rejects.toMatchObject({ code: 'runtime_owner_superseded' });
    const other = await reserveServiceRuntimeOwner(c.db, 2, 'deploy', null, nonce(2));
    expect(sameRuntimeOwner(first, other)).toBe(false);
    expect(sameRuntimeOwner(first, null)).toBe(false); expect(sameRuntimeOwner(null, first)).toBe(false);
    expect(sameRuntimeOwner(null, null)).toBe(true); expect(sameRuntimeOwner(first, first)).toBe(true);
  });

  it('invalidates an older lifecycle lease, public retry and late callback when a different mutator reserves authority', async () => {
    const accepted = await acceptNodeLifecycleIntent(c.db, await service(), 'start');
    const lease = (await claimNodeLifecycleIntent(c.db, accepted.id))!;
    const owner = await readServiceRuntimeOwner(c.db, 1);
    const deploy = await reserveServiceRuntimeOwner(c.db, 1, 'deploy', owner, nonce(20));
    await expect(checkpointNodeLifecycleIntent(c.db, lease)).rejects.toMatchObject({ code: 'node_lifecycle_superseded' });
    await expect(retryNodeLifecycleIntent(c.db, await service())).rejects.toMatchObject({ code: 'node_lifecycle_superseded' });
    expect((await publicNodeLifecycle(c.db, await service())).command).toMatchObject({ current: false, retryable: false });
    expect(await readServiceRuntimeOwner(c.db, 1)).toEqual(deploy);
  });

  it.each(['start', 'restart'] as const)('does not steal deployment authority for %s while a target handoff requires recovery', async action => {
    const deploy = await reserveServiceRuntimeOwner(c.db, 1, 'deploy', null, nonce(1));
    await c.db.insert(servers).values({ id: 5, name: 'Target', host: 'target.test', tokenEncrypted: 'fixture' });
    await c.db.insert(fanoutTransitions).values({ serviceId: 1, serverId: 5, targetId: 42, deploymentId: 10, primaryRuntimeId: 'web-9',
      previousRuntimeId: 'web-t5-8', candidateRuntimeId: 'web-t5-10', port: 3000 });
    await expect(acceptNodeLifecycleIntent(c.db, await service(), action)).rejects.toMatchObject({ code: 'node_lifecycle_deployment_busy' });
    expect(await readServiceRuntimeOwner(c.db, 1)).toEqual(deploy);
    expect(await c.db.select().from(nodeLifecycleIntents)).toEqual([]);
  });

  it('uses authority revisions rather than history IDs after non-lifecycle work and history deletion', async () => {
    const first = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    await c.db.delete(nodeLifecycleIntents);
    const old = await readServiceRuntimeOwner(c.db, 1);
    const deploy = await reserveServiceRuntimeOwner(c.db, 1, 'deploy', old, nonce(20));
    const stop = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(stop.snapshot.revisionEpoch).toBeGreaterThan(stop.id);
    expect(nodeLifecycleWireRevision(stop, 'fence')).toBeGreaterThan(serviceRuntimeRevision(deploy.epoch, 3));
    expect(nodeLifecycleWireRevision(stop, 'effect')).toBeGreaterThan(nodeLifecycleWireRevision(first, 'effect'));
  });

  it('preserves the original wire revision for a migrated pending command whose authority epoch is larger than its ID', async () => {
    const accepted = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    await c.db.update(serviceRuntimeOwners).set({ epoch: 500 }).where(eq(serviceRuntimeOwners.serviceId, 1));
    await c.db.update(nodeLifecycleIntents).set({ snapshot: { ...accepted.snapshot, mutationEpoch: 500, revisionEpoch: undefined } }).where(eq(nodeLifecycleIntents.id, accepted.id));
    const claimed = (await claimNodeLifecycleIntent(c.db, accepted.id))!;
    expect(nodeLifecycleWireRevision(claimed, 'effect')).toBe(accepted.id * 4 + 1);
    expect(await checkpointNodeLifecycleIntent(c.db, claimed)).toMatchObject({ intent: { id: accepted.id } });
    const next = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    expect(nodeLifecycleWireRevision(next, 'fence')).toBeGreaterThan(serviceRuntimeRevision(500, 3));
  });

  it('bounds revision capacity without wrapping or changing the accepted owner', async () => {
    const first = await reserveServiceRuntimeOwner(c.db, 1, 'deploy', null, nonce(1));
    await c.db.update(serviceRuntimeOwners).set({ epoch: MAX_RUNTIME_EPOCH }).where(eq(serviceRuntimeOwners.serviceId, 1));
    const maximum = (await readServiceRuntimeOwner(c.db, 1))!;
    await expect(reserveServiceRuntimeOwner(c.db, 1, 'wake', maximum, nonce(2))).rejects.toThrow(/capacity/);
    expect((await readServiceRuntimeOwner(c.db, 1))!.requestId).toBe(first.requestId);
    expect(serviceRuntimeRevision(MAX_RUNTIME_EPOCH, 3)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    for (const epoch of [0, -1, 1.5, MAX_RUNTIME_EPOCH + 1]) expect(() => serviceRuntimeRevision(epoch, 0)).toThrow(/capacity/);
    expect(() => serviceRuntimeRevision(1, 4 as 0)).toThrow(/capacity/);
  });

  it('advances a migrated high-water mark whose legacy head has no active request', async () => {
    await c.db.insert(serviceRuntimeOwners).values({ serviceId: 1, epoch: 500, kind: 'legacy', requestId: null });
    const legacy = await readServiceRuntimeOwner(c.db, 1);
    const next = await reserveServiceRuntimeOwner(c.db, 1, 'deploy', legacy, nonce(1));
    expect(next).toMatchObject({ epoch: 501, requestId: nonce(1), kind: 'deploy' });
  });

  it.each([{ epoch: -1 }, { epoch: MAX_RUNTIME_EPOCH + 1 }, { kind: 'corrupt' }, { kind: 'legacy' }, { requestId: 'invalid' }, { requestId: null }, { epoch: 0 }])('retains an invalid existing head for review: %j', async patch => {
    await reserveServiceRuntimeOwner(c.db, 1, 'deploy', null, nonce(1));
    const key = Object.keys(patch)[0]!;
    const column = key === 'requestId' ? 'request_id' : key;
    await c.client!.execute({ sql: `UPDATE service_runtime_owners SET ${column}=? WHERE service_id=1`, args: [Object.values(patch)[0]!] });
    await expect(readServiceRuntimeOwner(c.db, 1)).rejects.toThrow(/invalid/);
    await expect(reserveServiceRuntimeOwner(c.db, 1, 'wake', null, nonce(2))).rejects.toThrow(/invalid/);
  });

  it('rejects invalid requests and unknown services before writing authority', async () => {
    await expect(reserveServiceRuntimeOwner(c.db, 0, 'deploy', null, nonce(1))).rejects.toThrow(/Invalid/);
    await expect(reserveServiceRuntimeOwner(c.db, 1, 'deploy', null, 'invalid')).rejects.toThrow(/Invalid/);
    await expect(reserveServiceRuntimeOwner(c.db, 1, 'legacy' as 'deploy', null, nonce(1))).rejects.toThrow(/Invalid/);
    await expect(reserveServiceRuntimeOwner(c.db, 99, 'deploy', null, nonce(1))).rejects.toMatchObject({ code: 'runtime_owner_superseded' });
    expect(await c.db.select().from(serviceRuntimeOwners)).toEqual([]);
  });

  it('refuses a corrupt legacy high-water mark instead of restarting its revision sequence', async () => {
    await c.client!.execute("DELETE FROM sqlite_sequence WHERE name='node_lifecycle_intents'");
    await c.client!.execute("INSERT INTO sqlite_sequence(name,seq) VALUES ('node_lifecycle_intents',-1)");
    await expect(reserveServiceRuntimeOwner(c.db, 1, 'deploy', null, nonce(1))).rejects.toThrow(/capacity/);
    expect(await c.db.select().from(serviceRuntimeOwners)).toEqual([]);
  });

  it.each([{ type: 'docker', orchestrator: 'docker' }, { type: 'docker', orchestrator: 'swarm' }, { type: 'compose', orchestrator: 'docker' }, { type: 'pm2', orchestrator: 'docker' }] as const)(
    'changes only metadata for $type/$orchestrator, never placement or runtime state', async placement => {
      await c.db.update(services).set(placement).where(eq(services.id, 1));
      const before = await service();
      const reserved = await reserveServiceRuntimeOwner(c.db, 1, 'deploy', null, nonce(1));
      expect(reserved.kind).toBe('deploy'); expect(await service()).toEqual(before);
    });
});
