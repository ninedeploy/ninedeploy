import fp from 'fastify-plugin';
import { reconcilePrimaryTransitions } from '../engine/primaryRecovery.js';
import { createNodePreparationRecoveryRunner } from '../lib/nodePreparationRecovery.js';

export default fp(async app => {
  const abort = new AbortController();
  const recoverPreparations = createNodePreparationRecoveryRunner(app.db, { log: line => app.log.warn(line) });
  let timer: NodeJS.Timeout | undefined, cycle: Promise<unknown> | undefined;
  const tick = async () => {
    if (abort.signal.aborted || cycle) return;
    cycle = reconcilePrimaryTransitions(app.db, { signal: abort.signal, log: line => app.log.warn(line) })
      .then(() => abort.signal.aborted ? undefined : recoverPreparations(abort.signal))
      .catch(err => app.log.warn({ err }, 'primary recovery unavailable'));
    await cycle; cycle = undefined;
    if (!abort.signal.aborted) { timer = setTimeout(() => void tick(), 60_000); timer.unref(); }
  };
  app.addHook('onReady', () => { timer = setTimeout(() => void tick(), 1000); timer.unref(); });
  app.addHook('onClose', async () => { abort.abort(); clearTimeout(timer); await cycle; });
}, { name: 'ninedeploy-primary-recovery' });
