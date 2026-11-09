/**
 * 0.16.10: requests per service, counted in memory from the traffic tailer
 * (lib/trafficAnalytics.ts), for the autoscaler's `rps` metric and the
 * idle check of scale to zero (0.16.11). Ten-second buckets, kept 24 hours behind the latest recorded request
 * (the longest idle window); only buckets that saw a request are stored. Nothing is persisted: after a restart the rate
 * starts from zero, which only delays a scale-down (the autoscaler waits a
 * full window before it acts on a rate).
 *
 * No imports: the traffic module imports this.
 */

export const REQUEST_RATE_BUCKET_MS = 10_000;
const KEEP_MS = 24 * 60 * 60 * 1000;
const KEEP_BUCKETS = Math.round(KEEP_MS / REQUEST_RATE_BUCKET_MS);

const buckets = new Map<number, Map<number, number>>();
const latestBuckets = new Map<number, number>();

/** One request to `serviceId` that started at `startMs`. */
export function recordServiceRequest(serviceId: number | null, startMs: number): void {
  if (serviceId == null) return;
  const b = Math.floor(startMs / REQUEST_RATE_BUCKET_MS);
  const previous = latestBuckets.get(serviceId);
  const latest = Math.max(previous ?? b, b);
  const oldest = latest - KEEP_BUCKETS;
  if (b < oldest) return;
  let m = buckets.get(serviceId);
  if (!m) {
    m = new Map();
    buckets.set(serviceId, m);
  }
  if (previous !== undefined && latest > previous) {
    const priorOldest = previous - KEEP_BUCKETS;
    if (oldest - priorOldest > m.size) {
      for (const bucket of m.keys()) if (bucket < oldest) m.delete(bucket);
    } else {
      for (let bucket = priorOldest; bucket < oldest; bucket++) m.delete(bucket);
    }
  }
  latestBuckets.set(serviceId, latest);
  m.set(b, (m.get(b) ?? 0) + 1);
}

/**
 * Requests per second to `serviceId` over the `windowMs` that ended `lagMs`
 * before `now`. The tailer reads the access log every 10 s, so the most
 * recent seconds are not counted yet; the lag leaves them out instead of
 * reading them as a drop.
 */
export function serviceRequestRate(serviceId: number, windowMs: number, now: number, lagMs = REQUEST_RATE_BUCKET_MS): number {
  const m = buckets.get(serviceId);
  if (!m) return 0;
  const end = Math.floor((now - lagMs) / REQUEST_RATE_BUCKET_MS);
  const start = end - Math.max(1, Math.round(windowMs / REQUEST_RATE_BUCKET_MS));
  let total = 0;
  for (const [b, n] of m) {
    if (b < end - Math.round(KEEP_MS / REQUEST_RATE_BUCKET_MS)) m.delete(b);
    else if (b >= start && b < end) total += n;
  }
  if (m.size === 0) {
    buckets.delete(serviceId);
    latestBuckets.delete(serviceId);
  }
  return total / ((end - start) * (REQUEST_RATE_BUCKET_MS / 1000));
}

/** Latest retained request to `serviceId` (to its bucket's end), or null when its history is empty. */
export function lastServiceRequestAt(serviceId: number): number | null {
  const m = buckets.get(serviceId);
  if (!m || m.size === 0) return null;
  let latest = Number.NEGATIVE_INFINITY;
  for (const bucket of m.keys()) latest = Math.max(latest, bucket);
  return (latest + 1) * REQUEST_RATE_BUCKET_MS;
}

/** Tests only. */
export function resetRequestRates(): void {
  buckets.clear();
  latestBuckets.clear();
}
