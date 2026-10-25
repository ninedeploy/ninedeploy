import { z } from 'zod';
import type { AgentCall } from './remoteDocker.js';
import type { RemoteRunInput, RemoteRunResult } from './remoteRun.js';
import { MAX_REPLICAS, replicaNames } from '../dockerNames.js';
import { capabilityRefusal } from '../../lib/agentCapabilities.js';

const identity = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string(), managed: z.string().nullable(),
  serviceId: z.string().nullable(), deploymentId: z.string().nullable() }).strict();

export async function retireRemoteReplicas(agent: AgentCall, targets: ReadonlyArray<{ id: string; name: string }>, grace = 5): Promise<void> {
  for (const target of [...targets].reverse()) {
    const result = await agent('docker.retire', { ...target, graceSeconds: String(grace) }, () => undefined, { timeoutMs: Math.max(35_000, (grace + 30) * 1000) });
    if (result.exitCode !== 0 || !result.lines.includes(`ND-RETIRED ${target.id}`)) throw new Error('Node replica retirement unconfirmed');
  }
}

/** Reconstruct an older set only from this service's managed generation, never name alone. */
export async function discoverRemoteReplicas(agent: AgentCall, runtimeId: string, serviceId: number): Promise<Array<{ id: string; name: string }>> {
  const deploymentId = /^[A-Za-z0-9][A-Za-z0-9_.-]*-([1-9]\d*)$/.exec(runtimeId)?.[1];
  if (!deploymentId) throw new Error('Previous node replica generation identity unavailable');
  const targets: Array<{ id: string; name: string }> = [];
  for (const name of replicaNames(runtimeId, MAX_REPLICAS)) {
    const result = await agent('docker.identity', { name }, () => undefined, { timeoutMs: 15_000 });
    const frames = result.lines.filter(line => line.startsWith('ND-CONTAINER '));
    if (result.exitCode !== 0 || frames.length !== 1 || Buffer.byteLength(frames[0]!) > 16_384) throw new Error('Previous node replica identity unavailable');
    const found = identity.nullable().parse(JSON.parse(frames[0]!.slice(13)));
    if (!found) continue;
    if (found.name !== name || found.managed !== 'service' || found.serviceId !== String(serviceId) || found.deploymentId !== deploymentId ||
      targets.some(target => target.id === found.id)) throw new Error('Previous node replica ownership changed; generation retained');
    targets.push({ id: found.id, name });
  }
  return targets;
}

/** Prepare every manual replica or fail the generation. Never retire by a reusable name. */
export async function runRemoteReplicas(agent: AgentCall, input: RemoteRunInput,
  runOne: (agent: AgentCall, input: RemoteRunInput) => Promise<RemoteRunResult>): Promise<RemoteRunResult> {
  const { service, deploymentId, log } = input;
  if (service.type !== 'docker' || service.orchestrator === 'swarm' || service.serverId == null) throw new Error('Node replica preparation requires plain Docker placement');
  const deadline = Date.now() + 300_000;
  const call: AgentCall = async (op, params, sink, options) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Node replica preparation deadline exceeded');
    const result = await agent(op, params, sink, { ...options, timeoutMs: Math.min(options?.timeoutMs ?? 15_000, remaining) });
    if (Date.now() >= deadline) throw new Error('Node replica preparation deadline exceeded');
    if (result.exitCode !== 0) throw new Error(`Node replica operation ${op} failed`);
    return result;
  };
  const refusal = await capabilityRefusal(call, input.nodeLabel ?? `#${service.serverId}`, input.sealed ?? true, {
    cap: ['docker.recovery', 'docker.readiness', 'docker.lifecycle'], feature: 'prepare and verify every immutable node replica', sealedRequired: true,
  });
  if (refusal) throw new Error(refusal.message);
  const targets: Array<{ id: string; name: string }> = [];
  const readIdentity = async (name: string) => {
    const response = await call('docker.identity', { name }, () => undefined, { timeoutMs: 15_000 });
    const lines = response.lines.filter(line => line.startsWith('ND-CONTAINER '));
    if (response.exitCode !== 0 || lines.length !== 1 || Buffer.byteLength(lines[0]!) > 16_384) throw new Error('Node replica identity unavailable');
    return identity.nullable().parse(JSON.parse(lines[0]!.slice(13)));
  };
  const readImage = async (id: string) => {
    const response = await call('docker.inspect', { name: id, format: 'image' }, () => undefined, { timeoutMs: 15_000 });
    const lines = response.lines.filter(line => line.trim());
    if (response.exitCode !== 0 || lines.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(lines[0]!.trim())) throw new Error('Node replica immutable image identity unavailable');
    return lines[0]!.trim();
  };
  let pinnedImage: string | undefined;
  try {
    for (const name of replicaNames(input.name, service.replicas ?? 1)) {
      if (await readIdentity(name)) throw new Error(`Node replica name ${name} is occupied; existing container retained`);
      const result = await runOne(call, { ...input, name, service: { ...service, replicas: 1,
        ...(targets.length ? { publishedPort: null, portMappings: [] } : {}) }, image: pinnedImage ?? input.image,
      previous: targets.length ? undefined : input.previous, immutableFailureCleanup: true });
      if (!result.containerId) throw new Error(`Node replica ${name} has no immutable creation receipt; container retained`);
      const found = await readIdentity(result.containerId);
      if (!found || found.id !== result.containerId || found.name !== name || found.managed !== 'service' ||
        found.serviceId !== String(service.id) || found.deploymentId !== String(deploymentId)) throw new Error(`Node replica ownership of ${name} is unconfirmed; container retained`);
      if (targets.some(target => target.id === found.id)) throw new Error('Duplicate node replica creation identity');
      targets.push({ id: found.id, name });
      const image = await readImage(found.id);
      pinnedImage ??= image;
      if (image !== pinnedImage) throw new Error(`Node replica image of ${name} changed`);
    }
    log(`Prepared all ${targets.length} node replicas from one immutable image.`);
    return { port: service.port ?? null, replicas: targets.length, targets };
  } catch (error) {
    for (const target of [...targets].reverse()) {
      try {
        const retired = await agent('docker.retire', target, () => undefined, { timeoutMs: 30_000 });
        if (retired.exitCode !== 0 || !retired.lines.includes(`ND-RETIRED ${target.id}`)) throw new Error('Retirement receipt unavailable');
      } catch {
        log(`Node replica cleanup is unconfirmed for ${target.name} (${target.id}); retained for recovery.`);
      }
    }
    throw error;
  }
}
