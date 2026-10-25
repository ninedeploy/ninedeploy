import { eq, desc, type DB, type Service, nodeLifecycleIntents } from '@ninedeploy/db';
import { and, inArray, isNull, lte, or } from 'drizzle-orm';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { capabilityRefusal } from './agentCapabilities.js';
import { executeNodeLifecycleIntent, type NodeLifecycleControllerDeps } from './nodeLifecycleController.js';
import { writeDynamicConfig } from '../engine/proxy.js';
import { HttpError } from './errors.js';

export async function assertNodeLifecycleAvailable(db: DB, service: Service, options: { signal?: AbortSignal } = {}): Promise<void> {
  options.signal?.throwIfAborted();
  if (service.serverId == null) throw new HttpError(422, 'node_lifecycle_unsupported', 'Ordered lifecycle requires a node');
  const sealed = options.signal ? await agentTransportSealed(db, service.serverId, options.signal) : await agentTransportSealed(db, service.serverId);
  const refusal = await capabilityRefusal((op, params, sink) => agentOp(db, service.serverId!, op, params, sink, { timeoutMs: 5000, ...(options.signal ? { signal: options.signal } : {}) }),
    `#${service.serverId}`, sealed, {
      cap: ['docker.lifecycle', 'docker.recovery', 'docker.readiness', 'proxy.routingAck'], feature: 'execute ordered node lifecycle commands', sealedRequired: true,
    });
  options.signal?.throwIfAborted();
  if (refusal) throw new HttpError(refusal.status, refusal.code, refusal.message);
}

export function nodeLifecycleRuntime(db: DB, options: { signal?: AbortSignal; log?: (line: string) => void } = {}): NodeLifecycleControllerDeps {
  return {
    agent: (id, op, params, opts) => agentOp(db, id, op, params, () => undefined, opts),
    sealed: id => options.signal ? agentTransportSealed(db, id, options.signal) : agentTransportSealed(db, id),
    route: (service, parent) => {
      const signal = AbortSignal.any([...(parent ? [parent] : []), AbortSignal.timeout(60_000)]);
      signal.throwIfAborted();
      return new Promise<void>((resolve, reject) => {
        const cancelled = () => reject(signal.reason);
        signal.addEventListener('abort', cancelled, { once: true });
        // A queued write also observes cancellation before touching any proxy.
        void writeDynamicConfig(db, { requireNode: service.serverId!, confirmNodeRouting: true, confirmServiceId: service.id, signal })
          .then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled));
      });
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), ...options,
  };
}

/** One bounded batch. Expired leases and held commands recover through the same dispatcher. */
export async function reconcileNodeLifecycleIntents(db: DB, options: { signal?: AbortSignal; log?: (line: string) => void; limit?: number;
  settled?: (serviceId: number, action: 'start' | 'stop' | 'restart', id: number) => Promise<void>;
  held?: (serviceId: number, action: 'start' | 'stop' | 'restart', id: number) => Promise<void> } = {}) {
  options.signal?.throwIfAborted();
  const now = new Date();
  const due = await db.select().from(nodeLifecycleIntents).where(and(
    inArray(nodeLifecycleIntents.phase, ['fencing', 'preparing', 'routing', 'applying', 'readiness', 'starting', 'warming', 'publishing']),
    lte(nodeLifecycleIntents.nextAttemptAt, now), or(isNull(nodeLifecycleIntents.leaseUntil), lte(nodeLifecycleIntents.leaseUntil, now)),
  )).orderBy(nodeLifecycleIntents.nextAttemptAt, nodeLifecycleIntents.id).limit(Math.min(4, Math.max(1, options.limit ?? 4)));
  return Promise.all(due.map(async row => {
    try {
      const result = await executeNodeLifecycleIntent(db, row.id, nodeLifecycleRuntime(db, options));
      if (result.state === 'completed') await options.settled?.(row.serviceId, row.action, row.id);
      if (result.state === 'held' && !options.signal?.aborted) await options.held?.(row.serviceId, row.action, row.id);
      return { id: row.id, ...result };
    } catch (error) {
      options.log?.(`Node lifecycle #${row.id} unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return { id: row.id, state: 'failed' as const };
    }
  }));
}

export async function publicNodeLifecycle(db: DB, service: Service, commandId?: number) {
  const row = await db.query.nodeLifecycleIntents.findFirst({ where: and(eq(nodeLifecycleIntents.serviceId, service.id), commandId == null ? undefined : eq(nodeLifecycleIntents.id, commandId)), orderBy: desc(nodeLifecycleIntents.id) });
  if (!row) return { command: null };
  const latest = commandId == null ? row.id : (await db.select({ id: nodeLifecycleIntents.id }).from(nodeLifecycleIntents).where(eq(nodeLifecycleIntents.serviceId, service.id)).orderBy(desc(nodeLifecycleIntents.id)).limit(1))[0]?.id;
  const current = row.id === latest && row.phase !== 'superseded' && service.type === 'docker' && service.orchestrator !== 'swarm' && service.serverId === row.serverId && service.runtimeId === row.runtimeId;
  const busy = !!row.ownerToken && !!row.leaseUntil && row.leaseUntil.getTime() > Date.now();
  return { command: { id: row.id, action: row.action, phase: row.phase, reason: row.reason, attempts: row.attempts,
    busy, current, retryable: current && !busy && row.phase !== 'completed' && row.phase !== 'superseded',
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), nextAttemptAt: row.nextAttemptAt.toISOString() } };
}
