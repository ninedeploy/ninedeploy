import { type Service, services, type DB } from '@ninedeploy/db';
import {
  autoscaleConfig,
  desiredReplicas,
  type AutoscaleConfig,
  type AutoscaleEvent,
  type AutoscaleStatusView,
} from '@ninedeploy/schemas';
import { and, eq } from 'drizzle-orm';
import { MAX_REPLICAS, replicaNames } from '../engine/dockerNames.js';
import type { ContainerStat } from './stats.js';
import { serviceRequestRate } from './requestRate.js';

/**
 * 0.16.10 autoscaling (plugins/autoscaler.ts runs it every 30 s).
 *
 * A deploy of an autoscaled docker service creates all `maxReplicas`
 * containers and stops the ones it does not need (engine/builders/docker.ts),
 * so scaling here is only `docker start` / `docker stop` of `<runtime>-rN`
 * plus `services.runtimeReplicas`, which the proxy renders. Scaling up probes
 * each started container before it is routed; scaling down routes the
 * containers away before it stops them.
 *
 * Decisions follow Kubernetes' HPA: the desired count is the current one
 * scaled by value/target (10 % tolerance). Up happens once the need has
 * lasted `scaleUpSeconds`, to the smallest count asked for in that time;
 * down once it has lasted `scaleDownSeconds`, to the largest. State is in
 * memory: after a restart the windows start again.
 */

export const AUTOSCALE_TICK_MS = 30_000;
/** A started container has this long to pass its healthcheck before it is stopped again. */
export const AUTOSCALE_PROBE_MS = 60_000;

interface ServiceState {
  history: Array<{ at: number; desired: number }>;
  aboveSince: number | null;
  belowSince: number | null;
  value: number | null;
  desired: number | null;
  holding: string | null;
  lastEvent: AutoscaleEvent | null;
}

const states = new Map<number, ServiceState>();

function stateOf(serviceId: number): ServiceState {
  let s = states.get(serviceId);
  if (!s) {
    s = { history: [], aboveSince: null, belowSince: null, value: null, desired: null, holding: null, lastEvent: null };
    states.set(serviceId, s);
  }
  return s;
}

/** The service's autoscale configuration, or null when it has none (or a stored one that no longer parses). */
export function autoscaleOf(svc: Pick<Service, 'autoscale'>): AutoscaleConfig | null {
  if (!svc.autoscale) return null;
  const parsed = autoscaleConfig.safeParse(svc.autoscale);
  return parsed.success ? parsed.data : null;
}

/** Containers serving now: `runtimeReplicas`, at least 1. */
export const servingReplicas = (svc: Pick<Service, 'runtimeReplicas'>): number => Math.max(1, Math.min(svc.runtimeReplicas ?? 1, MAX_REPLICAS));

/**
 * The metric's value per serving container, or why it cannot be read.
 * cpu: percent of the CPU limit (of one core without one); memory: percent
 * of the memory limit; rps: requests per second per container over the last
 * minute (traffic analytics must be on).
 */
export function measure(
  svc: Pick<Service, 'id' | 'runtimeId' | 'runtimeReplicas' | 'cpuLimitMilli'>,
  cfg: AutoscaleConfig,
  containers: ReadonlyMap<string, ContainerStat>,
  opts: { analyticsOn: boolean; now: number },
): { value: number | null; holding: string | null } {
  const current = servingReplicas(svc);
  if (cfg.metric === 'rps') {
    if (!opts.analyticsOn) return { value: null, holding: 'requests per second need traffic analytics (Traefik → Traffic)' };
    const perContainer = serviceRequestRate(svc.id, 60_000, opts.now) / current;
    return { value: Math.round(perContainer * 100) / 100, holding: null };
  }
  const stats = replicaNames(svc.runtimeId!, current)
    .map((n) => containers.get(n))
    .filter((s): s is ContainerStat => s !== undefined);
  if (stats.length === 0) return { value: null, holding: 'no container stats yet' };
  const per = stats.map((s) => {
    if (cfg.metric === 'memory') return s.memLimitBytes > 0 ? (s.memBytes / s.memLimitBytes) * 100 : 0;
    const cores = (svc.cpuLimitMilli ?? 0) > 0 ? svc.cpuLimitMilli! / 1000 : 1;
    return s.cpuPct / cores;
  });
  return { value: Math.round((per.reduce((a, b) => a + b, 0) / per.length) * 10) / 10, holding: null };
}

