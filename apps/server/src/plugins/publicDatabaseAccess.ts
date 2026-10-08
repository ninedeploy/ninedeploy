import fp from 'fastify-plugin';
import { eventBus } from '../lib/events.js';
import { reconcilePublicAccess, rerenderTlsSidecars } from '../lib/publicDatabaseAccess.js';

/** The watchdog period: the same 5 minutes as the panel Traefik's watchdog. */
export const PUBLIC_DB_WATCHDOG_MS = 5 * 60 * 1000;

/** Audit actions T2 emits for uploaded certificates (M15). */
export const CERTIFICATE_ACTIONS = new Set([
  'traefik.certificate.upload',
  'traefik.certificate.replace',
  'traefik.certificate.delete',
]);

/**
 * Public database access sidecars (0.14): boot reconcile and a 5-minute
 * watchdog (every enabled row's `nd-dbpub-<slug>` runs with the current
 * fingerprint; orphan `ninedeploy.public-db` containers are removed), plus the
 * certificate-change re-render through `eventBus` (mount point M15).
 *
 * Nothing here blocks boot or throws: Docker being down at boot is the
 * watchdog's job, exactly like the panel Traefik's heal. Design: DESIGN.md §1.1.
 */
export default fp(
  async (fastify) => {
    const log = (line: string) => fastify.log.info({ component: 'public-db-access' }, line);
    // An instance without the db decorator (an isolated test instance) has
    // nothing to reconcile.
    const ready = () => fastify.hasDecorator('db') && !!fastify.db;

    let running: Promise<unknown> | null = null;
    const reconcile = (why: string): Promise<unknown> => {
      if (!ready()) return Promise.resolve();
      // One pass at a time: a slow image pull must not stack watchdog passes.
      running ??= reconcilePublicAccess(fastify.db, log)
        .catch((err: unknown) => fastify.log.warn({ err }, `public database access ${why} reconcile failed`))
        .finally(() => {
          running = null;
        });
      return running;
    };

    fastify.addHook('onReady', async () => {
      // Not awaited: an image pull for a sidecar must not hold the panel's boot.
      void reconcile('boot');
    });

    const timer = setInterval(() => void reconcile('watchdog'), PUBLIC_DB_WATCHDOG_MS);
    timer.unref();

    const unsubscribe = eventBus.subscribe((event) => {
      if (!CERTIFICATE_ACTIONS.has(event.action) || !ready()) return;
      void rerenderTlsSidecars(fastify.db, log).catch((err: unknown) =>
        fastify.log.warn({ err }, 'public database access TLS re-render failed'),
      );
    });

    fastify.addHook('onClose', async () => {
      clearInterval(timer);
      unsubscribe();
    });
  },
  { name: 'ninedeploy-public-db-access' },
);
