import { randomBytes } from 'node:crypto';
import type { DB } from '@ninedeploy/db';
import { containerMetricsReply, containerMetricsRequest, type ContainerMetricsRequest } from '@ninedeploy/schemas';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { capabilityRefusal } from './agentCapabilities.js';

/** Selected-host, generation-bound data for node controllers; never panel stats. */
export async function readNodeContainerMetrics(db: DB, serverId: number,
  spec: Omit<ContainerMetricsRequest, 'requestId' | 'timeoutMs'>,
  options: { checkpoint: () => Promise<void>; signal?: AbortSignal; timeoutMs?: number }) {
  if (!Number.isSafeInteger(serverId) || serverId <= 0) throw new Error('Node metrics require an explicit server');
  const budget = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(budget) || budget < 1 || budget > 15_000) throw new Error('Invalid node metrics deadline');
  const input = containerMetricsRequest.parse({ ...spec, requestId: randomBytes(16).toString('hex'), timeoutMs: 1 });
  const deadline = Date.now() + budget;
  const current = async () => {
    options.signal?.throwIfAborted();
    await options.checkpoint();
    options.signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('Node metrics deadline exceeded');
  };
  await current();
  const sealed = await agentTransportSealed(db, serverId);
  await current();
  const refusal = await capabilityRefusal(async (op, params, sink) => {
    await current();
    const result = await agentOp(db, serverId, op, params, sink, { signal: options.signal, timeoutMs: Math.min(5000, deadline - Date.now()) });
    await current();
    return result;
  }, `#${serverId}`, sealed, { cap: 'docker.metrics', feature: 'measure immutable container resources', sealedRequired: true });
  if (refusal) throw new Error(`Node metrics unavailable: ${refusal.message}`);
  await current();
  const request = containerMetricsRequest.parse({ ...input, timeoutMs: Math.max(1, Math.min(10_000, Math.floor(deadline - Date.now()))) });
  const result = await agentOp(db, serverId, 'docker.metrics', request, () => undefined, { signal: options.signal, timeoutMs: deadline - Date.now() });
  await current();
  const frames = result.lines.filter(line => line.startsWith('ND-METRICS '));
  if (result.exitCode !== 0 || frames.length !== 1 || Buffer.byteLength(frames[0]!) > 64 * 1024) throw new Error('Node metric receipt unavailable');
  const reply = containerMetricsReply.parse(JSON.parse(frames[0]!.slice(11)));
  if (!reply.complete || reply.requestId !== request.requestId || reply.serviceId !== request.serviceId || reply.deploymentId !== request.deploymentId ||
    reply.items.length !== request.targets.length || new Set(reply.items.map(item => item.id)).size !== request.targets.length ||
    request.targets.some(target => !reply.items.some(item => item.id === target.id && item.name === target.name))) throw new Error('Node metric identity or coverage changed');
  return { ...reply, serverId, sampledAt: Date.now() };
}
