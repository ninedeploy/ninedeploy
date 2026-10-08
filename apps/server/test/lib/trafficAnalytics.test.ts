/**
 * 0.15 traffic analytics (DESIGN §2.3, §2.7): parser, attribution, histogram
 * and percentiles, the minute/hour aggregator, the rollup writer (cursor
 * committed with the rows), the tailer's partial lines, rotation (rename +
 * USR1, drain, delete), the USR1 fallback, the boot hard-cap skip, inode
 * changes, the disable drain-and-purge, retention and the summary queries —
 * against a real migrated SQLite and a real temp directory.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, domains, services, settings, trafficRollups } from '@ninedeploy/db';
import { serviceTrafficSummary, TRAFFIC_LATENCY_BUCKETS } from '@ninedeploy/schemas';

const auditMock = vi.hoisted(() => ({ audit: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock('../../src/lib/audit.js', () => auditMock);
const execMock = vi.hoisted(() => ({
  run: vi.fn(async (..._a: unknown[]) => undefined),
  capture: vi.fn(async () => ''),
  sleep: vi.fn(async () => undefined),
}));
vi.mock('../../src/lib/exec.js', () => execMock);

const T = await import('../../src/lib/trafficAnalytics.js');

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-traffic-'));
afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows file lock on a closed libsql database */
  }
});

let db: DB;
let close: () => void;
let dir: string;
let n = 0;

beforeEach(async () => {
  // A file database: libsql's in-memory client cannot run a transaction.
  const created = createDb({ url: `file:${path.join(tmp, `db-${++n}.sqlite`)}` });
  await created.ready;
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  dir = path.join(tmp, `case-${n}`);
  mkdirSync(dir, { recursive: true });
  auditMock.audit.mockClear();
  execMock.run.mockReset();
  execMock.run.mockResolvedValue(undefined);
});
afterEach(() => close());

const T0 = Date.parse('2026-10-08T12:00:00Z');
/** One Traefik v3 JSON access-log line with the fields the static config keeps. */
const line = (o: Partial<Record<string, unknown>> = {}) =>
  `${JSON.stringify({
    DownstreamContentSize: 100,
    DownstreamStatus: 200,
    Duration: 12_000_000,
    OriginDuration: 11_000_000,
    RequestHost: 'app.example.com',
    RequestMethod: 'GET',
    RouterName: 'web_1@file',
    ServiceName: 'svc_web_1@file',
    StartUTC: '2026-10-08T12:00:05.123456789Z',
    level: 'info',
    msg: '',
    time: '2026-10-08T12:00:05Z',
    ...o,
  })}\n`;

async function seedDomains(): Promise<{ serviceId: number }> {
  const [svc] = await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker' } as never).returning();
  await db.insert(domains).values({ id: 1, serviceId: svc!.id, hostname: 'app.example.com' } as never);
  await db.insert(domains).values({ id: 2, serviceId: svc!.id, hostname: 'www.example.com' } as never);
  return { serviceId: svc!.id };
}

const tailer = (o: Partial<ConstructorParameters<typeof T.TrafficTailer>[0]> = {}) =>
  new T.TrafficTailer({ db, dir, now: () => T0 + 60_000, reopen: vi.fn(async () => undefined), ...o });
const live = () => path.join(dir, 'access.log');
const rotated = () => path.join(dir, 'access.log.1');
const rows = () => db.select().from(trafficRollups);
const minuteRow = async (scopeKey: string) =>
  (await rows()).find((r) => r.granularity === 60 && r.scopeKey === scopeKey);

