import type { Service } from '@ninedeploy/db';
import { autoscaleConfig, containerMetricsReply } from '@ninedeploy/schemas';
import { AUTOSCALE_STATS_MAX_AGE_MS, decideWithState } from './autoscaler.js';
import { effectiveMinimum } from './autoscaleSchedule.js';
import { measureNodeAutoscale } from './nodeAutoscaleMetrics.js';

type Window = { history: Array<{ at: number; desired: number }>; aboveSince: number | null; belowSince: number | null; desired: number | null };
type State = { generation: string; sampledAt: number; requestId: string; observedAt: number; window: Window };
export type NodeAutoscaleEvidence = { serverId: number; serviceId: number; deploymentId: number; sampledAt: number; requestId: string; targets: Array<{ name: string; id: string }> };

/** Builds decisions only; the durable admission and controller own all effects. */
export function createNodeAutoscaleDecider() {
  const states = new Map<number, State>();
  return {
    forget(serviceId: number) { states.delete(serviceId); },
    observe(service: Service, sample: unknown, now: number, blocked = false): { to: number | null; holding: string | null; evidence?: NodeAutoscaleEvidence } {
      const hold = (reason: string) => { states.delete(service.id); return { to: null, holding: reason }; };
      const config = autoscaleConfig.safeParse(service.autoscale);
      if (blocked || service.type !== 'docker' || service.orchestrator === 'swarm' || !service.serverId || service.status !== 'running' ||
        service.asleepAt != null || !service.runtimeId || !config.success) return hold('node autoscale is blocked or placement changed');
      if (config.data.metric === 'rps') return hold('node request rate is not available for autoscaling');
      const measurement = measureNodeAutoscale(service, config.data.metric, sample, now);
      if (measurement.value === null) return hold(measurement.holding ?? 'node metrics unavailable');
      const { serverId: _serverId, sampledAt, ...data } = sample as Record<string, unknown> & { sampledAt: number };
      const receipt = containerMetricsReply.parse(data);
      const identities = receipt.items.map(item => ({ name: item.name, id: item.id, restarts: item.restarts,
        cpuLimitMilli: item.cpuLimitMilli, memLimitBytes: item.memLimitBytes })).sort((a, b) => a.name.localeCompare(b.name));
      const generation = JSON.stringify([service.serverId, service.runtimeId, service.runtimeReplicas, config.data, identities]);
      let state = states.get(service.id);
      if (!state || state.generation !== generation || now < state.observedAt || now - state.observedAt > AUTOSCALE_STATS_MAX_AGE_MS || sampledAt < state.sampledAt) {
        state = { generation, sampledAt, requestId: receipt.requestId, observedAt: now,
          window: { history: [], aboveSince: null, belowSince: null, desired: null } };
        states.set(service.id, state);
      } else if (sampledAt === state.sampledAt || receipt.requestId === state.requestId) {
        return { to: null, holding: 'waiting for a new node metrics sample' };
      } else { state.sampledAt = sampledAt; state.requestId = receipt.requestId; state.observedAt = now; }
      const floor = effectiveMinimum(config.data, now);
      const effective = { ...config.data, minReplicas: floor.minReplicas };
      const bounded = Math.min(effective.maxReplicas, Math.max(effective.minReplicas, service.runtimeReplicas));
      const evidence: NodeAutoscaleEvidence = { serverId: service.serverId, serviceId: receipt.serviceId, deploymentId: receipt.deploymentId,
        sampledAt, requestId: receipt.requestId, targets: receipt.items.map(({ name, id }) => ({ name, id })) };
      if (bounded !== service.runtimeReplicas) { states.delete(service.id); return { to: bounded, holding: null, evidence }; }
      const decision = decideWithState(state.window, service.runtimeReplicas, measurement.value, effective, now);
      if (decision) states.delete(service.id);
      return decision ? { to: decision.to, holding: null, evidence } : { to: null, holding: null };
    },
  };
}
