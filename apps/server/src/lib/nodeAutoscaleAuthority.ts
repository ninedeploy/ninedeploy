import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import { deployments, fanoutTransitions, nodeAutoscaleCapacity, nodeAutoscaleTransitions, nodeLifecycleIntents, primaryTransitions, serviceTargets, services,
  type DB, type Service, type ServiceRuntimeOwner } from '@ninedeploy/db';
import { autoscaleConfig, containerInventoryReply } from '@ninedeploy/schemas';
import { MAX_REPLICAS, replicaNames } from '../engine/dockerNames.js';
import { canaryActive } from '../engine/canaryState.js';
import { readServiceRuntimeOwner, reserveServiceRuntimeOwnerInTransaction, sameRuntimeOwner, serviceRuntimeRevision } from './serviceRuntimeOwner.js';
import { swarmRuntimeOf } from './swarm.js';
import type { NodeAutoscaleEvidence } from './nodeAutoscaleDecision.js';
import { AUTOSCALE_STATS_MAX_AGE_MS } from './autoscaler.js';

type Placement = { serverId: number; runtimeId: string | null };
export type NodeAutoscaleAdmission = { owner: ServiceRuntimeOwner; service: Service; targets: Placement[]; watermark: number; desiredReplicas: number; workerToken: string; measurement?: NodeAutoscaleEvidence | null };
export const NODE_AUTOSCALE_LEASE_MS = 90_000;
/** The fence identity is stable across worker lease changes and panel restarts. */
export function nodeAutoscaleFence(admission: NodeAutoscaleAdmission, serverId = admission.service.serverId!) {
  if (serverId !== admission.service.serverId && !admission.targets.some(target => target.serverId === serverId)) throw new Error('Node autoscale fence placement changed');
  return { requestId: createHash('sha256').update(`${admission.owner.requestId}:scale-fence:${serverId}`).digest('hex').slice(0, 32),
    serviceId: admission.service.id, revision: serviceRuntimeRevision(admission.owner.epoch, 0), timeoutMs: 30_000, deploymentWatermark: admission.watermark };
}
const snapshot = (s: Service) => JSON.stringify([s.type, s.orchestrator, s.slug, s.serverId, s.status, s.asleepAt,
  s.runtimeId, s.replicas, s.autoscale, s.port, s.healthCheck, s.healthPath, s.healthCommand, s.healthTimeoutSeconds,
  s.cpuShares, s.cpuLimitMilli, s.memLimitMb]);
const placements = (db: Pick<DB, 'select'>, serviceId: number) => db.select({ serverId: serviceTargets.serverId, runtimeId: serviceTargets.runtimeId })
  .from(serviceTargets).where(eq(serviceTargets.serviceId, serviceId)).orderBy(serviceTargets.id);
const validCapacity = (row: typeof nodeAutoscaleCapacity.$inferSelect | undefined, svc: Service, count: number) => {
  const deploymentId = Number(/-([1-9]\d*)$/.exec(svc.runtimeId ?? '')?.[1]);
  if (!row || row.deploymentId !== deploymentId || row.serviceId !== svc.id || row.serverId !== svc.serverId || row.runtimeId !== svc.runtimeId ||
    !/^sha256:[a-f0-9]{64}$/.test(row.imageId) || !Array.isArray(row.targets) || row.targets.length < count || row.targets.length > MAX_REPLICAS) return false;
  const names = replicaNames(row.runtimeId, row.targets.length);
  return row.targets.every((target, index) => target && target.name === names[index] && typeof target.id === 'string' && /^[a-f0-9]{64}$/.test(target.id)) &&
    new Set(row.targets.map(target => target.id)).size === names.length;
};

