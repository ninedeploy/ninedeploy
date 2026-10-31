import { eq, deploymentRuntimeOwners, deployments, nodeAutoscaleCapacity, nodeDeploymentPreparations, primaryTransitions, services, type DB, type DeploymentRuntimeOwner } from '@ninedeploy/db';
import { MAX_REPLICAS, replicaNames } from '../engine/dockerNames.js';
import { readServiceRuntimeOwner, serviceRuntimeRevision } from './serviceRuntimeOwner.js';

type Spec = { runtimeId: string; imageId: string; serving: number; capacity: number; databaseNetworks?: string[] };
type Target = { id: string; name: string };
type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

function validTargets(runtimeId: string, capacity: number, targets: unknown): targets is Target[] {
  const names = replicaNames(runtimeId, capacity);
  return Array.isArray(targets) && targets.length === names.length && targets.every((target, index) => target && target.name === names[index] &&
    typeof target.id === 'string' && /^[a-f0-9]{64}$/.test(target.id)) && new Set(targets.map(target => target.id)).size === names.length;
}
function validNetworks(networks: unknown): networks is string[] {
  return Array.isArray(networks) && networks.length <= 8 && networks.every(value => typeof value === 'string' && /^(?:[1-9]\d*:)?[1-9]\d*:nd-dbnet-[a-z0-9][a-z0-9_.-]*$/.test(value)) &&
    new Set(networks).size === networks.length && networks.every((value, index) => index === 0 || networks[index - 1]! < value);
}
function validRecord(row: typeof nodeDeploymentPreparations.$inferSelect, owner: DeploymentRuntimeOwner, slug: string): boolean {
  return row.serviceId === owner.serviceId && row.serverId === owner.serverId && row.epoch === owner.epoch && row.requestId === owner.requestId &&
    row.runtimeId === `${slug}-${owner.deploymentId}` && /^sha256:[a-f0-9]{64}$/.test(row.imageId) &&
    Number.isSafeInteger(row.serving) && Number.isSafeInteger(row.capacity) && row.serving >= 1 && row.capacity >= row.serving && row.capacity <= MAX_REPLICAS && validNetworks(row.databaseNetworks) &&
    (row.phase === 'preparing' ? row.targets === null && row.recoveryWatermark === null :
      (row.phase === 'prepared' ? row.recoveryWatermark === null : (row.phase === 'fencing' || row.phase === 'retiring') &&
        Number.isSafeInteger(row.recoveryWatermark) && row.recoveryWatermark! >= owner.deploymentId) && validTargets(row.runtimeId, row.capacity, row.targets));
}

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
  const databaseNetworks = [...(spec.databaseNetworks ?? [])].sort();
  if (!/^sha256:[a-f0-9]{64}$/.test(spec.imageId) || !Number.isSafeInteger(spec.serving) || !Number.isSafeInteger(spec.capacity) ||
    spec.serving < 1 || spec.capacity < spec.serving || spec.capacity > MAX_REPLICAS || !validNetworks(databaseNetworks) ||
    databaseNetworks.some(network => !/^[1-9]\d*:[1-9]\d*:/.test(network))) throw new Error('Invalid node preparation intent');
  return db.transaction(async tx => {
    const service = await assertOwner(tx, owner);
    const deployment = await tx.query.deployments.findFirst({ where: eq(deployments.id, owner.deploymentId) });
    if (!deployment || deployment.serviceId !== owner.serviceId || !['building', 'deploying'].includes(deployment.status)) {
      throw new Error('Node preparation deployment is not active');
    }
    if (spec.runtimeId !== `${service.slug}-${owner.deploymentId}`) throw new Error('Invalid node preparation generation');
    await tx.insert(nodeDeploymentPreparations).values({ deploymentId: owner.deploymentId, serviceId: owner.serviceId, serverId: owner.serverId,
      epoch: owner.epoch, requestId: owner.requestId, ...spec, databaseNetworks }).onConflictDoNothing();
    const row = await tx.query.nodeDeploymentPreparations.findFirst({ where: eq(nodeDeploymentPreparations.deploymentId, owner.deploymentId) });
    if (!row || !validRecord(row, owner, service.slug) || row.phase === 'retiring' || row.phase === 'fencing' || row.runtimeId !== spec.runtimeId || row.imageId !== spec.imageId ||
      row.serving !== spec.serving || row.capacity !== spec.capacity || JSON.stringify(row.databaseNetworks) !== JSON.stringify(databaseNetworks)) {
      throw new Error('Node preparation intent changed');
    }
    return row;
  });
}

