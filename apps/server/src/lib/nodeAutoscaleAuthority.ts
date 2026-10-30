import { randomBytes } from 'node:crypto';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { deployments, fanoutTransitions, nodeAutoscaleTransitions, nodeLifecycleIntents, primaryTransitions, serviceTargets, services,
  type DB, type Service, type ServiceRuntimeOwner } from '@ninedeploy/db';
import { autoscaleConfig } from '@ninedeploy/schemas';
import { MAX_REPLICAS } from '../engine/dockerNames.js';
import { readServiceRuntimeOwner, reserveServiceRuntimeOwnerInTransaction, sameRuntimeOwner } from './serviceRuntimeOwner.js';
import { swarmRuntimeOf } from './swarm.js';

type Placement = { serverId: number; runtimeId: string | null };
export type NodeAutoscaleAdmission = { owner: ServiceRuntimeOwner; service: Service; targets: Placement[]; watermark: number; desiredReplicas: number };
const snapshot = (s: Service) => JSON.stringify([s.type, s.orchestrator, s.slug, s.serverId, s.status, s.asleepAt,
  s.runtimeId, s.replicas, s.autoscale, s.port, s.healthCheck, s.healthPath, s.healthCommand, s.healthTimeoutSeconds,
  s.cpuShares, s.cpuLimitMilli, s.memLimitMb]);
const placements = (db: Pick<DB, 'select'>, serviceId: number) => db.select({ serverId: serviceTargets.serverId, runtimeId: serviceTargets.runtimeId })
  .from(serviceTargets).where(eq(serviceTargets.serviceId, serviceId)).orderBy(serviceTargets.id);

/** Reserve a scale owner only for the exact running generation observed by the controller. */
export async function admitNodeAutoscale(db: DB, expected: Service, desiredReplicas: number): Promise<NodeAutoscaleAdmission | null> {
  const config = autoscaleConfig.safeParse(expected.autoscale);
  if (expected.type !== 'docker' || expected.orchestrator === 'swarm' || swarmRuntimeOf(expected) ||
    !expected.serverId || expected.status !== 'running' || !expected.runtimeId || expected.asleepAt != null ||
    !config.success || !Number.isSafeInteger(expected.runtimeReplicas) || expected.runtimeReplicas < 1 || expected.runtimeReplicas > MAX_REPLICAS ||
    !Number.isSafeInteger(desiredReplicas) || desiredReplicas < 1 || desiredReplicas > config.data.maxReplicas ||
    desiredReplicas === expected.runtimeReplicas) return null;
  return db.transaction(async tx => {
    const fresh = await tx.query.services.findFirst({ where: eq(services.id, expected.id) });
    if (!fresh || snapshot(fresh) !== snapshot(expected) || fresh.runtimeReplicas !== expected.runtimeReplicas) return null;
    const [active, lifecycle, primary, fanout, priorTransition] = await Promise.all([
      tx.select({ id: deployments.id }).from(deployments).where(and(eq(deployments.serviceId, fresh.id), inArray(deployments.status, ['queued', 'building', 'deploying']))).limit(1),
      tx.select({ id: nodeLifecycleIntents.id }).from(nodeLifecycleIntents).where(and(eq(nodeLifecycleIntents.serviceId, fresh.id), notInArray(nodeLifecycleIntents.phase, ['completed', 'superseded']))).limit(1),
      tx.select({ id: primaryTransitions.id }).from(primaryTransitions).where(eq(primaryTransitions.serviceId, fresh.id)).limit(1),
      tx.select({ id: fanoutTransitions.id }).from(fanoutTransitions).where(eq(fanoutTransitions.serviceId, fresh.id)).limit(1),
      tx.select({ id: nodeAutoscaleTransitions.serviceId }).from(nodeAutoscaleTransitions).where(eq(nodeAutoscaleTransitions.serviceId, fresh.id)).limit(1),
    ]);
    if (active.length || lifecycle.length || primary.length || fanout.length || priorTransition.length) return null;
    const targets = await placements(tx, fresh.id);
    if (targets.some(t => !t.runtimeId || t.serverId === fresh.serverId) || new Set(targets.map(t => t.serverId)).size !== targets.length) return null;
    const [sequence] = await tx.select({ id: sql<number>`COALESCE((SELECT seq FROM sqlite_sequence WHERE name='deployments'), 0)` })
      .from(services).where(eq(services.id, fresh.id)).limit(1);
    const generations = [fresh.runtimeId!, ...targets.map(target => target.runtimeId!)].map(name => Number(/-([1-9]\d*)$/.exec(name)?.[1]));
    if (generations.some(id => !Number.isSafeInteger(id) || id < 1)) return null;
    const watermark = Math.max(Number(sequence?.id ?? 0), ...generations);
    if (!Number.isSafeInteger(watermark) || watermark < 1) return null;
    const prior = await readServiceRuntimeOwner(tx, fresh.id);
    const owner = await reserveServiceRuntimeOwnerInTransaction(tx, fresh.id, 'scale', randomBytes(16).toString('hex'), prior);
    await tx.insert(nodeAutoscaleTransitions).values({ serviceId: fresh.id, ownerEpoch: owner.epoch, requestId: owner.requestId!,
      serverId: fresh.serverId!, runtimeId: fresh.runtimeId!, fromReplicas: fresh.runtimeReplicas, toReplicas: desiredReplicas,
      watermark, configuration: snapshot(fresh), targets: targets.map(t => ({ serverId: t.serverId, runtimeId: t.runtimeId! })) });
    return { owner, service: fresh, targets, watermark, desiredReplicas };
  });
}

