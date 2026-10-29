/**
 * ROADMAP item 9: usage and cost (`lib/usageReport.ts`, `modules/usage.ts`)
 * against a migrated in-memory SQLite. Samples are written straight into the
 * tables the collector fills, so the arithmetic is checked to the unit.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  metricRollups,
  metrics,
  projects,
  servers,
  serviceProjects,
  services,
  serviceWorkspaces,
  settings,
  trafficRollups,
  users,
  workspaces,
  type DB,
} from '@ninedeploy/db';

const h = vi.hoisted(() => ({ retention: 1 as number | Error, traffic: false as boolean | Error }));
vi.mock('../../src/lib/observabilitySettings.js', () => ({
  readObservabilitySettings: async () => {
    if (h.retention instanceof Error) throw h.retention;
    return { retentionDays: h.retention };
  },
}));
vi.mock('../../src/lib/trafficAnalytics.js', () => ({
  trafficAnalyticsEnabled: async () => {
    if (h.traffic instanceof Error) throw h.traffic;
    return h.traffic;
  },
}));

const lib = await import('../../src/lib/usageReport.js');
const { usageRoutes } = await import('../../src/modules/usage.js');
const { buildTestApp, asUser } = await import('../helpers.js');
const { closeMigratedDb, migratedDb } = await import('./githubAppKit.js');

const NOW = new Date('2026-10-30T12:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;
const GiB = 1024 ** 3;

let db: DB;
let ids: { a: number; b: number; c: number; nodeX: number; nodeY: number; project: number; workspace: number };
beforeEach(async () => {
  db = await migratedDb();
  h.retention = 1;
  h.traffic = false;
  const [nodeX] = await db.insert(servers).values({ name: 'node-x', host: '198.51.100.1', port: 4600, tokenEncrypted: 'x', status: 'online' }).returning();
  const [nodeY] = await db.insert(servers).values({ name: 'node-y', host: '198.51.100.2', port: 4600, tokenEncrypted: 'x', status: 'online' }).returning();
  const [a] = await db.insert(services).values({ name: 'api', slug: 'api', type: 'docker' } as never).returning();
  const [b] = await db.insert(services).values({ name: 'worker', slug: 'worker', type: 'docker' } as never).returning();
  const [c] = await db.insert(services).values({ name: 'edge', slug: 'edge', type: 'docker', serverId: nodeX!.id } as never).returning();
  const [user] = await db.insert(users).values({ email: 'o@x.test', name: 'o', passwordHash: 'x' }).returning();
  const [workspace] = await db.insert(workspaces).values({ name: 'Acme', slug: 'acme', ownerId: user!.id }).returning();
  const [project] = await db.insert(projects).values({ name: 'Shop', slug: 'shop', workspaceId: workspace!.id }).returning();
  await db.insert(serviceProjects).values([{ serviceId: a!.id, projectId: project!.id }, { serviceId: b!.id, projectId: project!.id }]);
  await db.insert(serviceWorkspaces).values({ serviceId: a!.id, workspaceId: workspace!.id });
  ids = { a: a!.id, b: b!.id, c: c!.id, nodeX: nodeX!.id, nodeY: nodeY!.id, project: project!.id, workspace: workspace!.id };
});
afterEach(() => closeMigratedDb(db));

/** `count` raw 30-second samples of one kind, the newest 10 minutes ago. */
async function raw(serviceId: number, kind: string, value: number, count: number, newestAgoMs = 10 * MIN) {
  await db.insert(metrics).values(
    Array.from({ length: count }, (_, i) => ({ serviceId, kind, value, ts: new Date(NOW.getTime() - newestAgoMs - i * 30_000) })),
  );
}
const rollup = (serviceId: number, kind: string, bucketSeconds: number, agoMs: number, value: number, samples: number) =>
  db.insert(metricRollups).values({ serviceId, kind, bucketSeconds, ts: new Date(NOW.getTime() - agoMs), sum: value * samples, samples, min: value, max: value });

