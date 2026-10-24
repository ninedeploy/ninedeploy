import fp from 'fastify-plugin';
import { shipLogsOnce } from '../engine/logShipper.js';

/** How often new container output is forwarded to the configured drains. */
export const LOG_SHIP_INTERVAL_MS = 10_000;

/**
 * r231: runs the log-drain shipper (`engine/logShipper.ts`). Without it a
 * configured drain never received a single line.
 */
export default fp(
  async (fastify) => {
    const abort = new AbortController();
    let running = true;
    let timer: NodeJS.Timeout | undefined;
    let cycle: Promise<void> | undefined;
    const start = () => { cycle = tick().finally(() => { cycle = undefined; }); };

    const tick = async () => {
      try {
        const { failed } = await shipLogsOnce(fastify.db, undefined, AbortSignal.any([abort.signal, AbortSignal.timeout(45_000)]));
        if (failed > 0) fastify.log.warn({ failed }, 'log drain delivery failed for some lines');
      } catch (err) {
        fastify.log.error({ err }, 'log shipper failed');
      } finally {
        if (running) {
          timer = setTimeout(start, LOG_SHIP_INTERVAL_MS);
          timer.unref();
        }
      }
    };

    fastify.addHook('onClose', async () => {
      running = false;
      abort.abort();
      clearTimeout(timer);
      await cycle;
    });

    timer = setTimeout(start, LOG_SHIP_INTERVAL_MS);
    timer.unref();
  },
  { name: 'ninedeploy-log-shipper' },
);
