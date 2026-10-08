import fp from 'fastify-plugin';
import {
  dockerTransport,
  forceRemoveContainer,
  isEngineTransport,
  listContainersWithLabel,
  TERMINAL_EXPIRES_LABEL,
  TERMINAL_SESSION_LABEL,
} from '../lib/dockerTty.js';
import {
  expireTerminalTickets,
  isTerminalLive,
  recoverTerminalSessions,
  sweepPending,
} from '../lib/terminalSessions.js';

/**
 * Terminal sessions (0.15, DESIGN §1.2, mount point M8):
 *
 * - Boot recovery: every `pending` / `active` row becomes `ended` with
 *   `end_reason='panel_restart'` (with its end audit), and every container
 *   labelled `ninedeploy.terminal.session` is removed — no session survives a
 *   restart, and a host-shell helper must not outlive its session.
 * - A 60s reaper: `pending` rows past their ticket expiry become `expired`,
 *   in-memory ticket contexts are dropped, and helper containers whose
 *   session is not live in this process (or past their expiry label) are
 *   removed.
 *
 * Neither ever throws into the boot: a Docker outage is logged and retried
 * on the next tick. Docker is reached only through the Engine API transport;
 * with a CLI-only `DOCKER_HOST` there are no helpers (host shells are
 * refused there), so there is nothing to remove.
 */

export const TERMINAL_REAPER_MS = 60_000;

/** Remove helper containers that belong to no live session. Returns how many were removed. */
export async function reapTerminalHelpers(opts: { all?: boolean; now?: number } = {}): Promise<number> {
  const transport = dockerTransport();
  if (!isEngineTransport(transport)) return 0;
  const helpers = await listContainersWithLabel(transport, TERMINAL_SESSION_LABEL);
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  let removed = 0;
  for (const h of helpers) {
    const sessionId = Number(h.labels[TERMINAL_SESSION_LABEL]);
    const expires = Number(h.labels[TERMINAL_EXPIRES_LABEL]);
    const expired = Number.isFinite(expires) && expires > 0 && expires < nowSec;
    if (opts.all || expired || !Number.isInteger(sessionId) || !isTerminalLive(sessionId)) {
      await forceRemoveContainer(transport, h.id).catch(() => undefined);
      removed++;
    }
  }
  return removed;
}

export default fp(
  async (fastify) => {
    let timer: NodeJS.Timeout | undefined;
    let running = false;

    const tick = async () => {
      if (running) return;
      running = true;
      try {
        sweepPending();
        await expireTerminalTickets(fastify.db).catch((err) => fastify.log.warn({ err }, 'terminal ticket expiry failed'));
        await reapTerminalHelpers().catch((err) => fastify.log.warn({ err }, 'terminal helper sweep failed'));
      } finally {
        running = false;
      }
    };

    fastify.addHook('onReady', async () => {
      // A bare instance without the database (an isolated registration) has nothing to recover.
      if (!fastify.hasDecorator('db')) return;
      try {
        const closed = await recoverTerminalSessions(fastify.db);
        if (closed > 0) fastify.log.info({ component: 'terminals', closed }, 'closed terminal sessions left by the previous run');
      } catch (err) {
        fastify.log.error({ err }, 'terminal session boot recovery failed');
      }
      try {
        const removed = await reapTerminalHelpers({ all: true });
        if (removed > 0) fastify.log.info({ component: 'terminals', removed }, 'removed host-shell helpers left by the previous run');
      } catch (err) {
        fastify.log.warn({ err }, 'terminal helper cleanup failed (docker unreachable?) — the reaper retries');
      }
      timer = setInterval(() => void tick(), TERMINAL_REAPER_MS);
      timer.unref?.();
    });

    fastify.addHook('onClose', async () => {
      if (timer) clearInterval(timer);
    });
  },
  { name: 'ninedeploy-terminals' },
);
