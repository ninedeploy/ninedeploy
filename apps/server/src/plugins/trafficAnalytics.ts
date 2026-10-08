import fp from 'fastify-plugin';
import { startTrafficTailer, stopTrafficTailer, trafficAnalyticsEnabled } from '../lib/trafficAnalytics.js';

/**
 * Traffic analytics tailer (0.15, opt-in — owner decision O3): when enabled,
 * polls Traefik's JSON access log every 10s, folds it into minute and hour
 * rollups (`traffic_rollups`) with the cursor committed in the same
 * transaction, and rotates the file. Idle while analytics is off.
 *
 * Design: .temp_files/run_0.15/DESIGN.md §2.3. Owner: task T3. Registered in
 * `app.ts` after the traefik plugin (mount point M2), so at boot Traefik has
 * already been healed onto the file config before the first tick. The
 * settings PUT (`modules/traffic.ts`) starts and stops the same process-wide
 * tailer at runtime (M15).
 */
export default fp(
  async (fastify) => {
    fastify.addHook('onReady', async () => {
      // A bare instance (the wiring guard) has no database: nothing to tail.
      if (!fastify.hasDecorator('db')) return;
      try {
        if (!(await trafficAnalyticsEnabled(fastify.db))) return;
        startTrafficTailer({
          db: fastify.db,
          log: (msg, err) => fastify.log.warn({ err, component: 'traffic-analytics' }, msg),
        });
        fastify.log.info({ component: 'traffic-analytics' }, 'traffic analytics tailer started');
      } catch (err) {
        // Never blocks startup; enabling again from the panel restarts it.
        fastify.log.warn({ err, component: 'traffic-analytics' }, 'traffic analytics tailer not started');
      }
    });

    fastify.addHook('onClose', async () => {
      await stopTrafficTailer();
    });
  },
  { name: 'ninedeploy-traffic-analytics' },
);
