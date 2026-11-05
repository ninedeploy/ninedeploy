import fp from 'fastify-plugin';
import { failInterruptedPitrRecoveries, pitrDatabases, pitrMaintenance } from '../lib/pitr.js';

/** One pass an hour; the first ten minutes after boot (a restart storm takes no base backups). */
const TICK_MS = 60 * 60_000;
const FIRST_TICK_MS = 10 * 60_000;

/**
 * R3: point-in-time recovery upkeep for every PostgreSQL database with it on
 * (lib/pitr.ts `pitrMaintenance`): failing-archiving reports, a base backup a
 * day, and the WAL archive retention. One database at a time. At boot it also
 * fails the recoveries a previous process left `running`.
 */
export default fp(
  async (fastify) => {
    let running = true;
    let busy = false;
    const log = (line: string) => fastify.log.info({ component: 'pitr' }, line);
    const tick = async () => {
      if (!running || busy) return;
      busy = true;
      try {
        for (const d of await pitrDatabases(fastify.db)) {
          if (!running) break;
          await pitrMaintenance(fastify.db, d, log).catch((err: unknown) => fastify.log.warn({ err, databaseId: d.id }, 'point-in-time recovery upkeep failed'));
        }
      } catch (err) {
        fastify.log.error({ err }, 'point-in-time recovery scheduler tick failed');
      } finally {
        busy = false;
      }
    };
    try {
      await failInterruptedPitrRecoveries(fastify.db, log);
    } catch (err) {
      fastify.log.warn({ err }, 'point-in-time recovery: could not sweep interrupted recoveries at boot');
    }
    const first = setTimeout(() => void tick(), FIRST_TICK_MS);
    first.unref?.();
    const timer = setInterval(() => void tick(), TICK_MS);
    timer.unref?.();
    fastify.addHook('onClose', async () => {
      running = false;
      clearTimeout(first);
      clearInterval(timer);
    });
  },
  { name: 'ninedeploy-pitr' },
);