/**
 * Feed one measurement; returns the count to scale to now, or null to hold.
 * Exported for tests; the plugin calls {@link autoscaleStep}.
 */
export function decide(serviceId: number, current: number, value: number, cfg: AutoscaleConfig, now: number): { to: number; reason: string } | null {
  const st = stateOf(serviceId);
  const desired = desiredReplicas(current, value, cfg);
  st.desired = desired;
  st.history.push({ at: now, desired });
  const keep = Math.max(cfg.scaleUpSeconds, cfg.scaleDownSeconds) * 1000;
  st.history = st.history.filter((h) => h.at >= now - keep);
  const unit = cfg.metric === 'rps' ? ' req/s' : '%';
  if (desired > current) {
    st.belowSince = null;
    st.aboveSince ??= now;
    if (now - st.aboveSince < cfg.scaleUpSeconds * 1000) return null;
    const since = st.aboveSince;
    const to = Math.min(...st.history.filter((h) => h.at >= since).map((h) => h.desired));
    return to > current ? { to, reason: `${cfg.metric} ${value}${unit} per container over ${cfg.scaleUpSeconds}s (target ${cfg.target}${unit})` } : null;
  }
  if (desired < current) {
    st.aboveSince = null;
    st.belowSince ??= now;
    if (now - st.belowSince < cfg.scaleDownSeconds * 1000) return null;
    const since = st.belowSince;
    const to = Math.max(...st.history.filter((h) => h.at >= since).map((h) => h.desired));
    return to < current ? { to, reason: `${cfg.metric} ${value}${unit} per container over ${cfg.scaleDownSeconds}s (target ${cfg.target}${unit})` } : null;
  }
  st.aboveSince = null;
  st.belowSince = null;
  return null;
}