/** Reserve a scale owner only for the exact running generation observed by the controller. */
export async function admitNodeAutoscale(db: DB, expected: Service, desiredReplicas: number, measurement?: NodeAutoscaleEvidence,
  measuredOwner?: ServiceRuntimeOwner | null): Promise<NodeAutoscaleAdmission | null> {
  const config = autoscaleConfig.safeParse(expected.autoscale);
  if (expected.type !== 'docker' || expected.orchestrator === 'swarm' || swarmRuntimeOf(expected) ||
    !expected.serverId || expected.status !== 'running' || !expected.runtimeId || expected.asleepAt != null ||
    !config.success || !Number.isSafeInteger(expected.runtimeReplicas) || expected.runtimeReplicas < 1 || expected.runtimeReplicas > MAX_REPLICAS ||
    !Number.isSafeInteger(desiredReplicas) || desiredReplicas < config.data.minReplicas || desiredReplicas > config.data.maxReplicas ||
    desiredReplicas === expected.runtimeReplicas || canaryActive(expected.id)) return null;
  if (measurement) {
    const now = Date.now(), deploymentId = Number(/-([1-9]\d*)$/.exec(expected.runtimeId)?.[1]);
    const names = replicaNames(expected.runtimeId, expected.runtimeReplicas);
    if (measurement.serverId !== expected.serverId || measurement.serviceId !== expected.id || measurement.deploymentId !== deploymentId ||
      !Number.isSafeInteger(deploymentId) || !Number.isFinite(measurement.sampledAt) || measurement.sampledAt > now ||
      now - measurement.sampledAt > AUTOSCALE_STATS_MAX_AGE_MS || typeof measurement.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(measurement.requestId) ||
      !Array.isArray(measurement.targets) || measurement.targets.length !== names.length ||
      measurement.targets.some(target => !target || typeof target.name !== 'string' || typeof target.id !== 'string' || !/^[a-f0-9]{64}$/.test(target.id)) ||
      new Set(measurement.targets.map(target => target.id)).size !== names.length ||
      names.some(name => !measurement.targets.some(target => target.name === name))) return null;
  }
  return db.transaction(async tx => {
    const fresh = await tx.query.services.findFirst({ where: eq(services.id, expected.id) });
    if (!fresh || snapshot(fresh) !== snapshot(expected) || fresh.runtimeReplicas !== expected.runtimeReplicas || canaryActive(expected.id)) return null;
    const [active, lifecycle, primary, fanout, priorTransition] = await Promise.all([
      tx.select({ id: deployments.id }).from(deployments).where(and(eq(deployments.serviceId, fresh.id), inArray(deployments.status, ['queued', 'building', 'deploying']))).limit(1),
      tx.select({ id: nodeLifecycleIntents.id }).from(nodeLifecycleIntents).where(and(eq(nodeLifecycleIntents.serviceId, fresh.id), notInArray(nodeLifecycleIntents.phase, ['completed', 'superseded']))).limit(1),
      tx.select({ id: primaryTransitions.id }).from(primaryTransitions).where(eq(primaryTransitions.serviceId, fresh.id)).limit(1),
      tx.select({ id: fanoutTransitions.id }).from(fanoutTransitions).where(eq(fanoutTransitions.serviceId, fresh.id)).limit(1),
      tx.select({ id: nodeAutoscaleTransitions.serviceId }).from(nodeAutoscaleTransitions).where(eq(nodeAutoscaleTransitions.serviceId, fresh.id)).limit(1),
    ]);
    if (active.length || lifecycle.length || primary.length || fanout.length || priorTransition.length) return null;
    const capacityDeploymentId = Number(/-([1-9]\d*)$/.exec(fresh.runtimeId!)?.[1]);
    if (!Number.isSafeInteger(capacityDeploymentId) || capacityDeploymentId < 1) return null;
    const capacity = await tx.query.nodeAutoscaleCapacity.findFirst({ where: eq(nodeAutoscaleCapacity.deploymentId, capacityDeploymentId) });
    if (!validCapacity(capacity, fresh, Math.max(fresh.runtimeReplicas, desiredReplicas))) return null;
    const targets = await placements(tx, fresh.id);
    if (targets.some(t => !t.runtimeId || t.serverId === fresh.serverId) || new Set(targets.map(t => t.serverId)).size !== targets.length) return null;
    const [sequence] = await tx.select({ id: sql<number>`COALESCE((SELECT seq FROM sqlite_sequence WHERE name='deployments'), 0)` })
      .from(services).where(eq(services.id, fresh.id)).limit(1);
    const generations = [fresh.runtimeId!, ...targets.map(target => target.runtimeId!)].map(name => Number(/-([1-9]\d*)$/.exec(name)?.[1]));
    if (generations.some(id => !Number.isSafeInteger(id) || id < 1)) return null;
    const watermark = Math.max(Number(sequence?.id ?? 0), ...generations);
    if (!Number.isSafeInteger(watermark) || watermark < 1) return null;
    if (measurement && (measurement.sampledAt > Date.now() || Date.now() - measurement.sampledAt > AUTOSCALE_STATS_MAX_AGE_MS)) return null;
    const prior = await readServiceRuntimeOwner(tx, fresh.id);
    if (measuredOwner !== undefined && !sameRuntimeOwner(prior, measuredOwner)) return null;
    if (canaryActive(expected.id)) return null;
    const owner = await reserveServiceRuntimeOwnerInTransaction(tx, fresh.id, 'scale', randomBytes(16).toString('hex'), prior);
    if (canaryActive(expected.id)) throw new Error('Node autoscale admission interrupted by active canary');
    const workerToken = randomBytes(16).toString('hex');
    await tx.insert(nodeAutoscaleTransitions).values({ serviceId: fresh.id, ownerEpoch: owner.epoch, requestId: owner.requestId!,
      serverId: fresh.serverId!, runtimeId: fresh.runtimeId!, fromReplicas: fresh.runtimeReplicas, toReplicas: desiredReplicas,
      watermark, configuration: snapshot(fresh), workerToken, leaseUntil: new Date(Date.now() + NODE_AUTOSCALE_LEASE_MS),
      targets: targets.map(t => ({ serverId: t.serverId, runtimeId: t.runtimeId! })), measurement: measurement ?? null });
    if (canaryActive(expected.id)) throw new Error('Node autoscale admission interrupted by active canary');
    return { owner, service: fresh, targets, watermark, desiredReplicas, workerToken, measurement: measurement ?? null };
  });
}

