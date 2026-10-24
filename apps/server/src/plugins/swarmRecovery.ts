import fp from 'fastify-plugin';
import { reconcileSwarmTransitions } from '../engine/swarmRecovery.js';

export default fp(async app => {
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined, cycle: Promise<unknown> | undefined;
  const tick = async () => {
    if (abort.signal.aborted || cycle) return;
    cycle = reconcileSwarmTransitions(app.db, { signal: abort.signal, log: line => app.log.warn(line) })
      .catch(() => app.log.warn('Swarm recovery unavailable; native services retained'));
    await cycle; cycle = undefined;
    if (!abort.signal.aborted) { timer = setTimeout(() => void tick(), 60_000); timer.unref(); }
  };
  app.addHook('onReady', () => { timer = setTimeout(() => void tick(), 1000); timer.unref(); });
  app.addHook('onClose', async () => { abort.abort(); clearTimeout(timer); await cycle; });
}, { name: 'ninedeploy-swarm-recovery' });
