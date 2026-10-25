import fp from 'fastify-plugin';
import { eq, services } from '@ninedeploy/db';
import { reconcileNodeLifecycleIntents } from '../lib/nodeLifecycleRuntime.js';
import { audit } from '../lib/audit.js';
import { createNodeRecoveryNotifier } from '../lib/nodeLifecycleAlerts.js';

export default fp(async app => {
  const abort = new AbortController();
  const { held } = createNodeRecoveryNotifier(app.db, abort.signal);
  let timer: NodeJS.Timeout | undefined, cycle: Promise<unknown> | undefined;
  const tick = async () => {
    if (abort.signal.aborted || cycle) return;
    cycle = reconcileNodeLifecycleIntents(app.db, { signal: abort.signal, log: line => app.log.warn(line), held,
      settled: async (serviceId, action, id) => {
        const service = await app.db.query.services.findFirst({ where: eq(services.id, serviceId) });
        if (!service) return;
        await audit(app.db, null, `service.${action}`, `${service.name} #${serviceId}`, { serviceId, commandId: id });
        if (action === 'stop') app.kernel?.events.emit('service.stopped', { serviceId });
      },
    }).catch(error => { if (!abort.signal.aborted) app.log.warn({ err: error }, 'node lifecycle recovery unavailable'); });
    await cycle; cycle = undefined;
    if (!abort.signal.aborted) { timer = setTimeout(() => void tick(), 1000); timer.unref(); }
  };
  app.addHook('onReady', () => { timer = setTimeout(() => void tick(), 1000); timer.unref(); });
  app.addHook('onClose', async () => { abort.abort(); clearTimeout(timer); await cycle; });
}, { name: 'ninedeploy-node-lifecycle' });
