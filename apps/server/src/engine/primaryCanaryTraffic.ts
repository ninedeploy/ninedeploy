import { randomBytes } from 'node:crypto';
import type { DB, PrimaryRuntimeSnapshot } from '@ninedeploy/db';
import type { ProxyTrafficOpen } from '@ninedeploy/schemas';
import { agentOp, agentTransportSealed } from '../lib/agentClient.js';
import { capabilityRefusal } from '../lib/agentCapabilities.js';
import { openLocalCanaryTraffic } from '../lib/localCanaryTraffic.js';
import { openNodeProxyTraffic } from '../lib/nodeProxyTrafficClient.js';
import { proxyTrafficUnavailable } from '../lib/proxyTrafficCounter.js';
import { trafficAnalyticsEnabled } from '../lib/trafficAnalytics.js';
import type { RunCanaryDeps } from './canary.js';
import { canaryActive, canaryRouteFor, canaryStatus } from './canaryState.js';
import { ProxyRoutingUnconfirmed } from '../lib/proxyRoutingAck.js';
import type { PrimaryRecoveryLease } from './primaryRecovery.js';
import { renderDynamicConfig, writeDynamicConfig } from './proxy.js';

type Source = { id: number; slug: string; runtimeId: string | null; serverId: number | null; orchestrator: string | null };
type Recovery = Pick<PrimaryRecoveryLease, 'row' | 'check' | 'beforeCanaryRouting' | 'confirm'>;
type Step = Parameters<NonNullable<RunCanaryDeps['openTraffic']>>[0];

/** Bind a worker's traffic source to its primary transition, never a fan-out or panel substitute. */
export async function primaryCanaryTraffic(db: DB, source: Source, deploymentId: number, recovery: Recovery | undefined,
  checkpoint: () => Promise<void>): Promise<Pick<RunCanaryDeps, 'measured' | 'prepare' | 'writeConfig' | 'openTraffic'>> {
  const writeConfig = async () => {
    await recovery?.beforeCanaryRouting();
    // confirm() requires the selected node's loaded HTTP/TLS generation, including rollback removals.
    if (recovery) await recovery.confirm();
    else await writeDynamicConfig(db, { confirmServiceId: source.id });
    await recovery?.check();
  };
  if (source.serverId == null) return {
    measured: await trafficAnalyticsEnabled(db), writeConfig,
    openTraffic: step => openLocalCanaryTraffic(db, source, step.durationMs + 60_000),
  };

  const nodeId = source.serverId;
  const unavailable = () => proxyTrafficUnavailable('primary transition identities were not confirmed');
  const bound = () => {
    const row = recovery?.row;
    if (!row || source.orchestrator === 'swarm' || row.serverId !== nodeId || row.serviceId !== source.id || row.deploymentId !== deploymentId ||
      !source.runtimeId || row.previous?.runtimeId !== source.runtimeId || row.previous.native || row.candidate.native ||
      row.candidate.runtimeId === source.runtimeId) throw unavailable();
    return row;
  };
  const targets = (group: PrimaryRuntimeSnapshot): ProxyTrafficOpen['stable'] => {
    if (!Number.isInteger(group.port) || group.port! < 1 || group.port! > 65535 || group.replicas !== group.containers.length || !group.containers.length) throw unavailable();
    return group.containers.map(item => {
      if (!item.observed || !item.id || !/^[a-f0-9]{64}$/.test(item.id)) throw unavailable();
      return { name: item.name, id: item.id, port: group.port! };
    });
  };
  const initial = bound();
  // Snapshot immutable serving identities; spare autoscale capacity is not a traffic backend.
  const stable = targets(initial.previous!), canary = targets(initial.candidate);
  const signature = JSON.stringify([stable, canary]);
  const current = async () => {
    await checkpoint(); await recovery!.check();
    const row = bound();
    if (JSON.stringify([targets(row.previous!), targets(row.candidate)]) !== signature) throw unavailable();
  };
  await current();
  const refusal = await capabilityRefusal((op, args, sink) => agentOp(db, nodeId, op, args, sink, { timeoutMs: 5000 }), `#${nodeId}`,
    await agentTransportSealed(db, nodeId), { cap: ['proxy.traffic', 'proxy.routingAck'], feature: 'run measured canary releases', sealedRequired: true });
  if (refusal) throw proxyTrafficUnavailable(refusal.message);
  await current();
  const stepCurrent = async (step: Step) => {
    await current();
    const route = canaryRouteFor(source.id, { serverId: nodeId, stableRuntimeId: source.runtimeId }), status = canaryStatus(source.id);
    if (step.deploymentId !== deploymentId || step.serverId !== nodeId || step.stableRuntimeId !== source.runtimeId ||
      !status.active || status.deploymentId !== deploymentId || status.step !== step.step || route?.weight !== step.weight ||
      route?.runtimeId !== recovery!.row.candidate.runtimeId || route?.port !== recovery!.row.candidate.port || route?.replicas !== canary.length) {
      throw proxyTrafficUnavailable('canary step or placement changed');
    }
  };
  return {
    measured: true,
    prepare: async () => {
      const stableOnly = async () => {
        await current();
        if (canaryActive(source.id)) throw new ProxyRoutingUnconfirmed('A canary already owns routing; stable-source preparation refused');
      };
      await stableOnly();
      await recovery!.confirm();
      await stableOnly();
      const routingConfig = await renderDynamicConfig(db, { serverId: nodeId });
      await stableOnly();
      const window = await openNodeProxyTraffic(db, { requestId: randomBytes(16).toString('hex'), nodeId, serviceId: source.id, deploymentId, step: 1,
        slug: source.slug, durationMs: 1000, routingConfig, stable, canary }, { checkpoint: stableOnly });
      try { await stableOnly(); } finally { await window.close(); }
      await stableOnly();
    },
    writeConfig: async () => { await recovery!.check(); bound(); await writeConfig(); },
    openTraffic: async step => {
      await stepCurrent(step);
      const routingConfig = await renderDynamicConfig(db, { serverId: nodeId });
      await stepCurrent(step);
      return openNodeProxyTraffic(db, { requestId: randomBytes(16).toString('hex'), nodeId, serviceId: source.id, deploymentId, step: step.step,
        slug: source.slug, durationMs: step.durationMs, routingConfig, stable, canary }, { checkpoint: () => stepCurrent(step) });
    },
  };
}
