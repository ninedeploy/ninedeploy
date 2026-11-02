import type { Service } from '@ninedeploy/db';
import { containerMetricsReply, servingTrafficSnapshot, type ServingTrafficSnapshot } from '@ninedeploy/schemas';
import { MAX_REPLICAS, replicaNames } from '../engine/dockerNames.js';
import { AUTOSCALE_STATS_MAX_AGE_MS } from './autoscaler.js';

/** Convert a complete, identity-bound node sample into a per-serving-replica value. */
export function measureNodeAutoscale(
  service: Pick<Service, 'id' | 'serverId' | 'runtimeId' | 'runtimeReplicas'>,
  metric: 'cpu' | 'memory',
  sample: unknown,
  now: number,
): { value: number | null; holding: string | null } {
  const held = { value: null, holding: 'waiting for fresh, complete node replica metrics' };
  const count = service.runtimeReplicas;
  if (!service.serverId || !service.runtimeId || !Number.isSafeInteger(count) || count! < 1 || count! > MAX_REPLICAS ||
    !Number.isFinite(now) || !sample || typeof sample !== 'object' || Array.isArray(sample)) return held;
  const deploymentId = Number(/-([1-9]\d*)$/.exec(service.runtimeId)?.[1]);
  if (!Number.isSafeInteger(deploymentId) || deploymentId < 1) return held;
  const { serverId, sampledAt, ...receipt } = sample as Record<string, unknown>;
  if (serverId !== service.serverId || typeof sampledAt !== 'number' || !Number.isFinite(sampledAt) ||
    sampledAt > now || now - sampledAt > AUTOSCALE_STATS_MAX_AGE_MS) return held;
  const parsed = containerMetricsReply.safeParse(receipt);
  if (!parsed.success || !parsed.data.complete || parsed.data.serviceId !== service.id || parsed.data.deploymentId !== deploymentId) return held;
  const items = parsed.data.items, names = replicaNames(service.runtimeId, count!);
  if (items.length !== names.length || new Set(items.map(item => item.id)).size !== names.length ||
    new Set(items.map(item => item.name)).size !== names.length || names.some(name => !items.some(item => item.name === name))) return held;
  if (metric === 'memory' && items.some(item => item.memLimitBytes <= 0)) {
    return { value: null, holding: 'waiting for configured memory limits on every node replica' };
  }
  const total = items.reduce((sum, item) => sum + (metric === 'memory'
    ? item.memBytes / item.memLimitBytes * 100
    : item.cpuPct / (item.cpuLimitMilli > 0 ? item.cpuLimitMilli / 1000 : 1)), 0);
  if (!Number.isFinite(total)) return held;
  return { value: Math.round(total / items.length * 10) / 10, holding: null };
}

/** A consumed serving-traffic receipt for the exact serving generation (lib/nodeServingTrafficSample.ts). */
export type NodeServingSample = { kind: 'serving'; serverId: number; sampledAt: number; serving: Array<{ name: string; id: string }>; snapshot: ServingTrafficSnapshot };

/** Requests per second per serving replica from one completed, identity-bound window; never zero for missing coverage. */
export function measureNodeServingTraffic(
  service: Pick<Service, 'id' | 'serverId' | 'runtimeId' | 'runtimeReplicas'>,
  sample: unknown,
  now: number,
): { value: number | null; holding: string | null; sample?: NodeServingSample } {
  const held = { value: null, holding: 'waiting for a complete node serving-traffic window' };
  const count = service.runtimeReplicas;
  if (!service.serverId || !service.runtimeId || !Number.isSafeInteger(count) || count! < 1 || count! > MAX_REPLICAS ||
    !Number.isFinite(now) || !sample || typeof sample !== 'object' || Array.isArray(sample)) return held;
  const deploymentId = Number(/-([1-9]\d*)$/.exec(service.runtimeId)?.[1]);
  const raw = sample as Partial<NodeServingSample>;
  if (raw.kind !== 'serving' || raw.serverId !== service.serverId || typeof raw.sampledAt !== 'number' || !Number.isFinite(raw.sampledAt) ||
    raw.sampledAt > now || now - raw.sampledAt > AUTOSCALE_STATS_MAX_AGE_MS || !Array.isArray(raw.serving)) return held;
  const parsed = servingTrafficSnapshot.safeParse(raw.snapshot);
  if (!parsed.success) return held;
  const snapshot = parsed.data, names = replicaNames(service.runtimeId, count!);
  if (!snapshot.complete || snapshot.endCounter === null || snapshot.elapsedMs < 1 || snapshot.nodeId !== service.serverId ||
    snapshot.serviceId !== service.id || snapshot.deploymentId !== deploymentId || raw.serving.length !== names.length ||
    names.some((name, index) => raw.serving![index]?.name !== name || !/^[a-f0-9]{64}$/.test(raw.serving![index]?.id ?? '')) ||
    new Set(raw.serving.map(target => target.id)).size !== names.length) return held;
  const value = snapshot.serving.requests * 1000 / snapshot.elapsedMs / names.length;
  if (!Number.isFinite(value)) return held;
  return { value: Math.round(value * 10) / 10, holding: null, sample: { kind: 'serving', serverId: raw.serverId, sampledAt: raw.sampledAt,
    serving: raw.serving.map(({ name, id }) => ({ name, id })), snapshot } };
}