async function assertCurrent(tx: Pick<DB, 'query' | 'select'>, admission: NodeAutoscaleAdmission, expectedReplicas: number): Promise<void> {
    const fresh = await tx.query.services.findFirst({ where: eq(services.id, admission.service.id) });
    const config = autoscaleConfig.safeParse(admission.service.autoscale);
    if (!config.success || !Number.isSafeInteger(admission.desiredReplicas) || admission.desiredReplicas < config.data.minReplicas ||
      admission.desiredReplicas > config.data.maxReplicas) throw new Error('Node autoscale desired count is outside configured bounds');
    if (!fresh || admission.owner.kind !== 'scale' || snapshot(fresh) !== snapshot(admission.service) || fresh.runtimeReplicas !== expectedReplicas ||
      !sameRuntimeOwner(await readServiceRuntimeOwner(tx, fresh.id), admission.owner) ||
      JSON.stringify(await placements(tx, fresh.id)) !== JSON.stringify(admission.targets)) throw new Error('Node autoscale ownership, runtime or placement changed');
    const [transition] = await tx.select().from(nodeAutoscaleTransitions).where(eq(nodeAutoscaleTransitions.serviceId, fresh.id)).limit(1);
    if (transition && (!/^[a-f0-9]{32}$/.test(admission.workerToken) || transition.workerToken !== admission.workerToken ||
      !transition.leaseUntil || transition.leaseUntil.getTime() <= Date.now())) throw new Error('Node autoscale worker lease changed or expired');
    if (!transition || !['accepted', 'prepared', 'started', 'ready', 'routing', 'draining', 'stopping'].includes(transition.phase) || transition.ownerEpoch !== admission.owner.epoch || transition.requestId !== admission.owner.requestId ||
      transition.serverId !== fresh.serverId || transition.runtimeId !== fresh.runtimeId || transition.fromReplicas !== admission.service.runtimeReplicas ||
      transition.toReplicas !== admission.desiredReplicas || transition.watermark !== admission.watermark || transition.configuration !== snapshot(admission.service) ||
      JSON.stringify(transition.targets) !== JSON.stringify(admission.targets) ||
      JSON.stringify(transition.measurement) !== JSON.stringify(admission.measurement ?? null)) throw new Error('Node autoscale transition changed');
    const capacity = await tx.query.nodeAutoscaleCapacity.findFirst({ where: eq(nodeAutoscaleCapacity.deploymentId, Number(/-([1-9]\d*)$/.exec(fresh.runtimeId!)?.[1])) });
    if (!validCapacity(capacity, fresh, Math.max(admission.service.runtimeReplicas, admission.desiredReplicas)) ||
      transition.replicaInventory?.some(item => !capacity!.targets.some(target => target.name === item.name && target.id === item.id))) {
      throw new Error('Node autoscale capacity identity changed');
    }
    const [active, lifecycle, primary, fanout] = await Promise.all([
      tx.select({ id: deployments.id }).from(deployments).where(and(eq(deployments.serviceId, fresh.id), inArray(deployments.status, ['queued', 'building', 'deploying']))).limit(1),
      tx.select({ id: nodeLifecycleIntents.id }).from(nodeLifecycleIntents).where(and(eq(nodeLifecycleIntents.serviceId, fresh.id), notInArray(nodeLifecycleIntents.phase, ['completed', 'superseded']))).limit(1),
      tx.select({ id: primaryTransitions.id }).from(primaryTransitions).where(eq(primaryTransitions.serviceId, fresh.id)).limit(1),
      tx.select({ id: fanoutTransitions.id }).from(fanoutTransitions).where(eq(fanoutTransitions.serviceId, fresh.id)).limit(1),
    ]);
    if (active.length || lifecycle.length || primary.length || fanout.length) throw new Error('Node autoscale blocked by active runtime work');
    if (canaryActive(fresh.id)) throw new Error('Node autoscale blocked by active canary');
}

