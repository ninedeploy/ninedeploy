import fp from 'fastify-plugin';
import { pollDueGitServices } from '../lib/gitPoll.js';

/**
 * X2: four times a minute, poll the services whose Git polling is due
 * (lib/gitPoll.ts: each on its own interval, of a minute at the least, so a
 * poll starts within fifteen seconds of falling due). Idle, one indexed
 * query, while no service polls. A tick never overlaps the one before.
 */
export default fp(
  async (fastify) => {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void pollDueGitServices(fastify.db)
        .then((summary) => {
          if (summary.due > 0) fastify.log.info({ component: 'git-poll', gitPoll: summary }, 'git polling');
        })
        .catch((err) => fastify.log.warn({ err, component: 'git-poll' }, 'git polling failed'))
        .finally(() => {
          busy = false;
        });
    }, 15_000);
    timer.unref();
    fastify.addHook('onClose', async () => clearInterval(timer));
  },
  { name: 'ninedeploy-git-poll' },
);
