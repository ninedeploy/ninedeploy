import { z } from 'zod';

// ── Traffic analytics (0.15) ────────────────────────────────────────────────
// Request and response shapes for `/v1/traffic` and
// `/v1/services/:id/traffic`. Analytics is opt-in everywhere (owner decision
// O3): with it off, Traefik's static config is byte-identical to 0.14. Only
// aggregate counters are kept — no client IP, path, query string or header.
// Design: DESIGN.md §2.

export const TRAFFIC_RETENTION_DAYS_MIN = 1;
export const TRAFFIC_RETENTION_DAYS_MAX = 400;
export const TRAFFIC_RETENTION_DAYS_DEFAULT = 30;
export const TRAFFIC_TOP_MAX = 50;

/** Bucket widths in seconds: minute rows and hour rows. */
export const TRAFFIC_GRANULARITIES = [60, 3600] as const;
export const trafficGranularity = z.union([z.literal(60), z.literal(3600)]);
export type TrafficGranularity = z.infer<typeof trafficGranularity>;

/** Upper edges (ms) of the latency histogram; one overflow bucket follows. */
export const TRAFFIC_LATENCY_EDGES_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;
/** Buckets in `latencyHist`: one per edge plus the overflow. */
export const TRAFFIC_LATENCY_BUCKETS = TRAFFIC_LATENCY_EDGES_MS.length + 1;

export const trafficRange = z.enum(['1h', '24h', '7d', '30d']);
export type TrafficRange = z.infer<typeof trafficRange>;

/** Minute buckets for 1h/24h, hour buckets for 7d/30d. */
export function trafficRangeGranularity(range: TrafficRange): TrafficGranularity {
  return range === '1h' || range === '24h' ? 60 : 3600;
}

export const trafficStatus = z.enum(['off', 'starting', 'running', 'error']);
export type TrafficStatus = z.infer<typeof trafficStatus>;

/** PUT /v1/traffic/settings (operator). Enabling or disabling recreates Traefik once. */
export const trafficSettingsUpdate = z
  .object({
    enabled: z.boolean().optional(),
    retentionDays: z.number().int().min(TRAFFIC_RETENTION_DAYS_MIN).max(TRAFFIC_RETENTION_DAYS_MAX).optional(),
  })
  .strict();
export type TrafficSettingsUpdate = z.infer<typeof trafficSettingsUpdate>;

/** GET /v1/traffic/settings, and the PUT answer. */
export const trafficSettingsView = z.object({
  enabled: z.boolean(),
  retentionDays: z.number().int(),
  status: trafficStatus,
  lastError: z.string().nullable(),
  lastIngestAt: z.string().nullable(),
  logBytes: z.number().int().nonnegative(),
  malformedLines: z.number().int().nonnegative(),
  /** `docker info` LoggingDriver; null when Docker did not answer. */
  dockerLogDriver: z.string().nullable(),
});
export type TrafficSettingsView = z.infer<typeof trafficSettingsView>;

/** GET /v1/traffic/summary and /v1/services/:id/traffic query. */
export const trafficSummaryQuery = z
  .object({
    range: trafficRange.default('24h'),
    top: z.coerce.number().int().min(1).max(TRAFFIC_TOP_MAX).default(10),
  })
  .strict();
export type TrafficSummaryQuery = z.infer<typeof trafficSummaryQuery>;

/** Counters shared by a bucket, a domain row and the totals. */
export const trafficCounters = z.object({
  requests: z.number().int().nonnegative(),
  status1xx: z.number().int().nonnegative(),
  status2xx: z.number().int().nonnegative(),
  status3xx: z.number().int().nonnegative(),
  status4xx: z.number().int().nonnegative(),
  status5xx: z.number().int().nonnegative(),
  statusOther: z.number().int().nonnegative(),
  bytesOut: z.number().int().nonnegative(),
  durationSumMs: z.number().int().nonnegative(),
  durationMaxMs: z.number().int().nonnegative(),
});
export type TrafficCounters = z.infer<typeof trafficCounters>;

/** Percentiles estimated from the histogram; null when there were no requests. */
export const trafficPercentiles = z.object({
  p50Ms: z.number().nonnegative().nullable(),
  p95Ms: z.number().nonnegative().nullable(),
  p99Ms: z.number().nonnegative().nullable(),
});
export type TrafficPercentiles = z.infer<typeof trafficPercentiles>;

export const trafficBucket = trafficCounters.extend({
  /** Bucket start, ISO 8601. */
  t: z.string(),
});
export type TrafficBucket = z.infer<typeof trafficBucket>;

/** One domain (or the panel / custom / other bucket) over the range. */
export const trafficScopeTotal = trafficCounters.extend(trafficPercentiles.shape).extend({
  /** `d:<domainId>` | `panel` | `custom` | `other`. */
  scopeKey: z.string(),
  domainId: z.number().int().positive().nullable(),
  serviceId: z.number().int().positive().nullable(),
  /** The host as recorded, kept after the domain is deleted. */
  host: z.string().nullable(),
});
export type TrafficScopeTotal = z.infer<typeof trafficScopeTotal>;

/** GET /v1/traffic/summary (operator): the whole instance. */
export const trafficSummary = z.object({
  enabled: z.boolean(),
  range: trafficRange,
  granularity: trafficGranularity,
  totals: trafficCounters.extend(trafficPercentiles.shape),
  series: z.array(trafficBucket),
  topDomains: z.array(trafficScopeTotal),
  panel: trafficScopeTotal.nullable(),
  custom: trafficScopeTotal.nullable(),
});
export type TrafficSummary = z.infer<typeof trafficSummary>;

/** GET /v1/services/:id/traffic (any seat on the service). Empty series, never 404, without data. */
export const serviceTrafficSummary = z.object({
  enabled: z.boolean(),
  range: trafficRange,
  granularity: trafficGranularity,
  totals: trafficCounters.extend(trafficPercentiles.shape),
  series: z.array(trafficBucket),
  domains: z.array(trafficScopeTotal),
});
export type ServiceTrafficSummary = z.infer<typeof serviceTrafficSummary>;
