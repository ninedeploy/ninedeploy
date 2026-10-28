import fp from 'fastify-plugin';
import { sweepGithubRunners } from '../lib/githubRunners.js';

/**
 * G4.5 runner upkeep: every minute, start Actions jobs that waited for a free
 * runner slot and remove runners that never picked up a job. A panel without
 * runners turned on makes no Docker call here.
 */
export default fp(
  async (fastify) => {
    const SWEEP_INTERVAL_MS = 60 * 1000;
    let running = true;
    let busy = false;

    const tick = async () => {
      if (!running || busy) return;
      busy = true;
      try {
        await sweepGithubRunners(fastify.db, fastify.log);
      } catch (err) {
        fastify.log.warn({ err, component: 'github-runners' }, 'runner sweep failed');
      } finally {
        busy = false;
      }
    };

    const timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
    timer.unref();
    fastify.addHook('onClose', async () => {
      running = false;
      clearInterval(timer);
    });
  },
  { name: 'ninedeploy-github-runners' },
);
