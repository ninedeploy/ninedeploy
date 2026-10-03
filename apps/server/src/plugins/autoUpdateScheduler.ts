import fp from 'fastify-plugin';
import { sweepAutoUpdates } from '../lib/autoUpdate.js';

/**
 * Image auto-update sweep: every 30 minutes, probe the registries of
 * opt-in image services and enqueue re-deploys when a tag's digest moved.
 * The sweep is deliberately lazy about failure — one broken registry or
 * one bad image ref must never break the interval or the panel.
 */
export default fp(
  async (fastify) => {
    const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
    let running = true;
    let timer: NodeJS.Timeout | undefined;

    const tick = async () => {
      if (!running) return;
      try {
        const result = await sweepAutoUpdates(fastify.db, undefined, (msg) =>
          fastify.log.info({ component: 'autoupdate' }, msg),
        );
        if (result.enqueued > 0) {
          fastify.log.info(
            { component: 'autoupdate', probed: result.probed, enqueued: result.enqueued, skipped: result.skipped },
            'auto-update sweep enqueued re-deploys',
          );
        }
      } catch (err) {
        fastify.log.warn({ err, component: 'autoupdate' }, 'auto-update sweep failed');
      }
    };

    fastify.addHook('onClose', async () => {
      running = false;
      clearTimeout(timer);
    });

    // First sweep shortly after boot (let the panel settle), then on an interval.
    timer = setTimeout(() => {
      void tick().finally(() => {
        if (!running) return;
        timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
        timer.unref();
      });
    }, 5 * 60 * 1000);
    timer.unref();
  },
  { name: 'ninedeploy-autoupdate' },
);
