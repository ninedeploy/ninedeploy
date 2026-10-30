import { createHash } from 'node:crypto';
import type { DeploymentRuntimeOwner, PrimaryRuntimeSnapshot } from '@ninedeploy/db';
import { containerRetireSetReply, containerRetireSetRequest } from '@ninedeploy/schemas';
import { MAX_REPLICAS, replicaNames } from '../engine/dockerNames.js';
import { serviceRuntimeRevision } from './serviceRuntimeOwner.js';

type RetireRequest = ReturnType<typeof containerRetireSetRequest.parse>;
/** The caller must first persist observations, confirm routing and recheck all placement references. */
export async function retireNodeDeploymentGeneration(client: { retire(input: RetireRequest): Promise<unknown> }, input: {
  owner: DeploymentRuntimeOwner; group: PrimaryRuntimeSnapshot; selectedRuntimeId: string | null; graceSeconds: number; checkpoint: () => Promise<void>;
}): Promise<void> {
  const { owner, group } = input;
  if (group.native || group.runtimeId === input.selectedRuntimeId || !Number.isSafeInteger(owner.serviceId) || owner.serviceId < 1 ||
    !Number.isSafeInteger(owner.serverId) || owner.serverId < 1 || !Number.isSafeInteger(owner.deploymentId) || owner.deploymentId < 1 || !/^[a-f0-9]{32}$/.test(owner.requestId) ||
    !Number.isInteger(group.replicas) || group.replicas < 1 || group.replicas > MAX_REPLICAS || !Array.isArray(group.containers) ||
    !Number.isInteger(input.graceSeconds) || input.graceSeconds < 0 || input.graceSeconds > 300) throw new Error('Node deployment retirement authority is invalid');
  const deploymentId = Number(/-([1-9]\d*)$/.exec(group.runtimeId)?.[1]);
  if (!Number.isSafeInteger(deploymentId) || deploymentId < 1) throw new Error('Node deployment retirement generation is unconfirmed');
  const names = replicaNames(group.runtimeId, MAX_REPLICAS), entries = [...group.containers, ...(group.spares ?? [])];
  if (group.containers.length !== group.replicas || entries.length > MAX_REPLICAS || entries.some((item, index) =>
    item.name !== names[index] || !item.observed || item.id !== null && !/^[a-f0-9]{64}$/.test(item.id))) throw new Error('Node deployment retirement identities are unconfirmed');
  const ids = entries.flatMap(item => item.id === null ? [] : [{ id: item.id, name: item.name, deploymentId }]);
  const request = containerRetireSetRequest.parse({ requestId: createHash('sha256').update(`${owner.requestId}:retire:${group.runtimeId}`).digest('hex').slice(0, 32),
    serviceId: owner.serviceId, revision: serviceRuntimeRevision(owner.epoch, 2), timeoutMs: Math.min(330_000, Math.max(35_000, (input.graceSeconds + 30) * 1000)),
    graceSeconds: input.graceSeconds, targets: ids });
  await input.checkpoint();
  let raw: unknown;
  try { raw = await client.retire(request); } finally { await input.checkpoint(); }
  const reply = containerRetireSetReply.parse(raw);
  if (reply.requestId !== request.requestId || reply.serviceId !== request.serviceId || reply.revision !== request.revision || reply.items.length !== ids.length ||
    ids.some(target => !reply.items.some(item => item.id === target.id && item.name === target.name && item.deploymentId === target.deploymentId))) {
    throw new Error('Node deployment retirement receipt is unconfirmed');
  }
}
