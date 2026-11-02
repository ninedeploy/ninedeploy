import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, lte, ne, notInArray, or } from 'drizzle-orm';
import { nodeSleepTransitions, nodeWakeMaintenance, servers, type DB, type NodeWakeMaintenance } from '@ninedeploy/db';
import { readNodeSleepingState, refreshNodeSleepCatcherInTransaction } from './nodeSleepAuthority.js';

const LEASE_MS = 120_000;
const nonce = () => randomBytes(16).toString('hex');
export type NodeWakeMaintenanceClaim = { serverId: number; generation: number; requestId: string; binding: string; workerToken: string };
type ReadDB = Pick<DB, 'select' | 'query'>;
const changed = () => new Error('Node wake maintenance ownership or worker lease changed');
const stamp = (row: Pick<NodeWakeMaintenance, 'serverId' | 'generation' | 'requestId' | 'snapshot'>) => createHash('sha256')
  .update(JSON.stringify([row.serverId, row.generation, row.requestId, row.snapshot])).digest('hex');
async function noActiveTransitions(db: ReadDB, serverId: number) {
  return !(await db.select({ id: nodeSleepTransitions.serviceId }).from(nodeSleepTransitions).where(and(eq(nodeSleepTransitions.serverId, serverId),
    notInArray(nodeSleepTransitions.phase, ['asleep', 'completed', 'superseded']))).limit(1)).length;
}
async function current(db: ReadDB, claim: NodeWakeMaintenanceClaim) {
  const row = await db.query.nodeWakeMaintenance.findFirst({ where: eq(nodeWakeMaintenance.serverId, claim.serverId) });
  const node = await db.query.servers.findFirst({ where: eq(servers.id, claim.serverId) });
  if (!node || !row || row.phase === 'completed' || !['preparing', 'routing', 'rebinding'].includes(row.phase) ||
    !Number.isSafeInteger(row.generation) || row.generation < 1 || row.generation !== claim.generation || row.requestId !== claim.requestId ||
    !/^[a-f0-9]{32}$/.test(row.requestId) || !/^[a-f0-9]{64}$/.test(row.binding) || !/^[a-f0-9]{32}$/.test(claim.workerToken) ||
    row.binding !== claim.binding || stamp(row) !== row.binding || row.workerToken !== claim.workerToken || !row.leaseUntil || !Number.isFinite(row.leaseUntil.getTime()) || row.leaseUntil.getTime() <= Date.now() ||
    !await noActiveTransitions(db, claim.serverId)) throw changed();
  return row;
}

/** The intent remains an admission barrier even when its worker expires or the panel restarts. */
export async function claimNodeWakeMaintenance(db: DB, serverId: number): Promise<NodeWakeMaintenanceClaim | null> {
  if (!Number.isSafeInteger(serverId) || serverId <= 0) throw changed();
  return db.transaction(async tx => {
    const node = await tx.query.servers.findFirst({ where: eq(servers.id, serverId) });
    if (!node || !await noActiveTransitions(tx, serverId)) return null;
    const prior = await tx.query.nodeWakeMaintenance.findFirst({ where: eq(nodeWakeMaintenance.serverId, serverId) });
    if (prior && (!Number.isSafeInteger(prior.generation) || prior.generation < 1)) throw changed();
    const workerToken = nonce(), leaseUntil = new Date(Date.now() + LEASE_MS);
    if (prior && prior.phase !== 'completed') {
      if (prior.leaseUntil && prior.leaseUntil.getTime() > Date.now()) return null;
      const [row] = await tx.update(nodeWakeMaintenance).set({ workerToken, leaseUntil }).where(and(eq(nodeWakeMaintenance.serverId, serverId),
        eq(nodeWakeMaintenance.requestId, prior.requestId), ne(nodeWakeMaintenance.phase, 'completed'),
        or(isNull(nodeWakeMaintenance.leaseUntil), lte(nodeWakeMaintenance.leaseUntil, new Date())))).returning();
      if (!row) return null;
      const claim = { serverId, generation: row.generation, requestId: row.requestId, binding: row.binding, workerToken };
      await current(tx, claim); return claim;
    }
    const sleeping = await tx.select().from(nodeSleepTransitions).where(and(eq(nodeSleepTransitions.serverId, serverId), eq(nodeSleepTransitions.phase, 'asleep')));
    const snapshot: NodeWakeMaintenance['snapshot'] = [];
    for (const item of sleeping) {
      const state = await readNodeSleepingState(tx, item.serviceId);
      if (state) snapshot.push({ serviceId: item.serviceId, ownerEpoch: state.owner.epoch, requestId: state.owner.requestId!, binding: item.binding, catcherId: item.catcherId! });
    }
    if (!snapshot.length) return null;
    const generation = (prior?.generation ?? 0) + 1, requestId = nonce();
    if (!Number.isSafeInteger(generation) || generation <= 0) throw changed();
    const binding = stamp({ serverId, generation, requestId, snapshot });
    const values = { serverId, generation, requestId, binding, snapshot, phase: 'preparing' as const, workerToken, leaseUntil, catcherId: null, catcherImage: null, reason: null };
    const [row] = await tx.insert(nodeWakeMaintenance).values(values).onConflictDoUpdate({ target: nodeWakeMaintenance.serverId, set: values,
      setWhere: eq(nodeWakeMaintenance.phase, 'completed') }).returning();
    if (!row) return null;
    return { serverId, generation, requestId, binding, workerToken };
  });
}

