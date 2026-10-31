import { randomBytes } from 'node:crypto';
import { and, eq, nodeDeploymentPreparations, runtimeMutationKinds, serviceRuntimeOwners, services, sql, type DB, type ServiceRuntimeOwner } from '@ninedeploy/db';
import { isNull } from 'drizzle-orm';
import { HttpError } from './errors.js';

export type RuntimeMutationKind = Exclude<ServiceRuntimeOwner['kind'], 'legacy'>;
export type RuntimeOwnerDB = Pick<DB, 'select' | 'insert' | 'update'>;
export const MAX_RUNTIME_EPOCH = Math.floor((Number.MAX_SAFE_INTEGER - 3) / 4);
const changed = () => new HttpError(409, 'runtime_owner_superseded', 'A newer service mutation owns this runtime');

export function serviceRuntimeRevision(epoch: number, phase: 0 | 1 | 2 | 3): number {
  if (!Number.isSafeInteger(epoch) || epoch < 1 || epoch > MAX_RUNTIME_EPOCH || ![0, 1, 2, 3].includes(phase)) {
    throw new Error('Runtime ownership revision capacity exceeded');
  }
  return epoch * 4 + phase;
}

function valid(owner: ServiceRuntimeOwner): ServiceRuntimeOwner {
  if (!Number.isSafeInteger(owner.epoch) || owner.epoch < 0 || owner.epoch > MAX_RUNTIME_EPOCH ||
    (owner.kind !== 'legacy' && !runtimeMutationKinds.includes(owner.kind)) ||
    (owner.kind === 'legacy' ? owner.requestId !== null : owner.epoch < 1 || owner.requestId === null || !/^[a-f0-9]{32}$/.test(owner.requestId))) {
    throw new Error('Runtime ownership is invalid; effects retained for review');
  }
  return owner;
}

export async function readServiceRuntimeOwner(db: Pick<DB, 'select'>, serviceId: number): Promise<ServiceRuntimeOwner | null> {
  const [row] = await db.select().from(serviceRuntimeOwners).where(eq(serviceRuntimeOwners.serviceId, serviceId)).limit(1);
  return row ? valid(row) : null;
}

export function sameRuntimeOwner(current: ServiceRuntimeOwner | null, expected: ServiceRuntimeOwner | null): boolean {
  return current === null || expected === null ? current === expected : current.serviceId === expected.serviceId && current.epoch === expected.epoch &&
    current.requestId === expected.requestId && current.kind === expected.kind;
}

/** Call inside the transaction that checks eligibility and records the corresponding command/job. */
export async function reserveServiceRuntimeOwnerInTransaction(db: RuntimeOwnerDB, serviceId: number, kind: RuntimeMutationKind,
  requestId: string, expected: ServiceRuntimeOwner | null | 'supersede'): Promise<ServiceRuntimeOwner> {
  if (!Number.isSafeInteger(serviceId) || serviceId < 1 || !/^[a-f0-9]{32}$/.test(requestId) ||
    !runtimeMutationKinds.includes(kind)) throw new Error('Invalid runtime ownership request');
  if (expected !== 'supersede' && expected !== null && expected.serviceId !== serviceId) throw changed();
  const current = await readServiceRuntimeOwner(db, serviceId);
  if (current?.requestId === requestId) {
    if (current.kind !== kind) throw changed();
    return current;
  }
  if (expected !== 'supersede' && !sameRuntimeOwner(current, expected)) throw changed();
  if (kind !== 'stop' && (await db.select({ deploymentId: nodeDeploymentPreparations.deploymentId }).from(nodeDeploymentPreparations)
    .where(eq(nodeDeploymentPreparations.serviceId, serviceId)).limit(1)).length) {
    throw new HttpError(409, 'node_preparation_pending', 'Node deployment preparation must be recovered before changing runtime ownership');
  }
  // The legacy journal's AUTOINCREMENT high-water mark survives deleted history.
  const [seed] = await db.select({ epoch: sql<number>`COALESCE((SELECT seq FROM sqlite_sequence WHERE name='node_lifecycle_intents'), 0)` })
    .from(services).where(eq(services.id, serviceId)).limit(1);
  if (!seed) throw changed();
  const inherited = Number(seed.epoch);
  if (!Number.isSafeInteger(inherited) || inherited < 0) throw new Error('Runtime ownership revision capacity exceeded');
  const previous = Math.max(current?.epoch ?? 0, inherited);
  if (!Number.isSafeInteger(previous) || previous < 0 || previous >= MAX_RUNTIME_EPOCH) throw new Error('Runtime ownership revision capacity exceeded');
  const values = { epoch: previous + 1, requestId, kind, updatedAt: new Date() };
  const rows = current
    ? await db.update(serviceRuntimeOwners).set(values).where(and(eq(serviceRuntimeOwners.serviceId, serviceId), eq(serviceRuntimeOwners.epoch, current.epoch),
      current.requestId === null ? isNull(serviceRuntimeOwners.requestId) : eq(serviceRuntimeOwners.requestId, current.requestId), eq(serviceRuntimeOwners.kind, current.kind))).returning()
    : await db.insert(serviceRuntimeOwners).values({ serviceId, ...values }).onConflictDoNothing().returning();
  if (rows.length !== 1) throw changed();
  return valid(rows[0]!);
}

/** Persisted expected ownership prevents a delayed automatic job from claiming a newer command. */
export async function reserveServiceRuntimeOwner(db: DB, serviceId: number, kind: RuntimeMutationKind,
  expected: ServiceRuntimeOwner | null, requestId = randomBytes(16).toString('hex')): Promise<ServiceRuntimeOwner> {
  return db.transaction(tx => reserveServiceRuntimeOwnerInTransaction(tx, serviceId, kind, requestId, expected));
}
