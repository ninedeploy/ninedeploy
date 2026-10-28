import fp from 'fastify-plugin';
import { audit } from '../lib/audit.js';
import { enforceRestartLimits } from '../lib/restartLimit.js';

/**
 * G1.3: once a minute, stop a service whose containers keep restarting past
 * its opt-in limit, and audit `service.restart_limit` (which notifies).
 * Idle while no service has a limit.
 */
export default fp(
  async (fastify) => {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void enforceRestartLimits(fastify.db, {
        onTripped: (svc, limit, restarts) => {
          void audit(fastify.db, null, 'service.restart_limit', `${svc.name} #${svc.id}`, {
            serviceId: svc.id,
            restarts,
            maxRestarts: limit.maxRestarts,
            windowMinutes: limit.windowMinutes,
          });
          fastify.kernel?.events.emit('service.stopped', { serviceId: svc.id });
          fastify.log.warn({ serviceId: svc.id, restarts }, 'restart-loop limit reached; service stopped');
        },
      })
        .catch((err) => fastify.log.warn({ err, component: 'restart-limit' }, 'restart-loop check failed'))
        .finally(() => {
          busy = false;
        });
    }, 60_000);
    timer.unref();
    fastify.addHook('onClose', async () => clearInterval(timer));
  },
  { name: 'ninedeploy-restart-limit' },
);
