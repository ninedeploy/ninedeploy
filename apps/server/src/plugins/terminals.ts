import fp from 'fastify-plugin';

/**
 * Terminal sessions (0.15): boot recovery (every `pending` / `active` row
 * becomes `ended` with `end_reason='panel_restart'`, and every container
 * labelled `ninedeploy.terminal.session` is removed — no session survives a
 * restart) and a 60s reaper (expired tickets, orphaned host-shell helpers).
 *
 * Design: .temp_files/run_0.15/DESIGN.md §1.2. Owner: task T2a.
 *
 * T1 stub: registered in `app.ts` after the traefik plugin (mount point M2)
 * with no hooks yet.
 */
export default fp(
  async (_fastify) => {
    // Hooks land in T2a.
  },
  { name: 'ninedeploy-terminals' },
);
