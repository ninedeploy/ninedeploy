import { canaryStepProblem, type CanaryConfig, type CanaryReleaseStats } from '@ninedeploy/schemas';
import {
  beginCanary,
  canaryPromoteRequested,
  canaryStats,
  endCanary,
  setCanaryStep,
} from './canaryState.js';
import type { DeployRuntime } from './types.js';

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
  runtime: DeployRuntime;
  rollback: boolean;
  hostPorts: boolean;
  routedDomains: number;
}): string | null {
  if (!input.config) return null;
  if (input.type !== 'docker') return 'canary releases apply to docker services only';
  if (input.serverId != null) return 'canary releases run on the panel host only for now; this service runs on a node';
  if (input.orchestrator === 'swarm') return 'canary releases do not apply to Swarm services';
  if (!input.previous || input.previous.runtimeId === input.runtime.runtimeId) return 'there is no previous release to split traffic with';
  if (input.hostPorts) return 'the service publishes host ports, so the previous release was stopped before the new one started';
  if (input.rollback) return 'a rollback switches all traffic at once';
  if (input.routedDomains === 0) return 'no domain routes traffic to the service';
  return null;
}

/** A canary step failed; the previous release has all the traffic again. */
export class CanaryAborted extends Error {
  constructor(reason: string) {
    super(`Canary aborted: ${reason}. All traffic is back on the previous release.`);
    this.name = 'CanaryAborted';
  }
}

export interface RunCanaryDeps {
  serviceId: number;
  slug: string;
  deploymentId: number;
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
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tickMs = deps.tickMs ?? 5_000;
  const probeEveryMs = deps.probeEveryMs ?? 15_000;
  const { config: cfg, log } = deps;
  beginCanary(deps.serviceId, deps.slug, deps.deploymentId, cfg.steps.length, deps.measured);
  log(
    `Canary release: ${cfg.steps.map((w) => `${w}%`).join(' → ')} → 100%, ${cfg.stepSeconds}s per step. ` +
      (deps.measured
        ? `A step fails over ${cfg.maxErrorRate}% 5xx${cfg.maxP95Ms != null ? ` or a p95 over ${cfg.maxP95Ms} ms` : ''} (judged from ${cfg.minRequests} requests).`
        : 'Traffic analytics is off (Traefik → Traffic, operators), so each step is judged on the healthcheck only.'),
  );
  try {
    for (const [i, weight] of cfg.steps.entries()) {
      const startedAt = now();
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
      log(`##[stage:CANARY:running] Step ${i + 1}/${cfg.steps.length}: ${weight}% of requests go to the new release for ${cfg.stepSeconds}s`);
      let lastProbe = startedAt;
      while (now() < startedAt + cfg.stepSeconds * 1000) {
        await sleep(tickMs);
        await deps.checkpoint();
        if (canaryPromoteRequested(deps.serviceId)) {
          log('Canary promoted: skipping the remaining steps');
          log('##[stage:CANARY:success] Promoted');
          return 'promoted';
        }
        if (now() - lastProbe >= probeEveryMs) {
          lastProbe = now();
          if (!(await deps.probe())) throw new CanaryAborted(`the new release failed its healthcheck at ${weight}%`);
        }
      }
      if (!(await deps.probe())) throw new CanaryAborted(`the new release failed its healthcheck at ${weight}%`);
      const stats = canaryStats(deps.serviceId)!;
      if (deps.measured) {
        log(`Step ${i + 1} measured: new release ${fmt(stats.canary)}; previous release ${fmt(stats.stable)}`);
        const problem = canaryStepProblem(stats.canary, cfg);
        if (problem) throw new CanaryAborted(`at ${weight}%, ${problem}`);
        if (stats.canary.requests < cfg.minRequests) {
          log(`Only ${stats.canary.requests} requests reached the new release (${cfg.minRequests} are needed to judge them); the step passed on its healthcheck`);
        }
      }
    }
    log('##[stage:CANARY:success] Every step passed');
    return 'completed';
  } catch (err) {
    log(`##[stage:CANARY:failed] ${err instanceof Error ? err.message : String(err)}`);
    endCanary(deps.serviceId);
    // Route everything back before the pipeline stops the new container.
    // One retry; a write that still fails is logged and the stop goes ahead,
    // as with any failed deploy whose route write failed.
    try {
      await deps.writeConfig();
    } catch {
      await sleep(2000);
      await deps.writeConfig().catch((e: unknown) => log(`⚠ could not route the traffic back: ${e instanceof Error ? e.message : String(e)}`));
    }
    throw err;
  }
}
