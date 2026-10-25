import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import { deployments, nodeLifecycleIntents, primaryTransitions, services, type DB, type NodeLifecycleIntent, type Service } from '@ninedeploy/db';
import { HttpError } from './errors.js';
import { runtimeReplicaCounts } from './runtimeReplicaCounts.js';

const terminal = ['completed', 'superseded'] as const;
export const NODE_LIFECYCLE_LEASE_MS = 90_000;
const changed = () => new HttpError(409, 'node_lifecycle_superseded', 'The service or node lifecycle owner changed');
const configuration = (s: Service) => JSON.stringify([s.type, s.orchestrator, s.runtimeId, s.serverId, s.port,
  s.healthCheck, s.healthPath, s.healthCommand, s.healthTimeoutSeconds, s.runtimeReplicas, s.replicas, s.autoscale, s.sleepAfterMinutes]);

/** Reserve a fence, an effect and a restart's Start revision per durable command. */
export function nodeLifecycleRevision(id: number, phase: 'fence' | 'effect' | 'restart-start'): number {
  if (!Number.isSafeInteger(id) || id < 1 || id > (Number.MAX_SAFE_INTEGER - 3) / 4) throw new Error('Node lifecycle revision capacity exceeded');
  return id * 4 + (phase === 'effect' ? 1 : phase === 'restart-start' ? 2 : 0);
}

export async function acceptNodeLifecycleIntent(db: DB, service: Service, action: 'start' | 'stop' | 'restart', options: { automatic?: boolean } = {}): Promise<NodeLifecycleIntent> {
  if (service.type !== 'docker' || service.orchestrator === 'swarm' || service.serverId == null || !service.runtimeId) {
    throw new HttpError(422, 'node_lifecycle_unsupported', 'Ordered node lifecycle requires a plain Docker runtime on a node');
  }
  const deploymentId = Number(/-([1-9]\d*)$/.exec(service.runtimeId)?.[1]);
  if (!Number.isSafeInteger(deploymentId) || deploymentId < 1) throw new HttpError(422, 'node_lifecycle_identity_unknown', 'Redeploy this service to establish a managed runtime identity');
  return db.transaction(async tx => {
    const fresh = await tx.query.services.findFirst({ where: eq(services.id, service.id) });
    if (!fresh || fresh.type !== 'docker' || fresh.orchestrator === 'swarm' || fresh.runtimeId !== service.runtimeId || fresh.serverId !== service.serverId ||
      action !== 'stop' && (configuration(fresh) !== configuration(service) || fresh.status !== service.status)) throw changed();
    if (options.automatic) {
      if (action !== 'start' || fresh.status !== 'running') throw changed();
      const pending = await tx.query.nodeLifecycleIntents.findFirst({ where: and(eq(nodeLifecycleIntents.serviceId, service.id), notInArray(nodeLifecycleIntents.phase, [...terminal])) });
      if (pending) return pending;
    }
    if (action !== 'stop') {
      const active = await tx.select({ id: deployments.id }).from(deployments).where(and(eq(deployments.serviceId, service.id), inArray(deployments.status, ['queued', 'building', 'deploying']))).limit(1);
      const recovering = await tx.select({ id: primaryTransitions.id }).from(primaryTransitions).where(eq(primaryTransitions.serviceId, service.id)).limit(1);
      if (active.length || recovering.length) throw new HttpError(409, 'node_lifecycle_deployment_busy', 'Wait for the current deployment or recovery before starting this runtime');
    }
    await tx.update(nodeLifecycleIntents).set({ phase: 'superseded', ownerToken: null, leaseUntil: null, completedAt: new Date() })
      .where(and(eq(nodeLifecycleIntents.serviceId, service.id), notInArray(nodeLifecycleIntents.phase, [...terminal])));
    const shape = runtimeReplicaCounts(fresh);
    const acceptedAt = new Date();
    const [intent] = await tx.insert(nodeLifecycleIntents).values({ serviceId: fresh.id, serverId: fresh.serverId!, runtimeId: fresh.runtimeId!, deploymentId,
      action, requestId: randomBytes(16).toString('hex'), phase: action !== 'start' ? 'fencing' : 'preparing',
      nextAttemptAt: acceptedAt, createdAt: acceptedAt, updatedAt: acceptedAt,
      snapshot: { status: fresh.status, port: fresh.port, healthCheck: fresh.healthCheck, healthPath: fresh.healthPath, healthCommand: fresh.healthCommand,
        healthTimeoutS: fresh.healthTimeoutSeconds, serving: shape.serving, capacity: shape.capacity, configuration: configuration(fresh) } }).returning();
    nodeLifecycleRevision(intent!.id, 'effect');
    if (action !== 'start') {
      await tx.update(services).set({ status: 'stopped', asleepAt: null }).where(eq(services.id, service.id));
      await tx.update(deployments).set({ status: 'cancelled', finishedAt: new Date() })
        .where(and(eq(deployments.serviceId, service.id), inArray(deployments.status, ['queued', 'building', 'deploying'])));
    }
    return intent!;
  });
}