describe('parseAccessLogLine', () => {
  it('reads a Traefik v3 JSON line: @provider suffix stripped, Duration in nanoseconds', () => {
    const hit = T.parseAccessLogLine(line().trim());
    expect(hit).toEqual({
      startMs: Date.parse('2026-10-08T12:00:05.123Z'),
      router: 'web_1',
      host: 'app.example.com',
      status: 200,
      bytesOut: 100,
      durationMs: 12,
    });
  });

  it('falls back to `time`, then to now, for the start; missing fields default', () => {
    expect(T.parseAccessLogLine(JSON.stringify({ time: '2026-10-08T12:00:00Z' }), 5)).toEqual({
      startMs: Date.parse('2026-10-08T12:00:00Z'),
      router: null,
      host: null,
      status: 0,
      bytesOut: 0,
      durationMs: 0,
    });
    expect(T.parseAccessLogLine('{}', 1234)!.startMs).toBe(1234);
    expect(T.parseAccessLogLine(JSON.stringify({ StartUTC: 'garbage', DownstreamStatus: -1, Duration: 'x' }), 7)).toMatchObject({
      startMs: 7,
      status: 0,
      durationMs: 0,
    });
  });

  it('rejects malformed JSON and non-objects', () => {
    for (const bad of ['{"Router', 'null', '[1,2]', '42', '"str"', '']) expect(T.parseAccessLogLine(bad)).toBeNull();
  });
});

describe('attributeRouter / scopeFor', () => {
  it('classifies panel, custom, domain (incl. _http twins) and other routers', () => {
    expect(T.attributeRouter('ninedeploy_panel')).toEqual({ kind: 'panel' });
    expect(T.attributeRouter('ninedeploy_panel_http')).toEqual({ kind: 'panel' });
    expect(T.attributeRouter('web_12')).toEqual({ kind: 'domain', domainId: 12, slug: 'web' });
    expect(T.attributeRouter('my_app_7_http')).toEqual({ kind: 'domain', domainId: 7, slug: 'my_app' });
    expect(T.attributeRouter('custom-dashboard')).toEqual({ kind: 'custom' });
    expect(T.attributeRouter('custom_api')).toEqual({ kind: 'custom' });
    expect(T.attributeRouter('custom-app_5')).toEqual({ kind: 'domain', domainId: 5, slug: 'custom-app' });
    expect(T.attributeRouter('api@internal')).toEqual({ kind: 'other' });
    expect(T.attributeRouter('web_0')).toEqual({ kind: 'other' });
    expect(T.attributeRouter(null)).toEqual({ kind: 'other' });
  });

  it('confirms a domain router against the database; a stale or look-alike name falls back', () => {
    const index: T.DomainIndex = new Map([[5, { serviceId: 9, slug: 'web' }]]);
    const hit = (router: string | null) => ({ startMs: 0, router, host: 'h.example.com', status: 200, bytesOut: 0, durationMs: 1 });
    expect(T.scopeFor(hit('web_5'), index)).toEqual({ scopeKey: 'd:5', domainId: 5, serviceId: 9, host: 'h.example.com' });
    expect(T.scopeFor(hit('web_5_http'), index)).toMatchObject({ scopeKey: 'd:5' });
    // A custom router that looks like a domain router (no such domain/slug).
    expect(T.scopeFor(hit('custom-app_5'), index)).toEqual({ scopeKey: 'custom', domainId: null, serviceId: null, host: null });
    // A deleted domain.
    expect(T.scopeFor(hit('web_6'), index)).toEqual({ scopeKey: 'other', domainId: null, serviceId: null, host: null });
    expect(T.scopeFor(hit('ninedeploy_panel'), index)).toEqual({ scopeKey: 'panel', domainId: null, serviceId: null, host: 'h.example.com' });
    expect(T.scopeFor(hit(null), index)).toMatchObject({ scopeKey: 'other', host: null });
  });
});