/** Freeze the complete immutable creation receipt under the same deployment owner. */
export async function completeNodeDeploymentPreparation(db: DB, owner: DeploymentRuntimeOwner, targets: Target[]) {
  return db.transaction(async tx => {
    const service = await assertOwner(tx, owner);
    const row = await tx.query.nodeDeploymentPreparations.findFirst({ where: eq(nodeDeploymentPreparations.deploymentId, owner.deploymentId) });
    if (!row || !validRecord(row, owner, service.slug)) {
      throw new Error('Node preparation intent unavailable');
    }
    if (!validTargets(row.runtimeId, row.capacity, targets)) {
      throw new Error('Node preparation receipt is incomplete');
    }
    if (row.targets && row.targets.some((target, index) => target.id !== targets[index]?.id || target.name !== targets[index]?.name)) {
      throw new Error('Node preparation receipt changed');
    }
    if (row.phase === 'prepared' && row.targets) return row;
    if (row.phase !== 'preparing' || row.targets !== null) throw new Error('Node preparation phase changed');
    const [saved] = await tx.update(nodeDeploymentPreparations).set({ phase: 'prepared', targets }).where(eq(nodeDeploymentPreparations.deploymentId, owner.deploymentId)).returning();
    if (!saved) throw new Error('Node preparation intent disappeared');
    return saved;
  });
}

/** Read persisted preparation evidence only while its deployment still owns the node. */
export async function readNodeDeploymentPreparation(db: DB, owner: DeploymentRuntimeOwner) {
  return db.transaction(async tx => {
    const service = await assertOwner(tx, owner);
    const row = await tx.query.nodeDeploymentPreparations.findFirst({ where: eq(nodeDeploymentPreparations.deploymentId, owner.deploymentId) });
    if (!row) return null;
    if (!validRecord(row, owner, service.slug)) {
      throw new Error('Node preparation evidence is invalid');
    }
    return row;
  });
}

/** Remove preparation evidence only after the leased recovery record owns the same observed identities. */
export async function handoffNodeDeploymentPreparation(db: DB, owner: DeploymentRuntimeOwner, token: string, required = true) {
  return db.transaction(async tx => {
    const service = await assertOwner(tx, owner);
    const row = await tx.query.nodeDeploymentPreparations.findFirst({ where: eq(nodeDeploymentPreparations.deploymentId, owner.deploymentId) });
    if (!row && !required) return false;
    if (!row || !validRecord(row, owner, service.slug) || row.phase !== 'prepared' || !row.targets) throw new Error('Prepared node evidence unavailable');
    const transition = await tx.query.primaryTransitions.findFirst({ where: eq(primaryTransitions.serviceId, owner.serviceId) });
    const ordered = transition?.orderedOwner;
    const candidate = transition?.candidate;
    const identities = candidate && Array.isArray(candidate.containers) && Array.isArray(candidate.spares)
      ? [...candidate.containers, ...candidate.spares] : [];
    if (!transition || transition.deploymentId !== owner.deploymentId || transition.serverId !== owner.serverId ||
      !ordered || ordered.deploymentId !== owner.deploymentId || ordered.serviceId !== owner.serviceId || ordered.serverId !== owner.serverId ||
      ordered.epoch !== owner.epoch || ordered.requestId !== owner.requestId || transition.ownerToken !== token ||
      !transition.leaseUntil || transition.leaseUntil.getTime() <= Date.now() || transition.phase !== 'ready' || transition.routingTouched ||
      transition.imageDigest !== row.imageId || candidate?.runtimeId !== row.runtimeId || candidate.replicas !== row.serving ||
      !Array.isArray(candidate.containers) || candidate.containers.length !== row.serving || !Array.isArray(candidate.spares) ||
      (service.runtimeId !== candidate.runtimeId && service.runtimeId !== transition.previous?.runtimeId && !(service.runtimeId == null && !transition.previous)) ||
      row.targets.some((target, index) => identities[index]?.id !== target.id || identities[index]?.name !== target.name || identities[index]?.observed !== true)) {
      throw new Error('Node preparation recovery handoff is unconfirmed');
    }
    await tx.insert(nodeAutoscaleCapacity).values({ deploymentId: owner.deploymentId, serviceId: owner.serviceId, serverId: owner.serverId,
      runtimeId: row.runtimeId, imageId: row.imageId, targets: row.targets, databaseNetworks: row.databaseNetworks }).onConflictDoNothing();
    const capacity = await tx.query.nodeAutoscaleCapacity.findFirst({ where: eq(nodeAutoscaleCapacity.deploymentId, owner.deploymentId) });
    if (!capacity || capacity.serviceId !== row.serviceId || capacity.serverId !== row.serverId || capacity.runtimeId !== row.runtimeId ||
      capacity.imageId !== row.imageId || JSON.stringify(capacity.databaseNetworks) !== JSON.stringify(row.databaseNetworks) || !validTargets(row.runtimeId, row.capacity, capacity.targets) ||
      capacity.targets.some((target, index) => target.id !== row.targets?.[index]?.id || target.name !== row.targets?.[index]?.name)) {
      throw new Error('Node autoscale capacity receipt changed');
    }
    const deleted = await tx.delete(nodeDeploymentPreparations).where(eq(nodeDeploymentPreparations.deploymentId, owner.deploymentId)).returning();
    if (deleted.length !== 1) throw new Error('Node preparation evidence disappeared');
    return true;
  });
}
