import fp from 'fastify-plugin';

/**
 * Database dump imports (0.14): boot recovery (`running` rows become `failed`,
 * stale `uploading` / `pending` rows become `expired` and lose their staging
 * file) and the same sweep hourly.
 *
 * Design: .temp_files/run_0.14/DESIGN.md §3.2. Owner: task T4.
 *
 * T1 stub: registered in `app.ts` after the traefik plugin (mount point M2)
 * with no hooks yet.
 */
export default fp(
  async (_fastify) => {
    // Hooks land in T4.
  },
  { name: 'ninedeploy-database-imports' },
);
