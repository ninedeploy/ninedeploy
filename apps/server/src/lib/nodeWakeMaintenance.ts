import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, lte, ne, notInArray, or } from 'drizzle-orm';
import { nodeSleepTransitions, nodeWakeMaintenance, servers, services, type DB, type NodeWakeMaintenance } from '@ninedeploy/db';
import { readNodeSleepingState, refreshNodeSleepCatcherInTransaction } from './nodeSleepAuthority.js';
import { validNodeCatcherName } from './nodeCatcherIdentity.js';
import { registerNodeCatcherRoutePromotion } from './nodeCatcherRoutePromotion.js';

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
  if (!node || !row || row.phase === 'completed' || !['preparing', 'routing', 'rebinding', 'retiring', 'rerouting', 'retirement_rebinding'].includes(row.phase) ||
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
      if (state) snapshot.push({ serviceId: item.serviceId, ownerEpoch: state.owner.epoch, requestId: state.owner.requestId!, binding: item.binding, catcherId: item.catcherId!, catcherName: item.catcherName });
    }
    if (!snapshot.length) return null;
    const generation = (prior?.generation ?? 0) + 1, requestId = nonce();
    if (!Number.isSafeInteger(generation) || generation <= 0) throw changed();
    const binding = stamp({ serverId, generation, requestId, snapshot });
    const values = { serverId, generation, requestId, binding, snapshot, phase: 'preparing' as const, workerToken, leaseUntil, catcherId: null, catcherImage: null, catcherName: 'ninedeploy-wake', reason: null };
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
export async function recordNodeWakeMaintenanceCatcher(db: DB, claim: NodeWakeMaintenanceClaim, catcher: { id: string; image: string; name?: string }) {
  const name = catcher.name ?? 'ninedeploy-wake';
  if (!/^[a-f0-9]{64}$/.test(catcher.id) || !/^sha256:[a-f0-9]{64}$/.test(catcher.image) || !validNodeCatcherName(name)) throw changed();
  await db.transaction(async tx => {
    const prior = await current(tx, claim);
    if (prior.phase === 'retiring') throw changed();
    // A recovered/recreated catcher invalidates any earlier routing acknowledgement.
    await tx.update(nodeWakeMaintenance).set({ catcherId: catcher.id, catcherImage: catcher.image, catcherName: name,
      phase: ['rerouting', 'retirement_rebinding'].includes(prior.phase) ? 'rerouting' : 'routing' }).where(eq(nodeWakeMaintenance.serverId, claim.serverId));
  });
}
export async function confirmNodeWakeMaintenanceRouting(db: DB, claim: NodeWakeMaintenanceClaim) {
  await db.transaction(async tx => {
    const row = await current(tx, claim);
    if (!['routing', 'rerouting'].includes(row.phase) || !row.catcherId || !row.catcherImage) throw changed();
    await tx.update(nodeWakeMaintenance).set({ phase: row.phase === 'rerouting' ? 'retirement_rebinding' : 'rebinding' }).where(eq(nodeWakeMaintenance.serverId, claim.serverId));
  });
}
/** Caller confirms reachability and exact fallback routing before this atomic binding settlement. */
export async function completeNodeWakeMaintenance(db: DB, claim: NodeWakeMaintenanceClaim) {
  return db.transaction(async tx => {
    const row = await current(tx, claim);
    if (!['rebinding', 'retirement_rebinding'].includes(row.phase) || !row.catcherId || !row.catcherImage) throw changed();
    let rebound = 0;
    for (const item of row.snapshot) {
      if (item.retirementOnly) continue;
      const state = await readNodeSleepingState(tx, item.serviceId);
      if (!state) continue; // A newer explicit command owns settlement of this service.
      if (state.row.binding !== item.binding || state.owner.epoch !== item.ownerEpoch || state.owner.requestId !== item.requestId || state.row.catcherId !== item.catcherId) throw changed();
      await refreshNodeSleepCatcherInTransaction(tx, state.owner, item.catcherId, { id: row.catcherId, image: row.catcherImage, name: row.catcherName }); rebound++;
    }
    await tx.update(nodeWakeMaintenance).set({ phase: 'retiring', reason: null }).where(eq(nodeWakeMaintenance.serverId, claim.serverId));
    return rebound;
  });
}

/** The ready candidate may override only this maintenance intent's captured fallback members. */
export async function prepareNodeCatcherRouting(db: DB, claim: NodeWakeMaintenanceClaim) {
  const row = await checkpointNodeWakeMaintenance(db, claim);
  if (!['routing', 'rerouting'].includes(row.phase) || !row.catcherId || !row.catcherImage || !validNodeCatcherName(row.catcherName)) throw changed();
  const target = { id: row.catcherId, image: row.catcherImage, name: row.catcherName, services: row.snapshot.filter(item => !item.retirementOnly) };
  return registerNodeCatcherRoutePromotion(claim.serverId, target, async () => {
    const fresh = await checkpointNodeWakeMaintenance(db, claim);
    if (fresh.phase !== row.phase || fresh.catcherId !== target.id || fresh.catcherImage !== target.image || fresh.catcherName !== target.name) throw changed();
  }, async () => {
    await confirmNodeWakeMaintenanceRouting(db, claim);
    return completeNodeWakeMaintenance(db, claim);
  });
}

