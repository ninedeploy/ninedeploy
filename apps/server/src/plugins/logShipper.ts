import fp from 'fastify-plugin';
import { shipLogsOnce, type ShipperCursors } from '../engine/logShipper.js';

/** How often new container output is forwarded to the configured drains. */
export const LOG_SHIP_INTERVAL_MS = 10_000;

/**
 * r231: runs the log-drain shipper (`engine/logShipper.ts`). Without it a
 * configured drain never received a single line.
 */
export default fp(
  async (fastify) => {
    const cursors: ShipperCursors = new Map();
    let running = true;
    let timer: NodeJS.Timeout | undefined;

    const tick = async () => {
      try {
        const { failed } = await shipLogsOnce(fastify.db, cursors);
        if (failed > 0) fastify.log.warn({ failed }, 'log drain delivery failed for some lines');
      } catch (err) {
        fastify.log.error({ err }, 'log shipper failed');
      } finally {
        if (running) {
          timer = setTimeout(() => void tick(), LOG_SHIP_INTERVAL_MS);
          timer.unref();
        }
      }
    };

    fastify.addHook('onClose', async () => {
      running = false;
      clearTimeout(timer);
    });

    timer = setTimeout(() => void tick(), LOG_SHIP_INTERVAL_MS);
    timer.unref();
  },
  { name: 'ninedeploy-log-shipper' },
);
