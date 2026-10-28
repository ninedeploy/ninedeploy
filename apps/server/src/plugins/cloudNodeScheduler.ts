import fp from 'fastify-plugin';
import { sweepCloudNodes } from '../lib/hetznerCloud.js';

/**
 * G4.3: every two minutes, finish the rekey of cloud nodes still on the
 * agent key from their user data (a panel restart while one booted, or a
 * rekey cut short). A panel with no cloud node does nothing.
 */
export default fp(
  async (fastify) => {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void sweepCloudNodes(fastify.db, fastify.log)
        .catch((err) => fastify.log.warn({ err, component: 'hetzner' }, 'cloud node sweep failed'))
        .finally(() => {
          busy = false;
        });
    }, 2 * 60 * 1000);
    timer.unref();
    fastify.addHook('onClose', async () => clearInterval(timer));
  },
  { name: 'ninedeploy-cloud-nodes' },
);
