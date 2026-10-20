import fp from 'fastify-plugin';
import { deployments, domains, type Service, services } from '@ninedeploy/db';
import { eq, inArray, isNotNull } from 'drizzle-orm';
import { canaryActive } from '../engine/canaryState.js';
import { putToSleep, SLEEP_TICK_MS, type SleepDeps, sleepHoldReason } from '../lib/sleep.js';
import { sleepDeps } from '../lib/sleepRuntime.js';
import { wakeUnreachableReason } from '../lib/panelUpstream.js';
import { trafficAnalyticsEnabled } from '../lib/trafficAnalytics.js';

/**
 * 0.16.11 scale to zero: every minute, puts to sleep the services with
 * `sleepAfterMinutes` whose domains had no request for that long
 * (lib/sleep.ts). Waking is the wake endpoint's job (modules/wake.ts).
 */
export function createSleeper(deps: {
  load: () => Promise<Service[]>;
  inFlightDeploys: () => Promise<Set<number>>;
  routedDomains: () => Promise<Map<number, number>>;
  analyticsOn: () => Promise<boolean>;
  canaryRunning: (serviceId: number) => boolean;
  /** Null when Traefik can reach the wake endpoint; otherwise why not (nothing sleeps then). */
  wakeUnreachable: () => Promise<string | null>;
  step: SleepDeps;
  now?: () => number;
  onError?: (err: unknown) => void;
}) {
  return {
    async tick(): Promise<number> {
      let slept = 0;
      try {
        const list = await deps.load();
        if (list.length === 0) return 0;
        const [inFlight, routed, analyticsOn] = await Promise.all([deps.inFlightDeploys(), deps.routedDomains(), deps.analyticsOn().catch(() => false)]);
        const now = (deps.now ?? Date.now)();
        for (const svc of list) {
          const hold = sleepHoldReason(svc, { now, analyticsOn, inFlight, routedDomains: routed.get(svc.id) ?? 0, canaryRunning: deps.canaryRunning(svc.id) });
          if (hold) continue;
          // Never put to sleep what could not be woken.
          const unreachable = await deps.wakeUnreachable();
          if (unreachable) {
            deps.step.log(`sleep: ${svc.name} stays awake: ${unreachable}`);
            continue;
          }
          try {
            if (await putToSleep(deps.step, svc)) slept++;
          } catch (err) {
            deps.onError?.(err);
          }
        }
      } catch (err) {
        deps.onError?.(err);
      }
      return slept;
    },
  };
}

export default fp(
  async (fastify) => {
    const sleeper = createSleeper({
      load: async () => {
        try {
          return await fastify.db.select().from(services).where(isNotNull(services.sleepAfterMinutes));
        } catch {
          return []; // pre-migration
        }
      },
      inFlightDeploys: async () =>
        new Set(
          (await fastify.db.select({ serviceId: deployments.serviceId }).from(deployments).where(inArray(deployments.status, ['queued', 'building']))).map(
            (r) => r.serviceId,
          ),
        ),
      routedDomains: async () => {
        const counts = new Map<number, number>();
        for (const d of await fastify.db.select({ serviceId: domains.serviceId }).from(domains).where(eq(domains.status, 'active'))) {
          counts.set(d.serviceId, (counts.get(d.serviceId) ?? 0) + 1);
        }
        return counts;
      },
      analyticsOn: () => trafficAnalyticsEnabled(fastify.db),
      canaryRunning: canaryActive,
      wakeUnreachable: () => wakeUnreachableReason(),
      step: sleepDeps(fastify.db, (line) => fastify.log.info({ component: 'sleeper' }, line)),
      onError: (err) => fastify.log.warn({ err }, 'scale-to-zero step failed'),
    });
    let timer: NodeJS.Timeout | undefined;
    let running = true;
    const loop = async () => {
      await sleeper.tick();
      if (running) {
        timer = setTimeout(() => void loop(), SLEEP_TICK_MS);
        timer.unref?.();
      }
    };
    fastify.addHook('onClose', async () => {
      running = false;
      clearTimeout(timer);
    });
    timer = setTimeout(() => void loop(), SLEEP_TICK_MS);
    timer.unref?.();
  },
  { name: 'ninedeploy-sleeper' },
);
