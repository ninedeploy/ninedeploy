import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { eq, nodeAutoscaleCapacity, type DB, type Service } from '@ninedeploy/db';
import { servingTrafficOpen } from '@ninedeploy/schemas';
import { MAX_REPLICAS, replicaNames } from '../engine/dockerNames.js';
import { renderDynamicConfig } from '../engine/proxy.js';
import type { NodeServingSample } from './nodeAutoscaleMetrics.js';
import { openNodeServingTraffic } from './nodeServingTrafficClient.js';

/** Observation window per autoscale tick; the agent bounds it at 60 s. */
export const NODE_SERVING_WINDOW_MS = 10_000;
/** The agent times its window by sequence markers, so finish a little after the panel's own wait. */
const FINISH_MARGIN_MS = 250;

/**
 * Observe one completed serving-traffic window for the exact current serving
 * generation. The receipt is consumed (persisted once) before it is returned;
 * any refusal throws, so missing coverage never reads as zero requests.
 */
export async function readNodeServingTrafficSample(db: DB, service: Service,
  options: { signal?: AbortSignal; durationMs?: number; open?: typeof openNodeServingTraffic; now?: () => number } = {}): Promise<NodeServingSample> {
  const durationMs = options.durationMs ?? NODE_SERVING_WINDOW_MS;
  const count = service.runtimeReplicas, serverId = service.serverId;
  const deploymentId = Number(/-([1-9]\d*)$/.exec(service.runtimeId ?? '')?.[1]);
  if (service.type !== 'docker' || service.orchestrator === 'swarm' || !serverId || service.status !== 'running' || service.asleepAt != null ||
    !service.runtimeId || service.runtimeId !== `${service.slug}-${deploymentId}` || !Number.isSafeInteger(deploymentId) || deploymentId < 1 ||
    !Number.isSafeInteger(count) || count < 1 || count > MAX_REPLICAS || !service.port) throw new Error('Node serving-traffic placement is invalid');
  const capacity = await db.query.nodeAutoscaleCapacity.findFirst({ where: eq(nodeAutoscaleCapacity.deploymentId, deploymentId) });
  const names = replicaNames(service.runtimeId, count);
  const known = Array.isArray(capacity?.targets) ? capacity.targets.slice(0, count) : [];
  if (!capacity || capacity.serviceId !== service.id || capacity.serverId !== serverId || capacity.runtimeId !== service.runtimeId ||
    known.length !== count || names.some((name, index) => known[index]?.name !== name)) throw new Error('Node serving-traffic capacity is not confirmed');
  const routingConfig = await renderDynamicConfig(db, { serverId });
  if (!routingConfig) throw new Error('Node serving traffic needs a routed domain on the node');
  const input = servingTrafficOpen.parse({ purpose: 'autoscale', requestId: randomBytes(16).toString('hex'), nodeId: serverId,
    serviceId: service.id, deploymentId, slug: service.slug, durationMs, routingConfig,
    serving: known.map(target => ({ name: target.name, id: target.id, port: service.port })) });
  const window = await (options.open ?? openNodeServingTraffic)(db, input, { signal: options.signal });
  try {
    await sleep(durationMs + FINISH_MARGIN_MS, undefined, { signal: options.signal });
    const snapshot = await window.finish();
    return { kind: 'serving', serverId, sampledAt: (options.now ?? Date.now)(), serving: known.map(({ name, id }) => ({ name, id })), snapshot };
  } finally {
    await window.close();
  }
}
