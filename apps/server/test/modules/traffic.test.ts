/**
 * 0.15 traffic analytics routes (DESIGN §2.4) against a real migrated SQLite:
 * the opt-in switch and its one Traefik recreate (ensureTraefik is mocked —
 * Docker is never reached), the failed-recreate rollback, the tailer start /
 * stop wiring (M15), the instance summary and the per-service route. Every
 * response is parsed with its `@ninedeploy/schemas` contract.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  type DB,
  serviceWorkspaces,
  services,
  trafficRollups,
  users,
  workspaceMembers,
  workspaces,
} from '@ninedeploy/db';
import { serviceTrafficSummary, trafficSettingsView, trafficSummary } from '@ninedeploy/schemas';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-traffic-routes-'));
const h = vi.hoisted(() => ({
  ensureTraefik: vi.fn(async (..._a: unknown[]) => true),
  ensureNetwork: vi.fn(async (..._a: unknown[]) => undefined),
  dockerLoggingDriver: vi.fn(async () => 'json-file' as string | null),
  audit: vi.fn(async (..._a: unknown[]) => undefined),
}));
vi.mock('../../src/config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/config.js')>();
  return { ...mod, config: { ...mod.config, paths: { ...mod.config.paths, dataDir: tmp } } };
});
vi.mock('../../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/engine/proxy.js')>()),
  ensureTraefik: h.ensureTraefik,
  ensureNetwork: h.ensureNetwork,
  dockerLoggingDriver: h.dockerLoggingDriver,
}));
vi.mock('../../src/lib/audit.js', () => ({ audit: h.audit }));
vi.mock('../../src/lib/trafficAnalytics.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/lib/trafficAnalytics.js')>();
  return {
    ...mod,
    startTrafficTailer: vi.fn((deps: Parameters<typeof mod.startTrafficTailer>[0]) =>
      mod.startTrafficTailer({ ...deps, reopen: async () => undefined }),
    ),
    stopTrafficTailer: vi.fn(mod.stopTrafficTailer),
  };
});

const T = await import('../../src/lib/trafficAnalytics.js');
const { serviceTrafficRoutes, trafficRoutes } = await import('../../src/modules/traffic.js');
const trafficAnalyticsPlugin = (await import('../../src/plugins/trafficAnalytics.js')).default;
const { asUser, buildTestApp } = await import('../helpers.js');

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));
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
let serviceId: number;
const OPERATOR = 1;
const VIEWER = 2;
const OUTSIDER = 3;
const logDir = path.join(tmp, 'traffic-logs');

beforeEach(async () => {
  const created = createDb({ url: `file:${path.join(tmp, `db-${++n}.sqlite`)}` });
  await created.ready;
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values([OPERATOR, VIEWER, OUTSIDER].map((id) => ({ id, email: `u${id}@example.com`, passwordHash: 'x', isInstanceOperator: id === OPERATOR })));
  const [ws] = await db.insert(workspaces).values({ name: 'W', slug: 'w', ownerId: OPERATOR }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: VIEWER, role: 'viewer' });
  const [svc] = await db.insert(services).values({ name: 'web', slug: 'web' }).returning();
  serviceId = svc!.id;
  await db.insert(serviceWorkspaces).values({ serviceId, workspaceId: ws!.id });
  h.ensureTraefik.mockReset();
  h.ensureTraefik.mockResolvedValue(true);
  h.ensureNetwork.mockClear();
  h.audit.mockClear();
  vi.mocked(T.startTrafficTailer).mockClear();
  vi.mocked(T.stopTrafficTailer).mockClear();
});
afterEach(async () => {
  await T.stopTrafficTailer();
  close();
  rmSync(logDir, { recursive: true, force: true });
});

async function app() {
  const a = await buildTestApp({ db });
  await a.register(trafficRoutes, { prefix: '/traffic' });
  await a.register(serviceTrafficRoutes, { prefix: '/services' });
  return a;
}
const op = asUser({ id: OPERATOR, isOperator: true });
const member = (id: number) => asUser({ id, isOperator: false, role: 'member' });
const actions = () => h.audit.mock.calls.map((c) => c[2]);

describe('GET/PUT /v1/traffic/settings', () => {
  it('reports the opt-in default (off) on an upgraded instance; operator only', async () => {
    const a = await app();
    const res = await a.inject({ method: 'GET', url: '/traffic/settings', headers: op });
    expect(res.statusCode).toBe(200);
    expect(trafficSettingsView.parse(res.json())).toEqual({
      enabled: false,
      retentionDays: 30,
      status: 'off',
      lastError: null,
      lastIngestAt: null,
      logBytes: 0,
      malformedLines: 0,
      dockerLogDriver: 'json-file',
    });
    for (const method of ['GET', 'PUT'] as const) {
      const denied = await a.inject({ method, url: '/traffic/settings', headers: member(VIEWER), payload: method === 'PUT' ? { enabled: true } : undefined });
      expect(denied.statusCode).toBe(403);
    }
    expect(h.ensureTraefik).not.toHaveBeenCalled();
  });

  it('enable: one recreate on the file config, the tailer starts, enable + update audited', async () => {
    const a = await app();
    const res = await a.inject({ method: 'PUT', url: '/traffic/settings', headers: op, payload: { enabled: true } });
    expect(res.statusCode, res.body).toBe(200);
    const view = trafficSettingsView.parse(res.json());
    expect(view.enabled).toBe(true);
    expect(['starting', 'running']).toContain(view.status);
    expect(h.ensureTraefik).toHaveBeenCalledTimes(1);
    expect(h.ensureTraefik).toHaveBeenCalledWith(expect.any(Function), null, expect.anything(), expect.objectContaining({ accessLog: 'file' }));
    expect(T.startTrafficTailer).toHaveBeenCalledTimes(1);
    expect(T.trafficTailerActive()).toBe(true);
    expect(actions()).toEqual(['traffic.enable', 'traffic.settings.update']);
    expect(h.audit.mock.calls[0]![4]).toEqual({ previous: { enabled: false, retentionDays: 30 } });

    // Again: no second recreate.
    const again = await a.inject({ method: 'PUT', url: '/traffic/settings', headers: op, payload: { enabled: true } });
    expect(again.statusCode).toBe(200);
    expect(h.ensureTraefik).toHaveBeenCalledTimes(1);
  });

  it('disable: recreate on the stdout config, the tailer drains and deletes the log files', async () => {
    const a = await app();
    await a.inject({ method: 'PUT', url: '/traffic/settings', headers: op, payload: { enabled: true } });
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      path.join(logDir, 'access.log'),
      `${JSON.stringify({ RouterName: 'ninedeploy_panel@file', DownstreamStatus: 200, StartUTC: new Date().toISOString() })}\n`,
    );
    h.ensureTraefik.mockClear();
    h.audit.mockClear();
    const res = await a.inject({ method: 'PUT', url: '/traffic/settings', headers: op, payload: { enabled: false } });
    expect(res.statusCode, res.body).toBe(200);
    expect(trafficSettingsView.parse(res.json())).toMatchObject({ enabled: false, status: 'off', logBytes: 0 });
    expect(h.ensureTraefik).toHaveBeenCalledWith(expect.any(Function), null, expect.anything(), expect.objectContaining({ accessLog: 'stdout' }));
    expect(T.stopTrafficTailer).toHaveBeenCalledWith({ purge: expect.objectContaining({ db }) });
    expect(existsSync(path.join(logDir, 'access.log'))).toBe(false);
    // Drained before the delete; the rollup rows stay.
    expect((await db.select().from(trafficRollups)).filter((r) => r.scopeKey === 'panel' && r.granularity === 60)[0]?.requests).toBe(1);
    expect(actions()).toEqual(['traffic.disable', 'traffic.settings.update']);
  });

  it('a failed recreate keeps the previous value, restores the previous config and answers 502', async () => {
    h.ensureTraefik.mockRejectedValueOnce(new Error('port 80 is already allocated'));
    const a = await app();
    const res = await a.inject({ method: 'PUT', url: '/traffic/settings', headers: op, payload: { enabled: true } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('traefik_recreate_failed');
    expect(await T.trafficAnalyticsEnabled(db)).toBe(false);
    expect(h.ensureTraefik).toHaveBeenCalledTimes(2);
    expect(h.ensureTraefik.mock.calls[0]![3]).toMatchObject({ accessLog: 'file' });
    expect(h.ensureTraefik.mock.calls[1]![3]).toMatchObject({ accessLog: 'stdout' });
    expect(T.startTrafficTailer).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(db, OPERATOR, 'traffic.settings.update', 'traffic', expect.objectContaining({ outcome: 'recreate_failed' }));
    const view = await a.inject({ method: 'GET', url: '/traffic/settings', headers: op });
    expect(view.json().enabled).toBe(false);
  });

  it('retention: saved without touching Traefik; validated against the contract', async () => {
    const a = await app();
    const res = await a.inject({ method: 'PUT', url: '/traffic/settings', headers: op, payload: { retentionDays: 90 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().retentionDays).toBe(90);
    expect(h.ensureTraefik).not.toHaveBeenCalled();
    expect(actions()).toEqual(['traffic.settings.update']);
    for (const payload of [{ retentionDays: 0 }, { retentionDays: 401 }, { retentionDays: 1.5 }, { enabled: 'yes' }, { other: 1 }]) {
      expect((await a.inject({ method: 'PUT', url: '/traffic/settings', headers: op, payload })).statusCode).toBe(400);
    }
    expect(await T.getTrafficRetentionDays(db)).toBe(90);
  });
});

describe('GET /v1/traffic/summary and /v1/services/:id/traffic', () => {
  async function seedRows() {
    const now = Math.floor(Date.now() / 1000);
    const minute = now - (now % 60) - 120;
    const base = { granularity: 60, bucketStart: minute, latencyHist: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
    await db.insert(trafficRollups).values([
      { ...base, scopeKey: 'd:1', domainId: 1, serviceId, host: 'app.example.com', requests: 5, status2xx: 5, latencyHist: [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { ...base, scopeKey: 'd:9', domainId: 9, serviceId: serviceId + 100, host: 'else.example.com', requests: 2, status5xx: 2 },
      { ...base, scopeKey: 'panel', host: 'panel.example.com', requests: 3, status2xx: 3 },
      { ...base, scopeKey: 'custom', requests: 1, status4xx: 1 },
      { ...base, scopeKey: 'other', requests: 4, statusOther: 4 },
    ]);
  }

  it('instance summary: totals, series, top domains, panel and custom buckets', async () => {
    await seedRows();
    const a = await app();
    const res = await a.inject({ method: 'GET', url: '/traffic/summary?range=1h&top=1', headers: op });
    expect(res.statusCode, res.body).toBe(200);
    const body = trafficSummary.parse(res.json());
    expect(body).toMatchObject({ enabled: false, range: '1h', granularity: 60 });
    expect(body.totals.requests).toBe(15);
    expect(body.series).toHaveLength(1);
    expect(body.topDomains.map((d) => d.scopeKey)).toEqual(['d:1']);
    expect(body.panel).toMatchObject({ requests: 3, host: 'panel.example.com' });
    expect(body.custom).toMatchObject({ requests: 1 });
    expect((await a.inject({ method: 'GET', url: '/traffic/summary', headers: member(VIEWER) })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/traffic/summary?range=2d', headers: op })).statusCode).toBe(400);
  });

  it('per service: only its own domains; any seat; empty (not 404) without data; outsiders 404', async () => {
    const a = await app();
    const empty = await a.inject({ method: 'GET', url: `/services/${serviceId}/traffic`, headers: member(VIEWER) });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(serviceTrafficSummary.parse(empty.json())).toMatchObject({ range: '24h', granularity: 60, series: [], domains: [], totals: { requests: 0 } });

    await seedRows();
    const res = await a.inject({ method: 'GET', url: `/services/${serviceId}/traffic?range=24h`, headers: member(VIEWER) });
    const body = serviceTrafficSummary.parse(res.json());
    expect(body.totals.requests).toBe(5);
    expect(body.domains.map((d) => d.host)).toEqual(['app.example.com']);
    expect(JSON.stringify(body)).not.toContain('else.example.com');

    expect((await a.inject({ method: 'GET', url: `/services/${serviceId}/traffic`, headers: member(OUTSIDER) })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: `/services/${serviceId}/traffic` })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/services/abc/traffic', headers: op })).statusCode).toBe(400);
  });
});

describe('plugins/trafficAnalytics (M15)', () => {
  async function boot(database: unknown) {
    const f = Fastify({ logger: false });
    f.decorate('db', database as never);
    await f.register(trafficAnalyticsPlugin);
    await f.ready();
    return f;
  }

  it('starts the tailer at boot when analytics is enabled, stops it on close', async () => {
    await T.setTrafficAnalyticsEnabled(db, true);
    const f = await boot(db);
    expect(T.startTrafficTailer).toHaveBeenCalledWith(expect.objectContaining({ db }));
    expect(T.trafficTailerActive()).toBe(true);
    await f.close();
    expect(T.trafficTailerActive()).toBe(false);
  });

  it('stays idle when analytics is off, and never blocks boot on a database error', async () => {
    await (await boot(db)).close();
    expect(T.startTrafficTailer).not.toHaveBeenCalled();
    const broken = { query: { settings: { findFirst: async () => { throw new Error('no such table'); } } } };
    await (await boot(broken)).close();
    expect(T.startTrafficTailer).not.toHaveBeenCalled();
  });
});
