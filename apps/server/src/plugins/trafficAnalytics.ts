import fp from 'fastify-plugin';

/**
 * Traffic analytics tailer (0.15, opt-in — owner decision O3): when enabled,
 * polls Traefik's JSON access log every 10s, folds it into minute and hour
 * rollups (`traffic_rollups`) with the cursor committed in the same
 * transaction, and rotates the file. Idle while analytics is off.
 *
 * Design: .temp_files/run_0.15/DESIGN.md §2.3. Owner: task T3.
 *
 * T1 stub: registered in `app.ts` after the traefik plugin (mount point M2)
 * with no hooks yet.
 */
export default fp(
  async (_fastify) => {
    // Hooks land in T3.
  },
  { name: 'ninedeploy-traffic-analytics' },
);