export async function claimNodeLifecycleIntent(db: DB, id: number, now = Date.now()): Promise<NodeLifecycleIntent | null> {
  const [row] = await db.update(nodeLifecycleIntents).set({ ownerToken: randomBytes(16).toString('hex'), leaseUntil: new Date(now + NODE_LIFECYCLE_LEASE_MS),
    attempts: sql`${nodeLifecycleIntents.attempts} + 1` }).where(and(eq(nodeLifecycleIntents.id, id), notInArray(nodeLifecycleIntents.phase, [...terminal]),
    lte(nodeLifecycleIntents.nextAttemptAt, new Date(now)), or(isNull(nodeLifecycleIntents.leaseUntil), lte(nodeLifecycleIntents.leaseUntil, new Date(now))))).returning();
  return row ?? null;
}

async function owned(db: Pick<DB, 'query' | 'select'>, intent: NodeLifecycleIntent, now: number) {
  const fresh = await db.query.nodeLifecycleIntents.findFirst({ where: eq(nodeLifecycleIntents.id, intent.id) });
  if (!intent.ownerToken || !fresh || fresh.ownerToken !== intent.ownerToken || !fresh.leaseUntil ||
    terminal.includes(fresh.phase as typeof terminal[number])) throw changed();
  if (fresh.leaseUntil.getTime() <= now) throw new HttpError(409, 'node_lifecycle_lease_expired', 'The node lifecycle lease expired; unfinished work must be retried');
  const latest = await db.select({ id: nodeLifecycleIntents.id }).from(nodeLifecycleIntents).where(eq(nodeLifecycleIntents.serviceId, fresh.serviceId))
    .orderBy(desc(nodeLifecycleIntents.id)).limit(1);
  const service = await db.query.services.findFirst({ where: eq(services.id, fresh.serviceId) });
  if (latest[0]?.id !== intent.id || !service || service.type !== 'docker' || service.orchestrator === 'swarm' || service.runtimeId !== fresh.runtimeId || service.serverId !== fresh.serverId ||
    fresh.action === 'stop' && service.status !== 'stopped' || fresh.action !== 'stop' && (configuration(service) !== fresh.snapshot.configuration ||
      service.status !== (fresh.action === 'restart' ? fresh.phase === 'publishing' ? 'deploying' : 'stopped' : fresh.phase === 'routing' ? 'deploying' : fresh.snapshot.status))) throw changed();
  if (fresh.action !== 'stop') {
    const deploying = await db.select({ id: deployments.id }).from(deployments).where(and(eq(deployments.serviceId, service.id), inArray(deployments.status, ['queued', 'building', 'deploying']))).limit(1);
    const recovering = await db.select({ id: primaryTransitions.id }).from(primaryTransitions).where(eq(primaryTransitions.serviceId, service.id)).limit(1);
    if (deploying.length || recovering.length) throw changed();
  }
  return { fresh, service };
}

/** Explicit retries preserve the original request and cannot steal a live owner. */
export async function retryNodeLifecycleIntent(db: DB, service: Service): Promise<NodeLifecycleIntent> {
  return db.transaction(async tx => {
    const row = await tx.query.nodeLifecycleIntents.findFirst({ where: eq(nodeLifecycleIntents.serviceId, service.id), orderBy: desc(nodeLifecycleIntents.id) });
    const fresh = await tx.query.services.findFirst({ where: eq(services.id, service.id) });
    if (!row || !fresh || fresh.type !== 'docker' || fresh.orchestrator === 'swarm' || fresh.serverId !== row.serverId || fresh.runtimeId !== row.runtimeId ||
      terminal.includes(row.phase as typeof terminal[number])) throw changed();
    if (row.leaseUntil && row.leaseUntil.getTime() > Date.now()) throw new HttpError(409, 'node_lifecycle_busy', 'This node lifecycle command still has an active owner');
    const [updated] = await tx.update(nodeLifecycleIntents).set({ ownerToken: null, leaseUntil: null, reason: null, nextAttemptAt: new Date() })
      .where(eq(nodeLifecycleIntents.id, row.id)).returning();
    return updated!;
  });
}

