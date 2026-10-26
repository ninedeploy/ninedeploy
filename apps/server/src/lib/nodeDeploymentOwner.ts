import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { deploymentRuntimeOwners, deployments, services, type DB, type DeploymentRuntimeOwner, type Service } from '@ninedeploy/db';
import { readServiceRuntimeOwner, reserveServiceRuntimeOwnerInTransaction } from './serviceRuntimeOwner.js';

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