describe('usage figures', () => {
  it('turns 30-second samples into core-hours and GiB-hours, without counting a summary of the same time twice', async () => {
    await raw(ids.a, 'cpu', 10_000, 120); // one core for an hour
    await raw(ids.a, 'memory', GiB, 120); // 1 GiB for an hour
    await raw(ids.a, 'status', 1, 5); // not a resource
    // The collector writes the 5-minute summary of the same samples at once: not counted again.
    await rollup(ids.a, 'cpu', 300, 10 * MIN, 10_000, 10);
    // A raw sample older than a day (the prune has not run yet) is the summaries' to count.
    await raw(ids.a, 'cpu', 10_000, 10, 2 * DAY);
    const report = await lib.buildUsageReport(db, 1, NOW);
    const api = report.services.find((s) => s.serviceId === ids.a)!;
    expect(api).toMatchObject({ cpuCoreHours: 1, memoryGbHours: 1, egressGb: 0, requests: 0, cost: null, serverId: null, serverName: 'Panel host' });
    expect(api.projects).toEqual([{ id: ids.project, name: 'Shop' }]);
    expect(api.workspaces).toEqual([{ id: ids.workspace, name: 'Acme' }]);
    expect(report).toMatchObject({ days: 1, currency: 'USD', historyDays: 1, trafficAnalytics: false, to: NOW.toISOString() });
    // Sorted by CPU, then by name.
    expect(report.services.map((s) => s.name)).toEqual(['api', 'edge', 'worker']);
  });

  it('reads the 5-minute and hourly summaries for older time, as far as resource history is kept', async () => {
    h.retention = 30;
    await rollup(ids.a, 'cpu', 300, 3 * DAY, 10_000, 10); // 300 s of one core
    await rollup(ids.a, 'cpu', 3600, 20 * DAY, 5_000, 120); // an hour at half a core
    // An hourly summary inside the 5-minute tier's range is the same time: not counted.
    await rollup(ids.a, 'cpu', 3600, 3 * DAY, 10_000, 120);
    await rollup(ids.a, 'memory', 300, 2 * DAY, 2 * GiB, 120);
    const week = await lib.buildUsageReport(db, 7, NOW);
    expect(week.services.find((s) => s.serviceId === ids.a)).toMatchObject({ cpuCoreHours: round(300 / 3600), memoryGbHours: 2 });
    const month = await lib.buildUsageReport(db, 30, NOW);
    expect(month.services.find((s) => s.serviceId === ids.a)!.cpuCoreHours).toBe(round(300 / 3600 + 0.5));
    // With the one-day default the summaries are not read at all.
    h.retention = 1;
    expect((await lib.buildUsageReport(db, 30, NOW)).services.find((s) => s.serviceId === ids.a)!.cpuCoreHours).toBe(0);
    // An unreadable observability record falls back to the default.
    h.retention = new Error('Observability settings must be encrypted');
    expect((await lib.buildUsageReport(db, 30, NOW)).historyDays).toBe(1);
  });

  it('adds bandwidth and requests from the hourly traffic rows of the window', async () => {
    h.traffic = true;
    const sec = (ms: number) => Math.floor(ms / 1000);
    const row = (granularity: number, agoMs: number, bytesOut: number, requests: number, serviceId: number | null = ids.a) => ({
      granularity, bucketStart: sec(NOW.getTime() - agoMs), scopeKey: `d:${granularity}:${agoMs}:${serviceId}`, serviceId, bytesOut, requests,
    });
    await db.insert(trafficRollups).values([
      row(3600, 2 * 3600_000, 1.5e9, 1000),
      row(3600, 5 * 3600_000, 0.5e9, 500),
      row(60, 2 * 3600_000, 9e9, 9), // minute rows repeat the hour rows
      row(3600, 2 * DAY, 9e9, 9), // before the window
      row(3600, 3600_000, 9e9, 9, null), // the panel or an unattributed host
    ]);
    const report = await lib.buildUsageReport(db, 1, NOW);
    expect(report.trafficAnalytics).toBe(true);
    expect(report.services.find((s) => s.serviceId === ids.a)).toMatchObject({ egressGb: 2, requests: 1500 });
    expect(report.totals).toMatchObject({ egressGb: 2, requests: 1500 });
    h.traffic = new Error('database is locked');
    expect((await lib.buildUsageReport(db, 1, NOW)).trafficAnalytics).toBe(false);
  });

  it('groups by project and workspace; a service in a group counts in it', async () => {
    await raw(ids.a, 'cpu', 10_000, 120);
    await raw(ids.b, 'cpu', 20_000, 120);
    const report = await lib.buildUsageReport(db, 1, NOW);
    expect(report.projects).toEqual([{ id: ids.project, name: 'Shop', services: 2, cpuCoreHours: 3, memoryGbHours: 0, egressGb: 0, requests: 0, cost: null }]);
    expect(report.workspaces).toEqual([{ id: ids.workspace, name: 'Acme', services: 1, cpuCoreHours: 1, memoryGbHours: 0, egressGb: 0, requests: 0, cost: null }]);
    expect(report.totals).toMatchObject({ cpuCoreHours: 3, cost: null });
  });
});

const round = (n: number) => Math.round(n * 1e4) / 1e4;

