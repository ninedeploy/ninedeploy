import fp from 'fastify-plugin';
import { deployments, type Service, services } from '@ninedeploy/db';
import { and, inArray, isNotNull } from 'drizzle-orm';
import { dockerBuilder } from '../engine/builders/docker.js';
import { canaryActive } from '../engine/canaryState.js';
import { writeDynamicConfig } from '../engine/proxy.js';
import { audit } from '../lib/audit.js';
import { AUTOSCALE_IN_FLIGHT, AUTOSCALE_PROBE_MS, AUTOSCALE_TICK_MS, type AutoscaleDeps, autoscaleOf, autoscaleStep } from '../lib/autoscaler.js';
import { run, sleep } from '../lib/exec.js';
import type { ContainerStat } from '../lib/stats.js';
import { trafficAnalyticsEnabled } from '../lib/trafficAnalytics.js';
import { reconcileNodeAutoscale } from '../lib/nodeAutoscaleRecovery.js';

/**
 * 0.16.10: runs lib/autoscaler.ts every 30 s over the services that have an
 * autoscale configuration, on the container stats the collector caches. A
 * service is never looked at twice at once (scaling up waits for the new
 * container's healthcheck). Each tick also resumes expired node scale work,
 * including when autoscaling was disabled after an interrupted operation.
 */
export function createAutoscaler(deps: {
  load: () => Promise<Service[]>;
  inFlightDeploys: () => Promise<Set<number>>;
  containers: () => ReadonlyMap<string, ContainerStat>;
  sampledAt?: () => number | undefined;
  analyticsOn: () => Promise<boolean>;
  canaryRunning: (serviceId: number) => boolean;
  step: AutoscaleDeps;
  recover?: (signal: AbortSignal) => Promise<unknown>;
  now?: () => number;
  onError?: (err: unknown) => void;
}) {
  const busy = new Set<number>();
  const pending = new Set<Promise<void>>();
  const abort = new AbortController();
  let stopped = false;
  let ticking: Promise<number> | undefined;
  let stopping: Promise<void> | undefined;
  const runTick = async (): Promise<number> => {
      let looked = 0;
      try {
        if (deps.recover) {
          try { await deps.recover(abort.signal); } catch (err) { if (!stopped) deps.onError?.(err); }
          if (stopped) return 0;
        }
        const list = (await deps.load()).filter((s) => autoscaleOf(s) !== null);
        if (stopped || list.length === 0) return 0;
        const inFlight = await deps.inFlightDeploys();
        if (stopped) return 0;
        const analyticsOn = await deps.analyticsOn().catch(() => false);
        if (stopped) return 0;
        const containers = deps.containers();
        const sampledAt = deps.sampledAt?.();
        const now = (deps.now ?? Date.now)();
        for (const svc of list) {
          if (stopped || busy.has(svc.id)) continue;
          busy.add(svc.id);
          looked++;
          const job = autoscaleStep({ ...deps.step, signal: abort.signal }, svc, autoscaleOf(svc)!, {
            containers,
            analyticsOn,
            inFlight,
            canaryRunning: deps.canaryRunning(svc.id),
            now,
            ...(deps.sampledAt ? { sampledAt: sampledAt ?? null } : {}),
          })
            .then(() => undefined)
            .catch((err) => { if (!stopped) deps.onError?.(err); })
            .finally(() => { busy.delete(svc.id); pending.delete(job); });
          pending.add(job);
        }
      } catch (err) {
        if (!stopped) deps.onError?.(err);
      }
      return looked;
  };
  return {
    busy,
    tick(): Promise<number> {
      if (stopped) return Promise.resolve(0);
      ticking ??= runTick().finally(() => { ticking = undefined; });
      return ticking;
    },
    stop(): Promise<void> {
      stopped = true; abort.abort();
      stopping ??= (async () => { await ticking; await Promise.allSettled([...pending]); })();
      return stopping;
    },
  };
}

export default fp(
  async (fastify) => {
    const scaler = createAutoscaler({
      recover: signal => reconcileNodeAutoscale(fastify.db, { signal, log: line => fastify.log.warn({ component: 'autoscaler' }, line) }),
      load: async () => {
        try {
          return await fastify.db.select().from(services).where(isNotNull(services.autoscale));
        } catch {
          return []; // pre-migration
        }
      },
      inFlightDeploys: async () =>
        new Set(
          (
            await fastify.db
              .select({ serviceId: deployments.serviceId })
              .from(deployments)
              .where(and(inArray(deployments.status, [...AUTOSCALE_IN_FLIGHT])))
          ).map((r) => r.serviceId),
        ),
      containers: () => fastify.stats?.raw().containers ?? new Map(),
      sampledAt: () => fastify.stats?.raw().sampledAt,
      analyticsOn: () => trafficAnalyticsEnabled(fastify.db),
      canaryRunning: canaryActive,
      step: {
        db: fastify.db,
        docker: async (args) => {
          await run('docker', args, { timeoutMs: 15_000 }, () => undefined);
        },
        probe: (svc, name) =>
          dockerBuilder.isHealthy(
            {
              runtimeId: name,
              port: svc.port ?? null,
              healthPath: svc.healthPath ?? '/',
              ...(svc.healthCheck === 'running' ? { healthCheck: 'running' as const } : {}),
              ...(svc.healthCheck === 'http-strict' || svc.healthCheck === 'tcp' ? { healthCheck: svc.healthCheck } : {}),
              ...(svc.healthCheck === 'command' && svc.healthCommand ? { healthCheck: 'command' as const, healthCommand: svc.healthCommand } : {}),
            },
            AUTOSCALE_PROBE_MS,
            0,
          ),
        writeConfig: (svc, signal) => writeDynamicConfig(fastify.db, { confirmServiceId: svc.id, signal }),
        audit: (action, entity, meta) => audit(fastify.db, null, action, entity, meta),
        sleep,
        log: (line) => fastify.log.info({ component: 'autoscaler' }, line),
      },
      onError: (err) => fastify.log.warn({ err }, 'autoscaler step failed'),
    });
    let timer: NodeJS.Timeout | undefined;
    let running = true;
    const loop = async () => {
      await scaler.tick();
      if (running) {
        timer = setTimeout(() => void loop(), AUTOSCALE_TICK_MS);
        timer.unref?.();
      }
    };
    fastify.addHook('onClose', async () => {
      running = false;
      clearTimeout(timer);
      await scaler.stop();
    });
    // After the collector's first sample (5 s) has filled the stats cache.
    timer = setTimeout(() => void loop(), 40_000);
    timer.unref?.();
  },
  // Registered after the collector; reads its cache only when it is there.
  { name: 'ninedeploy-autoscaler' },
);
