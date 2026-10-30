import { eq, deploymentRuntimeOwners, deployments, nodeDeploymentPreparations, services, type DB, type DeploymentRuntimeOwner } from '@ninedeploy/db';
import { MAX_REPLICAS, replicaNames } from '../engine/dockerNames.js';
import { readServiceRuntimeOwner, serviceRuntimeRevision } from './serviceRuntimeOwner.js';

type Spec = { runtimeId: string; imageId: string; serving: number; capacity: number };
type Target = { id: string; name: string };
type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

async function assertOwner(tx: Tx, owner: DeploymentRuntimeOwner) {
  if (![owner.deploymentId, owner.serviceId, owner.serverId].every(value => Number.isSafeInteger(value) && value > 0) ||
    !/^[a-f0-9]{32}$/.test(owner.requestId)) throw new Error('Invalid node preparation owner');
  serviceRuntimeRevision(owner.epoch, 0);
  const stamp = await tx.query.deploymentRuntimeOwners.findFirst({ where: eq(deploymentRuntimeOwners.deploymentId, owner.deploymentId) });
  const service = await tx.query.services.findFirst({ where: eq(services.id, owner.serviceId) });
  const current = await readServiceRuntimeOwner(tx, owner.serviceId);
  if (!stamp || stamp.serviceId !== owner.serviceId || stamp.serverId !== owner.serverId || stamp.epoch !== owner.epoch || stamp.requestId !== owner.requestId ||
    !service || service.type !== 'docker' || service.orchestrator === 'swarm' || service.serverId !== owner.serverId ||
    !current || current.kind !== 'deploy' || current.epoch !== owner.epoch || current.requestId !== owner.requestId) {
    throw new Error('Node preparation ownership or placement changed');
  }
  return service;
}

/** Record immutable, non-secret preparation intent before sending any create request. */
export async function beginNodeDeploymentPreparation(db: DB, owner: DeploymentRuntimeOwner, spec: Spec) {
  if (!/^sha256:[a-f0-9]{64}$/.test(spec.imageId) || !Number.isSafeInteger(spec.serving) || !Number.isSafeInteger(spec.capacity) ||
    spec.serving < 1 || spec.capacity < spec.serving || spec.capacity > MAX_REPLICAS) throw new Error('Invalid node preparation intent');
  return db.transaction(async tx => {
    const service = await assertOwner(tx, owner);
    const deployment = await tx.query.deployments.findFirst({ where: eq(deployments.id, owner.deploymentId) });
    if (!deployment || deployment.serviceId !== owner.serviceId || !['building', 'deploying'].includes(deployment.status)) {
      throw new Error('Node preparation deployment is not active');
    }
    if (spec.runtimeId !== `${service.slug}-${owner.deploymentId}`) throw new Error('Invalid node preparation generation');
    await tx.insert(nodeDeploymentPreparations).values({ deploymentId: owner.deploymentId, serviceId: owner.serviceId, serverId: owner.serverId,
      epoch: owner.epoch, requestId: owner.requestId, ...spec }).onConflictDoNothing();
    const row = await tx.query.nodeDeploymentPreparations.findFirst({ where: eq(nodeDeploymentPreparations.deploymentId, owner.deploymentId) });
    if (!row || row.serviceId !== owner.serviceId || row.serverId !== owner.serverId || row.epoch !== owner.epoch || row.requestId !== owner.requestId ||
      row.runtimeId !== spec.runtimeId || row.imageId !== spec.imageId || row.serving !== spec.serving || row.capacity !== spec.capacity) {
      throw new Error('Node preparation intent changed');
    }
    return row;
  });
}

/** Freeze the complete immutable creation receipt under the same deployment owner. */
export async function completeNodeDeploymentPreparation(db: DB, owner: DeploymentRuntimeOwner, targets: Target[]) {
  return db.transaction(async tx => {
    await assertOwner(tx, owner);
    const row = await tx.query.nodeDeploymentPreparations.findFirst({ where: eq(nodeDeploymentPreparations.deploymentId, owner.deploymentId) });
    if (!row || row.serviceId !== owner.serviceId || row.serverId !== owner.serverId || row.epoch !== owner.epoch || row.requestId !== owner.requestId) {
      throw new Error('Node preparation intent unavailable');
    }
    const names = replicaNames(row.runtimeId, row.capacity);
    if (!Array.isArray(targets) || targets.length !== names.length || targets.some((target, index) => !target || target.name !== names[index] ||
      typeof target.id !== 'string' || !/^[a-f0-9]{64}$/.test(target.id)) || new Set(targets.map(target => target.id)).size !== names.length) {
      throw new Error('Node preparation receipt is incomplete');
    }
    if (row.targets && JSON.stringify(row.targets) !== JSON.stringify(targets)) throw new Error('Node preparation receipt changed');
    if (row.phase === 'prepared' && row.targets) return row;
    if (row.phase !== 'preparing' || row.targets !== null) throw new Error('Node preparation phase changed');
    const [saved] = await tx.update(nodeDeploymentPreparations).set({ phase: 'prepared', targets }).where(eq(nodeDeploymentPreparations.deploymentId, owner.deploymentId)).returning();
    if (!saved) throw new Error('Node preparation intent disappeared');
    return saved;
  });
}