describe('histogram and percentiles', () => {
  it('buckets on the upper edges 5…10000 ms, with an overflow bucket', () => {
    expect(TRAFFIC_LATENCY_BUCKETS).toBe(12);
    expect([0, 5, 5.01, 10, 24, 25, 99, 100, 1000, 10000, 10000.5, 1e9].map(T.latencyBucket)).toEqual([
      0, 0, 1, 1, 2, 2, 4, 4, 7, 10, 11, 11,
    ]);
  });

  it('estimates percentiles by interpolating inside the rank bucket', () => {
    const hist = T.emptyHist();
    hist[0] = 50; // ≤5 ms
    hist[4] = 50; // 50–100 ms
    expect(T.percentileFromHist(hist, 0.5, 90)).toBe(5);
    expect(T.percentileFromHist(hist, 0.95, 90)).toBe(90); // 95 ms estimate, capped at the max seen
    expect(T.percentileFromHist(hist, 0.95, 0)).toBe(95);
    expect(T.percentileFromHist(T.emptyHist(), 0.5)).toBeNull();
    const over = T.emptyHist();
    over[11] = 1;
    expect(T.percentileFromHist(over, 0.99, 30_000)).toBe(29800);
    expect(T.percentiles(hist, 90)).toEqual({ p50Ms: 5, p95Ms: 90, p99Ms: 90 });
  });

  it('merges element-wise; a stored histogram of the wrong shape counts as empty', () => {
    expect(T.mergeHist([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2])).toEqual([
      2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3,
    ]);
    expect(T.mergeHist(T.emptyHist(), [1, 2])).toEqual(T.emptyHist());
    expect(T.mergeHist(T.emptyHist(), null)).toEqual(T.emptyHist());
  });
});

describe('TrafficAggregator', () => {
  it('writes minute AND hour keys per scope, counting status classes, bytes and durations', () => {
    const agg = new T.TrafficAggregator();
    const scope = { scopeKey: 'd:1', domainId: 1, serviceId: 3, host: 'app.example.com' };
    const at = Date.parse('2026-10-08T12:34:56Z');
    for (const [status, ms] of [[200, 3], [304, 40], [404, 7], [503, 2000], [101, 1], [0, 1]] as const) {
      agg.add({ startMs: at, router: 'web_1', host: 'app.example.com', status, bytesOut: 10, durationMs: ms }, scope);
    }
    const [minute, hour] = agg.entries();
    expect(agg.size).toBe(2);
    expect(minute).toMatchObject({
      granularity: 60,
      bucketStart: Date.parse('2026-10-08T12:34:00Z') / 1000,
      requests: 6,
      status1xx: 1,
      status2xx: 1,
      status3xx: 1,
      status4xx: 1,
      status5xx: 1,
      statusOther: 1,
      bytesOut: 60,
      durationSumMs: 2052,
      durationMaxMs: 2000,
    });
    expect(minute!.latencyHist).toEqual([3, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0]);
    expect(hour).toMatchObject({ granularity: 3600, bucketStart: Date.parse('2026-10-08T12:00:00Z') / 1000, requests: 6 });
  });
});

