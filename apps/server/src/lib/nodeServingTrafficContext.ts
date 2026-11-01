import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { deployments, fanoutTransitions, nodeAutoscaleCapacity, nodeAutoscaleTransitions, nodeDeploymentPreparations,
  nodeLifecycleIntents, primaryTransitions, services, serviceTargets, type DB } from '@ninedeploy/db';
import type { ServingTrafficOpen } from '@ninedeploy/schemas';
import { canaryActive } from '../engine/canaryState.js';
import { replicaNames } from '../engine/dockerNames.js';
import { renderDynamicConfig } from '../engine/proxy.js';
import { validNodeAutoscaleDatabaseNetworks } from './nodeAutoscaleAuthority.js';
import { readServiceRuntimeOwner } from './serviceRuntimeOwner.js';
import { proxyTrafficUnavailable } from './proxyTrafficCounter.js';
import { servingTrafficRoutesMatch } from './servingTrafficRouting.js';

/** Read-only eligibility: observations never acquire runtime mutation authority. */
export async function nodeServingTrafficContext(db: DB, input: ServingTrafficOpen): Promise<string> {
  const read = () => db.transaction(async tx => {
    const svc = await tx.query.services.findFirst({ where: eq(services.id, input.serviceId) });
    const deployment = await tx.query.deployments.findFirst({ where: eq(deployments.id, input.deploymentId) });
    const capacity = await tx.query.nodeAutoscaleCapacity.findFirst({ where: eq(nodeAutoscaleCapacity.deploymentId, input.deploymentId) });
    const unavailable = () => proxyTrafficUnavailable('serving placement, ownership or capacity changed');
    if (!svc || svc.type !== 'docker' || svc.orchestrator === 'swarm' || svc.serverId !== input.nodeId || svc.slug !== input.slug ||
      svc.status !== 'running' || svc.asleepAt != null || svc.runtimeId !== `${input.slug}-${input.deploymentId}` ||
      svc.runtimeReplicas !== input.serving.length || !deployment || deployment.serviceId !== svc.id || deployment.status !== 'running' ||
      !capacity || capacity.serviceId !== svc.id || capacity.serverId !== svc.serverId || capacity.runtimeId !== svc.runtimeId ||
      !/^sha256:[a-f0-9]{64}$/.test(capacity.imageId) || !Array.isArray(capacity.targets) ||
      capacity.targets.length < svc.runtimeReplicas || capacity.targets.length > 10) throw unavailable();
    const names = replicaNames(svc.runtimeId, capacity.targets.length);
    if (capacity.targets.some((target, index) => !target || target.name !== names[index] || !/^[a-f0-9]{64}$/.test(target.id)) ||
      new Set(capacity.targets.map(target => target.id)).size !== names.length ||
      input.serving.some(target => target.port !== svc.port || !capacity.targets.slice(0, svc.runtimeReplicas).some(known => known.name === target.name && known.id === target.id)) ||
      !await validNodeAutoscaleDatabaseNetworks(tx, svc, capacity)) throw unavailable();
    const conflicts = await Promise.all([
      tx.select({ id: deployments.id }).from(deployments).where(and(eq(deployments.serviceId, svc.id), inArray(deployments.status, ['queued', 'building', 'deploying']))).limit(1),
      tx.select({ id: nodeLifecycleIntents.id }).from(nodeLifecycleIntents).where(and(eq(nodeLifecycleIntents.serviceId, svc.id), notInArray(nodeLifecycleIntents.phase, ['completed', 'superseded']))).limit(1),
      tx.select({ id: primaryTransitions.id }).from(primaryTransitions).where(eq(primaryTransitions.serviceId, svc.id)).limit(1),
      tx.select({ id: fanoutTransitions.id }).from(fanoutTransitions).where(eq(fanoutTransitions.serviceId, svc.id)).limit(1),
      tx.select({ id: nodeAutoscaleTransitions.serviceId }).from(nodeAutoscaleTransitions).where(eq(nodeAutoscaleTransitions.serviceId, svc.id)).limit(1),
      tx.select({ id: nodeDeploymentPreparations.deploymentId }).from(nodeDeploymentPreparations).where(eq(nodeDeploymentPreparations.serviceId, svc.id)).limit(1),
      // A node-local measurement cannot represent traffic served by other nodes.
      tx.select({ id: serviceTargets.id }).from(serviceTargets).where(eq(serviceTargets.serviceId, svc.id)).limit(1),
    ]);
    if (conflicts.some(rows => rows.length) || canaryActive(svc.id)) throw proxyTrafficUnavailable('active runtime work or fanout blocks serving observation');
    return JSON.stringify([svc, deployment, capacity, await readServiceRuntimeOwner(tx, svc.id)]);
  });
  const before = await read();
  const routes = await renderDynamicConfig(db, { serverId: input.nodeId });
  if (routes !== input.routingConfig || !servingTrafficRoutesMatch(input) || before !== await read()) {
    throw proxyTrafficUnavailable('serving routing or runtime context changed');
  }
  return before;
}
