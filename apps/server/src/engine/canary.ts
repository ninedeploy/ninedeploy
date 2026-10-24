import { canaryStepProblem, type CanaryConfig, type CanaryReleaseStats } from '@ninedeploy/schemas';
import {
  beginCanary,
  canaryPromoteRequested,
  canaryStats,
  canaryOwnedBy,
  canaryActive,
  endCanary,
  setCanaryStep,
  setCanaryObservation,
} from './canaryState.js';
import type { CanaryTrafficObservation } from '../lib/canaryTrafficWindow.js';
import type { DeployRuntime } from './types.js';
import { ProxyRoutingUnconfirmed } from '../lib/proxyRoutingAck.js';

/**
 * 0.16.9 canary releases: the pipeline stage between the new release's
 * healthcheck and the switch of all traffic to it (engine/pipeline.ts).
 *
 * Each step sends `weight` percent of the requests to the new release
 * (proxy.ts renders a Traefik weighted service from canaryState), waits
 * `stepSeconds` while it probes the new release's healthcheck, then judges
 * the step's 5xx share and p95 on the new release (traffic analytics, when
 * on). A failure routes everything back to the previous release before it
 * throws, so the pipeline's failure path stops the new container only once
 * nothing is sent to it.
 */

/** Why this deploy is not released as a canary, or null when it is. */
export function canarySkipReason(input: {
  config: CanaryConfig | null | undefined;
  type: string;
  serverId: number | null;
  orchestrator: string | null;
  previous: DeployRuntime | undefined;
  previousServing?: boolean;
  runtime: DeployRuntime;
  rollback: boolean;
  hostPorts: boolean;
  routedDomains: number;
}): string | null {
  if (!input.config) return null;
  if (input.type !== 'docker') return 'canary releases apply to docker services only';
  if (input.orchestrator === 'swarm') return 'canary releases do not apply to Swarm services';
  if (input.previousServing === false) return 'there is no serving previous release to split traffic with';
  if (!input.previous || input.previous.runtimeId === input.runtime.runtimeId) return 'there is no previous release to split traffic with';
  if (input.hostPorts) return 'the service publishes host ports, so the previous release was stopped before the new one started';
  if (input.rollback) return 'a rollback switches all traffic at once';
  if (input.routedDomains === 0) return 'no domain routes traffic to the service';
  return null;
}

/** A canary step failed; the previous release has all the traffic again. */
export class CanaryAborted extends Error {
  constructor(reason: string) {
    super(`Canary aborted: ${reason}`);
    this.name = 'CanaryAborted';
  }
}

export interface RunCanaryDeps {
  serviceId: number;
  slug: string;
  deploymentId: number;
  serverId?: number | null;
  stableRuntimeId?: string | null;
  /** Capture this incarnation so the parent cannot clean up a newer retry. */
  onOwner?: (owner: symbol) => void;
  config: CanaryConfig;
  runtime: DeployRuntime;
  log: (line: string) => void;
  /** Re-render the proxy config (it reads the canary route). */
  writeConfig: () => Promise<void>;
  /** One quick healthcheck of the new release. */
  probe: () => Promise<boolean>;
  /** Throws when the deploy was cancelled. */
  checkpoint: () => Promise<void>;
  /** Whether traffic analytics is on, so the steps can be measured. */
  measured: boolean;
  /** Confirm the stable route and traffic source before creating any split. */
  prepare?: () => Promise<void>;
  /** Open an independent source-bound window after routing acknowledgement. */
  openTraffic?: (step: Readonly<{ deploymentId: number; serverId: number | null; stableRuntimeId: string | null; step: number; weight: number; durationMs: number }>) => Promise<CanaryTrafficObservation>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How often the loop checks for a cancel or a promote. */
  tickMs?: number;
  /** How often it probes the new release's healthcheck. */
  probeEveryMs?: number;
}