/** Revalidate and renew ownership around each bounded asynchronous boundary. */
export async function checkpointNodeLifecycleIntent(db: DB, intent: NodeLifecycleIntent, now = Date.now()) {
  return db.transaction(async tx => {
    const current = await owned(tx, intent, now);
    const [renewed] = await tx.update(nodeLifecycleIntents).set({ leaseUntil: new Date(now + NODE_LIFECYCLE_LEASE_MS) })
      .where(and(eq(nodeLifecycleIntents.id, intent.id), eq(nodeLifecycleIntents.ownerToken, intent.ownerToken!))).returning();
    return { intent: renewed!, service: current.service };
  });
}

export async function advanceNodeLifecycleIntent(db: DB, intent: NodeLifecycleIntent, phase: NodeLifecycleIntent['phase'],
  patch: { targets?: NodeLifecycleIntent['targets']; serviceStatus?: 'deploying' | 'running' } = {}, now = Date.now()): Promise<NodeLifecycleIntent> {
  return db.transaction(async tx => {
    const { fresh } = await owned(tx, intent, now);
    if (fresh.phase !== intent.phase) throw changed();
    const order: NodeLifecycleIntent['phase'][] = fresh.action === 'restart' ? ['fencing', 'preparing', 'routing', 'applying', 'starting', 'warming', 'publishing', 'completed']
      : fresh.action === 'start' ? ['preparing', 'applying', 'readiness', 'routing', 'completed'] : ['fencing', 'preparing', 'routing', 'applying', 'completed'];
    if (order.indexOf(phase) !== order.indexOf(fresh.phase) + 1) throw new Error('Invalid node lifecycle phase transition');
    if (patch.targets !== undefined && fresh.targets !== null && JSON.stringify(fresh.targets) !== JSON.stringify(patch.targets)) throw new Error('Node lifecycle target intent changed');
    const publication = fresh.action === 'restart' ? 'publishing' : 'routing';
    if (patch.serviceStatus && (fresh.action === 'stop' || (phase === publication ? patch.serviceStatus !== 'deploying' : phase !== 'completed' || patch.serviceStatus !== 'running'))) throw new Error('Invalid node lifecycle publication phase');
    if (patch.serviceStatus) await tx.update(services).set({ status: patch.serviceStatus, asleepAt: null }).where(eq(services.id, fresh.serviceId));
    const done = phase === 'completed';
    const [row] = await tx.update(nodeLifecycleIntents).set({ phase, ...(patch.targets !== undefined ? { targets: patch.targets } : {}), reason: null,
      ownerToken: done ? null : fresh.ownerToken, leaseUntil: done ? null : new Date(now + NODE_LIFECYCLE_LEASE_MS), ...(done ? { completedAt: new Date(now) } : {}) })
      .where(and(eq(nodeLifecycleIntents.id, fresh.id), eq(nodeLifecycleIntents.ownerToken, fresh.ownerToken!))).returning();
    return row!;
  });
}

export async function holdNodeLifecycleIntent(db: DB, intent: NodeLifecycleIntent, error: unknown, now = Date.now()): Promise<void> {
  await db.update(nodeLifecycleIntents).set({ ownerToken: null, leaseUntil: null, reason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    nextAttemptAt: new Date(now + Math.min(3600, 60 * 2 ** Math.min(intent.attempts, 6)) * 1000) })
    .where(and(eq(nodeLifecycleIntents.id, intent.id), eq(nodeLifecycleIntents.ownerToken, intent.ownerToken ?? ''), notInArray(nodeLifecycleIntents.phase, [...terminal])));
}

/** A stale callback may close its own abandoned command, never another lease. */
export async function supersedeNodeLifecycleIntent(db: DB, intent: NodeLifecycleIntent): Promise<void> {
  await db.update(nodeLifecycleIntents).set({ phase: 'superseded', ownerToken: null, leaseUntil: null, completedAt: new Date() })
    .where(and(eq(nodeLifecycleIntents.id, intent.id), eq(nodeLifecycleIntents.ownerToken, intent.ownerToken ?? ''), notInArray(nodeLifecycleIntents.phase, [...terminal])));
}

/** Keep pending commands and each service's latest receipt; expire older terminal history after 30 days. */
export async function pruneNodeLifecycleHistory(db: DB, now = Date.now()): Promise<Array<{ id: number }>> {
  return db.delete(nodeLifecycleIntents).where(and(inArray(nodeLifecycleIntents.phase, [...terminal]),
    isNull(nodeLifecycleIntents.ownerToken), isNull(nodeLifecycleIntents.leaseUntil), lt(nodeLifecycleIntents.completedAt, new Date(now - 30 * 86_400_000)),
    sql`${nodeLifecycleIntents.id} < (SELECT max(later.id) FROM node_lifecycle_intents AS later WHERE later.service_id = ${nodeLifecycleIntents.serviceId})`,
  )).returning({ id: nodeLifecycleIntents.id });
}