/** Reconstruct a recorded decision only while its original runtime authority is still current. */
export async function recoverNodeAutoscaleAdmission(db: DB, serviceId: number): Promise<NodeAutoscaleAdmission | null> {
  return db.transaction(async tx => {
    const now = new Date(), workerToken = randomBytes(16).toString('hex');
    const [transition] = await tx.update(nodeAutoscaleTransitions).set({ workerToken, leaseUntil: new Date(now.getTime() + NODE_AUTOSCALE_LEASE_MS) })
      .where(and(eq(nodeAutoscaleTransitions.serviceId, serviceId), or(isNull(nodeAutoscaleTransitions.leaseUntil), lte(nodeAutoscaleTransitions.leaseUntil, now)))).returning();
    if (!transition) return null;
    const service = await tx.query.services.findFirst({ where: eq(services.id, serviceId) });
    const owner = await readServiceRuntimeOwner(tx, serviceId);
    if (!service || !owner || transition.configuration !== snapshot(service) ||
      (service.runtimeReplicas !== transition.fromReplicas && service.runtimeReplicas !== transition.toReplicas)) {
      throw new Error('Node autoscale recovery configuration or count changed');
    }
    const admission: NodeAutoscaleAdmission = { owner, service: { ...service, runtimeReplicas: transition.fromReplicas },
      targets: transition.targets, watermark: transition.watermark, desiredReplicas: transition.toReplicas, workerToken, measurement: transition.measurement };
    await assertCurrent(tx, admission, service.runtimeReplicas);
    return admission;
  });
}