/** A replacement during interrupted retirement keeps every older target under the same durable intent. */
export async function rebaseNodeWakeMaintenance(db: DB, claim: NodeWakeMaintenanceClaim, catcher: { id: string; image: string; name: string }): Promise<NodeWakeMaintenanceClaim> {
  if (!/^[a-f0-9]{64}$/.test(catcher.id) || !/^sha256:[a-f0-9]{64}$/.test(catcher.image) || !validNodeCatcherName(catcher.name)) throw changed();
  return db.transaction(async tx => {
    const row = await current(tx, claim);
    if (!row.catcherId || !row.catcherImage || !validNodeCatcherName(row.catcherName)) throw changed();
    const sleeping = await tx.select().from(nodeSleepTransitions).where(and(eq(nodeSleepTransitions.serverId, claim.serverId), eq(nodeSleepTransitions.phase, 'asleep')));
    const snapshot: NodeWakeMaintenance['snapshot'] = [];
    for (const item of sleeping) {
      const state = await readNodeSleepingState(tx, item.serviceId);
      if (state) snapshot.push({ serviceId: item.serviceId, ownerEpoch: state.owner.epoch, requestId: state.owner.requestId!, binding: item.binding,
        catcherId: item.catcherId!, catcherName: item.catcherName });
    }
    const liveIds = new Set(snapshot.map(item => item.catcherId)), retained = new Map<string, NodeWakeMaintenance['snapshot'][number]>();
    for (const prior of row.snapshot) {
      if (prior.catcherId !== catcher.id && !liveIds.has(prior.catcherId)) retained.set(prior.catcherId, { ...prior, retirementOnly: true });
    }
    if (row.catcherId !== catcher.id && !liveIds.has(row.catcherId)) {
      const source = row.snapshot[0]; if (!source) throw changed();
      retained.set(row.catcherId, { ...source, catcherId: row.catcherId, catcherName: row.catcherName, retirementOnly: true });
    }
    snapshot.push(...retained.values());
    const binding = stamp({ ...row, snapshot }), workerToken = nonce();
    await tx.update(nodeWakeMaintenance).set({ snapshot, binding, workerToken, leaseUntil: new Date(Date.now() + LEASE_MS),
      phase: 'rerouting', catcherId: catcher.id, catcherImage: catcher.image, catcherName: catcher.name, reason: null }).where(eq(nodeWakeMaintenance.serverId, claim.serverId));
    return { ...claim, binding, workerToken };
  });
}

export async function assertNodeCatcherUnreferenced(db: ReadDB, serverId: number, catcherId: string): Promise<void> {
  const references = await db.select({ id: nodeSleepTransitions.serviceId }).from(nodeSleepTransitions).innerJoin(services, eq(services.id, nodeSleepTransitions.serviceId))
    .where(and(eq(nodeSleepTransitions.serverId, serverId), eq(nodeSleepTransitions.catcherId, catcherId), eq(nodeSleepTransitions.fallbackRouting, true),
      ne(services.status, 'stopped'), eq(services.serverId, serverId), eq(services.runtimeId, nodeSleepTransitions.runtimeId))).limit(1);
  if (references.length) throw new Error('A retained catcher still has selected fallback routing');
}

/** The admission barrier survives a lost removal reply until every captured old ID is proved retired. */
export async function completeNodeWakeRetirement(db: DB, claim: NodeWakeMaintenanceClaim,
  receipts: Array<{ id: string; name: string; fenced: true; removed: boolean }>) {
  await db.transaction(async tx => {
    const row = await current(tx, claim);
    if (row.phase !== 'retiring' || !row.catcherId) throw changed();
    const expected = new Map(row.snapshot.filter(item => item.catcherId !== row.catcherId).map(item => [item.catcherId, item.catcherName]));
    if (receipts.length !== expected.size || new Set(receipts.map(item => item.id)).size !== receipts.length || receipts.some(item =>
      !expected.has(item.id) || !validNodeCatcherName(item.name) || expected.get(item.id) !== undefined && expected.get(item.id) !== item.name || item.fenced !== true || typeof item.removed !== 'boolean')) throw changed();
    for (const id of expected.keys()) await assertNodeCatcherUnreferenced(tx, claim.serverId, id);
    await tx.update(nodeWakeMaintenance).set({ phase: 'completed', workerToken: null, leaseUntil: null, reason: null }).where(eq(nodeWakeMaintenance.serverId, claim.serverId));
  });
}
export async function holdNodeWakeMaintenance(db: DB, claim: NodeWakeMaintenanceClaim, reason: string) {
  await db.update(nodeWakeMaintenance).set({ workerToken: null, leaseUntil: null, reason: reason.slice(0, 1000) }).where(and(
    eq(nodeWakeMaintenance.serverId, claim.serverId), eq(nodeWakeMaintenance.generation, claim.generation), eq(nodeWakeMaintenance.requestId, claim.requestId),
    eq(nodeWakeMaintenance.workerToken, claim.workerToken), eq(nodeWakeMaintenance.binding, claim.binding), ne(nodeWakeMaintenance.phase, 'completed')));
}
