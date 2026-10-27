import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { deploymentRuntimeOwners, deployments, services, type DB, type DeploymentRuntimeOwner, type Service } from '@ninedeploy/db';
import { MAX_RUNTIME_EPOCH, readServiceRuntimeOwner, reserveServiceRuntimeOwnerInTransaction } from './serviceRuntimeOwner.js';

export class NodeDeploymentOwnershipLost extends Error {
  constructor() { super('Node deployment authority changed; runtime effects retained for the current owner'); this.name = 'NodeDeploymentOwnershipLost'; }
}

/** SQL fencing is independent of deployment status: cancellation may still need owner-authorized cleanup. */
export function createNodeDeploymentAuthority(db: DB, input: DeploymentRuntimeOwner) {
  const owner = Object.freeze({ ...input });
  if (![owner.deploymentId, owner.serviceId, owner.serverId, owner.epoch].every(value => Number.isSafeInteger(value) && value > 0) ||
    owner.epoch > MAX_RUNTIME_EPOCH || !/^[a-f0-9]{32}$/.test(owner.requestId)) throw new Error('Invalid node deployment authority');
  const predicate = sql`EXISTS (SELECT 1 FROM deployment_runtime_owners AS stamp
    JOIN service_runtime_owners AS authority ON authority.service_id = stamp.service_id
    JOIN services AS placement ON placement.id = stamp.service_id
    JOIN deployments AS attempt ON attempt.id = stamp.deployment_id AND attempt.service_id = stamp.service_id
    WHERE stamp.deployment_id = ${owner.deploymentId} AND stamp.service_id = ${owner.serviceId}
      AND stamp.server_id = ${owner.serverId} AND stamp.epoch = ${owner.epoch} AND stamp.request_id = ${owner.requestId}
      AND authority.kind = 'deploy' AND authority.epoch = stamp.epoch AND authority.request_id = stamp.request_id
      AND placement.server_id = stamp.server_id AND placement.type = 'docker'
      AND (placement.orchestrator IS NULL OR placement.orchestrator <> 'swarm'))`;
  let lost = false;
  return {
    fence: () => predicate,
    lost: () => lost,
    async check() {
      if (!lost) {
        const current = await db.query.deploymentRuntimeOwners.findFirst({ columns: { deploymentId: true },
          where: and(eq(deploymentRuntimeOwners.deploymentId, owner.deploymentId), predicate) });
        if (current) return;
        lost = true;
      }
      throw new NodeDeploymentOwnershipLost();
    },
  };
}
export type NodeDeploymentAuthority = ReturnType<typeof createNodeDeploymentAuthority>;

export type NodeDeploymentAdmission = { claimed: true; owner: DeploymentRuntimeOwner }
  | { claimed: false; reason: 'placement_changed' | 'owner_changed' | 'not_claimable' };

/** Admission only: this transaction never adopts the node-side mutation protocol. */
export async function claimNodeDeploymentAttempt(db: DB, deploymentId: number, service: Service, configSnapshot: string): Promise<NodeDeploymentAdmission> {
  if (!Number.isSafeInteger(deploymentId) || deploymentId < 1 || service.type !== 'docker' || service.orchestrator === 'swarm' ||
    !Number.isSafeInteger(service.serverId) || service.serverId! < 1) throw new Error('Node deployment admission requires a plain Docker node placement');
  return db.transaction<NodeDeploymentAdmission>(async tx => {
    const fresh = await tx.query.services.findFirst({ where: eq(services.id, service.id) });
    if (!fresh || fresh.type !== 'docker' || fresh.orchestrator === 'swarm' || fresh.serverId !== service.serverId) return { claimed: false, reason: 'placement_changed' };
    const [stamp] = await tx.select().from(deploymentRuntimeOwners).where(eq(deploymentRuntimeOwners.deploymentId, deploymentId)).limit(1);
    const current = await readServiceRuntimeOwner(tx, service.id);
    if (stamp && (stamp.serviceId !== service.id || stamp.serverId !== service.serverId || current?.kind !== 'deploy' ||
      current.epoch !== stamp.epoch || current.requestId !== stamp.requestId)) return { claimed: false, reason: 'owner_changed' };
    const claimed = await tx.update(deployments).set({ status: 'building', startedAt: new Date(), configSnapshot })
      .where(and(eq(deployments.id, deploymentId), eq(deployments.serviceId, service.id), inArray(deployments.status, ['queued', 'building']),
        sql`NOT EXISTS (SELECT 1 FROM deployments AS active WHERE active.service_id = ${service.id} AND active.id <> ${deploymentId} AND active.status IN ('building','deploying'))`))
      .returning({ id: deployments.id });
    if (!claimed.length) return { claimed: false, reason: 'not_claimable' };
    let owner = stamp;
    if (!owner) {
      const authority = await reserveServiceRuntimeOwnerInTransaction(tx, service.id, 'deploy', randomBytes(16).toString('hex'), current);
      owner = { deploymentId, serviceId: service.id, serverId: service.serverId!, epoch: authority.epoch, requestId: authority.requestId! };
      await tx.insert(deploymentRuntimeOwners).values(owner);
    }
    await tx.update(services).set({ status: 'deploying' }).where(eq(services.id, service.id));
    return { claimed: true, owner };
  });
}
