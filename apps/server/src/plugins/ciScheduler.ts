import fp from 'fastify-plugin';
import { extendLeasesAfterRestart, sweepLostAttempts } from '../lib/ci.js';

/**
 * R5 runner upkeep. At boot every live lease gets a fresh period: runners
 * could not report while the panel was down, and must not be declared lost
 * for that. Afterwards, attempts whose lease lapsed are marked lost and their
 * jobs requeued (or failed when out of attempts).
 */
export default fp(
  async (fastify) => {
    const SWEEP_INTERVAL_MS = 15 * 1000;
    let running = true;
    let busy = false;

    await extendLeasesAfterRestart(fastify.db).catch((err: unknown) => {
      fastify.log.warn({ err, component: 'ci' }, 'could not extend CI leases after restart');
    });

    const tick = async () => {
      if (!running || busy) return;
      busy = true;
      try {
        const lost = await sweepLostAttempts(fastify.db);
        if (lost > 0) fastify.log.info({ component: 'ci', lost }, 'CI attempts lost: their runners stopped reporting');
      } catch (err) {
        fastify.log.warn({ err, component: 'ci' }, 'CI lease sweep failed');
      } finally {
        busy = false;
      }
    };

    const timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
    timer.unref();
    fastify.addHook('onClose', async () => {
      running = false;
      clearInterval(timer);
    });
  },
  { name: 'ninedeploy-ci-scheduler' },
);