export interface AutoscaleDeps {
  db: DB;
  /** `docker <args>`; rejects on failure. */
  docker: (args: string[]) => Promise<void>;
  /** Whether a just-started container passes the service's healthcheck. */
  probe: (svc: Service, containerName: string) => Promise<boolean>;
  writeConfig: () => Promise<void>;
  audit: (action: string, entity: string, meta: Record<string, unknown>) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

/**
 * Move a service from `from` to `to` serving containers. Returns the count
 * it reached: up stops at the first container that will not start or pass
 * its healthcheck. The row is only written while its runtime is the one
 * measured — a deploy that finished meanwhile wins.
 */
export async function scaleService(deps: AutoscaleDeps, svc: Service, from: number, to: number, reason: string, now: number): Promise<number> {
  const names = replicaNames(svc.runtimeId!, Math.max(from, to));
  const setServing = async (n: number): Promise<boolean> => {
    const updated = await deps.db
      .update(services)
      .set({ runtimeReplicas: n })
      .where(and(eq(services.id, svc.id), eq(services.runtimeId, svc.runtimeId!)))
      .returning({ id: services.id });
    return updated.length > 0;
  };
  let reached = from;
  if (to > from) {
    for (let i = from; i < to; i++) {
      const name = names[i]!;
      try {
        await deps.docker(['start', name]);
      } catch (err) {
        deps.log(`autoscale: ${svc.name}: ${name} would not start (${err instanceof Error ? err.message : String(err)})`);
        stateOf(svc.id).holding = `${name} could not be started; the next deploy creates the containers autoscaling starts`;
        break;
      }
      if (!(await deps.probe(svc, name))) {
        deps.log(`autoscale: ${svc.name}: ${name} failed its healthcheck; stopped again`);
        stateOf(svc.id).holding = `${name} failed its healthcheck when started`;
        await deps.docker(['stop', '-t', '5', name]).catch(() => undefined);
        break;
      }
      reached = i + 1;
    }
    if (reached === from) return from;
    if (!(await setServing(reached))) return from;
    await deps.writeConfig();
  } else {
    if (!(await setServing(to))) return from;
    await deps.writeConfig();
    // As a deploy's cleanup: let Traefik apply the route before the stop.
    await deps.sleep(2000);
    await deps.docker(['stop', '-t', '10', ...names.slice(to, from)]).catch((err: unknown) =>
      deps.log(`autoscale: ${svc.name}: stopping ${names.slice(to, from).join(', ')} failed (${err instanceof Error ? err.message : String(err)})`),
    );
    reached = to;
  }
  const event: AutoscaleEvent = { at: new Date(now).toISOString(), from, to: reached, reason };
  const st = stateOf(svc.id);
  st.lastEvent = event;
  st.history = [];
  st.aboveSince = null;
  st.belowSince = null;
  await deps.audit('service.autoscale', `${svc.name}: ${from} → ${reached}`, { serviceId: svc.id, from, to: reached, reason });
  return reached;
}

/** Why an autoscaled service is not measured now, or null when it is. */
export function holdReason(svc: Service, inFlight: ReadonlySet<number>, canaryRunning: boolean): string | null {
  if (svc.serverId != null) return 'autoscaling runs on the panel host only for now; this service runs on a node';
  if (svc.orchestrator === 'swarm') return 'a Swarm service scales with its own replicas';
  if (svc.status !== 'running' || !svc.runtimeId) return 'the service is not running';
  if (svc.asleepAt != null) return 'the service is asleep (scale to zero)';
  if (inFlight.has(svc.id)) return 'a deploy is in progress';
  if (canaryRunning) return 'a canary release is in progress';
  return null;
}

/**
 * One look at one autoscaled service: stop spare containers that run
 * unrouted (a Docker restart with `--restart always`), measure, decide,
 * scale. Returns the count serving afterwards.
 */
export async function autoscaleStep(
  deps: AutoscaleDeps,
  svc: Service,
  cfg: AutoscaleConfig,
  ctx: { containers: ReadonlyMap<string, ContainerStat>; analyticsOn: boolean; inFlight: ReadonlySet<number>; canaryRunning: boolean; now: number },
): Promise<number> {
  const st = stateOf(svc.id);
  const current = servingReplicas(svc);
  const hold = holdReason(svc, ctx.inFlight, ctx.canaryRunning);
  st.holding = hold;
  if (hold) {
    st.aboveSince = null;
    st.belowSince = null;
    return current;
  }
  const strays = replicaNames(svc.runtimeId!, cfg.maxReplicas).slice(current).filter((n) => ctx.containers.has(n));
  if (strays.length > 0) {
    deps.log(`autoscale: ${svc.name}: stopping ${strays.join(', ')}, running but not routed`);
    await deps.docker(['stop', '-t', '10', ...strays]).catch(() => undefined);
  }
  const m = measure(svc, cfg, ctx.containers, { analyticsOn: ctx.analyticsOn, now: ctx.now });
  st.value = m.value;
  st.holding = m.holding;
  // Outside the bounds (the configuration changed since the deploy): move inside first.
  const bounded = Math.min(cfg.maxReplicas, Math.max(cfg.minReplicas, current));
  if (bounded !== current) {
    return scaleService(deps, svc, current, bounded, `the configured bounds are ${cfg.minReplicas}–${cfg.maxReplicas}`, ctx.now);
  }
  if (m.value == null) return current;
  const d = decide(svc.id, current, m.value, cfg, ctx.now);
  if (!d) return current;
  return scaleService(deps, svc, current, d.to, d.reason, ctx.now);
}

/** `GET /v1/services/:id/autoscale`. */
export function autoscaleStatus(svc: Service): AutoscaleStatusView {
  const cfg = autoscaleOf(svc);
  const replicas = servingReplicas(svc);
  if (!cfg) return { enabled: false, replicas };
  const st = states.get(svc.id);
  return {
    enabled: true,
    replicas,
    minReplicas: cfg.minReplicas,
    maxReplicas: cfg.maxReplicas,
    metric: cfg.metric,
    target: cfg.target,
    value: st?.value ?? null,
    desired: st?.desired ?? null,
    holding: st?.holding ?? null,
    lastEvent: st?.lastEvent ?? null,
  };
}

/** Forget a service's windows (its configuration changed or it was redeployed). */
export function resetAutoscaleState(serviceId?: number): void {
  if (serviceId === undefined) states.clear();
  else states.delete(serviceId);
}
