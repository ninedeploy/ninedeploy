/** G5.6 right-sizing hints (`lib/sizingHints.ts`) against a migrated in-memory SQLite. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { metricRollups, metrics, services, users, type DB } from '@ninedeploy/db';
import { percentile, sizingFrom, sizingHints } from '../../src/lib/sizingHints.js';
import { closeMigratedDb, migratedDb } from './githubAppKit.js';

const series = (values: number[]) => ({ values, peak: Math.max(0, ...values) });
const flat = (v: number, n = 200) => Array.from({ length: n }, () => v);

describe('percentile', () => {
  it('is the nearest-rank percentile', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([], 95)).toBe(0);
  });
});

describe('sizingFrom', () => {
  const limits = (memLimitMb = 0, cpuLimitMilli = 0) => ({ memLimitMb, cpuLimitMilli });

  it('gives no hints with too little history, but still the figures', () => {
    const r = sizingFrom({ memory: series(flat(100)), cpu: series(flat(0.1)), spanHours: 3 }, limits());
    expect(r).toMatchObject({ enoughHistory: false, hints: [], memory: { p95: 100, peak: 100 } });
  });

  it('suggests a memory limit when there is none, with room above the peak', () => {
    const r = sizingFrom({ memory: series([...flat(200), 300]), cpu: series(flat(0.1)), spanHours: 24 }, limits());
    expect(r.hints).toEqual([{ resource: 'memory', action: 'set', current: null, suggested: 384, reason: 'no memory limit; it peaked at 300 MiB' }]);
  });

  it('raises a limit the service nearly hits, and lowers one it barely uses', () => {
    const near = sizingFrom({ memory: series([...flat(400), 480]), cpu: series(flat(0.9)), spanHours: 24 }, limits(512, 1000));
    expect(near.hints.map((h) => [h.resource, h.action, h.suggested])).toEqual([
      ['memory', 'raise', 640],
      ['cpu', 'raise', 1.5],
    ]);
    const idle = sizingFrom({ memory: series(flat(100)), cpu: series(flat(0.1)), spanHours: 48 }, limits(2048, 2000));
    expect(idle.hints.map((h) => [h.resource, h.action, h.suggested])).toEqual([
      ['memory', 'lower', 192],
      ['cpu', 'lower', 0.25],
    ]);
  });

  it('leaves a well-sized service alone', () => {
    const r = sizingFrom({ memory: series(flat(300)), cpu: series(flat(0.5)), spanHours: 24 }, limits(512, 1000));
    expect(r.hints).toEqual([]);
  });
});

describe('sizingHints', () => {
  let db: DB;
  beforeEach(async () => {
    db = await migratedDb();
    await db.insert(users).values({ id: 1, email: 'a@example.com', passwordHash: 'x' });
    await db.insert(services).values({ id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 1, memLimitMb: 512 } as never);
  });
  afterEach(() => closeMigratedDb(db));

  it('reads raw samples and older 5-minute summaries, in MiB and cores', async () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    const raw = Array.from({ length: 50 }, (_, i) => new Date(now - i * 60_000));
    await db.insert(metrics).values(
      raw.flatMap((ts) => [
        { serviceId: 5, kind: 'memory', value: 480 * 1024 * 1024, ts },
        { serviceId: 5, kind: 'cpu', value: 2500, ts }, // 25 % of a core
      ]),
    );
    // Three days ago: a summary averaging 200 MiB that peaked at 500 MiB.
    const old = new Date(now - 3 * 86_400_000);
    await db.insert(metricRollups).values({ serviceId: 5, kind: 'memory', bucketSeconds: 300, ts: old, sum: 2 * 200 * 1024 * 1024, samples: 2, min: 0, max: 500 * 1024 * 1024 });
    const r = await sizingHints(db, { id: 5, memLimitMb: 512, cpuLimitMilli: 0 }, now);
    expect(r).toMatchObject({ serviceId: 5, spanHours: 72, samples: 51, enoughHistory: true, limits: { memoryMiB: 512, cpuCores: null } });
    expect(r.memory).toEqual({ p95: 480, peak: 500 });
    expect(r.cpu).toEqual({ p95: 0.25, peak: 0.25 });
    expect(r.hints).toEqual([expect.objectContaining({ resource: 'memory', action: 'raise', current: 512 })]);
  });
});
