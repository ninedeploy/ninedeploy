import { createHash } from 'node:crypto';
import type { DeploymentRuntimeOwner, Service, ServiceRuntimeOptions } from '@ninedeploy/db';
import { autoscaleConfig, containerPrepareReply, containerPrepareRequest, formatPortMapping, runtimeFenceReply } from '@ninedeploy/schemas';
import { parseRunSpec } from '../../agentOps/runSpec.js';
import { serviceRuntimeRevision } from '../../lib/serviceRuntimeOwner.js';
import type { NodeFileMount } from '../../lib/serviceFiles.js';
import type { NodeVolumeAttachment } from '../../lib/remoteVolumes.js';
import { replicaNames } from '../dockerNames.js';
import { runSpecParams } from './remoteRun.js';

type PrepareClient = {
  fence(input: { requestId: string; serviceId: number; revision: number; timeoutMs: number; deploymentWatermark: number }): Promise<unknown>;
  prepare(input: ReturnType<typeof containerPrepareRequest.parse>): Promise<unknown>;
};
export const nodeAutoscalePrepareId = (owner: DeploymentRuntimeOwner, stage: 'fence' | 'prepare') =>
  createHash('sha256').update(`${owner.requestId}:autoscale-capacity:${stage}`).digest('hex').slice(0, 32);
/** Build one immutable node generation, with spare replicas created but not started. */
export async function prepareNodeAutoscaleCapacity(client: PrepareClient, input: {
  service: Service; owner: DeploymentRuntimeOwner; imageId: string; envFile: string; creationWatermark: number;
  attachments?: readonly NodeVolumeAttachment[]; files?: readonly NodeFileMount[]; runtimeOptions?: ServiceRuntimeOptions | null; extraNetworks?: readonly string[];
}): Promise<{ serving: Array<{ id: string; name: string }>; capacity: Array<{ id: string; name: string }>; replicas: number }> {
  const { service, owner } = input, cfg = autoscaleConfig.parse(service.autoscale);
  if (service.type !== 'docker' || service.orchestrator === 'swarm' || service.serverId !== owner.serverId || service.id !== owner.serviceId ||
    !Number.isSafeInteger(owner.deploymentId) || owner.deploymentId < 1 || !/^[a-f0-9]{32}$/.test(owner.requestId) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.imageId) || !Number.isSafeInteger(input.creationWatermark) || input.creationWatermark < owner.deploymentId) {
    throw new Error('Node autoscale preparation authority or image is invalid');
  }
  const base = `${service.slug}-${owner.deploymentId}`;
  const attemptPrefix = `.agent-env/nd-prep-${nodeAutoscalePrepareId(owner, 'prepare')}-`;
  if (!(input.envFile === `.agent-env/${base}.env` || input.envFile.startsWith(attemptPrefix) && /^[a-f0-9]{32}\.env$/.test(input.envFile.slice(attemptPrefix.length))) || service.portMappings?.some(mapping => mapping.allowFrom?.length)) {
    throw new Error('Node autoscale preparation environment or port mapping is invalid');
  }
  const servingCount = Math.max(cfg.minReplicas, Math.min(service.runtimeReplicas, cfg.maxReplicas));
  const names = replicaNames(base, cfg.maxReplicas), servingNames = names.slice(0, servingCount);
  const volumes = [...(service.volumeMount ? [{ name: `nd-svc-${service.slug}-data`, mount: service.volumeMount, readOnly: false }] : []),
    ...(input.attachments ?? []).map(item => ({ name: item.volumeName, mount: item.containerPath, readOnly: item.readOnly === true }))];
  const ports = (service.portMappings ?? []).map(formatPortMapping);
  const specs = names.map((name, index) => {
    const spec = runSpecParams(service, { name, image: input.imageId, envFile: input.envFile, envFileName: base, deploymentId: owner.deploymentId,
      volumes, ...(index === 0 && service.publishedPort && service.port ? { publish: `${service.publishedPort}:${service.port}` } : {}),
      ...(index === 0 ? { ports } : {}), fileMounts: input.files, runtimeOptions: input.runtimeOptions });
    if (input.extraNetworks?.length) spec.extraNetworks = [...input.extraNetworks];
    parseRunSpec(spec);
    return spec;
  });
  const fence = { requestId: nodeAutoscalePrepareId(owner, 'fence'), serviceId: service.id, revision: serviceRuntimeRevision(owner.epoch, 0), timeoutMs: 30_000,
    deploymentWatermark: input.creationWatermark };
  const preparation = containerPrepareRequest.parse({ requestId: nodeAutoscalePrepareId(owner, 'prepare'), serviceId: service.id, revision: serviceRuntimeRevision(owner.epoch, 1),
    deploymentId: owner.deploymentId, timeoutMs: 300_000, specs, startNames: servingNames });
  const fenced = runtimeFenceReply.parse(await client.fence(fence));
  if (fenced.requestId !== fence.requestId || fenced.serviceId !== fence.serviceId || fenced.revision !== fence.revision || fenced.deploymentWatermark !== fence.deploymentWatermark) throw new Error('Node autoscale preparation fence is unconfirmed');
  // The node journals this exact request before applying it. A lost response
  // can be replayed without creating a second set; ownership is rechecked by
  // the bound client on each call.
  let response: unknown;
  try { response = await client.prepare(preparation); }
  catch { response = await client.prepare(preparation); }
  const prepared = containerPrepareReply.parse(response);
  if (prepared.requestId !== preparation.requestId || prepared.serviceId !== service.id || prepared.revision !== preparation.revision || prepared.deploymentId !== owner.deploymentId ||
    prepared.items.length !== names.length || names.some((name, index) => !prepared.items.some(item => item.name === name && item.deploymentId === owner.deploymentId && item.running === (index < servingCount)))) {
    throw new Error('Node autoscale prepared capacity is unconfirmed');
  }
  const capacity = names.map(name => { const item = prepared.items.find(target => target.name === name)!; return { id: item.id, name: item.name }; });
  return { serving: capacity.slice(0, servingCount), capacity, replicas: servingCount };
}
