import { metrics, type DB, type Service } from '@ninedeploy/db';
import { replicaNames } from '../engine/dockerNames.js';
import { agentOp } from './agentClient.js';
import { evaluateAlerts } from './alerting.js';
import type { ContainerStat } from './stats.js';

/** Host identity is part of the key: two daemons can own the same name. */
export type NodeContainerStats = Map<number, Map<string, ContainerStat>>;
const NODE_STATS_TIMEOUT_MS = 20_000;

/** Parse only valid samples. Unknown/malformed metrics never become zeroes. */
export function parseNodeContainerStats(lines: readonly string[]): Map<string, ContainerStat> {
  const out = new Map<string, ContainerStat>();
  for (const line of lines) {
    const match = /^\/?([A-Za-z0-9][A-Za-z0-9_.-]*)\|([\d.]+)%\|\s*([\d.]+)\s*([KMGT]?i?B)\s*\//i.exec(line);
    if (!match) continue;
    const cpuPct = Number(match[2]);
    const size = Number(match[3]);
    const unit = match[4]!.toLowerCase();
    const power = ['b', 'kb', 'mb', 'gb', 'tb'].indexOf(unit.replace('i', ''));
    const memBytes = size * 1024 ** power;
    if (![cpuPct, memBytes].every((n) => Number.isFinite(n) && n >= 0) || power < 0) continue;
    out.set(match[1]!, { name: match[1]!, cpuPct, memBytes, memLimitBytes: 0 });
  }
  return out;
}

/** Sum the actually serving replicas; an incomplete sample stays unknown. */
export function nodeServiceStat(service: Pick<Service, 'runtimeId' | 'runtimeReplicas' | 'replicas' | 'memLimitMb'>, containers: ReadonlyMap<string, ContainerStat> | undefined): ContainerStat | undefined {
  if (!service.runtimeId || !containers) return undefined;
  const samples = replicaNames(service.runtimeId, service.runtimeReplicas ?? service.replicas ?? 1).map((name) => containers.get(name));
  if (samples.some((s) => !s)) return undefined;
  return {
    name: service.runtimeId,
    cpuPct: samples.reduce((n, s) => n + s!.cpuPct, 0),
    memBytes: samples.reduce((n, s) => n + s!.memBytes, 0),
    memLimitBytes: (service.memLimitMb ?? 0) * 1024 * 1024 * samples.length,
  };
}

/** Runs separately from local collection, with bounded concurrency and cancellation. */
export async function collectNodeMetrics(db: DB, services: readonly Service[], cache: NodeContainerStats, signal: AbortSignal, onError: (err: unknown) => void): Promise<void> {
  const ids = [...new Set(services.flatMap((s) => s.serverId == null ? [] : [s.serverId]))];
  for (const id of cache.keys()) if (!ids.includes(id)) cache.delete(id);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (!signal.aborted && next < ids.length) {
      const id = ids[next++]!;
      try {
        const response = await agentOp(db, id, 'agent.stats', {}, () => undefined, { timeoutMs: NODE_STATS_TIMEOUT_MS, signal });
        if (signal.aborted) return;
        if (response.exitCode !== 0) throw new Error(`Node #${id} stats exited with ${response.exitCode}`);
        const containers = parseNodeContainerStats(response.lines);
        cache.set(id, containers);
        const now = new Date();
        const rows: Array<{ serviceId: number; kind: string; value: number; ts: Date }> = [];
        for (const svc of services) {
          if (svc.serverId !== id || svc.orchestrator === 'swarm') continue;
          const stat = nodeServiceStat(svc, containers);
          if (!stat) continue;
          rows.push({ serviceId: svc.id, kind: 'cpu', value: Math.round(stat.cpuPct * 100), ts: now });
          rows.push({ serviceId: svc.id, kind: 'memory', value: stat.memBytes, ts: now });
        }
        if (rows.length) {
          await db.insert(metrics).values(rows);
          await evaluateAlerts(db, rows.map((r) => ({ serviceId: r.serviceId, kind: r.kind, value: r.kind === 'memory' ? Math.round(r.value / (1024 * 1024)) : r.value / 100 })));
        }
      } catch (err) {
        cache.delete(id);
        if (!signal.aborted) onError(err);
      }
    }
  }));
}