/** Recheck ownership, placement and serving count around every awaited scale effect. */
export async function checkpointNodeAutoscale(db: DB, admission: NodeAutoscaleAdmission, expectedReplicas: number): Promise<void> {
  await db.transaction(async tx => {
    await assertCurrent(tx, admission, expectedReplicas);
    await tx.update(nodeAutoscaleTransitions).set({ leaseUntil: new Date(Date.now() + NODE_AUTOSCALE_LEASE_MS) })
      .where(and(eq(nodeAutoscaleTransitions.serviceId, admission.service.id), eq(nodeAutoscaleTransitions.workerToken, admission.workerToken)));
  });
}

/** An accepted transition has not started containers or published routing; expired evidence can be discarded. */
export async function discardExpiredNodeAutoscale(db: DB, admission: NodeAutoscaleAdmission): Promise<boolean> {
  return db.transaction(async tx => {
    const [transition] = await tx.select().from(nodeAutoscaleTransitions).where(eq(nodeAutoscaleTransitions.serviceId, admission.service.id)).limit(1);
    if (!transition || transition.phase !== 'accepted' || !admission.measurement) return false;
    const now = Date.now();
    if (admission.measurement.sampledAt <= now && now - admission.measurement.sampledAt <= AUTOSCALE_STATS_MAX_AGE_MS) return false;
    await assertCurrent(tx, admission, admission.service.runtimeReplicas);
    const deleted = await tx.delete(nodeAutoscaleTransitions).where(and(eq(nodeAutoscaleTransitions.serviceId, admission.service.id),
      eq(nodeAutoscaleTransitions.workerToken, admission.workerToken), eq(nodeAutoscaleTransitions.phase, 'accepted'))).returning({ id: nodeAutoscaleTransitions.serviceId });
    if (deleted.length !== 1) throw new Error('Node autoscale expired transition changed');
    return true;
  });
}

/** Freeze primary replica identities before any scale effect; retries cannot replace a target. */
export async function freezeNodeAutoscaleInventory(db: DB, admission: NodeAutoscaleAdmission, evidence: unknown): Promise<void> {
  const receipt = containerInventoryReply.parse(evidence), fence = nodeAutoscaleFence(admission);
  if (receipt.requestId !== fence.requestId || receipt.serviceId !== fence.serviceId || receipt.revision !== fence.revision ||
    receipt.deploymentWatermark !== fence.deploymentWatermark) throw new Error('Node autoscale inventory fence changed');
  const runtimeId = admission.service.runtimeId;
  const deploymentId = Number(/-([1-9]\d*)$/.exec(runtimeId ?? '')?.[1]);
  if (!runtimeId || !Number.isSafeInteger(deploymentId) || deploymentId < 1) throw new Error('Node autoscale generation is unconfirmed');
  const from = admission.service.runtimeReplicas, names = replicaNames(runtimeId, Math.max(from, admission.desiredReplicas));
  const knownNames = replicaNames(runtimeId, MAX_REPLICAS);
  const known = receipt.items.filter(item => knownNames.includes(item.name));
  if (known.some(item => item.deploymentId !== deploymentId || item.running !== (knownNames.indexOf(item.name) < from))) {
    throw new Error('Node autoscale inventory state or generation changed');
  }
  const selected = names.map(name => known.find(item => item.name === name));
  if (selected.some(item => !item)) throw new Error('Node autoscale inventory is incomplete');
  if (admission.measurement && admission.measurement.targets.some(target => !selected.some(item => item?.name === target.name && item.id === target.id && item.running))) {
    throw new Error('Node autoscale measured replica identity changed');
  }
  await db.transaction(async tx => {
    await assertCurrent(tx, admission, from);
    const [transition] = await tx.select().from(nodeAutoscaleTransitions).where(eq(nodeAutoscaleTransitions.serviceId, admission.service.id)).limit(1);
    if (!transition) throw new Error('Node autoscale transition changed');
    if (transition.phase !== 'accepted') throw new Error('Node autoscale inventory phase changed');
    const capacity = await tx.query.nodeAutoscaleCapacity.findFirst({ where: eq(nodeAutoscaleCapacity.deploymentId, deploymentId) });
    if (!validCapacity(capacity, admission.service, names.length) || selected.some(item => !capacity!.targets.some(target => target.name === item?.name && target.id === item?.id))) {
      throw new Error('Node autoscale capacity identity changed');
    }
    if (admission.measurement && (admission.measurement.sampledAt > Date.now() || Date.now() - admission.measurement.sampledAt > AUTOSCALE_STATS_MAX_AGE_MS)) {
      throw new Error('Node autoscale measurement expired before inventory freeze');
    }
    if (transition.replicaInventory !== null && JSON.stringify(transition.replicaInventory) !== JSON.stringify(selected)) throw new Error('Node autoscale inventory changed');
    if (transition.replicaInventory === null) await tx.update(nodeAutoscaleTransitions).set({ replicaInventory: selected as NonNullable<typeof transition.replicaInventory> })
      .where(and(eq(nodeAutoscaleTransitions.serviceId, admission.service.id), eq(nodeAutoscaleTransitions.workerToken, admission.workerToken), isNull(nodeAutoscaleTransitions.replicaInventory)));
  });
}

