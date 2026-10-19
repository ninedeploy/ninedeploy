import fp from 'fastify-plugin';
import { uptimeMonitors } from '@ninedeploy/db';
import { monitorDue, probeMonitor, recordCheck, type UptimeMonitorRow } from '../lib/uptime.js';

/** How often the scheduler looks for due monitors. */
export const UPTIME_TICK_MS = 5000;
/** Checks in flight at once; a slow target never delays the others beyond this. */
export const UPTIME_CONCURRENCY = 20;

/**
 * 0.16.8 uptime monitors: every few seconds, start the checks that are due
 * (interval since the last one), at most {@link UPTIME_CONCURRENCY} at once
 * and never two of the same monitor. With no monitors (every install after
 * the upgrade) a tick is one empty SELECT.
 */
export function createUptimeScheduler(deps: {
  load: () => Promise<UptimeMonitorRow[]>;
  check: (m: UptimeMonitorRow) => Promise<void>;
  now?: () => number;
  onError?: (err: unknown) => void;
}) {
  const inFlight = new Set<number>();
  return {
    inFlight,
    async tick(): Promise<number> {
      let started = 0;
      try {
        const now = (deps.now ?? Date.now)();
        for (const m of await deps.load()) {
          if (inFlight.size >= UPTIME_CONCURRENCY) break;
          if (inFlight.has(m.id) || !monitorDue(m, now)) continue;
          inFlight.add(m.id);
          started++;
          void deps
            .check(m)
            .catch((err) => deps.onError?.(err))
            .finally(() => inFlight.delete(m.id));
        }
      } catch (err) {
        deps.onError?.(err);
      }
      return started;
    },
  };
}

export default fp(
  async (fastify) => {
    const scheduler = createUptimeScheduler({
      load: async () => {
        try {
          return await fastify.db.select().from(uptimeMonitors);
        } catch {
          return []; // pre-migration
        }
      },
      check: async (m) => {
        await recordCheck(fastify.db, m, await probeMonitor(m));
      },
      onError: (err) => fastify.log.warn({ err }, 'uptime check failed'),
    });
    let timer: NodeJS.Timeout | undefined;
    let running = true;
    const loop = async () => {
      await scheduler.tick();
      if (running) {
        timer = setTimeout(() => void loop(), UPTIME_TICK_MS);
        timer.unref?.();
      }
    };
    fastify.addHook('onClose', async () => {
      running = false;
      clearTimeout(timer);
    });
    timer = setTimeout(() => void loop(), 10_000);
    timer.unref?.();
  },
  { name: 'ninedeploy-uptime' },
);
