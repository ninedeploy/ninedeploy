import fp from 'fastify-plugin';
import { deployments, type Service, services } from '@ninedeploy/db';
import { and, inArray, isNotNull } from 'drizzle-orm';
import { dockerBuilder } from '../engine/builders/docker.js';
import { canaryActive } from '../engine/canaryState.js';
import { writeDynamicConfig } from '../engine/proxy.js';
import { audit } from '../lib/audit.js';
import { AUTOSCALE_PROBE_MS, AUTOSCALE_TICK_MS, type AutoscaleDeps, autoscaleOf, autoscaleStep } from '../lib/autoscaler.js';
import { run, sleep } from '../lib/exec.js';
import type { ContainerStat } from '../lib/stats.js';
import { trafficAnalyticsEnabled } from '../lib/trafficAnalytics.js';

/**
 * 0.16.10: runs lib/autoscaler.ts every 30 s over the services that have an
 * autoscale configuration, on the container stats the collector caches. A
 * service is never looked at twice at once (scaling up waits for the new
 * container's healthcheck). Nothing runs for a panel without autoscaled
 * services beyond one query per tick.
 */
export function createAutoscaler(deps: {
  load: () => Promise<Service[]>;
  inFlightDeploys: () => Promise<Set<number>>;
  containers: () => ReadonlyMap<string, ContainerStat>;
  analyticsOn: () => Promise<boolean>;
  canaryRunning: (serviceId: number) => boolean;
  step: AutoscaleDeps;
  now?: () => number;
  onError?: (err: unknown) => void;
}) {
  const busy = new Set<number>();
  return {
    busy,
    async tick(): Promise<number> {
      let looked = 0;
      try {
        const list = (await deps.load()).filter((s) => autoscaleOf(s) !== null);
        if (list.length === 0) return 0;
        const inFlight = await deps.inFlightDeploys();
        const analyticsOn = await deps.analyticsOn().catch(() => false);
        const containers = deps.containers();
        const now = (deps.now ?? Date.now)();
        for (const svc of list) {
          if (busy.has(svc.id)) continue;
          busy.add(svc.id);
          looked++;
          void autoscaleStep(deps.step, svc, autoscaleOf(svc)!, {
            containers,
            analyticsOn,
            inFlight,
            canaryRunning: deps.canaryRunning(svc.id),
            now,
          })
            .catch((err) => deps.onError?.(err))
            .finally(() => busy.delete(svc.id));
        }
      } catch (err) {
        deps.onError?.(err);
      }
      return looked;
    },
  };
}

export default fp(
  async (fastify) => {
    const scaler = createAutoscaler({
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
              .where(and(inArray(deployments.status, ['queued', 'building'])))
          ).map((r) => r.serviceId),
        ),
      containers: () => fastify.stats?.raw().containers ?? new Map(),
      analyticsOn: () => trafficAnalyticsEnabled(fastify.db),
      canaryRunning: canaryActive,
      step: {
        db: fastify.db,
        docker: async (args) => {
          await run('docker', args, {}, () => undefined);
        },
        probe: (svc, name) =>
          dockerBuilder.isHealthy(
            {
              runtimeId: name,
              port: svc.port ?? null,
              healthPath: svc.healthPath ?? '/',
              ...(svc.healthCheck === 'running' ? { healthCheck: 'running' as const } : {}),
              ...(svc.healthCheck === 'command' && svc.healthCommand ? { healthCheck: 'command' as const, healthCommand: svc.healthCommand } : {}),
            },
            AUTOSCALE_PROBE_MS,
            0,
          ),
        writeConfig: () => writeDynamicConfig(fastify.db),
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
    });
    // After the collector's first sample (5 s) has filled the stats cache.
    timer = setTimeout(() => void loop(), 40_000);
    timer.unref?.();
  },
  // Registered after the collector; reads its cache only when it is there.
  { name: 'ninedeploy-autoscaler' },
);
