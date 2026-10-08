import fp from 'fastify-plugin';

/**
 * Public database access sidecars (0.14): boot reconcile and a 5-minute
 * watchdog (every enabled row's `nd-dbpub-<slug>` runs with the current
 * fingerprint; orphan `ninedeploy.public-db` containers are removed), plus the
 * certificate-change re-render through `eventBus` (mount point M15).
 *
 * Design: .temp_files/run_0.14/DESIGN.md §1.1. Owner: task T3.
 *
 * T1 stub: registered in `app.ts` after the traefik plugin (mount point M2)
 * with no hooks yet.
 */
export default fp(
  async (_fastify) => {
    // Hooks land in T3.
  },
  { name: 'ninedeploy-public-db-access' },
);
