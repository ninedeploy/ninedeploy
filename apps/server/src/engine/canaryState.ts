import { errorRatePercent, type CanaryReleaseStats, type CanaryStatusView } from '@ninedeploy/schemas';

/**
 * 0.16.9 canary releases: what is in progress, held in memory.
 *
 * The deploy pipeline runs a canary inside the panel process (engine/canary.ts)
 * and is the only writer. The proxy render reads {@link canaryRouteFor} to
 * split a service's traffic, the traffic tailer feeds {@link recordCanaryHit},
 * and the canary routes read {@link canaryStatus}. Nothing is persisted on
 * purpose: a panel restart ends the deploy that ran the canary (the boot
 * recovery fails it and removes its container), and the first route write
 * after boot renders from an empty registry — all traffic on the release the
 * service row names, which is the previous one.
 *
 * No imports from the proxy or the traffic module, which both import this.
 */

/** The new release's share of a service's traffic. */
export interface CanaryRoute {
  /** The new release's primary container; its replicas follow `replicaNames`. */
  runtimeId: string;
  replicas: number;
  /** Its container port; null = the service's. */
  port: number | null;
  /** Percent of the requests it gets, 1–99. */
  weight: number;
}

/** Durations kept per release and step for the p95; requests past it are still counted. */
export const CANARY_SAMPLE_CAP = 20_000;

interface Sample {
  requests: number;
  errors: number;
  durations: number[];
}

interface ActiveCanary {
  deploymentId: number;
  slug: string;
  steps: number;
  step: number;
  route: CanaryRoute | null;
  stepStartedAt: number;
  stepEndsAt: number;
  measured: boolean;
  promote: boolean;
  canary: Sample;
  stable: Sample;
}

const active = new Map<number, ActiveCanary>();
const serviceBySlug = new Map<string, number>();

const emptySample = (): Sample => ({ requests: 0, errors: 0, durations: [] });

/** A canary starts for `serviceId`; no traffic moves until {@link setCanaryStep}. */
export function beginCanary(serviceId: number, slug: string, deploymentId: number, steps: number, measured: boolean): void {
  endCanary(serviceId);
  active.set(serviceId, {
    deploymentId,
    slug,
    steps,
    step: 0,
    route: null,
    stepStartedAt: 0,
    stepEndsAt: 0,
    measured,
    promote: false,
    canary: emptySample(),
    stable: emptySample(),
  });
  serviceBySlug.set(slug, serviceId);
}

/** Move to `step` (1-based) with this route; the step's numbers start from zero. */
export function setCanaryStep(serviceId: number, step: number, route: CanaryRoute, startedAt: number, endsAt: number): void {
  const c = active.get(serviceId);
  if (!c) return;
  c.step = step;
  c.route = { ...route };
  c.stepStartedAt = startedAt;
  c.stepEndsAt = endsAt;
  c.canary = emptySample();
  c.stable = emptySample();
}

/** The canary ended (promoted, finished or aborted): the next route write sends nothing to it. */
export function endCanary(serviceId: number): void {
  const c = active.get(serviceId);
  if (!c) return;
  active.delete(serviceId);
  if (serviceBySlug.get(c.slug) === serviceId) serviceBySlug.delete(c.slug);
}

/** How the proxy splits this service's traffic now; null = all on the service's runtime. */
export function canaryRouteFor(serviceId: number): CanaryRoute | null {
  return active.get(serviceId)?.route ?? null;
}

/** Whether a canary is in progress for the service. */
export function canaryActive(serviceId: number): boolean {
  return active.has(serviceId);
}

const SERVICE_NAME_RE = /^svc_(.+)_\d+_(stable|canary)(?:@[A-Za-z0-9_-]+)?$/;

/**
 * One access-log line, from the traffic tailer. `serviceName` is Traefik's
 * `ServiceName`: under a weighted service it is the leaf that answered
 * (`svc_<slug>_<domainId>_canary@file`), checked against Traefik 3. Lines of
 * services with no canary in progress, and lines from before the step began
 * (the tailer reads a few seconds behind), are ignored.
 */
export function recordCanaryHit(serviceName: string | null, status: number, durationMs: number, startMs: number): void {
  if (!serviceName || active.size === 0) return;
  const m = SERVICE_NAME_RE.exec(serviceName);
  if (!m) return;
  const serviceId = serviceBySlug.get(m[1]!);
  const c = serviceId === undefined ? undefined : active.get(serviceId);
  if (!c?.route || startMs < c.stepStartedAt) return;
  const s = m[2] === 'canary' ? c.canary : c.stable;
  s.requests++;
  if (status >= 500) s.errors++;
  if (s.durations.length < CANARY_SAMPLE_CAP) s.durations.push(durationMs);
}

function p95(durations: readonly number[]): number | null {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]!);
}

function view(s: Sample): CanaryReleaseStats {
  return { requests: s.requests, errors: s.errors, errorRate: errorRatePercent(s.errors, s.requests), p95Ms: p95(s.durations) };
}

/** The current step's numbers for both releases; null with no canary in progress. */
export function canaryStats(serviceId: number): { canary: CanaryReleaseStats; stable: CanaryReleaseStats } | null {
  const c = active.get(serviceId);
  return c ? { canary: view(c.canary), stable: view(c.stable) } : null;
}

/** Ask the running canary of `deploymentId` to finish now. False when there is none. */
export function requestCanaryPromote(serviceId: number, deploymentId: number): boolean {
  const c = active.get(serviceId);
  if (!c || c.deploymentId !== deploymentId) return false;
  c.promote = true;
  return true;
}

export function canaryPromoteRequested(serviceId: number): boolean {
  return active.get(serviceId)?.promote === true;
}

/** The canary status view of a service. */
export function canaryStatus(serviceId: number): CanaryStatusView {
  const c = active.get(serviceId);
  if (!c) return { active: false };
  return {
    active: true,
    deploymentId: c.deploymentId,
    step: c.step,
    steps: c.steps,
    weight: c.route?.weight ?? 0,
    ...(c.route ? { stepStartedAt: new Date(c.stepStartedAt).toISOString(), stepEndsAt: new Date(c.stepEndsAt).toISOString() } : {}),
    measured: c.measured,
    canary: view(c.canary),
    stable: view(c.stable),
    promoting: c.promote,
  };
}

/** Tests only: forget every canary. */
export function resetCanaryState(): void {
  active.clear();
  serviceBySlug.clear();
}
