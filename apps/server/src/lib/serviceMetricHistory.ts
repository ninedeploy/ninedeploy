import { and, asc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import { metricRollups, metrics, type DB } from '@ninedeploy/db';
import { readObservabilitySettings } from './observabilitySettings.js';

export interface MetricInput { serviceId: number; kind: string; value: number; ts: Date }
const DAY = 86_400_000;
// Bound SQL parameters while retaining one all-or-nothing collection cycle.
const INSERT_BATCH_ROWS = 500;
const floorTime = (ms: number, seconds: number) => new Date(Math.floor(ms / (seconds * 1000)) * seconds * 1000);

/** Capture raw and weighted summaries in one transaction. Existing installs keep their one-day policy. */
export async function persistServiceMetrics(db: DB, input: MetricInput[]): Promise<void> {
  const rows = input.filter((r) => Number.isFinite(r.value) && r.value >= 0 && Number.isFinite(r.ts.getTime()));
  if (!rows.length) return;
  let days: number;
  try { days = (await readObservabilitySettings(db)).retentionDays; }
  catch {
    // An unavailable key must not stop raw sampling or erase existing archives.
    days = 1;
  }
  if (days === 1 && rows.length <= INSERT_BATCH_ROWS) { await db.insert(metrics).values(rows); return; }
  const tiers = days === 1 ? [] : days > 7 ? [300, 3600] : [300];
  const rollups = rows.flatMap((r) => tiers.map((bucketSeconds) => ({
    serviceId: r.serviceId, kind: r.kind, bucketSeconds,
    ts: floorTime(r.ts.getTime(), bucketSeconds), sum: r.value, samples: 1, min: r.value, max: r.value,
  })));
  await db.transaction(async (tx) => {
    for (let at = 0; at < rows.length; at += INSERT_BATCH_ROWS) {
      await tx.insert(metrics).values(rows.slice(at, at + INSERT_BATCH_ROWS));
    }
    // Merge samples within a tier's bucket, preserving the weighting for larger chart windows.
    // Multiple samples for the same bucket in an input batch are valid SQLite upserts.
    for (let at = 0; at < rollups.length; at += INSERT_BATCH_ROWS) {
      await tx.insert(metricRollups).values(rollups.slice(at, at + INSERT_BATCH_ROWS)).onConflictDoUpdate({
        target: [metricRollups.serviceId, metricRollups.kind, metricRollups.bucketSeconds, metricRollups.ts],
        set: {
          sum: sql`${metricRollups.sum} + excluded."sum"`,
          samples: sql`${metricRollups.samples} + excluded."samples"`,
          min: sql`min(${metricRollups.min}, excluded."min")`,
          max: sql`max(${metricRollups.max}, excluded."max")`,
        },
      });
    }
  });
}

export async function pruneServiceMetrics(db: DB, now = new Date()): Promise<void> {
  const { retentionDays } = await readObservabilitySettings(db);
  // Align the raw/tier boundaries so a summary and a raw sample never overlap.
  await db.delete(metrics).where(lt(metrics.ts, floorTime(now.getTime() - DAY, 300)));
  await db.delete(metricRollups).where(and(eq(metricRollups.bucketSeconds, 300),
    lt(metricRollups.ts, floorTime(now.getTime() - Math.min(retentionDays, 7) * DAY, 3600))));
  await db.delete(metricRollups).where(and(eq(metricRollups.bucketSeconds, 3600),
    lt(metricRollups.ts, floorTime(now.getTime() - retentionDays * DAY, 3600))));
}

/** SQL aggregation covers the entire requested interval; LIMIT never discards the newest raw samples. */
export async function readMetricPoints(db: DB, serviceId: number, kind: 'cpu' | 'memory', minutes: number, now = new Date()): Promise<Array<{ ts: string; value: number }>> {
  const { retentionDays } = await readObservabilitySettings(db);
  const since = new Date(now.getTime() - Math.min(minutes, retentionDays * 1440) * 60_000);
  const rawStart = floorTime(now.getTime() - DAY, 300);
  const fineStart = floorTime(now.getTime() - 7 * DAY, 3600);
  const base = minutes > 7 * 1440 ? 3600 : minutes > 1440 ? 300 : 30;
  const step = Math.max(base, Math.ceil(minutes * 60 / 900 / base) * base);
  const groups = new Map<number, { total: number; samples: number }>();
  const merge = (rows: Array<{ bucket: number; total: number; samples: number }>) => {
    for (const r of rows) {
      if (!Number.isFinite(r.total) || r.samples <= 0) continue;
      const prior = groups.get(r.bucket) ?? { total: 0, samples: 0 };
      groups.set(r.bucket, { total: prior.total + r.total, samples: prior.samples + r.samples });
    }
  };
  const rawBucket = sql<number>`cast(${metrics.ts} / ${step} as integer) * ${step}`;
  merge(await db.select({ bucket: rawBucket, total: sql<number>`sum(${metrics.value})`, samples: sql<number>`count(*)` })
    .from(metrics).where(and(eq(metrics.serviceId, serviceId), eq(metrics.kind, kind), gte(metrics.ts, since), gte(metrics.ts, rawStart), lte(metrics.ts, now)))
    .groupBy(rawBucket).orderBy(asc(rawBucket)).limit(1000));
  const rollupBucket = sql<number>`cast(${metricRollups.ts} / ${step} as integer) * ${step}`;
  for (const tier of [{ seconds: 300, start: fineStart, end: rawStart }, { seconds: 3600, start: since, end: fineStart }]) {
    if (since >= tier.end || retentionDays === 1) continue;
    merge(await db.select({ bucket: rollupBucket, total: sql<number>`sum(${metricRollups.sum})`, samples: sql<number>`sum(${metricRollups.samples})` })
      .from(metricRollups).where(and(eq(metricRollups.serviceId, serviceId), eq(metricRollups.kind, kind),
        eq(metricRollups.bucketSeconds, tier.seconds), gte(metricRollups.ts, since), gte(metricRollups.ts, tier.start), lt(metricRollups.ts, tier.end)))
      .groupBy(rollupBucket).orderBy(asc(rollupBucket)).limit(1000));
  }
  return [...groups].sort(([a], [b]) => a - b).map(([ts, r]) => ({
    ts: new Date(ts * 1000).toISOString(),
    value: kind === 'memory' ? Math.round(r.total / r.samples / 1024 ** 2) : r.total / r.samples / 100,
  }));
}