const fmt = (s: CanaryReleaseStats): string =>
  s.requests === 0 ? 'no requests' : `${s.requests} requests, ${s.errorRate}% 5xx, p95 ${s.p95Ms} ms`;

/**
 * Run every step. Resolves `'completed'` after the last step or `'promoted'`
 * when a promote was asked for, with the canary route still in place: the
 * caller ends it and switches all traffic in one route write. Throws
 * {@link CanaryAborted} (or the checkpoint's error) with all traffic back on
 * the previous release.
 */
export async function runCanary(deps: RunCanaryDeps): Promise<'completed' | 'promoted'> {
  if (deps.measured && !deps.openTraffic) throw new CanaryAborted('traffic observation is unavailable');
  if (deps.serverId != null && !deps.measured) throw new CanaryAborted('node canary requires measured traffic');
  await deps.checkpoint();
  await deps.prepare?.();
  await deps.checkpoint();
  if (canaryActive(deps.serviceId)) throw new ProxyRoutingUnconfirmed('A canary already owns routing; the new split was refused');
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tickMs = deps.tickMs ?? 5_000;
  const probeEveryMs = deps.probeEveryMs ?? 15_000;
  const { config: cfg, log } = deps;
  const owner = beginCanary(deps.serviceId, deps.slug, deps.deploymentId, cfg.steps.length, deps.measured, deps.measured,
    { serverId: deps.serverId ?? null, stableRuntimeId: deps.stableRuntimeId ?? null });
  const assertOwner = () => {
    if (!canaryOwnedBy(deps.serviceId, deps.deploymentId, owner)) throw new ProxyRoutingUnconfirmed('Canary ownership changed; routing and runtime generations are left to the current owner');
  };
  const checkpoint = async () => { await deps.checkpoint(); assertOwner(); };
  const promoted = () => { log('Canary promoted: skipping the remaining steps'); log('##[stage:CANARY:success] Promoted'); return 'promoted' as const; };
  try {
    deps.onOwner?.(owner);
    log(
      `Canary release: ${cfg.steps.map((w) => `${w}%`).join(' → ')} → 100%, ${cfg.stepSeconds}s per step. ` +
        (deps.measured
          ? `A step fails over ${cfg.maxErrorRate}% 5xx${cfg.maxP95Ms != null ? ` or a p95 over ${cfg.maxP95Ms} ms` : ''} (judged from ${cfg.minRequests} requests).`
          : 'Traffic analytics is off (Traefik → Traffic, operators), so each step is judged on the healthcheck only.'),
    );
    for (const [i, weight] of cfg.steps.entries()) {
      let observation: CanaryTrafficObservation | undefined;
      let failed = false;
      try {
        await checkpoint();
        let startedAt = now();
        setCanaryStep(
          deps.serviceId,
          i + 1,
          { runtimeId: deps.runtime.runtimeId, replicas: deps.runtime.replicas ?? 1, port: deps.runtime.port, weight },
          startedAt,
          startedAt + cfg.stepSeconds * 1000,
        );
        try {
          await deps.writeConfig();
        } catch (err) {
          throw new CanaryAborted(`the Traefik config could not be written (${err instanceof Error ? err.message : String(err)})`);
        }
        await checkpoint();
        // Count the full observation window only once the requested split is loaded.
        if (deps.measured) observation = await deps.openTraffic!(Object.freeze({ deploymentId: deps.deploymentId, serverId: deps.serverId ?? null,
          stableRuntimeId: deps.stableRuntimeId ?? null, step: i + 1, weight, durationMs: cfg.stepSeconds * 1000 }));
        await checkpoint();
        startedAt = now();
        setCanaryStep(deps.serviceId, i + 1,
          { runtimeId: deps.runtime.runtimeId, replicas: deps.runtime.replicas ?? 1, port: deps.runtime.port, weight },
          startedAt, startedAt + cfg.stepSeconds * 1000);
        const observe = async (finish: boolean) => {
          if (!observation) return;
          const snapshot = await (finish ? observation.finish() : observation.sample());
          await checkpoint();
          if (finish && !snapshot.complete) throw new CanaryAborted('traffic observation is incomplete');
          if (!setCanaryObservation(deps.serviceId, deps.deploymentId, i + 1, snapshot)) {
            throw new CanaryAborted('traffic observation no longer belongs to this deployment step');
          }
        };
        log(`##[stage:CANARY:running] Step ${i + 1}/${cfg.steps.length}: ${weight}% of requests go to the new release for ${cfg.stepSeconds}s`);
        let lastProbe = startedAt;
        let lastProbeCompletedAt: number | null = null;
        let promotionWaiting = false;
        while (now() < startedAt + cfg.stepSeconds * 1000) {
          await sleep(tickMs);
          await checkpoint();
          await observe(false);
          if (canaryPromoteRequested(deps.serviceId)) {
            if (deps.serverId == null) { await observe(true); return promoted(); }
            if (!promotionWaiting) { log('Promotion waits for the current measured step to finish and pass'); promotionWaiting = true; }
          }
          if (now() - lastProbe >= probeEveryMs) {
            lastProbe = now();
            const healthy = await deps.probe(), completedAt = now(); await checkpoint();
            if (!healthy) throw new CanaryAborted(`the new release failed its healthcheck at ${weight}%`);
            lastProbeCompletedAt = completedAt;
          }
        }
        if (lastProbeCompletedAt === null || lastProbeCompletedAt < startedAt + cfg.stepSeconds * 1000) {
          const healthy = await deps.probe(); await checkpoint();
          if (!healthy) throw new CanaryAborted(`the new release failed its healthcheck at ${weight}%`);
        }
        await observe(true);
        const stats = canaryStats(deps.serviceId)!;
        if (deps.measured) {
          log(`Step ${i + 1} measured: new release ${fmt(stats.canary)}; previous release ${fmt(stats.stable)}`);
          const problem = canaryStepProblem(stats.canary, cfg);
          if (problem) throw new CanaryAborted(`at ${weight}%, ${problem}`);
          if (stats.canary.requests < cfg.minRequests) {
            log(`Only ${stats.canary.requests} requests reached the new release (${cfg.minRequests} are needed to judge them); the step passed on its healthcheck`);
          }
        }
        if (deps.serverId != null && canaryPromoteRequested(deps.serviceId)) return promoted();
      } catch (err) { failed = true; throw err; }
      finally { await observation?.close(); if (failed) assertOwner(); else await checkpoint(); }
    }
    log('##[stage:CANARY:success] Every step passed');
    return 'completed';
  } catch (err) {
    log(`##[stage:CANARY:failed] ${err instanceof Error ? err.message : String(err)}`);
    if (!canaryOwnedBy(deps.serviceId, deps.deploymentId, owner)) {
      throw new ProxyRoutingUnconfirmed('Canary ownership changed; routing and runtime generations are left to the current owner');
    }
    endCanary(deps.serviceId, deps.deploymentId, owner);
    const rollback = async () => {
      if (canaryActive(deps.serviceId)) throw new ProxyRoutingUnconfirmed('A newer canary owns routing; the old rollback is not applied');
      await deps.writeConfig();
      if (canaryActive(deps.serviceId)) throw new ProxyRoutingUnconfirmed('A newer canary owns routing; the old rollback outcome is not claimed');
    };
    // Route everything back before the pipeline stops the new container.
    // A failed confirmation does not prove the candidate is no longer routed.
    try {
      await rollback();
    } catch {
      if (canaryActive(deps.serviceId)) throw new ProxyRoutingUnconfirmed('A newer canary owns routing; the old rollback is not applied');
      await sleep(2000);
      try { await rollback(); } catch {
        log('⚠ Canary rollback was not confirmed; both runtime generations are kept running');
        throw new ProxyRoutingUnconfirmed('Canary routing rollback was not confirmed; both runtime generations are kept running');
      }
    }
    log('All traffic is back on the previous release.');
    throw err;
  }
}
