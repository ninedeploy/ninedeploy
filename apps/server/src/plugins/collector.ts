import { cpus } from 'node:os';
import { isNotNull } from 'drizzle-orm';
import { databases, servers, services } from '@ninedeploy/db';
import { persistServiceMetrics, pruneServiceMetrics } from '../lib/serviceMetricHistory.js';
import fp from 'fastify-plugin';
import { collectContainerStats, collectHostStats, type ContainerStat, type HostStat } from '../lib/stats.js';
import { evaluateAlerts, type MetricSnapshot } from '../lib/alerting.js';
import { trafficAlertSnapshots } from '../lib/trafficAlerts.js';
import { createNodeHealthWatch } from '../lib/nodeHealth.js';
import { readCertificates } from '../engine/proxy.js';
import { measurableSwarmTasks, swarmRuntimeOf, swarmServiceStat } from '../lib/swarm.js';
import { collectNodeMetrics, NODE_METRIC_MAX_AGE_MS, type NodeContainerStats, type NodeMetricSamples } from '../lib/nodeMetrics.js';
import { DISK_SAMPLE_SECONDS, sampleServiceDisk } from '../lib/diskUsage.js';
import { measureNodeVolume } from '../lib/nodeVolumes.js';

const INTERVAL_MS = 30_000;

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
  sampledAt?: number;
  host: HostStat | null;
  nodeContainers?: NodeContainerStats;
  nodeSamples?: NodeMetricSamples;
  /** P1: per Swarm service id, one task's worth over every running task; absent = unknown. */
  swarmStats?: Map<number, ContainerStat>;
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
    /** When disk was last sampled (0: on the first cycle). */
    let lastDiskSampleAt = 0;
    const nodeContainers: NodeContainerStats = new Map();
    const nodeSamples: NodeMetricSamples = new Map();
    const nodeAbort = new AbortController();
    let nodeCycle: Promise<void> | undefined;
    const nodeHealth = createNodeHealthWatch();

    const tick = async () => {
      try {
        const containers = await collectContainerStats();
        const sampledAt = Date.now();
        // The previous tick's Swarm figures stay until this tick's replace them (no gap for the stats routes).
        cache = { containers, sampledAt, host: await collectHostStats(), nodeContainers, nodeSamples, ...(cache.swarmStats ? { swarmStats: cache.swarmStats } : {}) };

        const all = await fastify.db.select().from(services);
        // P1: a Swarm service's tasks on workers that joined through NineDeploy are measured through their agents.
        const swarmServices = all.filter((s) => s.serverId == null && swarmRuntimeOf(s));
        const swarmWorkers = swarmServices.length
          ? (await fastify.db.select({ id: servers.id }).from(servers).where(isNotNull(servers.swarmNodeId))).map((r) => r.id)
          : [];
        if (!nodeCycle && running) {
          const databaseRows = await fastify.db.select({ serverId: databases.serverId, status: databases.status }).from(databases);
          nodeCycle = collectNodeMetrics(fastify.db, all, nodeContainers, nodeAbort.signal,
            (err) => fastify.log.warn({ err }, 'node metrics collection failed'), {
              serverIds: [...databaseRows.flatMap(row => row.serverId != null && row.status === 'running' ? [row.serverId] : []), ...swarmWorkers], samples: nodeSamples,
            })
            .catch((err) => fastify.log.warn({ err }, 'node metrics collection failed'))
            .finally(() => { nodeCycle = undefined; });
        }
        // P1: every running task of a Swarm service, from the panel host and each joined worker's fresh sample.
        const swarmStats = new Map<number, ContainerStat>();
        if (swarmServices.length) {
          const fresh = [...nodeContainers].filter(([id]) => (nodeSamples.get(id)?.sampledAt ?? 0) > Date.now() - NODE_METRIC_MAX_AGE_MS).map(([, m]) => m);
          for (const s of swarmServices) {
            const runtime = swarmRuntimeOf(s)!;
            const tasks = await measurableSwarmTasks(runtime).catch(() => null);
            const st = tasks ? swarmServiceStat(runtime, tasks, [containers, ...fresh], s.memLimitMb ?? 0) : undefined;
            if (st) swarmStats.set(s.id, st);
          }
        }
        cache = { ...cache, swarmStats };

        const now = new Date();
        const rows: Array<{ serviceId: number; kind: string; value: number; ts: Date }> = [];
        for (const s of all) {
          if (s.serverId != null) continue;
          // 0.16 T7, R2, P1: a Swarm service's metrics are one task's worth over every running task (unknown unless all were measured).
          const swarmRuntime = swarmRuntimeOf(s);
          const st = swarmRuntime
            ? swarmStats.get(s.id)
            : ((s.runtimeId ? containers.get(s.runtimeId) : undefined) ?? containers.get(`nd-app-${s.slug}`));
          if (!st) continue;
          rows.push({ serviceId: s.id, kind: 'cpu', value: Math.round(st.cpuPct * 100), ts: now });
          rows.push({ serviceId: s.id, kind: 'memory', value: st.memBytes, ts: now });
        }
        if (rows.length) await persistServiceMetrics(fastify.db, rows);

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

        // disk % (panel host + nodes) and server_offline minutes (0.12). Its
        // own guard: a node probe failure must not cost the local samples.
        try {
          snapshots.push(...(await nodeHealth.cycle(fastify.db, now)));
        } catch (err) {
          fastify.log.warn({ err }, 'node health probe failed');
        }

        // Error rate and p95 latency per service from traffic analytics (ROADMAP item 7).
        try {
          snapshots.push(...(await trafficAlertSnapshots(fastify.db, now.getTime())));
        } catch (err) {
          fastify.log.warn({ err }, 'traffic alert sampling failed');
        }

        await evaluateAlerts(fastify.db, snapshots);

        // Disk per service for the usage report, hourly (ROADMAP item 9). Not awaited: measuring
        // many volumes must not delay the 30-second samples; the hour gap keeps runs from overlapping.
        if (now.getTime() - lastDiskSampleAt >= DISK_SAMPLE_SECONDS * 1000) {
          lastDiskSampleAt = now.getTime();
          void sampleServiceDisk(fastify.db, { nodeSize: (serverId, volume) => measureNodeVolume(fastify.db, serverId, volume) }, now).catch((err: unknown) =>
            fastify.log.warn({ err }, 'disk usage sampling failed'),
          );
        }

        await pruneServiceMetrics(fastify.db);
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
      nodeAbort.abort();
      await nodeCycle;
    });

    timer = setTimeout(() => void tick(), 5000);
    timer.unref?.();
    fastify.log.info('metrics collector started');
  },
  { name: 'ninedeploy-collector' },
);
