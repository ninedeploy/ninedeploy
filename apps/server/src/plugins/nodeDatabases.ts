import fp from 'fastify-plugin';

/**
 * Node database status (multi-node): every 60 s, `docker.inspect` each node
 * database grouped by server, moving `status` the way the panel's own
 * transitions do. An unreachable node never changes `status`; the API reports
 * `reachable: false` instead.
 *
 * Design: .temp_files/run_0.16/DESIGN.md §5.6. Owner: task T6.
 *
 * T1 stub: registered in `app.ts` after `kernelPlugin` (mount point M2) with
 * no timers yet. Every test that boots the real app mocks it.
 */
export default fp(
  async (_fastify) => {
    // The status loop lands in T6.
  },
  { name: 'ninedeploy-node-databases' },
);