describe('cost', () => {
  it('prorates each server’s monthly cost and splits it half by CPU share, half by memory share', async () => {
    await raw(ids.a, 'cpu', 10_000, 120);
    await raw(ids.a, 'memory', GiB, 120);
    await raw(ids.b, 'cpu', 30_000, 120);
    await raw(ids.b, 'memory', GiB, 120);
    await lib.saveUsageCosts(db, { currency: 'EUR', servers: [{ serverId: null, monthlyCost: 730 }, { serverId: ids.nodeX, monthlyCost: 73 }] });
    const report = await lib.buildUsageReport(db, 1, NOW);
    expect(report.currency).toBe('EUR');
    // 730 a month is 24 a day. api: (1/4 CPU + 1/2 memory) / 2 = 0.375; worker 0.625.
    expect(report.services.find((s) => s.serviceId === ids.a)!.cost).toBe(9);
    expect(report.services.find((s) => s.serviceId === ids.b)!.cost).toBe(15);
    // node-x measured nothing: its whole cost is unallocated, and its service costs 0.
    expect(report.services.find((s) => s.serviceId === ids.c)!.cost).toBe(0);
    expect(report.servers).toEqual([
      { serverId: null, name: 'Panel host', monthlyCost: 730, periodCost: 24, unallocated: 0, cpuCoreHours: 4, memoryGbHours: 2 },
      { serverId: ids.nodeX, name: 'node-x', monthlyCost: 73, periodCost: 2.4, unallocated: 2.4, cpuCoreHours: 0, memoryGbHours: 0 },
      { serverId: ids.nodeY, name: 'node-y', monthlyCost: null, periodCost: null, unallocated: null, cpuCoreHours: 0, memoryGbHours: 0 },
    ]);
    expect(report.totals.cost).toBe(24);
    expect(report.projects[0]!.cost).toBe(24);
  });

  it('splits by memory alone when nothing used CPU', async () => {
    await raw(ids.a, 'memory', GiB, 120);
    await raw(ids.b, 'memory', 3 * GiB, 120);
    await lib.saveUsageCosts(db, { servers: [{ serverId: null, monthlyCost: 730 }] });
    const report = await lib.buildUsageReport(db, 1, NOW);
    expect(report.services.find((s) => s.serviceId === ids.a)!.cost).toBe(6);
    expect(report.services.find((s) => s.serviceId === ids.b)!.cost).toBe(18);
  });

  it('stores the costs, drops a deleted server’s, and refuses a server twice or a bad currency', async () => {
    expect(await lib.readUsageCosts(db)).toEqual({ currency: 'USD', servers: [] });
    await lib.saveUsageCosts(db, { currency: 'USD', servers: [{ serverId: ids.nodeY, monthlyCost: 5 }, { serverId: null, monthlyCost: 10 }] });
    await db.delete(servers).where(eq(servers.id, ids.nodeY));
    expect(await lib.readUsageCosts(db)).toEqual({ currency: 'USD', servers: [{ serverId: null, monthlyCost: 10 }] });
    await expect(lib.saveUsageCosts(db, { servers: [{ serverId: null, monthlyCost: 1 }, { serverId: null, monthlyCost: 2 }] })).rejects.toThrow(/each server once/);
    await expect(lib.saveUsageCosts(db, { currency: 'usd' })).rejects.toThrow();
    // A stored row that no longer parses reads as no costs.
    await db.update(settings).set({ value: JSON.stringify({ currency: 'dollars' }) }).where(eq(settings.key, 'usage_costs'));
    expect(await lib.readUsageCosts(db)).toEqual({ currency: 'USD', servers: [] });
  });
});

describe('routes', () => {
  it('are operator only, validate the window and the costs, and audit a cost change', async () => {
    const app = await buildTestApp({ db });
    await app.register(usageRoutes, { prefix: '/usage' });
    const OP = asUser({ id: 1, isOperator: true });
    const MEMBER = asUser({ id: 2, isOperator: false });
    expect((await app.inject({ url: '/usage', headers: MEMBER })).statusCode).toBe(403);
    expect((await app.inject({ url: '/usage?days=91', headers: OP })).statusCode).toBe(400);
    const report = await app.inject({ url: '/usage?days=7', headers: OP });
    expect(report.statusCode, report.body).toBe(200);
    expect(report.json()).toMatchObject({ days: 7, services: expect.any(Array) });
    expect((await app.inject({ url: '/usage', headers: OP })).json()).toMatchObject({ days: 30 });
    expect((await app.inject({ method: 'PUT', url: '/usage/costs', headers: OP, payload: { servers: [{ serverId: null, monthlyCost: -1 }] } })).statusCode).toBe(400);
    const put = await app.inject({ method: 'PUT', url: '/usage/costs', headers: OP, payload: { currency: 'EUR', servers: [{ serverId: null, monthlyCost: 40 }] } });
    expect(put.json()).toEqual({ currency: 'EUR', servers: [{ serverId: null, monthlyCost: 40 }] });
    expect((await app.inject({ url: '/usage/costs', headers: OP })).json()).toEqual({ currency: 'EUR', servers: [{ serverId: null, monthlyCost: 40 }] });
    await app.close();
  });
});
