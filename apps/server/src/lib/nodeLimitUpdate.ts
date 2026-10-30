import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DB, Service } from '@ninedeploy/db';
import { replicaNames } from '../engine/dockerNames.js';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { capabilityRefusal } from './agentCapabilities.js';
import { admitNodeLimits, checkpointNodeLimits } from './nodeLimitsAuthority.js';
import { createNodeRuntimeMutationClient } from './nodeRuntimeMutationClient.js';
import { runtimeReplicaCounts } from './runtimeReplicaCounts.js';
import { serviceRuntimeRevision } from './serviceRuntimeOwner.js';

const identity = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string(), managed: z.string().nullable(),
  serviceId: z.string().nullable(), deploymentId: z.string().nullable() }).strict();

/** Update all selected node replicas; an incomplete or superseded attempt is never reported as applied. */
export async function applyNodeLimits(db: DB, service: Service): Promise<boolean> {
  try {
    const admission = await admitNodeLimits(db, service);
    if (!admission || !admission.owner.requestId || !admission.service.serverId || !admission.service.runtimeId) return false;
    const checkpoint = () => checkpointNodeLimits(db, admission);
    const participants = [
      { serverId: admission.service.serverId, runtimeId: admission.service.runtimeId, capacity: runtimeReplicaCounts(admission.service).capacity },
      ...admission.targets.map(target => ({ serverId: target.serverId, runtimeId: target.runtimeId!, capacity: 1 })),
    ];
    // All nodes must pass discovery before any ordered mutation is admitted on an agent.
    for (const participant of participants) {
      await checkpoint();
      const sealed = await agentTransportSealed(db, participant.serverId); await checkpoint();
      const refusal = await capabilityRefusal(async (op, params, sink) => {
        await checkpoint(); const result = await agentOp(db, participant.serverId, op, params, sink, { timeoutMs: 5000 });
        await checkpoint(); if (result.exitCode !== 0) throw new Error('Node capability discovery failed'); return result;
      }, '#' + participant.serverId, sealed, { cap: ['docker.mutations', 'docker.limits', 'docker.recovery'], feature: 'apply node resource limits', sealedRequired: true });
      if (refusal) return false;
    }
    const requestId = admission.owner.requestId, serviceId = service.id, revision = serviceRuntimeRevision(admission.owner.epoch, 0);
    const clients = participants.map(participant => createNodeRuntimeMutationClient(db, participant.serverId, { checkpoint }));
    for (const [index, participant] of participants.entries()) {
      const fenceId = createHash('sha256').update(`${requestId}:limits-fence:${participant.serverId}`).digest('hex').slice(0, 32);
      await clients[index]!.fence({ requestId: fenceId, serviceId, revision, timeoutMs: 30_000, deploymentWatermark: admission.watermark });
    }
    const sets: Array<Array<{ id: string; name: string; deploymentId: number }>> = [];
    for (const participant of participants) {
      const deploymentId = Number(/-([1-9]\d*)$/.exec(participant.runtimeId)?.[1]);
      if (!Number.isSafeInteger(deploymentId) || deploymentId < 1) return false;
      const targets: Array<{ id: string; name: string; deploymentId: number }> = [];
      for (const name of replicaNames(participant.runtimeId, participant.capacity)) {
        await checkpoint(); const result = await agentOp(db, participant.serverId, 'docker.identity', { name }, () => {}, { timeoutMs: 15_000 });
        await checkpoint();
        const frames = result.lines.filter(line => line.startsWith('ND-CONTAINER '));
        if (result.exitCode !== 0 || frames.length !== 1 || Buffer.byteLength(frames[0]!) > 16_384) return false;
        const found = identity.parse(JSON.parse(frames[0]!.slice('ND-CONTAINER '.length)));
        if (found.name !== name || found.managed !== 'service' || found.serviceId !== String(serviceId) || found.deploymentId !== String(deploymentId) || targets.some(target => target.id === found.id)) return false;
        targets.push({ id: found.id, name, deploymentId });
      }
      sets.push(targets);
    }
    for (const [index] of participants.entries()) {
      await clients[index]!.limits({ requestId, serviceId, revision: serviceRuntimeRevision(admission.owner.epoch, 1), timeoutMs: 60_000,
        targets: sets[index]!, cpuShares: service.cpuShares, cpuLimitMilli: service.cpuLimitMilli, memLimitMb: service.memLimitMb });
    }
    await checkpoint(); return true;
  } catch { return false; }
}
