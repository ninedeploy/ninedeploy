import { eq, nodeSleepTransitions, services, type DB, type NodeSleepTransition } from '@ninedeploy/db';
import { inArray, ne } from 'drizzle-orm';
import { nodeWakeMaintenance } from '@ninedeploy/db';
import { admitNodeWake, holdNodeSleep, recoverNodeSleep, type NodeSleepAdmission } from './nodeSleepAuthority.js';
import { readNodeWakeDemand } from './nodeWakeCatcherClient.js';
import { executeNodeWake, type NodeWakeControllerDeps } from './nodeWakeController.js';
import { nodeWakeRuntime } from './nodeWakeRuntime.js';
import { claimNodeWakeMaintenance, holdNodeWakeMaintenance } from './nodeWakeMaintenance.js';
import { executeNodeWakeMaintenance, type NodeWakeMaintenanceDeps } from './nodeWakeMaintenanceController.js';
import { nodeWakeMaintenanceRuntime } from './nodeWakeMaintenanceRuntime.js';

export const NODE_WAKE_POLL_MS = 2000;
const MAX_NODES = 4, MAX_WAKES = 4, RETRY_MS = 30_000;
const active = ['accepted', 'fencing', 'starting', 'readiness', 'publishing'] as const;

/** Bounded coordinator. Catcher recovery requires the maintenance option and durable authority. */
export function createNodeWakePoller(db: DB, options: {
  runtime?: (signal: AbortSignal) => NodeWakeControllerDeps;
  /** Enable durable catcher maintenance; the production sleeper supplies this option. */
  recoverCatchers?: boolean;
  maintenanceRuntime?: (signal: AbortSignal) => NodeWakeMaintenanceDeps;
  now?: () => number;
  onError?: (error: unknown) => void;
} = {}) {
  const abort = new AbortController(), now = options.now ?? (() => performance.now());
  const nodes = new Map<number, Promise<void>>(), jobs = new Map<number, Promise<void>>();
  const loads = new Set<Promise<void>>();
  const nodeRetry = new Map<string, number>(), serviceRetry = new Map<number, number>();
  const maintenanceRetry = new Map<number, number>();
  let closed = false, loading = false, lastNode = 0;
  const recoverCatcher = async (nodeId: number) => {
    if (closed || !options.recoverCatchers || now() < (maintenanceRetry.get(nodeId) ?? 0)) return;
    const claim = await claimNodeWakeMaintenance(db, nodeId);
    if (!claim) return;
    if (closed) { await holdNodeWakeMaintenance(db, claim, 'node wake poller stopped before maintenance'); return; }
    const runtime = options.maintenanceRuntime?.(abort.signal) ?? nodeWakeMaintenanceRuntime(db, { signal: abort.signal });
    const result = await executeNodeWakeMaintenance(db, claim, { ...runtime, signal: abort.signal });
    if (result.state === 'held') maintenanceRetry.set(nodeId, now() + RETRY_MS);
    else maintenanceRetry.delete(nodeId);
  };
  const dispatch = (serviceId: number, admit: () => Promise<NodeSleepAdmission | null>) => {
    if (closed || jobs.has(serviceId) || jobs.size >= MAX_WAKES || now() < (serviceRetry.get(serviceId) ?? 0)) return;
    const job = Promise.resolve().then(async () => {
      const admission = await admit();
      if (!admission) return;
      if (closed) { await holdNodeSleep(db, admission, 'node wake poller stopped before dispatch'); return; }
      const runtime = options.runtime?.(abort.signal) ?? nodeWakeRuntime(db, { signal: abort.signal });
      const result = await executeNodeWake(db, admission, { ...runtime, signal: abort.signal });
      if (result.state === 'held') serviceRetry.set(serviceId, now() + RETRY_MS);
    }).catch(error => {
      serviceRetry.set(serviceId, now() + RETRY_MS);
      if (!closed) options.onError?.(error);
    }).finally(() => { if (jobs.get(serviceId) === job) jobs.delete(serviceId); });
    jobs.set(serviceId, job);
  };
  const poll = async (nodeId: number, groups: Map<string, NodeSleepTransition[]>) => {
    for (const [catcherId, rows] of groups) {
      const key = `${nodeId}:${catcherId}`;
      if (closed || now() < (nodeRetry.get(key) ?? 0)) continue;
      try {
        // Stateless lookback survives panel restart. Admission is one-use in SQLite,
        // so rereading a token cannot start another wake or the next sleep cycle.
        const receipt = await readNodeWakeDemand(db, nodeId, catcherId, Math.max(0, Date.now() - 60_000), abort.signal, rows[0]!.catcherName);
        if (closed) return;
        nodeRetry.delete(key);
        for (const item of receipt.items) {
          const row = rows.find(row => row.wakeToken === item.token);
          if (!row) continue;
          dispatch(row.serviceId, async () => {
            if (closed) return null;
            const service = await db.query.services.findFirst({ where: eq(services.id, row.serviceId) });
            if (!service || closed) return null;
            return admitNodeWake(db, service, { nodeId, token: item.token, catcherId, demandAt: item.lastAt, receivedAt: receipt.receivedAt });
          });
        }
      } catch (error) {
        nodeRetry.set(key, now() + RETRY_MS);
        if (!closed) options.onError?.(error);
        if (!closed && options.recoverCatchers) {
          try { await recoverCatcher(nodeId); }
          catch (recoveryError) { maintenanceRetry.set(nodeId, now() + RETRY_MS); if (!closed) options.onError?.(recoveryError); }
        }
      }
    }
  };
  const settle = async () => {
    await Promise.allSettled([...loads, ...nodes.values()]);
    await Promise.allSettled([...jobs.values()]);
  };
  return {
    /** Drain currently admitted work; callers must stop scheduling ticks to quiesce. */
    settle,
    async tick(): Promise<void> {
      if (closed || loading) return;
      loading = true;
      let finishLoad!: () => void;
      const load = new Promise<void>(resolve => { finishLoad = resolve; }); loads.add(load);
      const started: Promise<void>[] = [];
      try {
        const rows = await db.select().from(nodeSleepTransitions).where(inArray(nodeSleepTransitions.phase, ['asleep', ...active]));
        if (closed) return;
        const maintenance = options.recoverCatchers
          ? await db.select().from(nodeWakeMaintenance).where(ne(nodeWakeMaintenance.phase, 'completed')) : [];
        if (closed) return;
        const maintenanceNodes = new Set(maintenance.map(row => row.serverId));
        for (const id of maintenanceRetry.keys()) if (!maintenanceNodes.has(id)) maintenanceRetry.delete(id);
        for (const row of maintenance) {
          if (nodes.has(row.serverId) || nodes.size >= MAX_NODES || now() < (maintenanceRetry.get(row.serverId) ?? 0)) continue;
          const job = recoverCatcher(row.serverId).catch(error => {
            maintenanceRetry.set(row.serverId, now() + RETRY_MS); if (!closed) options.onError?.(error);
          }).finally(() => { if (nodes.get(row.serverId) === job) nodes.delete(row.serverId); });
          nodes.set(row.serverId, job); started.push(job);
        }
        const known = new Set(rows.map(row => row.serviceId));
        for (const id of serviceRetry.keys()) if (!known.has(id)) serviceRetry.delete(id);
        // Recovery does not need another visitor request. It retains command identity
        // and lets the controller repeat readiness before publication.
        for (const row of rows) {
          if (row.action !== 'wake' || row.phase === 'asleep' || row.leaseUntil && row.leaseUntil.getTime() > Date.now()) continue;
          dispatch(row.serviceId, async () => closed ? null : recoverNodeSleep(db, row.serviceId, row));
        }
        const grouped = new Map<number, Map<string, NodeSleepTransition[]>>(), bindings = new Set<string>();
        for (const row of rows) {
          if (row.action !== 'sleep' || row.phase !== 'asleep' || !row.catcherId) continue;
          const group = grouped.get(row.serverId) ?? new Map<string, NodeSleepTransition[]>();
          group.set(row.catcherId, [...(group.get(row.catcherId) ?? []), row]); grouped.set(row.serverId, group);
          bindings.add(`${row.serverId}:${row.catcherId}`);
        }
        for (const key of nodeRetry.keys()) if (!bindings.has(key)) nodeRetry.delete(key);
        const ids = [...grouped.keys()].sort((a, b) => a - b);
        const ordered = [...ids.filter(id => id > lastNode), ...ids.filter(id => id <= lastNode)];
        for (const id of ordered) {
          if (nodes.has(id)) continue;
          if (nodes.size >= MAX_NODES) break;
          const job = poll(id, grouped.get(id)!).finally(() => { if (nodes.get(id) === job) nodes.delete(id); });
          nodes.set(id, job); started.push(job); lastNode = id;
        }
      } catch (error) { if (!closed) options.onError?.(error); }
      finally { loading = false; finishLoad(); loads.delete(load); }
      await Promise.allSettled(started);
    },
    async close(): Promise<void> {
      closed = true; abort.abort(new Error('Node wake poller stopped'));
      await settle();
    },
  };
}
