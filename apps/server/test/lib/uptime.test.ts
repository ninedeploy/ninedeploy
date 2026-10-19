import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, runMigrations, services, uptimeChecks, uptimeDaily, uptimeMonitors, users } from '@ninedeploy/db';

/**
 * 0.16.8 uptime monitors: the probe against real local HTTP and TCP servers,
 * the up/down state machine, the records one check writes (on a real
 * migrated SQLite), the alert events, the uptime figures and retention.
 */

const audits = vi.hoisted(() => ({ calls: [] as Array<{ action: string; entity: string; meta: unknown }> }));
vi.mock('../../src/lib/audit.js', () => ({
  audit: vi.fn(async (_db: unknown, _actor: unknown, action: string, entity: string, meta: unknown) => {
    audits.calls.push({ action, entity, meta });
  }),
}));

const u = await import('../../src/lib/uptime.js');
const { createUptimeScheduler, UPTIME_CONCURRENCY } = await import('../../src/plugins/uptime.js');

let server: http.Server;
let base = '';
let tcpServer: net.Server;
let tcpPort = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/ok') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('all good: healthy');
    } else if (url === '/fail') {
      res.writeHead(503);
      res.end('down');
    } else if (url === '/redirect') {
      res.writeHead(302, { location: '/ok' });
      res.end();
    } else if (url === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
    } else if (url === '/ftp') {
      res.writeHead(301, { location: 'ftp://example.com/' });
      res.end();
    } else if (url === '/slow') {
      setTimeout(() => res.end('late'), 3000).unref();
    } else if (url === '/big') {
      res.writeHead(200);
      res.write(Buffer.alloc(u.KEYWORD_BODY_LIMIT + 10, 'a'));
      res.end('needle');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tcpServer = net.createServer((s) => s.end());
  await new Promise<void>((r) => tcpServer.listen(0, '127.0.0.1', r));
  tcpPort = (tcpServer.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await new Promise((r) => tcpServer.close(r));
});

const http0 = (over: Partial<Parameters<typeof u.probeMonitor>[0]> = {}) => ({
  kind: 'http' as const,
  target: `${base}/ok`,
  method: 'GET',
  expectedStatus: '200-399',
  keyword: null,
  timeoutSeconds: 5,
  followRedirects: true,
  verifyTls: true,
  ...over,
});

