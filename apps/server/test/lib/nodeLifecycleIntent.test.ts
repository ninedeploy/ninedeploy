import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, services, servers, users, deployments, nodeLifecycleIntents, eq } from '@ninedeploy/db';
import { acceptNodeLifecycleIntent, advanceNodeLifecycleIntent, checkpointNodeLifecycleIntent, claimNodeLifecycleIntent, holdNodeLifecycleIntent, nodeLifecycleRevision, pruneNodeLifecycleHistory, retryNodeLifecycleIntent, NODE_LIFECYCLE_LEASE_MS } from '../../src/lib/nodeLifecycleIntent.js';

let c: ReturnType<typeof createDb>;
beforeEach(async () => {
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(users).values({ id: 1, email: 'operator@example.test', passwordHash: 'fixture', isInstanceOperator: true });
  await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', ownerUserId: 1, serverId: 4, runtimeId: 'web-9', status: 'running', port: 3000, healthCheck: 'http-strict', runtimeReplicas: 3 });
});
afterEach(() => c.client?.close());
const row = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;

describe('durable panel node lifecycle intent', () => {
  it('reserves restart Start below the next command fence', async () => {
    const first = await acceptNodeLifecycleIntent(c.db, await row(), 'restart');
    const next = await acceptNodeLifecycleIntent(c.db, await row(), 'stop');
    expect(nodeLifecycleRevision(first.id, 'restart-start')).toBeGreaterThan(nodeLifecycleRevision(first.id, 'effect'));
    expect(nodeLifecycleRevision(first.id, 'restart-start')).toBeLessThan(nodeLifecycleRevision(next.id, 'fence'));
  });

  it('rejects Start checkpoints when a deployment takes ownership after acceptance', async () => {
    const accepted = await acceptNodeLifecycleIntent(c.db, await row(), 'start');
    const intent = (await claimNodeLifecycleIntent(c.db, accepted.id))!;
    await c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'queued' });
    await expect(checkpointNodeLifecycleIntent(c.db, intent)).rejects.toThrow(/changed/);
    expect((await row()).runtimeId).toBe('web-9');
    expect((await c.db.query.deployments.findFirst())!.status).toBe('queued');
  });

  it('clears an expired owner during manual retry so its late callback cannot delay recovery', async () => {
    const accepted = await acceptNodeLifecycleIntent(c.db, await row(), 'stop');
    const owner = (await claimNodeLifecycleIntent(c.db, accepted.id))!;
    await c.db.update(nodeLifecycleIntents).set({ leaseUntil: new Date(0) }).where(eq(nodeLifecycleIntents.id, accepted.id));
    const retried = await retryNodeLifecycleIntent(c.db, await row());
    expect(retried).toMatchObject({ id: accepted.id, requestId: accepted.requestId, phase: accepted.phase, ownerToken: null, leaseUntil: null });
    await holdNodeLifecycleIntent(c.db, owner, Error('Late abandoned callback'));
    expect((await c.db.query.nodeLifecycleIntents.findFirst())!.reason).toBeNull();
    const next = await claimNodeLifecycleIntent(c.db, accepted.id);
    expect(next?.ownerToken).toBeTruthy(); expect(next?.ownerToken).not.toBe(owner.ownerToken);
  });

  it('persists Stop before effects, cancels older deployment work and records the serving snapshot', async () => {
    await c.db.insert(deployments).values([{ id: 9, serviceId: 1, status: 'running' }, { id: 10, serviceId: 1, status: 'queued' }, { id: 11, serviceId: 1, status: 'deploying' }]);
    const intent = await acceptNodeLifecycleIntent(c.db, await row(), 'stop');
    expect(intent).toMatchObject({ serviceId: 1, serverId: 4, runtimeId: 'web-9', deploymentId: 9, action: 'stop', phase: 'fencing', snapshot: { serving: 3, port: 3000 } });
    expect(await row()).toMatchObject({ status: 'stopped', runtimeReplicas: 3 });
    expect((await c.db.select().from(nodeLifecycleIntents))).toHaveLength(1);
    expect((await c.db.query.deployments.findFirst({ where: eq(deployments.id, 10) }))!.status).toBe('cancelled');
    expect((await c.db.query.deployments.findFirst({ where: eq(deployments.id, 11) }))!.status).toBe('cancelled');
  });
  it('does not publish running while Start is still preparing', async () => {
    await c.db.update(services).set({ status: 'stopped' }).where(eq(services.id, 1));
    expect(await acceptNodeLifecycleIntent(c.db, await row(), 'start')).toMatchObject({ action: 'start', phase: 'preparing' });
    expect((await row()).status).toBe('stopped');
  });
  it('supersedes an older Start when a newer Stop is accepted', async () => {
    const first = await acceptNodeLifecycleIntent(c.db, await row(), 'start');
    const second = await acceptNodeLifecycleIntent(c.db, await row(), 'stop');
    expect(first).toHaveProperty('id', expect.any(Number)); expect(second).toHaveProperty('id', expect.any(Number));
    expect(Number((second as { id: number }).id)).toBeGreaterThan(Number((first as { id: number }).id));
    expect((await c.db.select().from(nodeLifecycleIntents))[0]).toMatchObject({ phase: 'superseded', ownerToken: null, leaseUntil: null });
    expect(await claimNodeLifecycleIntent(c.db, (first as { id: number }).id)).toBeNull();
  });
  it('refuses a stale runtime snapshot before changing the service or creating a command', async () => {
    const old = await row();
    await c.db.update(services).set({ runtimeId: 'web-12' }).where(eq(services.id, 1));
    await expect(acceptNodeLifecycleIntent(c.db, old, 'stop')).rejects.toThrow(/changed|superseded/i);
    expect((await row()).status).toBe('running');
    expect(await c.db.select().from(nodeLifecycleIntents)).toHaveLength(0);
  });
  it('claims a persistent command once and refuses a competing live lease', async () => {
    const intent = await acceptNodeLifecycleIntent(c.db, await row(), 'stop') as { id: number };
    expect(intent).toHaveProperty('id', expect.any(Number));
    const first = await claimNodeLifecycleIntent(c.db, intent.id);
    expect(first).toMatchObject({ id: intent.id, attempts: 1, ownerToken: expect.any(String), leaseUntil: expect.any(Date) });
    expect(await claimNodeLifecycleIntent(c.db, intent.id)).toBeNull();
  });
  it('keeps fence/effect revisions distinct and never reuses them after deleted history', async () => {
    const first = await acceptNodeLifecycleIntent(c.db, await row(), 'stop');
    expect(nodeLifecycleRevision(first.id, 'effect')).toBeGreaterThan(nodeLifecycleRevision(first.id, 'fence'));
    await c.db.delete(nodeLifecycleIntents);
    const next = await acceptNodeLifecycleIntent(c.db, await row(), 'start');
    expect(nodeLifecycleRevision(next.id, 'fence')).toBeGreaterThan(nodeLifecycleRevision(first.id, 'effect'));
  });
  it('recovers an expired lease while refusing callbacks from the old owner', async () => {
    const intent = await acceptNodeLifecycleIntent(c.db, await row(), 'stop');
    const first = (await claimNodeLifecycleIntent(c.db, intent.id))!;
    const next = (await claimNodeLifecycleIntent(c.db, intent.id, Date.now() + NODE_LIFECYCLE_LEASE_MS + 1000))!;
    expect(next.ownerToken).not.toBe(first.ownerToken); expect(next.attempts).toBe(2);
    await expect(checkpointNodeLifecycleIntent(c.db, first)).rejects.toThrow(/owner changed/);
  });
  it('does not let a late Start publication overwrite a newer Stop', async () => {
    await c.db.update(services).set({ status: 'stopped' }).where(eq(services.id, 1));
    const accepted = await acceptNodeLifecycleIntent(c.db, await row(), 'start');
    let started = (await claimNodeLifecycleIntent(c.db, accepted.id))!;
    started = await advanceNodeLifecycleIntent(c.db, started, 'applying', { targets: [{ id: 'a'.repeat(64), name: 'web-9' }] });
    started = await advanceNodeLifecycleIntent(c.db, started, 'readiness');
    expect((await row()).status).toBe('stopped');
    started = await advanceNodeLifecycleIntent(c.db, started, 'routing', { serviceStatus: 'deploying' });
    expect((await row()).status).toBe('deploying');
    await acceptNodeLifecycleIntent(c.db, await row(), 'stop');
    await expect(advanceNodeLifecycleIntent(c.db, started, 'completed', { serviceStatus: 'running' })).rejects.toThrow(/changed/);
    expect((await row()).status).toBe('stopped');
  });
  it('publishes running only through the completed routing phase', async () => {
    const accepted = await acceptNodeLifecycleIntent(c.db, await row(), 'start');
    let intent = (await claimNodeLifecycleIntent(c.db, accepted.id))!;
    await expect(advanceNodeLifecycleIntent(c.db, intent, 'completed', { serviceStatus: 'running' })).rejects.toThrow(/phase transition/);
    intent = await advanceNodeLifecycleIntent(c.db, intent, 'applying', { targets: [{ id: 'a'.repeat(64), name: 'web-9' }] });
    intent = await advanceNodeLifecycleIntent(c.db, intent, 'readiness');
    intent = await advanceNodeLifecycleIntent(c.db, intent, 'routing', { serviceStatus: 'deploying' });
    intent = await advanceNodeLifecycleIntent(c.db, intent, 'completed', { serviceStatus: 'running' });
    expect(intent).toMatchObject({ phase: 'completed', ownerToken: null, leaseUntil: null, completedAt: expect.any(Date) });
    expect((await row()).status).toBe('running');
    expect(await claimNodeLifecycleIntent(c.db, intent.id)).toBeNull();
  });
  it('retains targets and phase on a held command and does not steal another lease during retry', async () => {
    const accepted = await acceptNodeLifecycleIntent(c.db, await row(), 'stop');
    let intent = (await claimNodeLifecycleIntent(c.db, accepted.id))!;
    intent = await advanceNodeLifecycleIntent(c.db, intent, 'preparing');
    intent = await advanceNodeLifecycleIntent(c.db, intent, 'routing', { targets: [{ id: 'a'.repeat(64), name: 'web-9' }] });
    await holdNodeLifecycleIntent(c.db, intent, new Error('Node offline'));
    const held = (await c.db.query.nodeLifecycleIntents.findFirst())!;
    expect(held).toMatchObject({ phase: 'routing', targets: intent.targets, ownerToken: null, leaseUntil: null, reason: 'Node offline' });
    expect(await claimNodeLifecycleIntent(c.db, intent.id)).toBeNull();
    const next = (await claimNodeLifecycleIntent(c.db, intent.id, held.nextAttemptAt.getTime() + 1000))!;
    await holdNodeLifecycleIntent(c.db, intent, new Error('Old callback'));
    expect((await c.db.query.nodeLifecycleIntents.findFirst())!.ownerToken).toBe(next.ownerToken);
  });
  it('does not turn a foreign runtime into the recorded intent during retry', async () => {
    const accepted = await acceptNodeLifecycleIntent(c.db, await row(), 'start');
    const intent = (await claimNodeLifecycleIntent(c.db, accepted.id))!;
    await c.db.update(services).set({ runtimeId: 'web-10' }).where(eq(services.id, 1));
    await expect(checkpointNodeLifecycleIntent(c.db, intent)).rejects.toThrow(/changed/);
    await expect(advanceNodeLifecycleIntent(c.db, intent, 'applying')).rejects.toThrow(/changed/);
  });
  it('holds Start while a deployment owns the service', async () => {
    await c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'deploying' });
    await expect(acceptNodeLifecycleIntent(c.db, await row(), 'start')).rejects.toThrow(/deployment/);
    expect(await c.db.select().from(nodeLifecycleIntents)).toHaveLength(0);
  });
  it('does not allow a running-to-stopped change outside the actor to publish stale Start work', async () => {
    const accepted = await acceptNodeLifecycleIntent(c.db, await row(), 'start');
    const intent = (await claimNodeLifecycleIntent(c.db, accepted.id))!;
    await c.db.update(services).set({ status: 'stopped' }).where(eq(services.id, 1));
    await expect(checkpointNodeLifecycleIntent(c.db, intent)).rejects.toThrow(/changed/);
  });

  it('refuses Stop acceptance if the runtime changes orchestrator after the initial read', async () => {
    const before = await row();
    await c.db.update(services).set({ orchestrator: 'swarm' }).where(eq(services.id, 1));
    await expect(acceptNodeLifecycleIntent(c.db, before, 'stop')).rejects.toThrow(/changed/);
    expect((await row()).status).toBe('running');
    expect(await c.db.select().from(nodeLifecycleIntents)).toHaveLength(0);
  });

  it.each([{ orchestrator: 'swarm' as const }, { type: 'compose' as const }])('does not execute a captured Stop after placement type changes to %j', async patch => {
    const accepted = await acceptNodeLifecycleIntent(c.db, await row(), 'stop');
    const intent = (await claimNodeLifecycleIntent(c.db, accepted.id))!;
    await c.db.update(services).set(patch).where(eq(services.id, 1));
    await expect(checkpointNodeLifecycleIntent(c.db, intent)).rejects.toThrow(/changed/);
  });

  it('prunes only expired terminal history while preserving recent receipts, owners, leases and the last revision', async () => {
    const now = Date.now(), daysAgo = (n: number) => new Date(now - n * 86_400_000);
    const first = await acceptNodeLifecycleIntent(c.db, await row(), 'stop');
    await c.db.update(nodeLifecycleIntents).set({ phase: 'completed', completedAt: daysAgo(31) }).where(eq(nodeLifecycleIntents.id, first.id));
    let request = 0;
    const insert = async (phase: 'completed' | 'superseded', days: number, ownerToken: string | null = null, leaseUntil: Date | null = null) => {
      const [intent] = await c.db.insert(nodeLifecycleIntents).values({ ...first, id: undefined, phase, requestId: `fixture-${request++}`,
        completedAt: daysAgo(days), ownerToken, leaseUntil }).returning();
      return intent!;
    };
    const superseded = await insert('superseded', 40);
    const recent = await insert('completed', 3);
    const owned = await insert('completed', 100, 'owner');
    const leased = await insert('completed', 100, null, new Date(now + 100_000));
    const last = await insert('completed', 100);
    expect((await pruneNodeLifecycleHistory(c.db, now)).map(r => r.id).sort()).toEqual([first.id, superseded.id].sort());
    expect((await c.db.select().from(nodeLifecycleIntents)).map(r => r.id)).toEqual([recent.id, owned.id, leased.id, last.id]);
    const next = await acceptNodeLifecycleIntent(c.db, await row(), 'start');
    expect(nodeLifecycleRevision(next.id, 'fence')).toBeGreaterThan(nodeLifecycleRevision(last.id, 'effect'));
  });

  it('never age-evicts an unfinished or held command', async () => {
    const first = await acceptNodeLifecycleIntent(c.db, await row(), 'stop');
    await c.db.update(nodeLifecycleIntents).set({ createdAt: new Date(0), updatedAt: new Date(0), reason: 'Node offline' }).where(eq(nodeLifecycleIntents.id, first.id));
    expect(await pruneNodeLifecycleHistory(c.db)).toEqual([]);
    expect((await c.db.query.nodeLifecycleIntents.findFirst())!.id).toBe(first.id);
  });
  it('coalesces automatic recovery without superseding an existing command', async () => {
    const first = await acceptNodeLifecycleIntent(c.db, await row(), 'start', { automatic: true });
    const owner = await claimNodeLifecycleIntent(c.db, first.id);
    const second = await acceptNodeLifecycleIntent(c.db, await row(), 'start', { automatic: true });
    expect(second.id).toBe(first.id); expect(second.ownerToken).toBe(owner!.ownerToken);
    expect(await c.db.select().from(nodeLifecycleIntents)).toHaveLength(1);
  });
});
