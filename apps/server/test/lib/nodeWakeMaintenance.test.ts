import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deployments, domains, eq, nodeWakeMaintenance, servers, services } from '@ninedeploy/db';
import { servingReceiptFixture } from '../fixtures/servingTrafficReceipt.js';
import { nodeSleepEvidence } from '../fixtures/nodeSleepEvidence.js';
import { admitNodeSleep, admitNodeWake, advanceNodeSleep, bindNodeSleepCatcher, completeNodeSleep, nodeSleepCommand, type NodeSleepAdmission } from '../../src/lib/nodeSleepAuthority.js';
import { claimNodeWakeMaintenance, checkpointNodeWakeMaintenance, completeNodeWakeMaintenance, confirmNodeWakeMaintenanceRouting, holdNodeWakeMaintenance, recordNodeWakeMaintenanceCatcher,
  rebaseNodeWakeMaintenance, completeNodeWakeRetirement } from '../../src/lib/nodeWakeMaintenance.js';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';
import { nodeWakeKey } from '../../src/lib/nodeWakeKey.js';

let f: Awaited<ReturnType<typeof servingReceiptFixture>>;
const service = async (id = 1) => (await f.c.db.query.services.findFirst({ where: eq(services.id, id) }))!;
const journal = async (id = 1) => (await f.c.db.query.nodeSleepTransitions.findFirst({ where: (table, { eq }) => eq(table.serviceId, id) }))!;
beforeEach(async () => {
  f = await servingReceiptFixture('file::memory:'); await f.c.db.update(services).set({ sleepAfterMinutes: 5 });
  await nodeWakeKey(f.c.db, 4, true);
});
afterEach(() => { vi.restoreAllMocks(); f.c.client?.close(); });
async function admit(id = 1) {
  const current = await service(id), proof = await nodeSleepEvidence(f.c.db, 300_000, id === 1 ? {} : {
    nodeId: current.serverId!, serviceId: 2, deploymentId: 10, slug: 'api', serving: [{ name: 'api-10', id: 'b'.repeat(64), port: 3000 }],
  });
  return (await admitNodeSleep(f.c.db, current, proof.token))!;
}
async function asleep(id = 1) {
  const admission: NodeSleepAdmission = await admit(id); expect(admission).not.toBeNull();
  await advanceNodeSleep(f.c.db, admission, 'accepted', 'fencing');
  await bindNodeSleepCatcher(f.c.db, admission, { id: 'c'.repeat(64), image: `sha256:${'d'.repeat(64)}` });
  for (const [from, to] of [['fencing', 'prepared'], ['prepared', 'routing'], ['routing', 'routed'], ['routed', 'stopping']] as const) await advanceNodeSleep(f.c.db, admission, from, to);
  const row = await journal(id);
  await completeNodeSleep(f.c.db, admission, { ...nodeSleepCommand(admission, 'stop'), complete: true,
    items: row.targets.map(({ id, name, deploymentId }) => ({ id, name, deploymentId, running: false })) });
}
async function other(serverId = 4) {
  await f.c.db.insert(services).values({ id: 2, name: 'API', slug: 'api', type: 'docker', serverId, status: 'running', runtimeId: 'api-10', port: 3000, sleepAfterMinutes: 5 });
  await f.c.db.insert(deployments).values({ id: 10, serviceId: 2, status: 'running' });
  await f.c.db.insert(domains).values({ serviceId: 2, hostname: 'api.test', status: 'active' });
}
async function wake(id = 1) {
  const row = await journal(id); return admitNodeWake(f.c.db, await service(id), { nodeId: 4, token: row.wakeToken, catcherId: row.catcherId!, receivedAt: Date.now(), demandAt: Date.now() });
}
const replacement = { id: 'e'.repeat(64), image: `sha256:${'f'.repeat(64)}`, name: `ninedeploy-wake-g-${'f'.repeat(32)}` };
it('blocks new sleep and wake admission until maintenance reaches confirmed settlement', async () => {
  await asleep(); await other();
  const claim = (await claimNodeWakeMaintenance(f.c.db, 4))!; expect(claim).not.toBeNull();
  expect(await wake()).toBeNull(); expect(await admit(2)).toBeNull();
  await expect(completeNodeWakeMaintenance(f.c.db, claim)).rejects.toThrow();
  await recordNodeWakeMaintenanceCatcher(f.c.db, claim, replacement);
  await confirmNodeWakeMaintenanceRouting(f.c.db, claim);
  expect(await completeNodeWakeMaintenance(f.c.db, claim)).toBe(1);
  expect((await journal()).catcherId).toBe(replacement.id); expect((await service()).asleepAt).not.toBeNull();
  expect(await wake()).toBeNull();
  await completeNodeWakeRetirement(f.c.db, claim, [{ id: 'c'.repeat(64), name: 'ninedeploy-wake', removed: true, fenced: true }]);
  expect(await wake()).not.toBeNull();
});
it('retains the admission barrier after expiry and recovers the same intent under a different worker', async () => {
  await asleep(); const first = (await claimNodeWakeMaintenance(f.c.db, 4))!;
  expect(await claimNodeWakeMaintenance(f.c.db, 4)).toBeNull();
  await f.c.db.update(nodeWakeMaintenance).set({ leaseUntil: new Date(0) });
  expect(await wake()).toBeNull();
  const recovered = (await claimNodeWakeMaintenance(f.c.db, 4))!;
  expect(recovered.requestId).toBe(first.requestId); expect(recovered.generation).toBe(first.generation); expect(recovered.workerToken).not.toBe(first.workerToken);
  await expect(checkpointNodeWakeMaintenance(f.c.db, first)).rejects.toThrow();
  await holdNodeWakeMaintenance(f.c.db, first, 'late old failure');
  expect((await checkpointNodeWakeMaintenance(f.c.db, recovered)).workerToken).toBe(recovered.workerToken);
});
it('does not claim a node while another service has an active wake', async () => {
  await asleep(); await other(); await asleep(2); expect(await wake()).not.toBeNull();
  expect(await claimNodeWakeMaintenance(f.c.db, 4)).toBeNull();
});
it('does not claim a node while another service has an active sleep/Stop intent', async () => {
  await asleep(); await other(); expect(await admit(2)).not.toBeNull();
  expect(await claimNodeWakeMaintenance(f.c.db, 4)).toBeNull();
});
it('explicit Stop supersedes sleeping membership without being resurrected by maintenance completion', async () => {
  await asleep(); const claim = (await claimNodeWakeMaintenance(f.c.db, 4))!;
  await recordNodeWakeMaintenanceCatcher(f.c.db, claim, replacement); await confirmNodeWakeMaintenanceRouting(f.c.db, claim);
  await acceptNodeLifecycleIntent(f.c.db, await service(), 'stop');
  expect(await completeNodeWakeMaintenance(f.c.db, claim)).toBe(0);
  await completeNodeWakeRetirement(f.c.db, claim, [{ id: 'c'.repeat(64), name: 'ninedeploy-wake', removed: true, fenced: true }]);
  expect((await service()).status).toBe('stopped'); expect((await journal()).phase).toBe('superseded');
});
it('refuses retargeted maintenance snapshots and cannot settle without the routing phase', async () => {
  await asleep(); const claim = (await claimNodeWakeMaintenance(f.c.db, 4))!;
  await expect(confirmNodeWakeMaintenanceRouting(f.c.db, claim)).rejects.toThrow();
  await f.c.db.update(nodeWakeMaintenance).set({ snapshot: [] });
  await expect(checkpointNodeWakeMaintenance(f.c.db, claim)).rejects.toThrow(); expect(await wake()).toBeNull();
});
it('releases only the worker on hold and keeps the durable barrier for recovery', async () => {
  await asleep(); const first = (await claimNodeWakeMaintenance(f.c.db, 4))!;
  await holdNodeWakeMaintenance(f.c.db, first, 'offline node'); expect(await wake()).toBeNull();
  const recovered = (await claimNodeWakeMaintenance(f.c.db, 4))!;
  expect(recovered.requestId).toBe(first.requestId); expect((await checkpointNodeWakeMaintenance(f.c.db, recovered)).reason).toBe('offline node');
});
it('does not block sleep admission on a different node', async () => {
  await asleep(); await f.c.db.insert(servers).values({ id: 5, name: 'Other node', host: 'other.test', tokenEncrypted: 'fixture' }); await other(5);
  expect(await claimNodeWakeMaintenance(f.c.db, 4)).not.toBeNull(); expect(await admit(2)).not.toBeNull();
});
it('rolls back all catcher bindings when a later sleeping member changes during settlement', async () => {
  await asleep(); await other(); await asleep(2);
  const claim = (await claimNodeWakeMaintenance(f.c.db, 4))!;
  await recordNodeWakeMaintenanceCatcher(f.c.db, claim, replacement); await confirmNodeWakeMaintenanceRouting(f.c.db, claim);
  await f.c.db.update(services).set({ port: 4000 }).where(eq(services.id, 2));
  let wrote = false; const client = f.c.client!, transaction = client.transaction.bind(client);
  vi.spyOn(client, 'transaction').mockImplementation(async (...args) => {
    const tx = await transaction(...args), execute = tx.execute.bind(tx);
    tx.execute = async (...params) => {
      const result = await execute(...params), sql = typeof params[0] === 'string' ? params[0] : params[0].sql;
      if (sql.toLowerCase().includes('update "node_sleep_transitions"')) wrote = true;
      return result;
    };
    return tx;
  });
  await expect(completeNodeWakeMaintenance(f.c.db, claim)).rejects.toThrow();
  expect(wrote).toBe(true); expect((await journal()).catcherId).toBe('c'.repeat(64));
  expect((await journal(2)).catcherId).toBe('c'.repeat(64));
  expect((await f.c.db.query.nodeWakeMaintenance.findFirst())!.phase).toBe('rebinding');
});
it('requires a fresh routing confirmation when a recovered attempt records another catcher', async () => {
  await asleep(); const claim = (await claimNodeWakeMaintenance(f.c.db, 4))!;
  await recordNodeWakeMaintenanceCatcher(f.c.db, claim, replacement); await confirmNodeWakeMaintenanceRouting(f.c.db, claim);
  await recordNodeWakeMaintenanceCatcher(f.c.db, claim, { id: 'a'.repeat(64), image: `sha256:${'b'.repeat(64)}` });
  expect((await f.c.db.query.nodeWakeMaintenance.findFirst())!.phase).toBe('routing');
  await expect(completeNodeWakeMaintenance(f.c.db, claim)).rejects.toThrow();
});
it('rebases interrupted retirement to a new catcher without dropping older targets or reviving an old worker', async () => {
  await asleep(); const first = (await claimNodeWakeMaintenance(f.c.db, 4))!;
  const prior = { ...replacement, name: `ninedeploy-wake-g-${'f'.repeat(32)}` };
  await recordNodeWakeMaintenanceCatcher(f.c.db, first, prior); await confirmNodeWakeMaintenanceRouting(f.c.db, first);
  expect(await completeNodeWakeMaintenance(f.c.db, first)).toBe(1);
  expect(await wake()).toBeNull();
  await expect(completeNodeWakeRetirement(f.c.db, first, [])).rejects.toThrow();
  const next = { id: '9'.repeat(64), image: `sha256:${'9'.repeat(64)}`, name: `ninedeploy-wake-g-${'9'.repeat(32)}` };
  const recovered = await rebaseNodeWakeMaintenance(f.c.db, first, next);
  expect(recovered.requestId).toBe(first.requestId); expect(recovered.generation).toBe(first.generation);
  expect(recovered.workerToken).not.toBe(first.workerToken); expect(recovered.binding).not.toBe(first.binding);
  await holdNodeWakeMaintenance(f.c.db, first, 'late old worker');
  const row = await checkpointNodeWakeMaintenance(f.c.db, recovered);
  expect(row.phase).toBe('rerouting');
  expect(row.snapshot.filter(item => !item.retirementOnly).map(item => item.catcherId)).toEqual([prior.id]);
  expect(row.snapshot.filter(item => item.retirementOnly).map(item => item.catcherId)).toEqual(['c'.repeat(64)]);
  await confirmNodeWakeMaintenanceRouting(f.c.db, recovered);
  expect(await completeNodeWakeMaintenance(f.c.db, recovered)).toBe(1);
  await expect(completeNodeWakeRetirement(f.c.db, recovered, [{ id: prior.id, name: prior.name, removed: true, fenced: true }])).rejects.toThrow();
  await completeNodeWakeRetirement(f.c.db, recovered, [{ id: prior.id, name: prior.name, removed: true, fenced: true },
    { id: 'c'.repeat(64), name: 'ninedeploy-wake', removed: false, fenced: true }]);
  expect((await journal()).catcherId).toBe(next.id); expect(await wake()).not.toBeNull();
});
