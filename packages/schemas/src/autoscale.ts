import { z } from 'zod';

/**
 * 0.16.10 autoscaling.
 *
 * A docker service on the panel host runs between `minReplicas` and
 * `maxReplicas` containers. Every deploy creates all `maxReplicas` of them
 * and starts as many as were running before (within the bounds); the
 * autoscaler then starts and stops the extra ones, without a redeploy, to
 * keep the chosen metric near `target`:
 *   - `cpu`: average CPU per container, in percent of its CPU limit (of one core without a limit);
 *   - `memory`: average memory per container, in percent of its memory limit;
 *   - `rps`: requests per second per container (needs traffic analytics).
 * Scaling up waits until the need has lasted `scaleUpSeconds`; scaling down
 * waits `scaleDownSeconds` and never goes below the highest need seen in
 * that window, so a short dip does not drop capacity.
 */

/** The same bound as `replicas`. */
export const AUTOSCALE_MAX_REPLICAS = 10;
export const AUTOSCALE_METRICS = ['cpu', 'memory', 'rps'] as const;
export const autoscaleMetric = z.enum(AUTOSCALE_METRICS);
export type AutoscaleMetric = z.infer<typeof autoscaleMetric>;
/** Within this fraction of the target, nothing changes (as Kubernetes' HPA). */
export const AUTOSCALE_TOLERANCE = 0.1;

export const autoscaleConfig = z
  .object({
    minReplicas: z.number().int().min(1).max(AUTOSCALE_MAX_REPLICAS).default(1),
    maxReplicas: z.number().int().min(2).max(AUTOSCALE_MAX_REPLICAS),
    metric: autoscaleMetric.default('cpu'),
    /** cpu and memory: percent (1–100); rps: requests per second per container. */
    target: z.number().positive().max(100_000),
    scaleUpSeconds: z.number().int().min(30).max(3600).default(60),
    scaleDownSeconds: z.number().int().min(60).max(3600).default(300),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.maxReplicas <= c.minReplicas) {
      ctx.addIssue({ code: 'custom', path: ['maxReplicas'], message: 'maxReplicas must be above minReplicas' });
    }
    if (c.metric !== 'rps' && c.target > 100) {
      ctx.addIssue({ code: 'custom', path: ['target'], message: `A ${c.metric} target is a percentage, at most 100` });
    }
  });
export type AutoscaleConfig = z.infer<typeof autoscaleConfig>;
export type AutoscaleConfigInput = z.input<typeof autoscaleConfig>;

/** One scaling decision, as recorded and shown. */
export interface AutoscaleEvent {
  at: string;
  from: number;
  to: number;
  reason: string;
}

/** `GET /v1/services/:id/autoscale`. */
export interface AutoscaleStatusView {
  enabled: boolean;
  /** Containers serving now (`runtimeReplicas`). */
  replicas: number;
  minReplicas?: number;
  maxReplicas?: number;
  metric?: AutoscaleMetric;
  target?: number;
  /** The metric's last value (per container); null when it could not be read. */
  value?: number | null;
  /** How many containers the last value asks for. */
  desired?: number | null;
  /** Why the autoscaler is holding, when it is (a deploy in progress, no traffic analytics, …). */
  holding?: string | null;
  lastEvent?: AutoscaleEvent | null;
}

/**
 * How many containers keep `value` (per container, with `current` running)
 * near `target`, within the bounds. Inside the tolerance it is `current`.
 */
export function desiredReplicas(current: number, value: number, cfg: Pick<AutoscaleConfig, 'target' | 'minReplicas' | 'maxReplicas'>): number {
  const n = Math.max(1, current);
  const ratio = value / cfg.target;
  const want = Math.abs(ratio - 1) <= AUTOSCALE_TOLERANCE ? n : Math.ceil(n * ratio);
  return Math.min(cfg.maxReplicas, Math.max(cfg.minReplicas, want));
}
