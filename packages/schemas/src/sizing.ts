import { z } from 'zod';

// ── G5.6 scheduled replica floors and right-sizing hints ──────────────────

/** At most this many floor windows per service. */
export const AUTOSCALE_SCHEDULES_MAX = 20;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour');

/** True for an IANA time zone the runtime knows (`Europe/Istanbul`, `UTC`). */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * A raised minimum in a weekly time window: on `days` (0 = Sunday) from
 * `from` to `to`, local to the service's autoscale `timezone`. A window whose
 * end is before its start runs past midnight.
 */
export const autoscaleSchedule = z
  .object({
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    from: hhmm,
    to: hhmm,
    minReplicas: z.number().int().min(1).max(10),
  })
  .strict()
  .refine((w) => w.from !== w.to, { message: 'A window needs different start and end times', path: ['to'] });
export type AutoscaleSchedule = z.infer<typeof autoscaleSchedule>;

export const sizingHint = z.object({
  resource: z.enum(['memory', 'cpu']),
  /** `set`: no limit yet; `raise`: close to it; `lower`: far below it. */
  action: z.enum(['set', 'raise', 'lower']),
  /** The current limit (MiB, or cores); null without one. */
  current: z.number().nullable(),
  /** The suggested limit (MiB, or cores). */
  suggested: z.number(),
  reason: z.string(),
});
export type SizingHint = z.infer<typeof sizingHint>;

const usage = z.object({ p95: z.number(), peak: z.number() }).nullable();

/** `GET /v1/services/:id/sizing`: the figures behind the hints. */
export const sizingReport = z.object({
  serviceId: z.number().int(),
  /** How much history the figures cover, in hours (up to a week). */
  spanHours: z.number(),
  samples: z.number().int(),
  /** Memory in MiB per container. */
  memory: usage,
  /** CPU in cores per container. */
  cpu: usage,
  limits: z.object({ memoryMiB: z.number().nullable(), cpuCores: z.number().nullable() }),
  /** False under 12 hours of history: the figures are shown, no hints. */
  enoughHistory: z.boolean(),
  hints: z.array(sizingHint),
});
export type SizingReport = z.infer<typeof sizingReport>;
