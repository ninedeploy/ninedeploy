import { and, eq, gte } from 'drizzle-orm';
import { metricRollups, metrics, type DB, type Service } from '@ninedeploy/db';
import type { SizingHint, SizingReport } from '@ninedeploy/schemas';

/**
 * G5.6 right-sizing hints: memory and CPU limit suggestions from a service's
 * metric history (its primary container, sampled by the collector: `cpu` in
 * hundredths of a percent of one core, `memory` in bytes). Raw samples cover
 * the last day; with a longer metric retention the 5-minute summaries add up
 * to a week. Advisory only: nothing is changed.
 */

const DAY = 86_400_000;
const MIB = 1024 * 1024;
/** Less history than this gives no hints, only the figures. */
export const SIZING_MIN_HOURS = 12;

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[at]!;
}

const roundUp = (v: number, step: number) => Math.max(step, Math.ceil(v / step) * step);

interface Series {
  /** One value per raw sample or per 5-minute summary (its average). */
  values: number[];
  peak: number;
}

/**
 * The hints for a service's history and limits. `memory` in MiB, `cpu` in
 * cores; limits as stored (`memLimitMb`, `cpuLimitMilli`; 0 = none).
 */
export function sizingFrom(
  history: { memory: Series; cpu: Series; spanHours: number },
  limits: { memLimitMb: number; cpuLimitMilli: number },
): Pick<SizingReport, 'memory' | 'cpu' | 'hints' | 'enoughHistory'> {
  const enoughHistory = history.spanHours >= SIZING_MIN_HOURS && history.memory.values.length > 0;
  const memory = history.memory.values.length ? { p95: percentile(history.memory.values, 95), peak: history.memory.peak } : null;
  const cpu = history.cpu.values.length ? { p95: percentile(history.cpu.values, 95), peak: history.cpu.peak } : null;
  const hints: SizingHint[] = [];
  if (enoughHistory && memory) {
    // Room above the peak, as a container killed for memory loses its requests.
    const suggested = roundUp(Math.max(memory.peak * 1.25, memory.p95 * 1.5), 64);
    const limit = limits.memLimitMb;
    if (limit === 0) {
      hints.push({ resource: 'memory', action: 'set', current: null, suggested, reason: `no memory limit; it peaked at ${Math.round(memory.peak)} MiB` });
    } else if (memory.peak > limit * 0.9) {
      hints.push({ resource: 'memory', action: 'raise', current: limit, suggested: Math.max(suggested, roundUp(limit * 1.25, 64)), reason: `it peaked at ${Math.round(memory.peak)} MiB, ${Math.round((memory.peak / limit) * 100)} % of its limit` });
    } else if (limit >= 256 && memory.peak < limit * 0.4 && suggested < limit) {
      hints.push({ resource: 'memory', action: 'lower', current: limit, suggested, reason: `it peaked at ${Math.round(memory.peak)} MiB, ${Math.round((memory.peak / limit) * 100)} % of its limit` });
    }
  }
  if (enoughHistory && cpu) {
    const suggestedCores = roundUp(Math.max(cpu.p95 * 1.5, cpu.peak), 0.25);
    const limit = limits.cpuLimitMilli / 1000;
    if (limit > 0 && cpu.p95 > limit * 0.8) {
      hints.push({ resource: 'cpu', action: 'raise', current: limit, suggested: Math.max(suggestedCores, roundUp(limit * 1.5, 0.25)), reason: `it used ${cpu.p95.toFixed(2)} cores at the 95th percentile, ${Math.round((cpu.p95 / limit) * 100)} % of its limit` });
    } else if (limit >= 0.5 && cpu.peak < limit * 0.25 && suggestedCores < limit) {
      hints.push({ resource: 'cpu', action: 'lower', current: limit, suggested: suggestedCores, reason: `it peaked at ${cpu.peak.toFixed(2)} cores, ${Math.round((cpu.peak / limit) * 100)} % of its limit` });
    }
  }
  return { memory, cpu, hints, enoughHistory };
}

/** Read the service's history (up to a week) and compute its hints. */
export async function sizingHints(db: DB, svc: Pick<Service, 'id' | 'memLimitMb' | 'cpuLimitMilli'>, now = Date.now()): Promise<SizingReport> {
  const since = new Date(now - 7 * DAY);
  const rawSince = new Date(now - DAY);
  const series = { memory: { values: [] as number[], peak: 0 }, cpu: { values: [] as number[], peak: 0 } };
  let oldest = now;
  const scale = (kind: string, v: number) => (kind === 'memory' ? v / MIB : v / 10_000);
  const raw = await db
    .select({ kind: metrics.kind, value: metrics.value, ts: metrics.ts })
    .from(metrics)
    .where(and(eq(metrics.serviceId, svc.id), gte(metrics.ts, rawSince)));
  for (const r of raw) {
    const s = r.kind === 'memory' ? series.memory : r.kind === 'cpu' ? series.cpu : null;
    if (!s) continue;
    const v = scale(r.kind, r.value);
    s.values.push(v);
    s.peak = Math.max(s.peak, v);
    oldest = Math.min(oldest, r.ts.getTime());
  }
  // Older than the raw day: the 5-minute summaries, when the retention keeps them.
  const rollups = await db
    .select({ kind: metricRollups.kind, sum: metricRollups.sum, samples: metricRollups.samples, max: metricRollups.max, ts: metricRollups.ts })
    .from(metricRollups)
    .where(and(eq(metricRollups.serviceId, svc.id), eq(metricRollups.bucketSeconds, 300), gte(metricRollups.ts, since)));
  for (const r of rollups) {
    if (r.ts >= rawSince || r.samples <= 0) continue;
    const s = r.kind === 'memory' ? series.memory : r.kind === 'cpu' ? series.cpu : null;
    if (!s) continue;
    s.values.push(scale(r.kind, r.sum / r.samples));
    s.peak = Math.max(s.peak, scale(r.kind, r.max));
    oldest = Math.min(oldest, r.ts.getTime());
  }
  const spanHours = Math.round(((now - oldest) / 3_600_000) * 10) / 10;
  const result = sizingFrom({ ...series, spanHours }, { memLimitMb: svc.memLimitMb, cpuLimitMilli: svc.cpuLimitMilli });
  return {
    serviceId: svc.id,
    spanHours,
    samples: series.memory.values.length,
    limits: { memoryMiB: svc.memLimitMb || null, cpuCores: svc.cpuLimitMilli ? svc.cpuLimitMilli / 1000 : null },
    ...result,
  };
}
