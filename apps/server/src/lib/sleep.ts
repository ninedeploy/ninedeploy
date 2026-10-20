import { type DB, type Service, services } from '@ninedeploy/db';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { MAX_REPLICAS, replicaNames } from '../engine/dockerNames.js';
import { lastServiceRequestAt } from './requestRate.js';

/**
 * 0.16.11 scale to zero (plugins/sleeper.ts looks every minute).
 *
 * A docker service on the panel host with `sleepAfterMinutes` set goes to
 * sleep once its domains have had no request for that long: the routes of
 * its domains are pointed at the panel's wake endpoint (engine/proxy.ts,
 * modules/wake.ts), then its containers stop. The next request through one
 * of its domains starts them, waits for the healthcheck, routes the domains
 * back and sends the visitor on.
 *
 * `services.asleepAt` is the only stored state: the service stays
 * `running`, the runtime reconcile leaves a sleeping service alone, and a
 * deploy, a start or a stop ends the sleep. Requests are counted from the
 * traffic log, so traffic analytics must be on; without it nothing sleeps.
 */

export const SLEEP_TICK_MS = 60_000;
/** How long a request waits for a wake before it gets the "waking up" page. */
export const WAKE_WAIT_MS = 25_000;
/** A wake with no healthcheck timeout of its own gives the service this long. */
export const WAKE_PROBE_MS = 60_000;

/** When each service was last seen awake on its current runtime (in memory). */
const awake = new Map<number, { since: number; runtimeId: string }>();

/** The containers a sleeping service stops and a wake starts: the ones that serve. */
export function servingContainers(svc: Pick<Service, 'runtimeId' | 'runtimeReplicas'>): string[] {
  return replicaNames(svc.runtimeId!, Math.max(1, Math.min(svc.runtimeReplicas ?? 1, MAX_REPLICAS)));
}

/** Note the service awake now (a wake, or a runtime seen for the first time). */
export function markAwake(svc: Pick<Service, 'id' | 'runtimeId'>, now: number): void {
  awake.set(svc.id, { since: now, runtimeId: svc.runtimeId ?? '' });
}

/**
 * Why `svc` does not go to sleep now, or null when it does. A runtime seen
 * for the first time (a deploy, a panel restart) starts its idle window
 * from now: the request count is in memory and starts from zero.
 */
export function sleepHoldReason(
  svc: Service,
  ctx: { now: number; analyticsOn: boolean; inFlight: ReadonlySet<number>; routedDomains: number; canaryRunning: boolean },
): string | null {
  if (svc.sleepAfterMinutes == null || svc.asleepAt != null) return 'not set or already asleep';
  if (svc.type !== 'docker') return 'scale to zero applies to docker services only';
  if (svc.serverId != null) return 'scale to zero runs on the panel host only for now; this service runs on a node';
  if (svc.orchestrator === 'swarm') return 'scale to zero does not apply to Swarm services';
  if (svc.status !== 'running' || !svc.runtimeId) return 'the service is not running';
  if (!ctx.analyticsOn) return 'scale to zero needs traffic analytics (Traefik → Traffic) to see requests';
  if (ctx.routedDomains === 0) return 'no domain routes to the service, so no request could wake it';
  if (ctx.inFlight.has(svc.id)) return 'a deploy is in progress';
  if (ctx.canaryRunning) return 'a canary release is in progress';
  const seen = awake.get(svc.id);
  if (!seen || seen.runtimeId !== svc.runtimeId) {
    markAwake(svc, ctx.now);
    return 'just started; the idle window begins now';
  }
  const windowMs = svc.sleepAfterMinutes * 60_000;
  const last = Math.max(seen.since, lastServiceRequestAt(svc.id) ?? 0);
  if (ctx.now - last < windowMs) return 'it had a request within the idle window';
  return null;
}

export interface SleepDeps {
  db: DB;
  docker: (args: string[]) => Promise<void>;
  /** Whether a just-started container passes the service's healthcheck (within `timeoutMs`). */
  probe: (svc: Service, containerName: string, timeoutMs: number) => Promise<boolean>;
  writeConfig: () => Promise<void>;
  audit: (action: string, entity: string, meta: Record<string, unknown>) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  now?: () => number;
}

/**
 * Put `svc` to sleep: route its domains to the wake endpoint, then stop its
 * containers. False when the row moved on meanwhile (a deploy, a stop).
 */
export async function putToSleep(deps: SleepDeps, svc: Service): Promise<boolean> {
  const now = (deps.now ?? Date.now)();
  const marked = await deps.db
    .update(services)
    .set({ asleepAt: new Date(now) })
    .where(and(eq(services.id, svc.id), eq(services.runtimeId, svc.runtimeId!), eq(services.status, 'running'), isNull(services.asleepAt)))
    .returning({ id: services.id });
  if (marked.length === 0) return false;
  try {
    await deps.writeConfig();
  } catch (err) {
    // Requests would still go to containers about to stop: stay awake.
    await deps.db.update(services).set({ asleepAt: null }).where(eq(services.id, svc.id));
    deps.log(`sleep: ${svc.name}: the routes could not be written (${err instanceof Error ? err.message : String(err)}); it stays awake`);
    return false;
  }
  // As a deploy's cleanup: let Traefik apply the routes before the stop.
  await deps.sleep(2000);
  const names = servingContainers(svc);
  await deps.docker(['stop', '-t', '10', ...names]).catch((err: unknown) =>
    deps.log(`sleep: ${svc.name}: stopping ${names.join(', ')} failed (${err instanceof Error ? err.message : String(err)})`),
  );
  await deps.audit('service.sleep', svc.name, { serviceId: svc.id, afterMinutes: svc.sleepAfterMinutes });
  return true;
}

const waking = new Map<number, Promise<boolean>>();

/**
 * Wake `svc`: start its containers, wait for the primary's healthcheck,
 * route its domains back. Concurrent callers share one wake. Resolves
 * false when it could not start or stay healthy; it then stays asleep and
 * the next request tries again.
 */
export function wakeService(deps: SleepDeps, svc: Service, trigger: string): Promise<boolean> {
  const running = waking.get(svc.id);
  if (running) return running;
  const p = (async () => {
    const started = (deps.now ?? Date.now)();
    const names = servingContainers(svc);
    try {
      await deps.docker(['start', ...names]);
    } catch (err) {
      deps.log(`wake: ${svc.name}: starting ${names.join(', ')} failed (${err instanceof Error ? err.message : String(err)})`);
      return false;
    }
    const timeoutMs = (svc.healthTimeoutSeconds ?? WAKE_PROBE_MS / 1000) * 1000;
    if (!(await deps.probe(svc, names[0]!, timeoutMs))) {
      deps.log(`wake: ${svc.name}: ${names[0]} did not pass its healthcheck`);
      await deps.docker(['stop', '-t', '5', ...names]).catch(() => undefined);
      return false;
    }
    const cleared = await deps.db
      .update(services)
      .set({ asleepAt: null })
      .where(and(eq(services.id, svc.id), isNotNull(services.asleepAt)))
      .returning({ id: services.id });
    const now = (deps.now ?? Date.now)();
    markAwake(svc, now);
    if (cleared.length > 0) {
      await deps.writeConfig();
      await deps.audit('service.wake', svc.name, { serviceId: svc.id, trigger, ms: now - started });
    }
    return true;
  })().finally(() => waking.delete(svc.id));
  waking.set(svc.id, p);
  return p;
}

/** Tests only. */
export function resetSleepState(): void {
  awake.clear();
  waking.clear();
}
