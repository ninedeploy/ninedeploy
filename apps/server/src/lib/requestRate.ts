/**
 * 0.16.10: requests per service, counted in memory from the traffic tailer
 * (lib/trafficAnalytics.ts), for the autoscaler's `rps` metric. Ten-second
 * buckets, kept one hour. Nothing is persisted: after a restart the rate
 * starts from zero, which only delays a scale-down (the autoscaler waits a
 * full window before it acts on a rate).
 *
 * No imports: the traffic module imports this.
 */

export const REQUEST_RATE_BUCKET_MS = 10_000;
const KEEP_MS = 60 * 60 * 1000;

const buckets = new Map<number, Map<number, number>>();

/** One request to `serviceId` that started at `startMs`. */
export function recordServiceRequest(serviceId: number | null, startMs: number): void {
  if (serviceId == null) return;
  let m = buckets.get(serviceId);
  if (!m) {
    m = new Map();
    buckets.set(serviceId, m);
  }
  const b = Math.floor(startMs / REQUEST_RATE_BUCKET_MS);
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
  return total / ((end - start) * (REQUEST_RATE_BUCKET_MS / 1000));
}

/** Tests only. */
export function resetRequestRates(): void {
  buckets.clear();
}
