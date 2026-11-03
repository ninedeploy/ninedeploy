import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { databaseAttachments, databases, deployments, domains, eq, nodeAutoscaleCapacity, nodeSleepTransitions, serviceTargets, services } from '@ninedeploy/db';
import { nodeSleepEvidence } from '../fixtures/nodeSleepEvidence.js';
import { servingReceiptFixture } from '../fixtures/servingTrafficReceipt.js';
import { admitNodeSleep, admitNodeWake, advanceNodeSleep, bindNodeSleepCatcher, checkpointNodeSleep, completeNodeSleep, completeNodeWake, nodeSleepCommand, recordNodeWakeStarted, recoverNodeSleep, refreshNodeSleepCatcher, type NodeSleepAdmission } from '../../src/lib/nodeSleepAuthority.js';
import { admitNodeAutoscale } from '../../src/lib/nodeAutoscaleAuthority.js';
import { admitNodeLimits } from '../../src/lib/nodeLimitsAuthority.js';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';
import { readServiceRuntimeOwner, reserveServiceRuntimeOwner } from '../../src/lib/serviceRuntimeOwner.js';
import type { NodeIdleEvidence } from '../../src/lib/nodeIdleCoverage.js';
import { beginCanary, endCanary } from '../../src/engine/canaryState.js';
import { reserveNodeProxyWrite, bindNodeProxyWrite } from '../../src/lib/nodeProxyAuthority.js';

