import { eq, nodeAutoscaleCapacity, type DB, type Service, type ServiceRuntimeOwner } from '@ninedeploy/db';
import { autoscaleConfig } from '@ninedeploy/schemas';
import { admitNodeAutoscale, type NodeAutoscaleAdmission, validNodeAutoscaleDatabaseNetworks } from './nodeAutoscaleAuthority.js';
import { executeNodeAutoscale, type NodeAutoscaleControllerDeps } from './nodeAutoscaleController.js';
import { createNodeAutoscaleDecider } from './nodeAutoscaleDecision.js';
import { nodeAutoscaleRuntime } from './nodeAutoscaleRuntime.js';
import { readNodeAutoscaleSample } from './nodeAutoscaleSample.js';
import { readServiceRuntimeOwner, sameRuntimeOwner } from './serviceRuntimeOwner.js';
import { recordNodeAutoscaleHolding, recordNodeAutoscaleSample } from './autoscaler.js';

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
      const held = (reason: string) => { recordNodeAutoscaleHolding(service, reason); return { state: 'held' as const, reason }; };
      try {
        signal?.throwIfAborted();
        const config = autoscaleConfig.safeParse(service.autoscale);
        if (!config.success || config.data.metric === 'rps' || await deps.blocked(service.id)) {
          forget(service.id);
          return held('node autoscale is blocked or its metric is unavailable');
        }
        const deploymentId = Number(/-([1-9]\d*)$/.exec(service.runtimeId ?? '')?.[1]);
        const capacity = Number.isSafeInteger(deploymentId) && deploymentId > 0
          ? await db.query.nodeAutoscaleCapacity.findFirst({ where: eq(nodeAutoscaleCapacity.deploymentId, deploymentId) }) : null;
        if (!capacity || capacity.serviceId !== service.id || capacity.serverId !== service.serverId || capacity.runtimeId !== service.runtimeId) {
          forget(service.id); return held('node autoscale capacity is not confirmed');
        }
        if (!await validNodeAutoscaleDatabaseNetworks(db, service, capacity)) {
          forget(service.id); return held('node autoscale database networks changed; redeploy to prepare capacity');
        }
        const measuredOwner = await readServiceRuntimeOwner(db, service.id);
        if (owners.has(service.id) && !sameRuntimeOwner(owners.get(service.id)!, measuredOwner)) forget(service.id);
        const sample = await (deps.sample ?? readNodeAutoscaleSample)(db, service, { signal });
        signal?.throwIfAborted();
        if (await deps.blocked(service.id)) { forget(service.id); return held('node autoscale is blocked'); }
        if (!sameRuntimeOwner(await readServiceRuntimeOwner(db, service.id), measuredOwner)) {
          forget(service.id); return held('node runtime ownership changed during measurement');
        }
        owners.set(service.id, measuredOwner);
        const decision = decider.observe(service, sample, (deps.now ?? Date.now)(), false, observation => recordNodeAutoscaleSample(service, observation));
        if (decision.to === null || !decision.evidence) {
          if (decision.holding) recordNodeAutoscaleHolding(service, decision.holding);
          return { state: 'held', ...(decision.holding ? { reason: decision.holding } : {}) };
        }
        signal?.throwIfAborted();
        const admission = await admitNodeAutoscale(db, service, decision.to, decision.evidence, measuredOwner);
        owners.delete(service.id);
        if (!admission) return held('node autoscale ownership changed');
        signal?.throwIfAborted();
        if (await deps.blocked(service.id)) {
          recordNodeAutoscaleHolding(service, 'node autoscale transition awaits recovery');
          return { state: 'pending', reason: 'node autoscale transition awaits recovery' };
        }
        const result = await executeNodeAutoscale(db, admission, deps.runtime?.(admission, signal) ?? nodeAutoscaleRuntime(db, admission, { signal }));
        if (result === 'aborted') return held('node autoscale decision was superseded');
        return { state: 'completed' };
      } catch (error) { forget(service.id); recordNodeAutoscaleHolding(service, 'node autoscale evaluation failed; see server logs'); throw error; }
      finally { busy.delete(service.id); }
    },
  };
}
