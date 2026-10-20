import { z } from 'zod';

/**
 * 0.16.9 canary releases.
 *
 * A docker service with a canary configuration does not switch all of its
 * traffic to a new release at once. After the new container passes its
 * healthcheck, Traefik sends it `steps[0]` percent of the requests, then each
 * following step, for `stepSeconds` each, and the deploy finishes at 100 %.
 * Each step is judged on the new release's healthcheck and, when traffic
 * analytics is on, on its share of 5xx responses and its p95 latency. A step
 * that fails sends every request back to the previous release and fails the
 * deploy, which leaves the previous release serving, as any failed deploy does.
 */

export const CANARY_STEPS_MAX = 5;
export const CANARY_STEP_SECONDS_MIN = 30;
export const CANARY_STEP_SECONDS_MAX = 3600;
export const CANARY_DEFAULT_STEPS = [10, 50] as const;
export const CANARY_DEFAULT_STEP_SECONDS = 120;
export const CANARY_DEFAULT_MAX_ERROR_RATE = 5;
export const CANARY_DEFAULT_MIN_REQUESTS = 20;

export const canaryConfig = z
  .object({
    /** Percent of the requests the new release gets at each step, ascending, 1–99. */
    steps: z
      .array(z.number().int().min(1).max(99))
      .min(1)
      .max(CANARY_STEPS_MAX)
      .refine((s) => s.every((v, i) => i === 0 || v > s[i - 1]!), 'Canary steps must go up, for example 10, 50'),
    /** How long each step runs before it is judged. */
    stepSeconds: z.number().int().min(CANARY_STEP_SECONDS_MIN).max(CANARY_STEP_SECONDS_MAX).default(CANARY_DEFAULT_STEP_SECONDS),
    /** The highest share of 5xx responses, in percent, the new release may answer with. */
    maxErrorRate: z.number().min(0).max(100).default(CANARY_DEFAULT_MAX_ERROR_RATE),
    /** The highest p95 response time, in ms, the new release may have; null = not judged. */
    maxP95Ms: z.number().int().min(10).max(600_000).nullable().default(null),
    /** Fewer requests than this in a step are too few to judge the error rate and latency. */
    minRequests: z.number().int().min(1).max(1_000_000).default(CANARY_DEFAULT_MIN_REQUESTS),
  })
  .strict();
export type CanaryConfig = z.infer<typeof canaryConfig>;
export type CanaryConfigInput = z.input<typeof canaryConfig>;

/** What one step measured on one release. */
export interface CanaryReleaseStats {
  requests: number;
  /** Responses with a 5xx status. */
  errors: number;
  /** Percent of the requests that were errors; null with no requests. */
  errorRate: number | null;
  /** p95 response time in ms; null with no requests. */
  p95Ms: number | null;
}

/** `GET /v1/services/:id/canary`: the canary of a deploy in progress, or `active: false`. */
export interface CanaryStatusView {
  active: boolean;
  deploymentId?: number;
  /** 1-based step running now, and how many there are. */
  step?: number;
  steps?: number;
  /** Percent of the requests the new release gets now. */
  weight?: number;
  stepStartedAt?: string;
  stepEndsAt?: string;
  /** False when traffic analytics is off: steps are judged on the healthcheck only. */
  measured?: boolean;
  canary?: CanaryReleaseStats;
  stable?: CanaryReleaseStats;
  /** A promote was asked for and is being applied. */
  promoting?: boolean;
}

/** Percent of `errors` in `requests`, rounded to two decimals; null with no requests. */
export function errorRatePercent(errors: number, requests: number): number | null {
  if (requests <= 0) return null;
  return Math.round((errors / requests) * 10_000) / 100;
}

/**
 * Why a step's numbers fail the configuration, or null when they pass. Too
 * few requests pass: there is not enough traffic to judge, and the step is
 * left to the healthcheck.
 */
export function canaryStepProblem(stats: CanaryReleaseStats, cfg: Pick<CanaryConfig, 'maxErrorRate' | 'maxP95Ms' | 'minRequests'>): string | null {
  if (stats.requests < cfg.minRequests) return null;
  if (stats.errorRate != null && stats.errorRate > cfg.maxErrorRate) {
    return `${stats.errorRate}% of ${stats.requests} requests failed with a 5xx (the limit is ${cfg.maxErrorRate}%)`;
  }
  if (cfg.maxP95Ms != null && stats.p95Ms != null && stats.p95Ms > cfg.maxP95Ms) {
    return `p95 response time ${stats.p95Ms} ms over ${stats.requests} requests (the limit is ${cfg.maxP95Ms} ms)`;
  }
  return null;
}
