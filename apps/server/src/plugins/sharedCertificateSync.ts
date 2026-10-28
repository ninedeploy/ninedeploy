import { statSync } from 'node:fs';
import fp from 'fastify-plugin';
import { acmeStoragePath, writeDynamicConfig } from '../engine/proxy.js';
import { sharedCertificatesEnabled } from '../lib/sharedCertificates.js';

/**
 * G5.7: node proxies hold copies of the panel's ACME certificates. When the
 * panel renews one (acme.json changes), re-render the proxies within the hour
 * so the nodes get the renewal long before the old copy expires (renewal
 * starts 30 days ahead). Idle while sharing is off.
 */
export default fp(
  async (fastify) => {
    let lastMtime = 0;
    let busy = false;
    const tick = async () => {
      if (busy || !(await sharedCertificatesEnabled(fastify.db))) return;
      let mtime = 0;
      try {
        mtime = statSync(acmeStoragePath()).mtimeMs;
      } catch {
        return; // no ACME storage yet
      }
      if (lastMtime === 0) {
        lastMtime = mtime; // the proxies were rendered at start-up
        return;
      }
      if (mtime === lastMtime) return;
      busy = true;
      try {
        await writeDynamicConfig(fastify.db);
        lastMtime = mtime;
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => {
      void tick().catch((err) => fastify.log.warn({ err, component: 'shared-certificates' }, 'shared certificate sync failed'));
    }, 60 * 60 * 1000);
    timer.unref();
    fastify.addHook('onClose', async () => clearInterval(timer));
  },
  { name: 'ninedeploy-shared-certificates' },
);
