/**
 * ROADMAP 0.16.8 item 7: error-rate and p95-latency alert samples from the
 * traffic analytics minute rollups, against a real migrated SQLite — the
 * window, the minimum traffic, the analytics switch, and a rule firing through
 * the real evaluator.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alertRules, alertState, createDb, type DB, services, trafficRollups } from '@ninedeploy/db';
import { TRAFFIC_LATENCY_BUCKETS } from '@ninedeploy/schemas';

const auditMock = vi.hoisted(() => ({ audit: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock('../../src/lib/audit.js', () => auditMock);

const { trafficAlertSnapshots, TRAFFIC_ALERT_WINDOW_S } = await import('../../src/lib/trafficAlerts.js');
const { setTrafficAnalyticsEnabled } = await import('../../src/lib/trafficAnalytics.js');
const { evaluateAlerts } = await import('../../src/lib/alerting.js');

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-traffic-alerts-'));
afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows file lock on a closed libsql database */
  }
});

let db: DB;
let close: () => void;
let n = 0;

beforeEach(async () => {
  const created = createDb({ url: `file:${path.join(tmp, `db-${++n}.sqlite`)}` });
  await created.ready;
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  auditMock.audit.mockClear();
});
afterEach(() => close());

const NOW_MS = Date.parse('2026-10-29T12:00:00Z');
const NOW_S = NOW_MS / 1000;

/** A histogram with every request in bucket `i` (index 7 is 500–1000 ms). */
const histAt = (i: number, count: number) => {
  const h = new Array<number>(TRAFFIC_LATENCY_BUCKETS).fill(0);
  h[i] = count;
  return h;
};

async function service(name: string): Promise<number> {
  const [svc] = await db.insert(services).values({ name, slug: name, type: 'docker' } as never).returning();
  return svc!.id;
}

async function rule(serviceId: number | null, metric: string, over: Record<string, unknown> = {}): Promise<number> {
  const [r] = await db
    .insert(alertRules)
    .values({ serviceId, name: `${metric}-${serviceId}`, metric, operator: '>', threshold: 5, durationWindows: 1, ...over } as never)
    .returning();
  await db.insert(alertState).values({ ruleId: r!.id } as never);
  return r!.id;
}

let scope = 0;
async function rollup(serviceId: number, bucketStart: number, requests: number, status5xx: number, hist: number[], over: Record<string, unknown> = {}) {
  await db.insert(trafficRollups).values({
    granularity: 60,
    bucketStart,
    scopeKey: `d:${++scope}`,
    serviceId,
    requests,
    status5xx,
    durationMaxMs: 900,
    latencyHist: hist,
    ...over,
  } as never);
}

describe('trafficAlertSnapshots', () => {
  it('samples nothing without an enabled per-service rule, or with traffic analytics off', async () => {
    const web = await service('web');
    await rollup(web, NOW_S - 60, 100, 50, histAt(7, 100));
    await setTrafficAnalyticsEnabled(db, true);
    expect(await trafficAlertSnapshots(db, NOW_MS)).toEqual([]);

    await rule(null, 'error_rate'); // host-wide: never valid, never sampled
    await rule(web, 'error_rate', { enabled: false });
    expect(await trafficAlertSnapshots(db, NOW_MS)).toEqual([]);

    await rule(web, 'latency_p95');
    await setTrafficAnalyticsEnabled(db, false);
    expect(await trafficAlertSnapshots(db, NOW_MS)).toEqual([]);
  });

  it('sums the minute rows of the last 5 minutes per service and skips quiet services', async () => {
    const web = await service('web');
    const quiet = await service('quiet');
    await rule(web, 'error_rate');
    await rule(quiet, 'latency_p95');
    await setTrafficAnalyticsEnabled(db, true);

    // Two domains of `web` in the window: 100 requests, 10 answered 5xx.
    await rollup(web, NOW_S - 120, 60, 6, histAt(7, 60));
    await rollup(web, NOW_S - TRAFFIC_ALERT_WINDOW_S, 40, 4, histAt(7, 40));
    // Outside the window, and an hour row inside it: neither counts.
    await rollup(web, NOW_S - TRAFFIC_ALERT_WINDOW_S - 60, 1000, 1000, histAt(10, 1000));
    await rollup(web, NOW_S - 60, 1000, 1000, histAt(10, 1000), { granularity: 3600 });
    // Fewer than 20 requests: no sample, so its rule keeps its state.
    await rollup(quiet, NOW_S - 60, 19, 19, histAt(10, 19));

    const snaps = await trafficAlertSnapshots(db, NOW_MS);
    expect(snaps.map((s) => [s.serviceId, s.kind])).toEqual([
      [web, 'error_rate'],
      [web, 'latency_p95'],
    ]);
    expect(snaps[0]).toMatchObject({ value: 10, detail: '10 of 100 requests answered 5xx in the last 5 minutes' });
    expect(snaps[1]!.value).toBeGreaterThan(500);
    expect(snaps[1]!.value).toBeLessThanOrEqual(1000);
    expect(snaps[1]!.detail).toBe('p95 over 100 requests in the last 5 minutes');
  });

  it('fires an error-rate rule through the real evaluator', async () => {
    const web = await service('web');
    const id = await rule(web, 'error_rate', { threshold: 5 });
    await setTrafficAnalyticsEnabled(db, true);
    await rollup(web, NOW_S - 60, 50, 25, histAt(3, 50));

    await evaluateAlerts(db, await trafficAlertSnapshots(db, NOW_MS), new Date(NOW_MS));
    const [state] = await db.select().from(alertState).where(eq(alertState.ruleId, id));
    expect(state).toMatchObject({ status: 'firing', lastValue: 50 });
    expect(auditMock.audit).toHaveBeenCalledWith(
      db,
      null,
      'alert.fired',
      expect.stringContaining('25 of 50 requests answered 5xx'),
      { ruleId: id, serviceId: web },
    );
  });
});