let f: Awaited<ReturnType<typeof servingReceiptFixture>>;
const selected = async () => (await f.c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
const journal = async () => (await f.c.db.query.nodeSleepTransitions.findFirst())!;
beforeEach(async () => {
  f = await servingReceiptFixture('file::memory:');
  await f.c.db.update(services).set({ sleepAfterMinutes: 5, autoscale: { minReplicas: 1, maxReplicas: 2, metric: 'cpu', target: 70, scaleUpSeconds: 60, scaleDownSeconds: 120 } });
});
afterEach(() => { endCanary(1); vi.restoreAllMocks(); f.c.client?.close(); });
const accept = async () => {
  const proof = await nodeSleepEvidence(f.c.db), admission = await admitNodeSleep(f.c.db, await selected(), proof.token);
  expect(admission).not.toBeNull(); return admission!;
};
async function stopping(admission: NodeSleepAdmission) {
  await advanceNodeSleep(f.c.db, admission, 'accepted', 'fencing');
  await bindNodeSleepCatcher(f.c.db, admission, { id: 'c'.repeat(64), image: `sha256:${'b'.repeat(64)}` });
  await advanceNodeSleep(f.c.db, admission, 'fencing', 'prepared');
  await advanceNodeSleep(f.c.db, admission, 'prepared', 'routing');
  await advanceNodeSleep(f.c.db, admission, 'routing', 'routed');
  await advanceNodeSleep(f.c.db, admission, 'routed', 'stopping');
}
async function receipt(admission: NodeSleepAdmission, action: 'stop' | 'start') {
  return { ...nodeSleepCommand(admission, action), complete: true, items: (await journal()).targets.map(({ id, name, deploymentId }) => ({ id, name, deploymentId, running: action === 'start' })) };
}
async function asleep() {
  const admission = await accept(); await stopping(admission); await completeNodeSleep(f.c.db, admission, await receipt(admission, 'stop')); return admission;
}
async function demand() {
  const row = await journal(); return { nodeId: row.serverId, token: row.wakeToken, catcherId: row.catcherId!, demandAt: Date.now(), receivedAt: Date.now() };
}

it('persists an exact sleep admission without stopping or marking the service asleep', async () => {
  const admission = await accept(), row = await journal();
  expect(row).toMatchObject({ serviceId: 1, serverId: 4, deploymentId: 9, runtimeId: 'web-9', action: 'sleep', phase: 'accepted', ownerEpoch: admission.owner.epoch,
    targets: [{ name: 'web-9', id: 'a'.repeat(64), port: 3000, deploymentId: 9 }], idleEvidence: { idleMs: 300_000 } });
  expect((await selected()).asleepAt).toBeNull(); expect((await selected()).status).toBe('running');
  expect(row.binding).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(row)).not.toContain('web.test');
  expect(JSON.stringify(row)).not.toContain('http:');
});
it('refuses manufactured, reused, revoked and insufficient idle evidence', async () => {
  expect(await admitNodeSleep(f.c.db, await selected(), {} as NodeIdleEvidence)).toBeNull();
  const short = await nodeSleepEvidence(f.c.db, 60_000); expect(await admitNodeSleep(f.c.db, await selected(), short.token)).toBeNull();
  const revoked = await nodeSleepEvidence(f.c.db); revoked.clock.reset(); expect(await admitNodeSleep(f.c.db, await selected(), revoked.token)).toBeNull();
  const proof = await nodeSleepEvidence(f.c.db); expect(await admitNodeSleep(f.c.db, await selected(), proof.token)).not.toBeNull();
  expect(await admitNodeSleep(f.c.db, await selected(), proof.token)).toBeNull();
});
it.each(['queued', 'owner', 'route', 'configuration'] as const)('cannot reserve sleep after %s changes', async change => {
  const proof = await nodeSleepEvidence(f.c.db), before = await selected();
  if (change === 'queued') await f.c.db.insert(deployments).values({ serviceId: 1, status: 'queued' });
  if (change === 'owner') await reserveServiceRuntimeOwner(f.c.db, 1, 'deploy', null, '2'.repeat(32));
  if (change === 'route') await f.c.db.update(domains).set({ hostname: 'changed.test' });
  if (change === 'configuration') await f.c.db.update(services).set({ port: 4000 });
  const owner = await readServiceRuntimeOwner(f.c.db, 1);
  expect(await admitNodeSleep(f.c.db, before, proof.token)).toBeNull();
  expect(await readServiceRuntimeOwner(f.c.db, 1)).toEqual(owner); expect(await f.c.db.select().from(nodeSleepTransitions)).toEqual([]);
});
it('requires catcher binding and every route phase before confirming a Stop', async () => {
  const admission = await accept();
  await expect(advanceNodeSleep(f.c.db, admission, 'accepted', 'stopping')).rejects.toThrow();
  await expect(completeNodeSleep(f.c.db, admission, await receipt(admission, 'stop'))).rejects.toThrow();
  await advanceNodeSleep(f.c.db, admission, 'accepted', 'fencing');
  await expect(advanceNodeSleep(f.c.db, admission, 'fencing', 'prepared')).rejects.toThrow();
  expect((await selected()).asleepAt).toBeNull(); expect((await journal()).phase).toBe('fencing');
});
it('marks asleep only after an exact complete Stop receipt and retains running service status', async () => {
  const admission = await accept(); await stopping(admission);
  const wrong = await receipt(admission, 'stop'); wrong.items[0]!.id = 'b'.repeat(64);
  await expect(completeNodeSleep(f.c.db, admission, wrong)).rejects.toThrow(); expect((await selected()).asleepAt).toBeNull();
  await completeNodeSleep(f.c.db, admission, await receipt(admission, 'stop'));
  expect((await selected()).asleepAt).toBeInstanceOf(Date); expect((await selected()).status).toBe('running');
  expect(await journal()).toMatchObject({ phase: 'asleep', workerToken: null, leaseUntil: null });
});
it.each(['stop', 'restart', 'deploy', 'limits'] as const)('explicit %s supersedes sleep and rejects its delayed continuation', async kind => {
  const admission = await accept();
  const newer = await reserveServiceRuntimeOwner(f.c.db, 1, kind, admission.owner);
  expect(newer.epoch).toBeGreaterThan(admission.owner.epoch);
  expect(await journal()).toMatchObject({ phase: 'superseded', workerToken: null });
  await expect(checkpointNodeSleep(f.c.db, admission)).rejects.toThrow();
  expect(await recoverNodeSleep(f.c.db, 1)).toBeNull();
});
it('automatic scaling and automatic Start cannot take a pending sleep owner', async () => {
  const admission = await accept();
  expect(await admitNodeAutoscale(f.c.db, await selected(), 2)).toBeNull();
  await expect(reserveServiceRuntimeOwner(f.c.db, 1, 'scale', admission.owner)).rejects.toThrow(/sleep or wake/);
  await expect(acceptNodeLifecycleIntent(f.c.db, await selected(), 'start', { automatic: true })).rejects.toThrow(/Automatic Start/);
  expect(await readServiceRuntimeOwner(f.c.db, 1)).toEqual(admission.owner);
});
it('the actual explicit Stop admission supersedes an asleep row and makes its old wake demand unusable', async () => {
  await asleep(); const old = await demand();
  await acceptNodeLifecycleIntent(f.c.db, await selected(), 'stop');
  expect((await journal()).phase).toBe('superseded');
  expect(await admitNodeWake(f.c.db, await selected(), old)).toBeNull();
  expect((await readServiceRuntimeOwner(f.c.db, 1))?.kind).toBe('stop');
});
it('recovers one expired worker lease with the same command identity and fences the old worker', async () => {
  const admission = await accept(), command = nodeSleepCommand(admission, 'fence');
  expect(await recoverNodeSleep(f.c.db, 1)).toBeNull();
  await f.c.db.update(nodeSleepTransitions).set({ leaseUntil: new Date(Date.now() - 1) });
  const recovered = (await recoverNodeSleep(f.c.db, 1))!; expect(recovered.workerToken).not.toBe(admission.workerToken);
  expect(nodeSleepCommand(recovered, 'fence')).toEqual(command);
  await expect(checkpointNodeSleep(f.c.db, admission)).rejects.toThrow();
  expect((await checkpointNodeSleep(f.c.db, recovered)).phase).toBe('accepted');
  expect(await recoverNodeSleep(f.c.db, 1)).toBeNull();
});
it('abandons stale unpublished sleep on recovery instead of applying an old idle decision', async () => {
  await accept(); const row = await journal();
  await f.c.db.update(nodeSleepTransitions).set({ leaseUntil: new Date(0) });
  vi.spyOn(Date, 'now').mockReturnValue(row.idleEvidence.sampledAt + 30_001);
  expect(await recoverNodeSleep(f.c.db, 1)).toBeNull();
  expect(await journal()).toMatchObject({ phase: 'superseded', reason: expect.stringMatching(/expired/) });
  expect((await selected()).asleepAt).toBeNull();
});
it('refuses retargeted or corrupted immutable journal fields', async () => {
  const admission = await accept(), row = await journal();
  await f.c.db.update(nodeSleepTransitions).set({ targets: row.targets.map(target => ({ ...target, id: 'b'.repeat(64) })) });
  await expect(checkpointNodeSleep(f.c.db, admission)).rejects.toThrow();
});
it('admits one fresh pinned-catcher demand and completes wake only after ordered phases plus exact Start receipt', async () => {
  const sleeping = await asleep(), incoming = await demand(), wake = (await admitNodeWake(f.c.db, await selected(), incoming))!;
  expect(wake).not.toBeNull(); expect(wake.owner.epoch).toBeGreaterThan(sleeping.owner.epoch);
  expect(await admitNodeWake(f.c.db, await selected(), incoming)).toBeNull();
  const head = await bindNodeProxyWrite(f.c.db, (await reserveNodeProxyWrite(f.c.db, 4, { adopt: true }))!, 'acknowledged fixture');
  await expect(completeNodeWake(f.c.db, wake, head)).rejects.toThrow();
  await advanceNodeSleep(f.c.db, wake, 'accepted', 'fencing');
  await advanceNodeSleep(f.c.db, wake, 'fencing', 'starting');
  await expect(advanceNodeSleep(f.c.db, wake, 'starting', 'readiness')).rejects.toThrow();
  const wrong = await receipt(wake, 'start'); wrong.items[0]!.id = 'e'.repeat(64);
  await expect(recordNodeWakeStarted(f.c.db, wake, wrong)).rejects.toThrow();
  await recordNodeWakeStarted(f.c.db, wake, await receipt(wake, 'start'));
  await advanceNodeSleep(f.c.db, wake, 'readiness', 'publishing');
  expect((await selected()).asleepAt).not.toBeNull();
  await completeNodeWake(f.c.db, wake, head);
  expect((await selected()).asleepAt).toBeNull(); expect((await journal()).phase).toBe('completed');
  expect((await journal()).fallbackRouting).toBe(false);
});
it.each(['token', 'node', 'catcher', 'old', 'future'] as const)('refuses %s wake demand without changing ownership', async kind => {
  const admission = await asleep(), incoming = await demand();
  if (kind === 'token') incoming.token = '0'.repeat(32);
  if (kind === 'node') incoming.nodeId = 5;
  if (kind === 'catcher') incoming.catcherId = '0'.repeat(64);
  if (kind === 'old') incoming.demandAt -= 60_001;
  if (kind === 'future') incoming.receivedAt += 60_000;
  expect(await admitNodeWake(f.c.db, await selected(), incoming)).toBeNull();
  expect(await readServiceRuntimeOwner(f.c.db, 1)).toEqual(admission.owner);
});
it('a new conflicting placement cannot wake a sleeping generation', async () => {
  await asleep(); const incoming = await demand();
  await f.c.db.insert(serviceTargets).values({ serviceId: 1, serverId: 4, runtimeId: 'web-t4-9' });
  await expect(admitNodeWake(f.c.db, await selected(), incoming)).rejects.toThrow();
  expect((await readServiceRuntimeOwner(f.c.db, 1))?.kind).toBe('sleep');
});
it('renews a recreated catcher under the same sleeping owner and refuses stale renewal after Stop', async () => {
  const admission = await asleep(), old = await demand();
  const replacement = { id: 'd'.repeat(64), image: `sha256:${'e'.repeat(64)}` };
  await refreshNodeSleepCatcher(f.c.db, admission.owner, old.catcherId, replacement);
  expect(await admitNodeWake(f.c.db, await selected(), old)).toBeNull();
  expect((await demand()).catcherId).toBe(replacement.id);
  await expect(refreshNodeSleepCatcher(f.c.db, admission.owner, old.catcherId, replacement)).rejects.toThrow();
  await acceptNodeLifecycleIntent(f.c.db, await selected(), 'stop');
  await expect(refreshNodeSleepCatcher(f.c.db, admission.owner, replacement.id, replacement)).rejects.toThrow();
});
it('retains fallback routing intent when an explicit deploy supersedes a sleep already publishing routes', async () => {
  const admission = await accept(); await stopping(admission);
  expect((await journal()).fallbackRouting).toBe(true);
  await reserveServiceRuntimeOwner(f.c.db, 1, 'deploy', admission.owner);
  expect(await journal()).toMatchObject({ phase: 'superseded', fallbackRouting: true });
  await expect(completeNodeSleep(f.c.db, admission, await receipt(admission, 'stop'))).rejects.toThrow();
});
it('holds automation while a superseded same-generation fallback remains, without blocking a new selected generation', async () => {
  const admission = await accept(); await stopping(admission);
  const owner = await reserveServiceRuntimeOwner(f.c.db, 1, 'limits', admission.owner);
  expect(await admitNodeAutoscale(f.c.db, await selected(), 2)).toBeNull();
  await expect(reserveServiceRuntimeOwner(f.c.db, 1, 'scale', owner)).rejects.toThrow(/sleep or wake/);
  await expect(acceptNodeLifecycleIntent(f.c.db, await selected(), 'start', { automatic: true })).rejects.toThrow(/Automatic Start/);
  await f.c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'running' });
  await f.c.db.update(services).set({ runtimeId: 'web-10' });
  await f.c.db.insert(nodeAutoscaleCapacity).values({ deploymentId: 10, serviceId: 1, serverId: 4, runtimeId: 'web-10', imageId: `sha256:${'b'.repeat(64)}`,
    targets: [{ name: 'web-10', id: 'c'.repeat(64) }, { name: 'web-10-r2', id: 'd'.repeat(64) }] });
  expect(await admitNodeAutoscale(f.c.db, await selected(), 2)).not.toBeNull();
});
it('does not strand an asleep generation when cosmetic or next-deploy preferences change', async () => {
  await asleep(); const incoming = await demand();
  await f.c.db.update(services).set({ name: 'Renamed web', replicas: 2, autoscale: null, sleepAfterMinutes: null });
  expect(await admitNodeWake(f.c.db, await selected(), incoming)).not.toBeNull();
});
it('does not continue an unpublished sleep after its idle policy is disabled or increased beyond the proof', async () => {
  const admission = await accept();
  await f.c.db.update(services).set({ sleepAfterMinutes: 10 });
  await expect(checkpointNodeSleep(f.c.db, admission)).rejects.toThrow();
  await f.c.db.update(services).set({ sleepAfterMinutes: null });
  await expect(checkpointNodeSleep(f.c.db, admission)).rejects.toThrow();
  expect((await selected()).asleepAt).toBeNull();
});
it('rolls back both runtime ownership and journal creation if a canary starts before admission commits', async () => {
  const proof = await nodeSleepEvidence(f.c.db), service = await selected(); let triggered = false;
  const client = f.c.client!, transaction = client.transaction.bind(client);
  vi.spyOn(client, 'transaction').mockImplementation(async (...args) => {
    const tx = await transaction(...args), execute = tx.execute.bind(tx);
    tx.execute = async (...params) => {
      const result = await execute(...params), statement = typeof params[0] === 'string' ? params[0] : params[0].sql;
      if (statement.toLowerCase().includes('insert into "node_sleep_transitions"')) {
        triggered = true; beginCanary(1, 'web', 10, 2, false, false, { serverId: 4, stableRuntimeId: 'web-9' });
      }
      return result;
    };
    return tx;
  });
  await expect(admitNodeSleep(f.c.db, service, proof.token)).rejects.toThrow(/authority/);
  expect(triggered).toBe(true); expect(await readServiceRuntimeOwner(f.c.db, 1)).toBeNull();
  expect(await f.c.db.select().from(nodeSleepTransitions)).toEqual([]);
});
it.each([
  ['a response header', { headers: JSON.stringify([{ name: 'X-Test', value: '1' }]) }],
  ['the SSL toggle', { ssl: false }],
  ['only updatedAt', { updatedAt: new Date(Date.now() + 60_000) }],
] as const)('an edit to %s on a sleeping service still lets a fresh demand wake it', async (_edit, change) => {
  await asleep();
  // PATCH /domains/:id and POST /domains/:id/ssl do not stop at a sleeping service; the renderer keeps the catcher route.
  await f.c.db.update(domains).set(change as Partial<typeof domains.$inferInsert>);
  expect(await admitNodeWake(f.c.db, await selected(), await demand())).not.toBeNull();
});
it('a health-setting edit on a sleeping service still lets a fresh demand wake it (readiness reads them live)', async () => {
  await asleep();
  await f.c.db.update(services).set({ healthPath: '/ready', healthTimeoutSeconds: 120 });
  expect(await admitNodeWake(f.c.db, await selected(), await demand())).not.toBeNull();
});
it('a journal written by 0.18.17 (whole domain rows in the configuration) still wakes after the upgrade', async () => {
  await asleep();
  const sha = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  const svc = await selected(), row = await journal();
  const config = [svc.type, svc.orchestrator, svc.slug, svc.serverId, svc.runtimeId, svc.runtimeReplicas, svc.port,
    svc.healthCheck, svc.healthPath, svc.healthCommand, svc.healthTimeoutSeconds, svc.cpuShares, svc.cpuLimitMilli, svc.memLimitMb];
  const attached = await f.c.db.select({ attachmentId: databaseAttachments.id, id: databases.id, slug: databases.slug, serverId: databases.serverId, status: databases.status })
    .from(databaseAttachments).innerJoin(databases, eq(databases.id, databaseAttachments.databaseId)).where(eq(databaseAttachments.serviceId, 1)).orderBy(databaseAttachments.id);
  const routes = await f.c.db.select().from(domains).where(eq(domains.serviceId, 1)).orderBy(domains.id);
  const capacity = await f.c.db.query.nodeAutoscaleCapacity.findFirst({ where: eq(nodeAutoscaleCapacity.deploymentId, row.deploymentId) });
  const legacy = sha([config, attached, routes, capacity]);
  expect(legacy).not.toBe(row.configuration);
  const binding = sha([row.serviceId, row.serverId, row.deploymentId, row.runtimeId, row.ownerEpoch, row.requestId, row.action, legacy, row.watermark, row.wakeToken, row.targets, row.idleEvidence]);
  await f.c.db.update(nodeSleepTransitions).set({ configuration: legacy, binding });
  expect(await admitNodeWake(f.c.db, await selected(), await demand())).not.toBeNull();
});
it('a serving-generation change on a sleeping service still refuses its wake', async () => {
  await asleep();
  await f.c.db.update(services).set({ port: 4000 });
  await expect(admitNodeWake(f.c.db, await selected(), await demand())).rejects.toThrow(/configuration/);
});
it('a limits edit on a sleeping service is saved for the next deploy: no live owner, and a demand still wakes it', async () => {
  await asleep();
  await f.c.db.update(services).set({ memLimitMb: 512 });
  // PATCH /:id/limits calls applyNodeLimits; superseding the asleep journal would leave the domains on the catcher with no wake.
  expect(await admitNodeLimits(f.c.db, await selected())).toBeNull();
  expect(await journal()).toMatchObject({ phase: 'asleep', fallbackRouting: true });
  expect(await admitNodeWake(f.c.db, await selected(), await demand())).not.toBeNull();
});
it('limits do not take the owner from an in-flight sleep either', async () => {
  const admission = await accept();
  expect(await admitNodeLimits(f.c.db, await selected())).toBeNull();
  expect(await readServiceRuntimeOwner(f.c.db, 1)).toEqual(admission.owner);
});
