import { randomBytes } from 'node:crypto';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { deployments, fanoutTransitions, nodeLifecycleIntents, primaryTransitions, services, serviceTargets,
  type DB, type Service, type ServiceRuntimeOwner } from '@ninedeploy/db';
import { readServiceRuntimeOwner, reserveServiceRuntimeOwnerInTransaction, sameRuntimeOwner } from './serviceRuntimeOwner.js';
import { swarmRuntimeOf } from './swarm.js';

type Placement = { serverId: number; runtimeId: string | null };
export type NodeLimitsAdmission = { owner: ServiceRuntimeOwner; service: Service; targets: Placement[]; watermark: number };
const snapshot = (s: Service) => JSON.stringify([s.type, s.orchestrator, s.serverId, s.status, s.runtimeId, s.replicas, s.runtimeReplicas,
  s.autoscale, s.cpuShares, s.cpuLimitMilli, s.memLimitMb]);
const placements = (db: Pick<DB, 'select'>, serviceId: number) => db.select({ serverId: serviceTargets.serverId, runtimeId: serviceTargets.runtimeId })
  .from(serviceTargets).where(eq(serviceTargets.serviceId, serviceId)).orderBy(serviceTargets.id);

/** Atomically admit limits only for a stable runtime, without superseding active work. */
export async function admitNodeLimits(db: DB, expected: Service): Promise<NodeLimitsAdmission | null> {
  if (expected.type !== 'docker' || expected.orchestrator === 'swarm' || swarmRuntimeOf(expected) || !expected.serverId || expected.status !== 'running' || !expected.runtimeId) return null;
  return db.transaction(async tx => {
    const fresh = await tx.query.services.findFirst({ where: eq(services.id, expected.id) });
    if (!fresh || snapshot(fresh) !== snapshot(expected)) return null;
    const [active, lifecycle, primary, fanout] = await Promise.all([
      tx.select({ id: deployments.id }).from(deployments).where(and(eq(deployments.serviceId, fresh.id), inArray(deployments.status, ['queued', 'building', 'deploying']))).limit(1),
      tx.select({ id: nodeLifecycleIntents.id }).from(nodeLifecycleIntents).where(and(eq(nodeLifecycleIntents.serviceId, fresh.id), notInArray(nodeLifecycleIntents.phase, ['completed', 'superseded']))).limit(1),
      tx.select({ id: primaryTransitions.id }).from(primaryTransitions).where(eq(primaryTransitions.serviceId, fresh.id)).limit(1),
      tx.select({ id: fanoutTransitions.id }).from(fanoutTransitions).where(eq(fanoutTransitions.serviceId, fresh.id)).limit(1),
    ]);
    if (active.length || lifecycle.length || primary.length || fanout.length) return null;
    const targets = await placements(tx, fresh.id);
    if (targets.some(t => !t.runtimeId || t.serverId === fresh.serverId) || new Set(targets.map(t => t.serverId)).size !== targets.length) return null;
    const [sequence] = await tx.select({ id: sql<number>`COALESCE((SELECT seq FROM sqlite_sequence WHERE name='deployments'), 0)` })
      .from(services).where(eq(services.id, fresh.id)).limit(1);
    const generations = [fresh.runtimeId!, ...targets.map(target => target.runtimeId!)].map(name => Number(/-([1-9]\d*)$/.exec(name)?.[1]));
    if (generations.some(id => !Number.isSafeInteger(id) || id < 1)) return null;
    const watermark = Math.max(Number(sequence?.id ?? 0), ...generations);
    if (!Number.isSafeInteger(watermark) || watermark < 1) return null;
    const prior = await readServiceRuntimeOwner(tx, fresh.id);
    const owner = await reserveServiceRuntimeOwnerInTransaction(tx, fresh.id, 'limits', randomBytes(16).toString('hex'), prior);
    return { owner, service: fresh, targets, watermark };
  });
}

/** Check the same placement, values and owner before and after each remote effect. */
export async function checkpointNodeLimits(db: DB, admission: NodeLimitsAdmission): Promise<void> {
  const fresh = await db.query.services.findFirst({ where: eq(services.id, admission.service.id) });
  if (!fresh || snapshot(fresh) !== snapshot(admission.service) || !sameRuntimeOwner(await readServiceRuntimeOwner(db, fresh.id), admission.owner) ||
    JSON.stringify(await placements(db, fresh.id)) !== JSON.stringify(admission.targets)) throw new Error('Node limit ownership or placement changed');
}
