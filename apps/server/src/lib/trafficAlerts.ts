import { and, eq, gte, inArray } from 'drizzle-orm';
import { alertRules, trafficRollups, type DB } from '@ninedeploy/db';
import { errorRatePercent } from '@ninedeploy/schemas';
import type { MetricSnapshot } from './alerting.js';
import { mergeHist, percentileFromHist, emptyHist, trafficAnalyticsEnabled } from './trafficAnalytics.js';

/**
 * Error-rate and latency alerts (ROADMAP 0.16.8 item 7): `error_rate` is the
 * share of 5xx answers in percent, `latency_p95` the 95th percentile response
 * time in ms, both per service over the last {@link TRAFFIC_ALERT_WINDOW_S}
 * seconds of traffic analytics minute rollups.
 *
 * A service with fewer than {@link TRAFFIC_ALERT_MIN_REQUESTS} requests in the
 * window gets no sample, so its rule keeps its state: a quiet service is
 * neither healthy nor failing on two requests. With traffic analytics off
 * there are no rollups, and no samples.
 */
export const TRAFFIC_ALERT_WINDOW_S = 5 * 60;
export const TRAFFIC_ALERT_MIN_REQUESTS = 20;
export const TRAFFIC_ALERT_METRICS = ['error_rate', 'latency_p95'] as const;

export async function trafficAlertSnapshots(db: DB, nowMs: number = Date.now()): Promise<MetricSnapshot[]> {
  const rules = await db
    .select({ serviceId: alertRules.serviceId })
    .from(alertRules)
    .where(and(eq(alertRules.enabled, true), inArray(alertRules.metric, [...TRAFFIC_ALERT_METRICS] as never[])));
  const serviceIds = [...new Set(rules.map((r) => r.serviceId).filter((id): id is number => id != null))];
  if (serviceIds.length === 0 || !(await trafficAnalyticsEnabled(db))) return [];
  const since = Math.floor(nowMs / 1000) - TRAFFIC_ALERT_WINDOW_S;
  const rows = await db
    .select({
      serviceId: trafficRollups.serviceId,
      requests: trafficRollups.requests,
      status5xx: trafficRollups.status5xx,
      durationMaxMs: trafficRollups.durationMaxMs,
      latencyHist: trafficRollups.latencyHist,
    })
    .from(trafficRollups)
    .where(and(eq(trafficRollups.granularity, 60), gte(trafficRollups.bucketStart, since), inArray(trafficRollups.serviceId, serviceIds)));
  const sums = new Map<number, { requests: number; errors: number; maxMs: number; hist: number[] }>();
  for (const r of rows) {
    if (r.serviceId == null) continue;
    const s = sums.get(r.serviceId) ?? { requests: 0, errors: 0, maxMs: 0, hist: emptyHist() };
    s.requests += r.requests;
    s.errors += r.status5xx;
    s.maxMs = Math.max(s.maxMs, r.durationMaxMs);
    mergeHist(s.hist, r.latencyHist);
    sums.set(r.serviceId, s);
  }
  const out: MetricSnapshot[] = [];
  for (const [serviceId, s] of sums) {
    if (s.requests < TRAFFIC_ALERT_MIN_REQUESTS) continue;
    out.push({ serviceId, kind: 'error_rate', value: errorRatePercent(s.errors, s.requests) ?? 0, detail: `${s.errors} of ${s.requests} requests answered 5xx in the last 5 minutes` });
    const p95 = percentileFromHist(s.hist, 0.95, s.maxMs);
    if (p95 != null) out.push({ serviceId, kind: 'latency_p95', value: Math.round(p95), detail: `p95 over ${s.requests} requests in the last 5 minutes` });
  }
  return out;
}
