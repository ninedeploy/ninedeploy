import type { DB, Service, ServiceRuntimeOwner } from '@ninedeploy/db';
import { autoscaleConfig } from '@ninedeploy/schemas';
import { admitNodeAutoscale, type NodeAutoscaleAdmission } from './nodeAutoscaleAuthority.js';
import { executeNodeAutoscale, type NodeAutoscaleControllerDeps } from './nodeAutoscaleController.js';
import { createNodeAutoscaleDecider } from './nodeAutoscaleDecision.js';
import { nodeAutoscaleRuntime } from './nodeAutoscaleRuntime.js';
import { readNodeAutoscaleSample } from './nodeAutoscaleSample.js';
import { readServiceRuntimeOwner, sameRuntimeOwner } from './serviceRuntimeOwner.js';

/** Compose measurement and durable effects; the caller schedules and supplies its live conflict check. */
export function createNodeAutoscaleWorker(db: DB, deps: {
  blocked: (serviceId: number) => boolean | Promise<boolean>;
  sample?: typeof readNodeAutoscaleSample;
  runtime?: (admission: NodeAutoscaleAdmission, signal?: AbortSignal) => NodeAutoscaleControllerDeps;
  now?: () => number;
}) {
  const decider = createNodeAutoscaleDecider(), busy = new Set<number>();
  const owners = new Map<number, ServiceRuntimeOwner | null>();
  const forget = (serviceId: number) => { decider.forget(serviceId); owners.delete(serviceId); };
  return {
    forget,
    async step(service: Service, signal?: AbortSignal): Promise<{ state: 'held' | 'busy' | 'completed' | 'pending'; reason?: string }> {
      if (busy.has(service.id)) return { state: 'busy' };
      busy.add(service.id);
      try {
        signal?.throwIfAborted();
        const config = autoscaleConfig.safeParse(service.autoscale);
        if (!config.success || config.data.metric === 'rps' || await deps.blocked(service.id)) {
          forget(service.id);
          return { state: 'held', reason: 'node autoscale is blocked or its metric is unavailable' };
        }
        const measuredOwner = await readServiceRuntimeOwner(db, service.id);
        if (owners.has(service.id) && !sameRuntimeOwner(owners.get(service.id)!, measuredOwner)) forget(service.id);
        const sample = await (deps.sample ?? readNodeAutoscaleSample)(db, service, { signal });
        signal?.throwIfAborted();
        if (await deps.blocked(service.id)) { forget(service.id); return { state: 'held', reason: 'node autoscale is blocked' }; }
        if (!sameRuntimeOwner(await readServiceRuntimeOwner(db, service.id), measuredOwner)) {
          forget(service.id); return { state: 'held', reason: 'node runtime ownership changed during measurement' };
        }
        owners.set(service.id, measuredOwner);
        const decision = decider.observe(service, sample, (deps.now ?? Date.now)());
        if (decision.to === null || !decision.evidence) return { state: 'held', ...(decision.holding ? { reason: decision.holding } : {}) };
        signal?.throwIfAborted();
        const admission = await admitNodeAutoscale(db, service, decision.to, decision.evidence, measuredOwner);
        owners.delete(service.id);
        if (!admission) return { state: 'held', reason: 'node autoscale ownership changed' };
        signal?.throwIfAborted();
        if (await deps.blocked(service.id)) return { state: 'pending', reason: 'node autoscale transition awaits recovery' };
        await executeNodeAutoscale(db, admission, deps.runtime?.(admission, signal) ?? nodeAutoscaleRuntime(db, admission, { signal }));
        return { state: 'completed' };
      } catch (error) { forget(service.id); throw error; }
      finally { busy.delete(service.id); }
    },
  };
}
