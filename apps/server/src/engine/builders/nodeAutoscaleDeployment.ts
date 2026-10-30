import { randomBytes } from 'node:crypto';
import type { DeploymentRuntimeOwner, Service } from '@ninedeploy/db';
import { autoscaleConfig } from '@ninedeploy/schemas';
import type { AgentCall } from './remoteDocker.js';
import type { DeployRuntime } from '../types.js';
import { capabilityRefusal } from '../../lib/agentCapabilities.js';
import { confirmedNodeEnvFile } from '../../lib/nodeEnvReceipt.js';
import { ensureNodeVolumes, nodeFileMountChecks, nodeRunCapabilities, nodeRunExtrasChecks, nodeRuntimeOptions, nodeVolumeLabels,
  type NodeVolumeAttachment } from '../../lib/remoteVolumes.js';
import { writeNodeFileMounts, type NodeServiceFile } from '../../lib/serviceFiles.js';
import { hasRuntimeOptions } from '../../lib/runtimeOptionArgs.js';
import { envForAgent } from './remoteRun.js';
import { nodeAutoscalePrepareId, prepareNodeAutoscaleCapacity } from './nodeAutoscalePrepare.js';

type CapacityClient = Parameters<typeof prepareNodeAutoscaleCapacity>[0];
/** Prepare dependencies and one ordered generation. The caller owns placement, cleanup and promotion. */
export async function prepareNodeAutoscaleDeployment(input: {
  service: Service; owner: DeploymentRuntimeOwner; image: string; creationWatermark: number; env: Record<string, string>;
  attachments?: readonly NodeVolumeAttachment[]; files?: readonly NodeServiceFile[]; extraNetworks?: readonly string[];
  agent: AgentCall; client: CapacityClient; sealed: boolean; checkpoint: () => Promise<void>; log: (line: string) => void;
  journal: { begin: (spec: { runtimeId: string; imageId: string; serving: number; capacity: number }) => Promise<unknown>;
    complete: (targets: Array<{ id: string; name: string }>) => Promise<unknown> };
}) {
  const { service, owner } = input, label = `#${owner.serverId}`, attachments = input.attachments ?? [], files = input.files ?? [];
  if (!input.journal || typeof input.journal.begin !== 'function' || typeof input.journal.complete !== 'function') {
    throw new Error('Node autoscale preparation requires a durable journal');
  }
  const scale = autoscaleConfig.safeParse(service.autoscale);
  if (service.type !== 'docker' || service.orchestrator === 'swarm' || service.id !== owner.serviceId || service.serverId !== owner.serverId ||
    !Number.isSafeInteger(owner.deploymentId) || owner.deploymentId < 1 || !Number.isSafeInteger(input.creationWatermark) ||
    input.creationWatermark < owner.deploymentId || !scale.success) throw new Error('Node autoscale deployment authority or configuration is invalid');
  const call: AgentCall = async (op, params, sink, options) => {
    await input.checkpoint();
    try { return await input.agent(op, params, sink, options); } finally { await input.checkpoint(); }
  };
  const checks = [
    { cap: ['docker.mutations', 'docker.prepareAttemptEnv', 'docker.startSet', 'docker.readiness', 'proxy.routingAck', 'proxy.orderedWrite', 'image.manage'] as const, feature: 'prepare and safely scale node replicas' },
    { cap: nodeRunCapabilities(service, attachments), feature: 'run the complete node replica configuration' },
    ...nodeRunExtrasChecks(service), ...nodeFileMountChecks(files.length),
    ...(service.portMappings?.length ? [{ cap: ['docker.ports' as const], feature: 'publish node port mappings' }] : []),
  ];
  for (const check of checks) {
    const refusal = await capabilityRefusal(call, label, input.sealed, { cap: [...check.cap], feature: check.feature, sealedRequired: true });
    if (refusal) throw new Error(refusal.message);
  }
  if (service.portMappings?.some(mapping => mapping.allowFrom?.length)) throw new Error('Node autoscale cannot use restricted host port mappings');
  const image = await call('docker.imageInspect', { image: input.image }, () => undefined, { timeoutMs: 15_000 });
  const lines = image.lines.filter(line => line.trim());
  const match = lines.length === 1 ? /^(sha256:[a-f0-9]{64})\|\d+$/.exec(lines[0]!.trim()) : null;
  if (image.exitCode !== 0 || !match) throw new Error('Node autoscale immutable image is unconfirmed');
  const runtimeOptions = await nodeRuntimeOptions(call, label, input.sealed, service, input.log);
  if (hasRuntimeOptions(service.runtimeOptions) && !runtimeOptions) throw new Error('Node autoscale container options are unavailable');
  await input.checkpoint();
  await input.journal.begin({ runtimeId: `${service.slug}-${owner.deploymentId}`, imageId: match[1]!,
    serving: Math.max(scale.data.minReplicas, Math.min(service.runtimeReplicas, scale.data.maxReplicas)), capacity: scale.data.maxReplicas });
  await input.checkpoint();
  const volumeNames = [...(service.volumeMount ? [`nd-svc-${service.slug}-data`] : []), ...attachments.map(item => item.volumeName)];
  if (volumeNames.length) {
    const { missingDatabaseVolumes } = await ensureNodeVolumes(call, volumeNames, nodeVolumeLabels({ serviceId: service.id, userId: service.ownerUserId }), input.log);
    if (missingDatabaseVolumes.length) throw new Error(`Node database volumes are unavailable: ${missingDatabaseVolumes.join(', ')}`);
  }
  const fileMounts = await writeNodeFileMounts(call, service, owner.deploymentId, files, input.log);
  const envName = `nd-prep-${nodeAutoscalePrepareId(owner, 'prepare')}-${randomBytes(16).toString('hex')}`;
  const envFile = confirmedNodeEnvFile(await call('file.writeEnv', { name: envName, env: envForAgent(input.env) }, () => undefined), envName);
  let prepareStarted = false, prepareConfirmed = false;
  const guarded: CapacityClient = {
    fence: async request => { await input.checkpoint(); try { return await input.client.fence(request); } finally { await input.checkpoint(); } },
    prepare: async request => { await input.checkpoint(); prepareStarted = true; try { return await input.client.prepare(request); } finally { await input.checkpoint(); } },
  };
  let result: Awaited<ReturnType<typeof prepareNodeAutoscaleCapacity>>;
  try {
    result = await prepareNodeAutoscaleCapacity(guarded, { service, owner, imageId: match[1]!, envFile,
      creationWatermark: input.creationWatermark, attachments, files: fileMounts, runtimeOptions, extraNetworks: input.extraNetworks });
    await input.checkpoint();
    await input.journal.complete(result.capacity); await input.checkpoint();
    prepareConfirmed = true;
  } finally {
    // An unanswered prepare may still be using this file on the node.
    if (prepareStarted && !prepareConfirmed) input.log('Node environment cleanup deferred: preparation outcome is unconfirmed.');
    else await input.agent('file.deleteEnv', { name: envName }, () => undefined).then(result => {
      if (result.exitCode !== 0) throw new Error('Node environment cleanup failed');
    }).catch(() => input.log('Node environment file cleanup is unconfirmed.'));
  }
  await input.checkpoint();
  const health = service.healthCheck;
  const runtime: DeployRuntime = { runtimeId: `${service.slug}-${owner.deploymentId}`, replicas: result.replicas,
    nodeDeploymentOwner: { ...owner }, nodeTargets: result.serving.map(target => ({ ...target })),
    nodeCapacityTargets: result.capacity.map(target => ({ ...target })), port: service.port ?? null, healthPath: service.healthPath ?? '/',
    ...(health === 'running' || health === 'http-strict' || health === 'tcp' ? { healthCheck: health } : {}),
    ...(health === 'command' && service.healthCommand ? { healthCheck: 'command' as const, healthCommand: service.healthCommand } : {}),
    imageDigest: match[1]! };
  return { ...result, imageId: match[1]!, runtime };
}
