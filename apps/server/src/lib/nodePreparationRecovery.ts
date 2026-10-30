import { createHash } from 'node:crypto';
import { and, eq, nodeDeploymentPreparations, nodeLifecycleIntents, primaryTransitions, fanoutTransitions, serviceTargets,
  deployments, services, sql, type DB, type DeploymentRuntimeOwner } from '@ninedeploy/db';
import { inArray } from 'drizzle-orm';
import { createNodeDeploymentAuthority } from './nodeDeploymentOwner.js';
import { readNodeDeploymentPreparation } from './nodeDeploymentPreparation.js';
import { createNodeRuntimeMutationClient } from './nodeRuntimeMutationClient.js';
import { serviceRuntimeRevision } from './serviceRuntimeOwner.js';

/** Retire only a failed, completely receipted candidate that never reached primary recovery. */
export async function recoverPreparedNodeCandidate(db: DB, owner: DeploymentRuntimeOwner, options: { signal?: AbortSignal } = {}) {
  const authority = createNodeDeploymentAuthority(db, owner);
  const initial = await readNodeDeploymentPreparation(db, owner);
  if (!initial || !['prepared', 'retiring'].includes(initial.phase) || !initial.targets) throw new Error('Prepared node candidate receipt unavailable');
  const targets = initial.targets.map(item => ({ ...item, deploymentId: owner.deploymentId }));
  const stable = JSON.stringify(initial.targets);
  const checkpoint = async () => {
    options.signal?.throwIfAborted(); await authority.check();
    const row = await readNodeDeploymentPreparation(db, owner);
    const [service, deployment, primary, fanout, lifecycle, target] = await Promise.all([
      db.query.services.findFirst({ where: eq(services.id, owner.serviceId) }),
      db.query.deployments.findFirst({ where: eq(deployments.id, owner.deploymentId) }),
      db.query.primaryTransitions.findFirst({ where: eq(primaryTransitions.serviceId, owner.serviceId) }),
      db.query.fanoutTransitions.findFirst({ where: eq(fanoutTransitions.serviceId, owner.serviceId) }),
      db.query.nodeLifecycleIntents.findFirst({ where: and(eq(nodeLifecycleIntents.serviceId, owner.serviceId), inArray(nodeLifecycleIntents.phase, ['fencing', 'preparing', 'routing', 'applying', 'starting', 'warming', 'publishing', 'readiness'])) }),
      db.query.serviceTargets.findFirst({ where: and(eq(serviceTargets.serviceId, owner.serviceId), eq(serviceTargets.runtimeId, initial.runtimeId)) }),
    ]);
    if (!service || service.runtimeId === initial.runtimeId || !deployment || deployment.serviceId !== owner.serviceId ||
      !['failed', 'cancelled'].includes(deployment.status) || !row || !['prepared', 'retiring'].includes(row.phase) || JSON.stringify(row.targets) !== stable ||
      row.runtimeId !== initial.runtimeId || row.imageId !== initial.imageId || primary || fanout || lifecycle || target) {
      throw new Error('Node preparation recovery ownership or routing is unconfirmed');
    }
    await authority.check(); options.signal?.throwIfAborted();
  };
  await checkpoint();
  const client = createNodeRuntimeMutationClient(db, owner.serverId, { checkpoint, signal: options.signal });
  const requestId = (stage: string) => createHash('sha256').update(`${owner.requestId}:preparation-recovery:${stage}`).digest('hex').slice(0, 32);
  if (initial.phase === 'prepared') {
    const [sequence] = await db.select({ id: sql<number>`COALESCE((SELECT seq FROM sqlite_sequence WHERE name='deployments'), 0)` })
      .from(services).where(eq(services.id, owner.serviceId)).limit(1);
    const watermark = Number(sequence?.id);
    if (!Number.isSafeInteger(watermark) || watermark < owner.deploymentId) throw new Error('Node preparation recovery watermark unavailable');
    const fence = { requestId: requestId('fence'), serviceId: owner.serviceId, revision: serviceRuntimeRevision(owner.epoch, 2), timeoutMs: 30_000, deploymentWatermark: watermark };
    await client.fence(fence);
    const inventory = await client.inventory({ ...fence, expectedNames: targets.map(item => item.name) });
    const candidates = inventory.items.filter(item => item.deploymentId === owner.deploymentId || targets.some(target => target.name === item.name || target.id === item.id));
    if (candidates.some(item => !targets.some(target => target.id === item.id && target.name === item.name && target.deploymentId === item.deploymentId))) {
      throw new Error('Node preparation recovery identity changed');
    }
    await checkpoint();
    const marked = await db.update(nodeDeploymentPreparations).set({ phase: 'retiring' }).where(and(eq(nodeDeploymentPreparations.deploymentId, owner.deploymentId),
      eq(nodeDeploymentPreparations.phase, 'prepared'), sql`${nodeDeploymentPreparations.targets} = ${stable}`, authority.fence(),
      sql`EXISTS (SELECT 1 FROM deployments d JOIN services s ON s.id = d.service_id WHERE d.id = ${owner.deploymentId} AND d.service_id = ${owner.serviceId} AND d.status IN ('failed','cancelled') AND (s.runtime_id IS NULL OR s.runtime_id <> ${initial.runtimeId}))`,
      sql`NOT EXISTS (SELECT 1 FROM primary_transitions p WHERE p.service_id = ${owner.serviceId})`,
      sql`NOT EXISTS (SELECT 1 FROM fanout_transitions f WHERE f.service_id = ${owner.serviceId})`,
      sql`NOT EXISTS (SELECT 1 FROM node_lifecycle_intents n WHERE n.service_id = ${owner.serviceId} AND n.phase NOT IN ('completed','superseded'))`,
      sql`NOT EXISTS (SELECT 1 FROM service_targets t WHERE t.service_id = ${owner.serviceId} AND t.runtime_id = ${initial.runtimeId})`)).returning({ id: nodeDeploymentPreparations.deploymentId });
    if (marked.length !== 1) throw new Error('Node preparation recovery changed before retirement');
  }
  await client.retire({ requestId: requestId('retire'), serviceId: owner.serviceId, revision: serviceRuntimeRevision(owner.epoch, 3),
    timeoutMs: 60_000, graceSeconds: 10, targets });
  await checkpoint();
  return db.transaction(async tx => {
    const removed = await tx.delete(nodeDeploymentPreparations).where(and(eq(nodeDeploymentPreparations.deploymentId, owner.deploymentId),
      eq(nodeDeploymentPreparations.serviceId, owner.serviceId), eq(nodeDeploymentPreparations.serverId, owner.serverId),
      eq(nodeDeploymentPreparations.epoch, owner.epoch), eq(nodeDeploymentPreparations.requestId, owner.requestId),
      eq(nodeDeploymentPreparations.phase, 'retiring'), sql`${nodeDeploymentPreparations.targets} = ${stable}`, authority.fence(),
      sql`EXISTS (SELECT 1 FROM deployments d JOIN services s ON s.id = d.service_id WHERE d.id = ${owner.deploymentId} AND d.service_id = ${owner.serviceId} AND d.status IN ('failed','cancelled') AND (s.runtime_id IS NULL OR s.runtime_id <> ${initial.runtimeId}))`,
      sql`NOT EXISTS (SELECT 1 FROM primary_transitions p WHERE p.service_id = ${owner.serviceId})`,
      sql`NOT EXISTS (SELECT 1 FROM fanout_transitions f WHERE f.service_id = ${owner.serviceId})`,
      sql`NOT EXISTS (SELECT 1 FROM node_lifecycle_intents n WHERE n.service_id = ${owner.serviceId} AND n.phase NOT IN ('completed','superseded'))`,
      sql`NOT EXISTS (SELECT 1 FROM service_targets t WHERE t.service_id = ${owner.serviceId} AND t.runtime_id = ${initial.runtimeId})`)).returning({ id: nodeDeploymentPreparations.deploymentId });
    if (removed.length !== 1) throw new Error('Node preparation recovery changed before settlement');
    return { deploymentId: owner.deploymentId, retired: targets.length };
  });
}
