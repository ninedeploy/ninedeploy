import { eq, isNotNull, isNull, notInArray, and } from 'drizzle-orm';
import { nodeSleepTransitions, services, type DB } from '@ninedeploy/db';
import type { createNodeIdleScheduler } from './nodeIdleScheduler.js';
import { admitNodeSleep, recoverNodeSleep, holdNodeSleep, type NodeSleepAdmission } from './nodeSleepAuthority.js';
import { executeNodeSleep, type NodeSleepControllerDeps } from './nodeSleepController.js';
import { nodeSleepRuntime } from './nodeSleepRuntime.js';

export const MAX_NODE_SLEEPS = 4;
const RETRY_MS = 30_000;

/** Bounded sleep admission/recovery. Only a fresh opaque scheduler proof can start a new sleep. */
export function createNodeSleepCoordinator(db: DB, options: {
  idle: Pick<ReturnType<typeof createNodeIdleScheduler>, 'takeEvidence'>;
  runtime?: (signal: AbortSignal) => NodeSleepControllerDeps;
  now?: () => number;
  onError?: (error: unknown) => void;
}) {
  const abort = new AbortController(), now = options.now ?? (() => performance.now());
  const jobs = new Map<number, Promise<void>>(), retries = new Map<number, number>();
  let closed = false, load: Promise<void> | undefined, lastService = 0;
  const dispatch = (id: number, admit: () => Promise<NodeSleepAdmission | null>) => {
    if (closed || jobs.has(id) || jobs.size >= MAX_NODE_SLEEPS || now() < (retries.get(id) ?? 0)) return;
    const job = Promise.resolve().then(async () => {
      if (closed) return;
      const admission = await admit();
      if (!admission) return;
      if (closed) { await holdNodeSleep(db, admission, 'Node sleep coordinator stopped before dispatch'); return; }
      const runtime = options.runtime?.(abort.signal) ?? nodeSleepRuntime(db, { signal: abort.signal });
      const result = await executeNodeSleep(db, admission, { ...runtime, signal: abort.signal });
      if (result.state === 'held') retries.set(id, now() + RETRY_MS);
      else retries.delete(id);
    }).catch(error => {
      retries.set(id, now() + RETRY_MS); if (!closed) options.onError?.(error);
    }).finally(() => { if (jobs.get(id) === job) jobs.delete(id); });
    jobs.set(id, job);
  };
  const settle = async () => { await load; await Promise.allSettled([...jobs.values()]); };
  return {
    settle,
    async tick(): Promise<void> {
      if (closed || load) return;
      load = Promise.resolve().then(async () => {
        const pending = await db.select().from(nodeSleepTransitions).where(and(eq(nodeSleepTransitions.action, 'sleep'),
          notInArray(nodeSleepTransitions.phase, ['asleep', 'completed', 'superseded'])));
        if (closed) return;
        // Recover the existing command before taking any new observation proof.
        for (const row of pending) {
          if (row.leaseUntil && row.leaseUntil.getTime() > Date.now()) continue;
          dispatch(row.serviceId, async () => closed ? null : recoverNodeSleep(db, row.serviceId, row));
        }
        const candidates = await db.select().from(services).where(and(isNotNull(services.sleepAfterMinutes), isNotNull(services.serverId),
          eq(services.type, 'docker'), eq(services.status, 'running'), isNull(services.asleepAt)));
        if (closed) return;
        const known = new Set([...pending.map(row => row.serviceId), ...candidates.map(row => row.id)]);
        for (const id of retries.keys()) if (!known.has(id)) retries.delete(id);
        const ordered = [...candidates.filter(row => row.id > lastService), ...candidates.filter(row => row.id <= lastService)]
          .sort((a, b) => (a.id <= lastService ? 1 : 0) - (b.id <= lastService ? 1 : 0) || a.id - b.id);
        for (const service of ordered) {
          if (jobs.size >= MAX_NODE_SLEEPS) break;
          if (service.orchestrator === 'swarm' || !service.runtimeId || !service.port) continue;
          if (pending.some(row => row.serviceId === service.id) || jobs.has(service.id)) continue;
          dispatch(service.id, async () => {
            if (closed) return null;
            // Consume evidence only inside an already reserved execution slot.
            const evidence = options.idle.takeEvidence(service);
            return evidence ? admitNodeSleep(db, service, evidence) : null;
          });
          lastService = service.id;
        }
      }).catch(error => { if (!closed) options.onError?.(error); }).finally(() => { load = undefined; });
      await load;
    },
    async close(): Promise<void> {
      closed = true; abort.abort(new Error('Node sleep coordinator stopped'));
      await settle();
    },
  };
}