describe('commitRollups', () => {
  it('accumulates over two commits (upsert) and stores the cursor', async () => {
    const delta = (requests: number, max: number): T.RollupDelta => ({
      granularity: 60,
      bucketStart: 1000,
      scopeKey: 'panel',
      domainId: null,
      serviceId: null,
      host: null,
      requests,
      status1xx: 0,
      status2xx: requests,
      status3xx: 0,
      status4xx: 0,
      status5xx: 0,
      statusOther: 0,
      bytesOut: 5,
      durationSumMs: 10,
      durationMaxMs: max,
      latencyHist: [requests, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    });
    await T.commitRollups(db, [delta(2, 30)], { dev: '1', ino: '2', offset: 10 });
    await T.commitRollups(db, [{ ...delta(3, 20), host: 'panel.example.com' }], { dev: '1', ino: '2', offset: 20 });
    const [row] = await rows();
    expect(row).toMatchObject({ requests: 5, status2xx: 5, bytesOut: 10, durationSumMs: 20, durationMaxMs: 30, host: 'panel.example.com' });
    expect(row!.latencyHist).toEqual([5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(await T.loadTrafficCursor(db)).toEqual({ dev: '1', ino: '2', offset: 20 });
  });

  it('ignores a cursor of the wrong shape', async () => {
    await db.insert(settings).values({ key: T.TRAFFIC_LOG_CURSOR_KEY, value: { dev: 1 } as never });
    expect(await T.loadTrafficCursor(db)).toBeNull();
  });
});

describe('TrafficTailer', () => {
  it('ingests complete lines, attributes them, and leaves a partial last line for the next tick', async () => {
    const { serviceId } = await seedDomains();
    writeFileSync(
      live(),
      line() +
        line({ RouterName: 'web_2_http@file', RequestHost: 'www.example.com', DownstreamStatus: 301 }) +
        line({ RouterName: 'ninedeploy_panel@file', RequestHost: 'panel.example.com' }) +
        line({ RouterName: 'custom-grafana@file' }) +
        line({ RouterName: undefined, DownstreamStatus: 404 }) +
        'not json\n' +
        line().slice(0, 40),
    );
    const t = tailer();
    const r1 = await t.tick();
    expect(r1).toMatchObject({ lines: 5, malformed: 1, rotated: false });
    expect(await minuteRow('d:1')).toMatchObject({ requests: 1, serviceId, domainId: 1, host: 'app.example.com', status2xx: 1 });
    expect(await minuteRow('d:2')).toMatchObject({ requests: 1, serviceId, status3xx: 1, host: 'www.example.com' });
    expect(await minuteRow('panel')).toMatchObject({ requests: 1, host: 'panel.example.com' });
    expect(await minuteRow('custom')).toMatchObject({ requests: 1, host: null, serviceId: null });
    expect(await minuteRow('other')).toMatchObject({ requests: 1, status4xx: 1 });
    expect(t.state.malformedLines).toBe(1);
    expect(t.state.lastIngestAt).toBe(new Date(T0 + 60_000).toISOString());

    // Nothing new: nothing written. The partial line completes: counted once.
    expect((await t.tick()).bytes).toBe(0);
    appendFileSync(live(), line().slice(40));
    expect(await t.tick()).toMatchObject({ lines: 1, malformed: 0 });
    expect(await minuteRow('d:1')).toMatchObject({ requests: 2 });
  });

  it('a crash before the commit re-reads nothing twice: rows and cursor roll back together', async () => {
    await seedDomains();
    writeFileSync(live(), line() + line());
    const failing = new Proxy(db, {
      get(target, key, recv) {
        if (key === 'transaction') {
          return (fn: (tx: unknown) => Promise<unknown>) =>
            target.transaction(async (tx) => {
              await fn(tx);
              throw new Error('disk I/O error');
            });
        }
        return Reflect.get(target, key, recv);
      },
    }) as DB;
    await expect(new T.TrafficTailer({ db: failing, dir, reopen: vi.fn() }).tick()).rejects.toThrow('disk I/O error');
    expect(await rows()).toEqual([]);
    expect(await T.loadTrafficCursor(db)).toBeNull();
    await tailer().tick();
    expect(await minuteRow('d:1')).toMatchObject({ requests: 2 });
    await tailer().tick();
    expect(await minuteRow('d:1')).toMatchObject({ requests: 2 });
  });

  it('caps a tick at the byte cap and continues where it stopped', async () => {
    writeFileSync(live(), line() + line() + line());
    const one = Buffer.byteLength(line());
    const t = tailer();
    expect(await t.tick({ cap: one + 5 })).toMatchObject({ lines: 1 });
    expect(await t.tick({ cap: one + 5 })).toMatchObject({ lines: 1 });
    expect(await t.tick({ cap: one + 5 })).toMatchObject({ lines: 1 });
    expect(await t.tick({ cap: one + 5 })).toMatchObject({ lines: 0, bytes: 0 });
  });

  it('skips a single line longer than the whole cap instead of stalling', async () => {
    writeFileSync(live(), `${'x'.repeat(100)}\n${line()}`);
    const t = tailer();
    expect(await t.tick({ cap: 50 })).toMatchObject({ bytes: 50, malformed: 1 });
  });

  it('a new inode (Traefik recreated the file) or a truncation resets the cursor', async () => {
    writeFileSync(live(), line() + line());
    const t = tailer();
    await t.tick();
    rmSync(live());
    writeFileSync(live(), line());
    expect(await t.tick()).toMatchObject({ lines: 1 });
    expect((await T.loadTrafficCursor(db))!.offset).toBe(Buffer.byteLength(line()));
    // Truncated in place (same inode, smaller than the cursor).
    writeFileSync(live(), '');
    appendFileSync(live(), '');
    expect((await t.tick()).lines).toBe(0);
    expect((await T.loadTrafficCursor(db))!.offset).toBe(0);
  });

  it('rotates past the threshold: rename, USR1, drain the .1 file on the next tick, then delete it', async () => {
    const big = line().repeat(Math.ceil(T.TRAFFIC_ROTATE_BYTES / Buffer.byteLength(line())) + 1);
    writeFileSync(live(), big);
    const reopen = vi.fn(async () => undefined);
    const t = tailer({ reopen });
    const r1 = await t.tick({ cap: Number.MAX_SAFE_INTEGER });
    expect(r1.rotated).toBe(true);
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(existsSync(rotated())).toBe(true);
    expect(existsSync(live())).toBe(false);
    const counted = (await minuteRow('other'))!.requests;

    // Traefik appended to the renamed file before it reopened, then created a new one.
    appendFileSync(rotated(), line() + line());
    writeFileSync(live(), line());
    const r2 = await t.tick();
    expect(r2.lines).toBe(3); // 2 drained from .1 + 1 from the new file
    expect(existsSync(rotated())).toBe(false);
    expect((await minuteRow('other'))!.requests).toBe(counted + 3);
  });

  it('waits for Traefik to reopen before deleting the drained .1 file (re-signals, then gives up)', async () => {
    writeFileSync(live(), line());
    const reopen = vi.fn(async () => undefined);
    const t = tailer({ reopen });
    await t.tick();
    renameSync(live(), rotated()); // a crash between the rename and the signal
    appendFileSync(rotated(), line());
    expect((await t.tick()).lines).toBe(1);
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(existsSync(rotated())).toBe(true);
    await t.tick();
    await t.tick();
    await t.tick();
    expect(existsSync(rotated())).toBe(false);
  });

  it('USR1 failure: undo the rename, truncate after reading (bare metal), keep counting', async () => {
    const big = line().repeat(Math.ceil(T.TRAFFIC_ROTATE_BYTES / Buffer.byteLength(line())) + 1);
    writeFileSync(live(), big);
    const reopen = vi.fn(async () => {
      throw new Error('Cannot connect to the Docker daemon');
    });
    const t = tailer({ reopen });
    const r = await t.tick({ cap: Number.MAX_SAFE_INTEGER });
    expect(r.rotated).toBe(true);
    expect(existsSync(rotated())).toBe(false);
    expect(existsSync(live())).toBe(true);
    expect((await T.loadTrafficCursor(db))!.offset).toBe(0);
    appendFileSync(live(), line());
    expect((await t.tick()).lines).toBe(1);
  });

  it('boot hard cap: a huge backlog is skipped to its tail, audited, and rotated', async () => {
    writeFileSync(live(), line());
    const huge = T.TRAFFIC_HARD_CAP_BYTES + 10;
    const { truncateSync } = await import('node:fs');
    truncateSync(live(), huge); // sparse: no real disk use
    const reopen = vi.fn(async () => undefined);
    const t = tailer({ reopen });
    const r = await t.tick();
    expect(r.skippedBytes).toBe(huge);
    expect(r.lines).toBe(0);
    expect(r.rotated).toBe(true);
    expect(auditMock.audit).toHaveBeenCalledWith(db, null, 'traffic.log_skipped', 'access.log', { skippedBytes: huge });
    // The next tick drains only what came after the skip, then deletes the .1.
    appendFileSync(rotated(), line());
    writeFileSync(live(), '');
    expect((await t.tick()).lines).toBe(1);
    expect(existsSync(rotated())).toBe(false);
  });

  it('drainAndPurge (disable): reads what is left, deletes both files, forgets the cursor', async () => {
    writeFileSync(live(), line());
    writeFileSync(rotated(), line());
    const t = tailer();
    await t.tick(); // cursor on the live file; the .1 is a leftover
    appendFileSync(live(), line() + line());
    await tailer().drainAndPurge();
    expect(existsSync(live())).toBe(false);
    expect(existsSync(rotated())).toBe(false);
    expect(await T.loadTrafficCursor(db)).toBeNull();
    expect((await minuteRow('other'))!.requests).toBe(3);
  });

  it('the default reopen signal is docker kill --signal USR1 ninedeploy-traefik', async () => {
    await T.signalTraefikReopen();
    expect(execMock.run).toHaveBeenCalledWith('docker', ['kill', '--signal', 'USR1', 'ninedeploy-traefik'], {}, expect.any(Function));
  });
});

describe('process-wide tailer', () => {
  it('starts once, ticks at once, reports running; stop is clean; state is off afterwards', async () => {
    writeFileSync(live(), line());
    const t = T.startTrafficTailer({ db, dir, reopen: vi.fn(async () => undefined) });
    expect(T.startTrafficTailer({ db, dir })).toBe(t);
    expect(T.trafficTailerActive()).toBe(true);
    await vi.waitFor(() => expect(t.state.status).toBe('running'));
    expect(T.trafficTailerState(dir)).toMatchObject({ status: 'running', logBytes: Buffer.byteLength(line()) });
    await T.stopTrafficTailer();
    expect(T.trafficTailerActive()).toBe(false);
    expect(T.trafficTailerState(dir)).toMatchObject({ status: 'off', lastError: null, lastIngestAt: t.state.lastIngestAt });
  });

  it('records a failing tick as error and keeps the process alive', async () => {
    const broken = new Proxy(db, {
      get(target, key, recv) {
        if (key === 'query') throw new Error('no such table: settings');
        return Reflect.get(target, key, recv);
      },
    }) as DB;
    const log = vi.fn();
    const t = T.startTrafficTailer({ db: broken, dir, log });
    await vi.waitFor(() => expect(t.state.status).toBe('error'));
    expect(t.state.lastError).toContain('no such table');
    expect(log).toHaveBeenCalledWith('traffic analytics tick failed', expect.any(Error));
    await T.stopTrafficTailer();
  });

  it('stop with purge drains and deletes the files', async () => {
    writeFileSync(live(), line());
    await T.stopTrafficTailer({ purge: { db, dir } });
    expect(existsSync(live())).toBe(false);
    expect((await minuteRow('other'))!.requests).toBe(1);
  });
});

describe('settings helpers', () => {
  it('analytics is off without a row; retention defaults to 30 and ignores invalid values', async () => {
    expect(await T.trafficAnalyticsEnabled(db)).toBe(false);
    await T.setTrafficAnalyticsEnabled(db, true);
    expect(await T.trafficAnalyticsEnabled(db)).toBe(true);
    expect(await T.getTrafficRetentionDays(db)).toBe(30);
    await T.setTrafficRetentionDays(db, 90);
    expect(await T.getTrafficRetentionDays(db)).toBe(90);
    await db.update(settings).set({ value: 'x' as never }).where((await import('drizzle-orm')).eq(settings.key, 'traffic_retention_days'));
    expect(await T.getTrafficRetentionDays(db)).toBe(30);
    await T.setTrafficRetentionDays(db, 999);
    expect(await T.getTrafficRetentionDays(db)).toBe(30);
  });
});

describe('pruneTrafficRollups (housekeeping step traffic-rollups)', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const sec = Math.floor(now / 1000);
  const row = (granularity: 60 | 3600, bucketStart: number, scopeKey: string) => ({ granularity, bucketStart, scopeKey, requests: 1 });

  it('deletes minute rows after 48h and hour rows after the configured days', async () => {
    await db.insert(trafficRollups).values([
      row(60, sec - 47 * 3600, 'keep-minute'),
      row(60, sec - 49 * 3600, 'old-minute'),
      row(3600, sec - 29 * 86_400, 'keep-hour'),
      row(3600, sec - 31 * 86_400, 'old-hour'),
    ]);
    expect(await T.pruneTrafficRollups(db, now)).toBe(2);
    expect((await rows()).map((r) => r.scopeKey).sort()).toEqual(['keep-hour', 'keep-minute']);
    await T.setTrafficRetentionDays(db, 7);
    expect(await T.pruneTrafficRollups(db, now)).toBe(1);
    expect((await rows()).map((r) => r.scopeKey)).toEqual(['keep-minute']);
  });

  it('deletes in batches of 5000 until done', async () => {
    const old = Array.from({ length: T.TRAFFIC_PRUNE_BATCH + 7 }, (_, i) => row(60, sec - 50 * 3600 - i * 60, `s${i}`));
    for (let i = 0; i < old.length; i += 500) await db.insert(trafficRollups).values(old.slice(i, i + 500));
    expect(await T.pruneTrafficRollups(db, now)).toBe(T.TRAFFIC_PRUNE_BATCH + 7);
    expect(await rows()).toEqual([]);
  });
});

describe('trafficReport', () => {
  it('sums series and scopes, merges histograms for percentiles; filters by service', async () => {
    const { serviceId } = await seedDomains();
    const now = Date.parse('2026-10-08T12:30:00Z');
    const agg = new T.TrafficAggregator();
    const hit = (ms: number, status: number, at = now - 5 * 60_000) => ({ startMs: at, router: 'x', host: 'h', status, bytesOut: 1, durationMs: ms });
    const d1 = { scopeKey: 'd:1', domainId: 1, serviceId, host: 'app.example.com' };
    const panel = { scopeKey: 'panel', domainId: null, serviceId: null, host: 'panel.example.com' };
    for (let i = 0; i < 9; i++) agg.add(hit(3, 200), d1);
    agg.add(hit(400, 500), d1);
    agg.add(hit(3, 200, now - 2 * 3600_000), d1); // outside 1h
    agg.add(hit(20, 302), panel);
    await T.commitRollups(db, agg.entries(), null);

    const all = await T.trafficReport(db, { range: '1h', now });
    expect(all.granularity).toBe(60);
    expect(all.totals).toMatchObject({ requests: 11, status2xx: 9, status3xx: 1, status5xx: 1, durationMaxMs: 400 });
    expect(all.totals.p50Ms).toBeLessThanOrEqual(5);
    expect(all.series).toEqual([expect.objectContaining({ t: '2026-10-08T12:25:00.000Z', requests: 11 })]);
    expect(all.scopes.map((s) => s.scopeKey)).toEqual(['d:1', 'panel']);
    expect(all.scopes[0]).toMatchObject({ domainId: 1, serviceId, host: 'app.example.com', requests: 10 });

    const day = await T.trafficReport(db, { range: '24h', now, serviceId });
    expect(day.totals.requests).toBe(11);
    expect(day.scopes.map((s) => s.scopeKey)).toEqual(['d:1']);
    expect(day.series).toHaveLength(2);
    const week = await T.trafficReport(db, { range: '7d', now, serviceId });
    expect(week.granularity).toBe(3600);
    expect(week.series.map((s) => s.t)).toEqual(['2026-10-08T10:00:00.000Z', '2026-10-08T12:00:00.000Z']);

    const none = await T.trafficReport(db, { range: '30d', now, serviceId: 999 });
    expect(none).toMatchObject({ series: [], scopes: [], totals: { requests: 0, p50Ms: null, p95Ms: null, p99Ms: null } });
    // The service shape the route returns parses against the contract.
    expect(() =>
      serviceTrafficSummary.parse({ enabled: true, range: '24h', granularity: day.granularity, totals: day.totals, series: day.series, domains: day.scopes }),
    ).not.toThrow();
  });

  it('rangeStart covers the current bucket plus the range', () => {
    const now = Date.parse('2026-10-08T12:30:30Z');
    expect(T.rangeStart('1h', now)).toEqual({ granularity: 60, since: Date.parse('2026-10-08T11:31:00Z') / 1000 });
    expect(T.rangeStart('30d', now)).toEqual({ granularity: 3600, since: Date.parse('2026-09-08T13:00:00Z') / 1000 });
  });
});