describe('probeMonitor', () => {
  it('http: a matching status is up, with a response time', async () => {
    const r = await u.probeMonitor(http0());
    expect(r).toMatchObject({ ok: true, statusCode: 200, error: null, certExpiresAt: null });
    expect(r.responseMs).toBeGreaterThanOrEqual(0);
  });

  it('http: an unexpected status names the codes it wanted', async () => {
    expect(await u.probeMonitor(http0({ target: `${base}/fail` }))).toMatchObject({ ok: false, statusCode: 503, error: 'status 503 (expected 200-399)' });
    expect(await u.probeMonitor(http0({ target: `${base}/fail`, expectedStatus: '500-599' }))).toMatchObject({ ok: true });
  });

  it('http: a keyword must be in the body (the first 1 MiB)', async () => {
    expect(await u.probeMonitor(http0({ keyword: 'healthy' }))).toMatchObject({ ok: true });
    expect(await u.probeMonitor(http0({ keyword: 'missing' }))).toMatchObject({ ok: false, error: 'keyword "missing" not found' });
    expect(await u.probeMonitor(http0({ target: `${base}/big`, keyword: 'needle' }))).toMatchObject({ ok: false, error: 'keyword "needle" not found' });
  });

  it('http: redirects are followed up to a limit, or not at all', async () => {
    expect(await u.probeMonitor(http0({ target: `${base}/redirect` }))).toMatchObject({ ok: true, statusCode: 200 });
    expect(await u.probeMonitor(http0({ target: `${base}/redirect`, followRedirects: false }))).toMatchObject({ ok: true, statusCode: 302 });
    expect(await u.probeMonitor(http0({ target: `${base}/redirect`, followRedirects: false, expectedStatus: '200' }))).toMatchObject({ ok: false, statusCode: 302 });
    expect(await u.probeMonitor(http0({ target: `${base}/loop` }))).toMatchObject({ ok: false, error: `more than ${u.MAX_REDIRECTS} redirects` });
    expect(await u.probeMonitor(http0({ target: `${base}/ftp` }))).toMatchObject({ ok: false, error: 'redirect to ftp: refused' });
  });

  it('http: a HEAD request reads no body', async () => {
    expect(await u.probeMonitor(http0({ method: 'HEAD' }))).toMatchObject({ ok: true, statusCode: 200 });
  });

  it('http: a slow target times out; a closed port is refused', async () => {
    expect(await u.probeMonitor(http0({ target: `${base}/slow`, timeoutSeconds: 1 }))).toMatchObject({ ok: false, responseMs: null, error: 'timed out after 1 s' });
    const closed = await u.probeMonitor(http0({ target: 'http://127.0.0.1:1/' }));
    expect(closed.ok).toBe(false);
    expect(closed.error).toMatch(/ECONNREFUSED/);
  });

  it('https: an untrusted certificate fails unless verifyTls is off; its expiry is read', async () => {
    const certs = fileURLToPath(new URL('../fixtures/certs/', import.meta.url));
    const tls = https.createServer({ cert: readFileSync(`${certs}valid.crt`), key: readFileSync(`${certs}valid.key`) }, (_req, res) => res.end('secure'));
    await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
    try {
      const target = `https://127.0.0.1:${(tls.address() as AddressInfo).port}/`;
      const strict = await u.probeMonitor(http0({ target }));
      expect(strict.ok).toBe(false);
      expect(strict.error).toMatch(/certificate|self.signed|UNABLE_TO_VERIFY|ERR_TLS/i);
      const lax = await u.probeMonitor(http0({ target, verifyTls: false, keyword: 'secure' }));
      expect(lax).toMatchObject({ ok: true, statusCode: 200 });
      expect(lax.certExpiresAt?.toISOString()).toBe('2099-12-31T00:00:00.000Z');
    } finally {
      tls.closeAllConnections?.();
      await new Promise((r) => tls.close(r));
    }
  });

  it('tcp: a listening port is up, a closed one down, a bad target refused', async () => {
    expect(await u.probeMonitor({ ...http0(), kind: 'tcp', target: `127.0.0.1:${tcpPort}` })).toMatchObject({ ok: true, statusCode: null });
    const closed = await u.probeMonitor({ ...http0(), kind: 'tcp', target: '127.0.0.1:1' });
    expect(closed).toMatchObject({ ok: false });
    expect(closed.error).toMatch(/ECONNREFUSED/);
    expect(await u.probeMonitor({ ...http0(), kind: 'tcp', target: 'nope' })).toMatchObject({ ok: false, error: 'invalid host:port' });
  });

  it('tcp: a connect that never completes times out', async () => {
    // 10.255.255.1 is unroutable on most networks; a fake clock is not enough for net.connect.
    const r = await u.probeMonitor({ ...http0(), kind: 'tcp', target: '10.255.255.1:81', timeoutSeconds: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out after 1 s|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED/);
  });
});

describe('the state machine and helpers', () => {
  it('goes down after failuresBeforeDown failures in a row, up after one success', () => {
    const s = (status: 'pending' | 'up' | 'down' | 'paused', consecutiveFailures = 0) => ({ status, consecutiveFailures, failuresBeforeDown: 2 });
    expect(u.nextMonitorState(s('pending'), true)).toEqual({ status: 'up', consecutiveFailures: 0, transition: null });
    expect(u.nextMonitorState(s('up'), false)).toEqual({ status: 'up', consecutiveFailures: 1, transition: null });
    expect(u.nextMonitorState(s('up', 1), false)).toEqual({ status: 'down', consecutiveFailures: 2, transition: 'down' });
    expect(u.nextMonitorState(s('down', 2), false)).toEqual({ status: 'down', consecutiveFailures: 3, transition: null });
    expect(u.nextMonitorState(s('down', 3), true)).toEqual({ status: 'up', consecutiveFailures: 0, transition: 'up' });
    expect(u.nextMonitorState(s('pending', 1), false)).toEqual({ status: 'down', consecutiveFailures: 2, transition: 'down' });
    expect(u.nextMonitorState(s('paused'), false)).toEqual({ status: 'pending', consecutiveFailures: 1, transition: null });
    expect(u.nextMonitorState({ status: 'up', consecutiveFailures: 0, failuresBeforeDown: 0 }, false).transition).toBe('down');
  });

  it('formats durations, days, percentages and due times', () => {
    expect(u.formatDuration(40_000)).toBe('40 s');
    expect(u.formatDuration(4 * 60_000)).toBe('4 min');
    expect(u.formatDuration(2 * 3600_000)).toBe('2 h');
    expect(u.formatDuration(125 * 60_000)).toBe('2 h 5 min');
    expect(u.formatDuration(-5)).toBe('0 s');
    expect(u.utcDay(new Date('2026-10-20T23:59:59Z'))).toBe('2026-10-20');
    expect(u.uptimePercent(0, 0)).toBeNull();
    expect(u.uptimePercent(3, 1)).toBe(66.67);
    const at = new Date('2026-10-20T10:00:00Z');
    expect(u.monitorDue({ enabled: false, intervalSeconds: 60, lastCheckedAt: null }, at.getTime())).toBe(false);
    expect(u.monitorDue({ enabled: true, intervalSeconds: 60, lastCheckedAt: null }, at.getTime())).toBe(true);
    expect(u.monitorDue({ enabled: true, intervalSeconds: 60, lastCheckedAt: at }, at.getTime() + 59_600)).toBe(true);
    expect(u.monitorDue({ enabled: true, intervalSeconds: 60, lastCheckedAt: at }, at.getTime() + 30_000)).toBe(false);
    expect(u.describeError(Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED: connect refused');
    expect(u.describeError('x'.repeat(400))).toHaveLength(300);
  });
});

describe('recordCheck, uptimes and retention (real SQLite)', () => {
  let db: DB;
  beforeEach(async () => {
    ({ db } = createDb({ url: ':memory:' }));
    await runMigrations(db, fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url)));
    await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true });
    await db.insert(services).values({ id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 1 } as never);
    audits.calls = [];
  });

  const monitor = async (over: Record<string, unknown> = {}) =>
    (await db.insert(uptimeMonitors).values({ name: 'API', kind: 'http', target: `${base}/ok`, serviceId: 5, statusSince: new Date('2026-10-20T09:00:00Z'), ...over } as never).returning())[0]!;

  it('writes the check and the day, moves the state and raises one event per transition', async () => {
    let m = await monitor({ failuresBeforeDown: 2 });
    const t = (min: number) => new Date(Date.UTC(2026, 9, 20, 10, min));
    m = await u.recordCheck(db, m, { ok: true, responseMs: 40, statusCode: 200, error: null, certExpiresAt: new Date('2027-01-01T00:00:00Z') }, t(0));
    expect(m).toMatchObject({ status: 'up', consecutiveFailures: 0, lastResponseMs: 40, lastStatusCode: 200 });
    expect(m.certExpiresAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    m = await u.recordCheck(db, m, { ok: false, responseMs: null, statusCode: 503, error: 'status 503 (expected 200-399)', certExpiresAt: null }, t(1));
    expect(m).toMatchObject({ status: 'up', consecutiveFailures: 1 });
    expect(audits.calls).toEqual([]);
    m = await u.recordCheck(db, m, { ok: false, responseMs: null, statusCode: 503, error: 'status 503 (expected 200-399)', certExpiresAt: null }, t(2));
    expect(m).toMatchObject({ status: 'down', consecutiveFailures: 2, lastError: 'status 503 (expected 200-399)' });
    expect(m.statusSince?.toISOString()).toBe(t(2).toISOString());
    // A certificate is kept from the last check that saw one.
    expect(m.certExpiresAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    m = await u.recordCheck(db, m, { ok: true, responseMs: 60, statusCode: 200, error: null, certExpiresAt: null }, t(9));
    expect(m.status).toBe('up');
    expect(audits.calls).toEqual([
      { action: 'alert.monitor_down', entity: `API #${m.id}: status 503 (expected 200-399)`, meta: { monitorId: m.id, serviceId: 5 } },
      { action: 'alert.monitor_up', entity: `API #${m.id} is up again after 7 min`, meta: { monitorId: m.id, serviceId: 5 } },
    ]);
    expect(await db.select().from(uptimeChecks).where(eq(uptimeChecks.monitorId, m.id))).toHaveLength(4);
    expect(await db.select().from(uptimeDaily)).toMatchObject([{ monitorId: m.id, day: '2026-10-20', checks: 4, failures: 2, responseMsSum: 100 }]);
  });

  it('an operator-only monitor raises its events without a service', async () => {
    let m = await monitor({ serviceId: null, failuresBeforeDown: 1, statusSince: null });
    m = await u.recordCheck(db, m, { ok: false, responseMs: null, statusCode: null, error: null, certExpiresAt: null });
    m = await u.recordCheck(db, m, { ok: true, responseMs: 1, statusCode: 200, error: null, certExpiresAt: null });
    expect(audits.calls.map((c) => c.meta)).toEqual([{ monitorId: m.id }, { monitorId: m.id }]);
    expect(audits.calls[0]!.entity).toBe(`API #${m.id}: check failed`);
  });

  it('reads 24-hour, 7-day and 30-day uptime', async () => {
    const m = await monitor();
    const other = await monitor({ name: 'Other' });
    const now = new Date('2026-10-20T12:00:00Z');
    await db.insert(uptimeChecks).values([
      { monitorId: m.id, ok: true, ts: new Date('2026-10-20T11:00:00Z') },
      { monitorId: m.id, ok: false, ts: new Date('2026-10-20T11:01:00Z') },
      { monitorId: m.id, ok: true, ts: new Date('2026-10-18T11:00:00Z') },
    ]);
    await db.insert(uptimeDaily).values([
      { monitorId: m.id, day: '2026-10-20', checks: 100, failures: 10 },
      { monitorId: m.id, day: '2026-10-10', checks: 100, failures: 0 },
      { monitorId: m.id, day: '2026-09-01', checks: 100, failures: 100 },
    ]);
    const up = await u.monitorUptimes(db, [m.id, other.id], now);
    expect(up.get(m.id)).toEqual({ h24: 50, d7: 90, d30: 95 });
    expect(up.get(other.id)).toEqual({ h24: null, d7: null, d30: null });
    expect((await u.monitorUptimes(db, [], now)).size).toBe(0);
  });

  it('prunes checks after 7 days and rollups after 400', async () => {
    const m = await monitor();
    const now = new Date('2026-10-20T12:00:00Z').getTime();
    await db.insert(uptimeChecks).values([
      { monitorId: m.id, ok: true, ts: new Date(now - 8 * 86_400_000) },
      { monitorId: m.id, ok: true, ts: new Date(now - 8 * 86_400_000) },
      { monitorId: m.id, ok: true, ts: new Date(now - 1 * 86_400_000) },
    ]);
    await db.insert(uptimeDaily).values([
      { monitorId: m.id, day: '2025-01-01', checks: 1 },
      { monitorId: m.id, day: '2026-10-19', checks: 1 },
    ]);
    expect(await u.pruneUptime(db, now, 1)).toEqual({ checks: 2, daily: 1 });
    expect(await db.select().from(uptimeChecks)).toHaveLength(1);
    expect((await db.select().from(uptimeDaily)).map((d) => d.day)).toEqual(['2026-10-19']);
  });
});

describe('the scheduler', () => {
  const row = (id: number, over: Record<string, unknown> = {}) =>
    ({ id, enabled: true, intervalSeconds: 60, lastCheckedAt: null, ...over }) as unknown as u.UptimeMonitorRow;

  it('starts due monitors once each, up to the concurrency limit, and survives a failing check or load', async () => {
    const pending: Array<() => void> = [];
    const errors: unknown[] = [];
    const check = vi.fn(
      (m: u.UptimeMonitorRow) =>
        new Promise<void>((resolve, reject) => pending.push(() => (m.id === 2 ? reject(new Error('boom')) : resolve()))),
    );
    const rows = [row(1), row(2), row(3, { enabled: false }), row(4, { lastCheckedAt: new Date() })];
    const s = createUptimeScheduler({ load: async () => rows, check, onError: (e) => errors.push(e) });
    expect(await s.tick()).toBe(2);
    expect(await s.tick()).toBe(0); // still in flight
    for (const p of pending) p();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.inFlight.size).toBe(0);
    expect(errors).toHaveLength(1);
    const many = Array.from({ length: UPTIME_CONCURRENCY + 5 }, (_, i) => row(100 + i));
    const busy = createUptimeScheduler({ load: async () => many, check: () => new Promise(() => undefined) });
    expect(await busy.tick()).toBe(UPTIME_CONCURRENCY);
    const broken = createUptimeScheduler({ load: async () => Promise.reject(new Error('no table')), check, onError: (e) => errors.push(e) });
    expect(await broken.tick()).toBe(0);
    expect(errors).toHaveLength(2);
  });
});
