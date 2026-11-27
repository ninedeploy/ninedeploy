import fp from 'fastify-plugin';
import { recoverInterruptedMoves } from '../lib/serviceMoveRecovery.js';

/**
 * N07: at boot, a move of a service with its data that the previous process
 * was running is marked `failed` with the reason and what to do
 * (lib/serviceMoveRecovery.ts). Nothing this process started can be running
 * yet, so it runs once and never blocks startup.
 */
export default fp(
  async (fastify) => {
    try {
      for (const move of await recoverInterruptedMoves(fastify.db)) {
        fastify.log.warn({ serviceId: move.serviceId, step: move.step, component: 'move' }, 'a move with data was interrupted by a panel restart and is marked failed');
      }
    } catch (err) {
      fastify.log.warn({ err, component: 'move' }, 'the moves interrupted by a panel restart could not be marked failed');
    }
  },
  { name: 'ninedeploy-service-move-recovery' },
);
