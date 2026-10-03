import { lt } from 'drizzle-orm';
import { cpus } from 'node:os';
import { metrics, services } from '@ninedeploy/db';
import fp from 'fastify-plugin';
import { collectContainerStats, collectHostStats, type ContainerStat, type HostStat } from '../lib/stats.js';
import { evaluateAlerts, type MetricSnapshot } from '../lib/alerting.js';
import { readCertificates } from '../engine/proxy.js';

const INTERVAL_MS = 30_000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Host CPU % between two os.cpus() samples (null on the first tick — no delta yet). */
export function cpuDeltaPct(prev: ReturnType<typeof cpus> | null, now: ReturnType<typeof cpus>): number | null {
  if (!prev || prev.length !== now.length) return null;
  let idle = 0;
  let total = 0;
  for (let i = 0; i < now.length; i++) {
    const nowTimes = now[i]!.times as Record<string, number>;
    const prevTimes = prev[i]!.times as Record<string, number>;
    const nowTotal = Object.values(nowTimes).reduce((a, b) => a + b, 0);
    const prevTotal = Object.values(prevTimes).reduce((a, b) => a + b, 0);
    idle += (nowTimes.idle ?? 0) - (prevTimes.idle ?? 0);
    total += nowTotal - prevTotal;
  }
  if (total <= 0) return null;
  return Math.round(((total - idle) / total) * 100);
}

export interface StatsCache {
  containers: Map<string, ContainerStat>;
  host: HostStat | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    stats: { raw: () => StatsCache };
  }
}

/** Periodically samples container/host stats, persists service metrics, and caches the latest snapshot. */
export default fp(
  async (fastify) => {
    let cache: StatsCache = { containers: new Map(), host: null };
    let running = true;
    let timer: NodeJS.Timeout | undefined;
    let prevCpu: ReturnType<typeof cpus> | null = null;

    const tick = async () => {
      try {
        const containers = await collectContainerStats();
        cache = { containers, host: await collectHostStats() };

        const all = await fastify.db.select().from(services);
        const now = new Date();
        const rows: Array<{ serviceId: number; kind: string; value: number; ts: Date }> = [];
        for (const s of all) {
          const st = (s.runtimeId ? containers.get(s.runtimeId) : undefined) ?? containers.get(`nd-app-${s.slug}`);
          if (!st) continue;
          rows.push({ serviceId: s.id, kind: 'cpu', value: Math.round(st.cpuPct * 100), ts: now });
          rows.push({ serviceId: s.id, kind: 'memory', value: st.memBytes, ts: now });
        }
        if (rows.length) await fastify.db.insert(metrics).values(rows);

        // Feed the alert evaluator in rule units (cpu %, memory MiB; null = host).
        const snapshots: MetricSnapshot[] = rows.map((r) => ({
          serviceId: r.serviceId,
          kind: r.kind,
          value: r.kind === 'memory' ? Math.round(r.value / (1024 * 1024)) : +(r.value / 100).toFixed(1),
        }));
        if (cache.host) {
          const h = cache.host;
          // Host CPU: real utilisation from os.cpus() deltas (not memory % or a
          // made-up load heuristic — alerts on host cpu must mean host cpu).
          const cpuNow = cpus();
          const hostCpu = cpuDeltaPct(prevCpu, cpuNow) ?? Math.round((h.load1 / Math.max(h.cpuCores, 1)) * 100);
          prevCpu = cpuNow;
          snapshots.push({ serviceId: null, kind: 'cpu', value: Math.min(hostCpu, 100) });
          snapshots.push({ serviceId: null, kind: 'memory', value: Math.round(h.memUsedBytes / (1024 * 1024)) });
        }

        // Cert-expiry alerting: the least days remaining across all issued certs.
        const certExpiries = readCertificates()
          .map((c) => c.expiresAt)
          .filter((d): d is Date => d !== null);
        if (certExpiries.length) {
          const minDays = Math.floor((Math.min(...certExpiries.map((d) => d.getTime())) - now.getTime()) / 86_400_000);
          snapshots.push({ serviceId: null, kind: 'cert-expiry', value: minDays });
        }

        await evaluateAlerts(fastify.db, snapshots);

        await fastify.db.delete(metrics).where(lt(metrics.ts, new Date(Date.now() - RETENTION_MS)));
      } catch (err) {
        fastify.log.error({ err }, 'metrics collection failed');
      } finally {
        if (running) {
          timer = setTimeout(() => void tick(), INTERVAL_MS);
          timer.unref?.();
        }
      }
    };

    fastify.decorate('stats', { raw: () => cache });
    fastify.addHook('onClose', async () => {
      running = false;
      clearTimeout(timer);
    });

    timer = setTimeout(() => void tick(), 5000);
    timer.unref?.();
    fastify.log.info('metrics collector started');
  },
  { name: 'ninedeploy-collector' },
);
