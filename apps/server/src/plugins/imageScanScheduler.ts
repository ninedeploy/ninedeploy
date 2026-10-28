import fp from 'fastify-plugin';
import { audit } from '../lib/audit.js';
import { rescanRunningImages, summaryLine } from '../lib/imageScan.js';

/**
 * G5.1: once an hour, rescan the images that run on the panel host when
 * their latest scan is older than the policy's interval (default 24 h). Off
 * unless an operator enabled image scanning. New fixable critical findings
 * are audited (`image_scan.critical`), which notifies the channels that
 * receive audit events.
 */
export default fp(
  async (fastify) => {
    let busy = false;
    const tick = () => {
      if (busy) return;
      busy = true;
      void rescanRunningImages(fastify.db, {
        onNewCritical: (svc, result) => {
          void audit(fastify.db, null, 'image_scan.critical', svc.name, {
            serviceId: svc.id,
            imageId: result.imageId,
            summary: summaryLine(result),
            critical: result.fixable.critical,
          });
        },
      })
        .catch((err) => fastify.log.warn({ err, component: 'image-scan' }, 'image rescan failed'))
        .finally(() => {
          busy = false;
        });
    };
    const timer = setInterval(tick, 60 * 60 * 1000);
    timer.unref();
    fastify.addHook('onClose', async () => clearInterval(timer));
  },
  { name: 'ninedeploy-image-scans' },
);