export type NodeAutoscalePhase = 'accepted' | 'prepared' | 'started' | 'ready' | 'routing' | 'draining' | 'stopping';
/** Each phase change is fenced by the same worker, service owner, generation and expected serving count. */
export async function advanceNodeAutoscale(db: DB, admission: NodeAutoscaleAdmission, expected: NodeAutoscalePhase,
  next: NodeAutoscalePhase | 'completed'): Promise<void> {
  const up = admission.desiredReplicas > admission.service.runtimeReplicas;
  const order: Array<NodeAutoscalePhase | 'completed'> = up
    ? ['accepted', 'prepared', 'started', 'ready', 'routing', 'completed']
    : ['accepted', 'prepared', 'routing', 'draining', 'stopping', 'completed'];
  if (order.indexOf(next) !== order.indexOf(expected) + 1 || order.indexOf(expected) < 0) throw new Error('Invalid node autoscale phase transition');
  const publishing = next === 'routing', serving = expected === 'routing' || expected === 'draining' || expected === 'stopping'
    ? admission.desiredReplicas : admission.service.runtimeReplicas;
  await db.transaction(async tx => {
    await assertCurrent(tx, admission, serving);
    const [transition] = await tx.select().from(nodeAutoscaleTransitions).where(eq(nodeAutoscaleTransitions.serviceId, admission.service.id)).limit(1);
    if (!transition || transition.phase !== expected || !transition.replicaInventory) throw new Error('Node autoscale phase or inventory changed');
    if (publishing) {
      const [updated] = await tx.update(services).set({ runtimeReplicas: admission.desiredReplicas }).where(and(eq(services.id, admission.service.id), eq(services.runtimeReplicas, serving))).returning();
      if (!updated) throw new Error('Node autoscale replica count changed');
    }
    if (next === 'completed') await tx.delete(nodeAutoscaleTransitions).where(and(eq(nodeAutoscaleTransitions.serviceId, admission.service.id), eq(nodeAutoscaleTransitions.workerToken, admission.workerToken), eq(nodeAutoscaleTransitions.phase, expected)));
    else await tx.update(nodeAutoscaleTransitions).set({ phase: next }).where(and(eq(nodeAutoscaleTransitions.serviceId, admission.service.id), eq(nodeAutoscaleTransitions.workerToken, admission.workerToken), eq(nodeAutoscaleTransitions.phase, expected)));
  });
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