async function assertCurrent(tx: Pick<DB, 'query' | 'select'>, admission: NodeAutoscaleAdmission, expectedReplicas: number): Promise<void> {
    const fresh = await tx.query.services.findFirst({ where: eq(services.id, admission.service.id) });
    if (!fresh || admission.owner.kind !== 'scale' || snapshot(fresh) !== snapshot(admission.service) || fresh.runtimeReplicas !== expectedReplicas ||
      !sameRuntimeOwner(await readServiceRuntimeOwner(tx, fresh.id), admission.owner) ||
      JSON.stringify(await placements(tx, fresh.id)) !== JSON.stringify(admission.targets)) throw new Error('Node autoscale ownership, runtime or placement changed');
    const [transition] = await tx.select().from(nodeAutoscaleTransitions).where(eq(nodeAutoscaleTransitions.serviceId, fresh.id)).limit(1);
    if (!transition || transition.phase !== 'accepted' || transition.ownerEpoch !== admission.owner.epoch || transition.requestId !== admission.owner.requestId ||
      transition.serverId !== fresh.serverId || transition.runtimeId !== fresh.runtimeId || transition.fromReplicas !== admission.service.runtimeReplicas ||
      transition.toReplicas !== admission.desiredReplicas || transition.watermark !== admission.watermark || transition.configuration !== snapshot(admission.service) ||
      JSON.stringify(transition.targets) !== JSON.stringify(admission.targets)) throw new Error('Node autoscale transition changed');
    const [active, lifecycle, primary, fanout] = await Promise.all([
      tx.select({ id: deployments.id }).from(deployments).where(and(eq(deployments.serviceId, fresh.id), inArray(deployments.status, ['queued', 'building', 'deploying']))).limit(1),
      tx.select({ id: nodeLifecycleIntents.id }).from(nodeLifecycleIntents).where(and(eq(nodeLifecycleIntents.serviceId, fresh.id), notInArray(nodeLifecycleIntents.phase, ['completed', 'superseded']))).limit(1),
      tx.select({ id: primaryTransitions.id }).from(primaryTransitions).where(eq(primaryTransitions.serviceId, fresh.id)).limit(1),
      tx.select({ id: fanoutTransitions.id }).from(fanoutTransitions).where(eq(fanoutTransitions.serviceId, fresh.id)).limit(1),
    ]);
    if (active.length || lifecycle.length || primary.length || fanout.length) throw new Error('Node autoscale blocked by active runtime work');
}

/** Reconstruct a recorded decision only while its original runtime authority is still current. */
export async function recoverNodeAutoscaleAdmission(db: DB, serviceId: number): Promise<NodeAutoscaleAdmission | null> {
  return db.transaction(async tx => {
    const [transition] = await tx.select().from(nodeAutoscaleTransitions).where(eq(nodeAutoscaleTransitions.serviceId, serviceId)).limit(1);
    if (!transition) return null;
    const service = await tx.query.services.findFirst({ where: eq(services.id, serviceId) });
    const owner = await readServiceRuntimeOwner(tx, serviceId);
    if (!service || !owner || transition.configuration !== snapshot(service) ||
      (service.runtimeReplicas !== transition.fromReplicas && service.runtimeReplicas !== transition.toReplicas)) {
      throw new Error('Node autoscale recovery configuration or count changed');
    }
    const admission: NodeAutoscaleAdmission = { owner, service: { ...service, runtimeReplicas: transition.fromReplicas },
      targets: transition.targets, watermark: transition.watermark, desiredReplicas: transition.toReplicas };
    await assertCurrent(tx, admission, service.runtimeReplicas);
    return admission;
  });
}

/** Recheck ownership, placement and serving count around every awaited scale effect. */
export async function checkpointNodeAutoscale(db: DB, admission: NodeAutoscaleAdmission, expectedReplicas: number): Promise<void> {
  await db.transaction(tx => assertCurrent(tx, admission, expectedReplicas));
}

/** Commit the count only with the same authority and observed generation in one transaction. */
export async function commitNodeAutoscaleReplicas(db: DB, admission: NodeAutoscaleAdmission, expectedReplicas: number, nextReplicas: number): Promise<void> {
  const config = autoscaleConfig.parse(admission.service.autoscale);
  if (!Number.isSafeInteger(expectedReplicas) || !Number.isSafeInteger(nextReplicas) || expectedReplicas < 1 ||
    nextReplicas < 1 || expectedReplicas > MAX_REPLICAS || nextReplicas > MAX_REPLICAS ||
    (nextReplicas !== admission.service.runtimeReplicas && nextReplicas > config.maxReplicas)) throw new Error('Invalid node autoscale replica count');
  await db.transaction(async tx => {
    await assertCurrent(tx, admission, expectedReplicas);
    if (nextReplicas !== admission.desiredReplicas && nextReplicas !== admission.service.runtimeReplicas) throw new Error('Node autoscale count is not recorded in its transition');
    const updated = await tx.update(services).set({ runtimeReplicas: nextReplicas }).where(and(
      eq(services.id, admission.service.id), eq(services.runtimeReplicas, expectedReplicas),
    )).returning({ id: services.id });
    if (updated.length !== 1) throw new Error('Node autoscale replica count changed');
  });
}