export async function checkpointNodeWakeMaintenance(db: DB, claim: NodeWakeMaintenanceClaim) {
  return db.transaction(async tx => {
    const row = await current(tx, claim);
    await tx.update(nodeWakeMaintenance).set({ leaseUntil: new Date(Date.now() + LEASE_MS) }).where(eq(nodeWakeMaintenance.serverId, claim.serverId));
    return row;
  });
}
export async function recordNodeWakeMaintenanceCatcher(db: DB, claim: NodeWakeMaintenanceClaim, catcher: { id: string; image: string }) {
  if (!/^[a-f0-9]{64}$/.test(catcher.id) || !/^sha256:[a-f0-9]{64}$/.test(catcher.image)) throw changed();
  await db.transaction(async tx => {
    await current(tx, claim);
    // A recovered/recreated catcher invalidates any earlier routing acknowledgement.
    await tx.update(nodeWakeMaintenance).set({ catcherId: catcher.id, catcherImage: catcher.image, phase: 'routing' }).where(eq(nodeWakeMaintenance.serverId, claim.serverId));
  });
}
export async function confirmNodeWakeMaintenanceRouting(db: DB, claim: NodeWakeMaintenanceClaim) {
  await db.transaction(async tx => {
    const row = await current(tx, claim);
    if (row.phase !== 'routing' || !row.catcherId || !row.catcherImage) throw changed();
    await tx.update(nodeWakeMaintenance).set({ phase: 'rebinding' }).where(eq(nodeWakeMaintenance.serverId, claim.serverId));
  });
}
/** Caller confirms reachability and exact fallback routing before this atomic binding settlement. */
export async function completeNodeWakeMaintenance(db: DB, claim: NodeWakeMaintenanceClaim) {
  return db.transaction(async tx => {
    const row = await current(tx, claim);
    if (row.phase !== 'rebinding' || !row.catcherId || !row.catcherImage) throw changed();
    let rebound = 0;
    for (const item of row.snapshot) {
      const state = await readNodeSleepingState(tx, item.serviceId);
      if (!state) continue; // A newer explicit command owns settlement of this service.
      if (state.row.binding !== item.binding || state.owner.epoch !== item.ownerEpoch || state.owner.requestId !== item.requestId || state.row.catcherId !== item.catcherId) throw changed();
      await refreshNodeSleepCatcherInTransaction(tx, state.owner, item.catcherId, { id: row.catcherId, image: row.catcherImage }); rebound++;
    }
    await tx.update(nodeWakeMaintenance).set({ phase: 'completed', workerToken: null, leaseUntil: null, reason: null }).where(eq(nodeWakeMaintenance.serverId, claim.serverId));
    return rebound;
  });
}
export async function holdNodeWakeMaintenance(db: DB, claim: NodeWakeMaintenanceClaim, reason: string) {
  await db.update(nodeWakeMaintenance).set({ workerToken: null, leaseUntil: null, reason: reason.slice(0, 1000) }).where(and(
    eq(nodeWakeMaintenance.serverId, claim.serverId), eq(nodeWakeMaintenance.generation, claim.generation), eq(nodeWakeMaintenance.requestId, claim.requestId),
    eq(nodeWakeMaintenance.workerToken, claim.workerToken), ne(nodeWakeMaintenance.phase, 'completed')));
}
