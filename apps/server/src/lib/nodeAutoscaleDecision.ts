import type { Service } from '@ninedeploy/db';
import { autoscaleConfig, containerMetricsReply } from '@ninedeploy/schemas';
import { AUTOSCALE_STATS_MAX_AGE_MS, decideWithState } from './autoscaler.js';
import { effectiveMinimum } from './autoscaleSchedule.js';
import { measureNodeAutoscale, measureNodeServingTraffic } from './nodeAutoscaleMetrics.js';

type Window = { history: Array<{ at: number; desired: number }>; aboveSince: number | null; belowSince: number | null; desired: number | null };
type State = { generation: string; sampledAt: number; requestId: string; observedAt: number; window: Window };
export type NodeAutoscaleEvidence = { serverId: number; serviceId: number; deploymentId: number; sampledAt: number; requestId: string; targets: Array<{ name: string; id: string }> };

/** Builds decisions only; the durable admission and controller own all effects. */
export function createNodeAutoscaleDecider() {
  const states = new Map<number, State>();
  return {
    forget(serviceId: number) { states.delete(serviceId); },
    observe(service: Service, sample: unknown, now: number, blocked = false,
      onSample?: (observation: { value: number; desired: number; sampledAt: number }) => void): { to: number | null; holding: string | null; evidence?: NodeAutoscaleEvidence } {
      const hold = (reason: string) => { states.delete(service.id); return { to: null, holding: reason }; };
      const config = autoscaleConfig.safeParse(service.autoscale);
      if (blocked || service.type !== 'docker' || service.orchestrator === 'swarm' || !service.serverId || service.status !== 'running' ||
        service.asleepAt != null || !service.runtimeId || !config.success) return hold('node autoscale is blocked or placement changed');
      let measured: { value: number; generation: unknown[]; sampledAt: number; requestId: string; evidence: NodeAutoscaleEvidence };
      if (config.data.metric === 'rps') {
        const measurement = measureNodeServingTraffic(service, sample, now);
        if (measurement.value === null || !measurement.sample) return hold(measurement.holding ?? 'node serving traffic unavailable');
        const { snapshot, serving, sampledAt } = measurement.sample;
        // A new proxy source, agent epoch, route or replica set starts a new sustained window.
        measured = { value: measurement.value, sampledAt, requestId: snapshot.requestId,
          generation: [serving, snapshot.sourceId, snapshot.proxyId, snapshot.epoch, snapshot.routingGeneration, snapshot.targetHash],
          evidence: { serverId: service.serverId, serviceId: snapshot.serviceId, deploymentId: snapshot.deploymentId, sampledAt,
            requestId: snapshot.requestId, targets: serving } };
      } else {
        const measurement = measureNodeAutoscale(service, config.data.metric, sample, now);
        if (measurement.value === null) return hold(measurement.holding ?? 'node metrics unavailable');
        const { serverId: _serverId, sampledAt, ...data } = sample as Record<string, unknown> & { sampledAt: number };
        const receipt = containerMetricsReply.parse(data);
        const identities = receipt.items.map(item => ({ name: item.name, id: item.id, restarts: item.restarts,
          cpuLimitMilli: item.cpuLimitMilli, memLimitBytes: item.memLimitBytes })).sort((a, b) => a.name.localeCompare(b.name));
        measured = { value: measurement.value, sampledAt, requestId: receipt.requestId, generation: [identities],
          evidence: { serverId: service.serverId, serviceId: receipt.serviceId, deploymentId: receipt.deploymentId,
            sampledAt, requestId: receipt.requestId, targets: receipt.items.map(({ name, id }) => ({ name, id })) } };
      }
      const { sampledAt, evidence } = measured;
      const generation = JSON.stringify([service.serverId, service.runtimeId, service.runtimeReplicas, config.data, ...measured.generation]);
      let state = states.get(service.id);
      if (!state || state.generation !== generation || now < state.observedAt || now - state.observedAt > AUTOSCALE_STATS_MAX_AGE_MS || sampledAt < state.sampledAt) {
        state = { generation, sampledAt, requestId: measured.requestId, observedAt: now,
          window: { history: [], aboveSince: null, belowSince: null, desired: null } };
        states.set(service.id, state);
      } else if (sampledAt === state.sampledAt || measured.requestId === state.requestId) {
        return { to: null, holding: 'waiting for a new node metrics sample' };
      } else { state.sampledAt = sampledAt; state.requestId = measured.requestId; state.observedAt = now; }
      const floor = effectiveMinimum(config.data, now);
      const effective = { ...config.data, minReplicas: floor.minReplicas };
      const bounded = Math.min(effective.maxReplicas, Math.max(effective.minReplicas, service.runtimeReplicas));
      const measurement = { value: measured.value };
      if (bounded !== service.runtimeReplicas) { onSample?.({ value: measurement.value, desired: bounded, sampledAt }); states.delete(service.id); return { to: bounded, holding: null, evidence }; }
      const decision = decideWithState(state.window, service.runtimeReplicas, measurement.value, effective, now);
      onSample?.({ value: measurement.value, desired: state.window.desired!, sampledAt });
      if (decision) states.delete(service.id);
      return decision ? { to: decision.to, holding: null, evidence } : { to: null, holding: null };
    },
  };
}
