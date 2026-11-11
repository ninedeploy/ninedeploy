import { randomBytes } from 'node:crypto';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { deployments, nodeLifecycleIntents, nodeSleepTransitions, services, serviceTargets, type DB, type Service } from '@ninedeploy/db';
import { containerReadinessReply } from '@ninedeploy/schemas';
import { agentOp } from './agentClient.js';
import { acceptNodeLifecycleIntent } from './nodeLifecycleIntent.js';
import { nodeSleepAutomationBlock } from './nodeSleepAutomationBlock.js';

/**
 * P2, restart-loop limit on a node (lib/restartLimit.ts runs the policy).
 *
 * Sampling uses two operations every agent since v0.18.0 has: `docker.identity`
 * resolves each replica name to a container id and proves the container is this
 * service's own generation (never the name alone), then one `docker.readiness`
 * in `running` mode (no probe) reads each id's `RestartCount`, whatever its
 * state; `docker.metrics` would refuse a container that is restarting, which
 * is exactly the one to count.
 *
 * The stop is the Stop button's own: a durable node lifecycle intent, carried
 * out by the lifecycle reconciler, which audits `service.stop` when it settles.
 */

export type NodeAgentCall = (serverId: number, op: string, params: Record<string, unknown>, timeoutMs: number) => Promise<{ exitCode: number; lines: string[] }>;

/** Deployment states a Stop would cancel: the limiter never cancels a deploy, even one waiting for CI or an approval. */
const CANCELLABLE = ['queued', 'building', 'deploying', 'awaiting_ci', 'awaiting_approval'] as const;

/**
 * `{containerId: RestartCount}` of a node service's own containers, or null
 * when the sample is not trustworthy (a container of another generation or
 * service under the name, a reply that does not match, nothing found). Throws
 * when the node cannot be asked; the caller then leaves the history alone.
 */
export async function sampleNodeRestarts(db: DB, svc: Pick<Service, 'id' | 'serverId' | 'runtimeId'>, names: string[], agent?: NodeAgentCall): Promise<Map<string, number> | null> {
  if (svc.serverId == null || !svc.runtimeId) return null;
  const generation = /-([1-9]\d*)$/.exec(svc.runtimeId)?.[1];
  if (!generation) return null;
  const call: NodeAgentCall = agent ?? ((serverId, op, params, timeoutMs) => agentOp(db, serverId, op, params, () => undefined, { timeoutMs }));
  const targets: Array<{ id: string; name: string }> = [];
  for (const name of names) {
    const res = await call(svc.serverId, 'docker.identity', { name }, 5_000);
    const frames = res.lines.filter((l) => l.startsWith('ND-CONTAINER '));
    if (res.exitCode !== 0 || frames.length !== 1 || Buffer.byteLength(frames[0]!) > 16_384) throw new Error('Node container identity unavailable');
    const found = JSON.parse(frames[0]!.slice('ND-CONTAINER '.length)) as { id?: unknown; name?: unknown; managed?: unknown; serviceId?: unknown; deploymentId?: unknown } | null;
    if (found === null) continue; // a replica that is not running at this capacity
    if (typeof found.id !== 'string' || !/^[a-f0-9]{64}$/.test(found.id) || found.name !== name || found.managed !== 'service' ||
      found.serviceId !== String(svc.id) || found.deploymentId !== generation) return null;
    targets.push({ id: found.id, name });
  }
  if (targets.length === 0) return null;
  const requestId = randomBytes(16).toString('hex');
  const res = await call(svc.serverId, 'docker.readiness', { requestId, targets, mode: 'running', port: null, path: '/', timeoutMs: 8_000 }, 12_000);
  const frames = res.lines.filter((l) => l.startsWith('ND-READINESS '));
  if (res.exitCode !== 0 || frames.length !== 1) throw new Error('Node restart counts unavailable');
  const reply = containerReadinessReply.safeParse(JSON.parse(frames[0]!.slice('ND-READINESS '.length)));
  if (!reply.success || reply.data.requestId !== requestId || reply.data.items.length !== targets.length) return null;
  const out = new Map<string, number>();
  for (const t of targets) {
    const item = reply.data.items.find((i) => i.id === t.id && i.name === t.name);
    if (!item) return null;
    out.set(t.id, item.restarts);
  }
  return out;
}

/**
 * Why the limiter must leave this node service alone right now, or null. A
 * Stop would supersede a pending Start or Restart, cancel a deploy (also one
 * waiting for CI or an approval), or fight a sleep or wake; fan-out services
 * run on other nodes this sample does not see.
 */
export async function nodeRestartStopBlocked(db: DB, svc: Pick<Service, 'id' | 'serverId' | 'runtimeId' | 'status' | 'asleepAt'>): Promise<string | null> {
  if (svc.serverId == null || !svc.runtimeId || svc.status !== 'running') return 'not running on a node';
  if (svc.asleepAt != null) return 'asleep';
  const fanout = await db.select({ id: serviceTargets.id }).from(serviceTargets).where(eq(serviceTargets.serviceId, svc.id)).limit(1);
  if (fanout.length) return 'fan-out';
  const work = await db.select({ id: deployments.id }).from(deployments)
    .where(and(eq(deployments.serviceId, svc.id), inArray(deployments.status, [...CANCELLABLE]))).limit(1);
  if (work.length) return 'a deploy is in progress';
  const intent = await db.select({ id: nodeLifecycleIntents.id }).from(nodeLifecycleIntents)
    .where(and(eq(nodeLifecycleIntents.serviceId, svc.id), notInArray(nodeLifecycleIntents.phase, ['completed', 'superseded']))).limit(1);
  if (intent.length) return 'a Start, Stop or Restart is pending';
  const sleep = await db.select({ id: nodeSleepTransitions.serviceId }).from(nodeSleepTransitions).where(nodeSleepAutomationBlock(svc.id, svc.runtimeId)).limit(1);
  if (sleep.length) return 'a sleep or wake is pending';
  return null;
}

/**
 * Request the Stop, as the Stop button does, when nothing blocks it on a fresh
 * read of the service. Returns false when it did not (the service changed).
 */
export async function requestNodeRestartStop(db: DB, svc: Service): Promise<boolean> {
  const fresh = await db.query.services.findFirst({ where: eq(services.id, svc.id) });
  if (!fresh || fresh.runtimeId !== svc.runtimeId || fresh.serverId !== svc.serverId || fresh.type !== 'docker' || fresh.orchestrator === 'swarm') return false;
  if (await nodeRestartStopBlocked(db, fresh)) return false;
  await acceptNodeLifecycleIntent(db, fresh, 'stop');
  return true;
}
