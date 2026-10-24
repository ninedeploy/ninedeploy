import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { auditLog, configEntries, metricRollups, metrics, services } from '@ninedeploy/db';
import { observabilityPatch, metricQuery } from '@ninedeploy/schemas';
import { observabilityDb } from './fixtures/observability.js';
import { persistServiceMetrics, pruneServiceMetrics, readMetricPoints } from '../src/lib/serviceMetricHistory.js';
import { exportOtlpMetrics, otlpMetrics, prometheusMetrics, resourceMetrics, type ResourceMetric } from '../src/lib/metricExport.js';
import { OBSERVABILITY_DEFAULTS, readObservabilitySettings } from '../src/lib/observabilitySettings.js';
import { statsRoutes, metricRoutes } from '../src/modules/stats.js';
import { asUser, buildTestApp } from './helpers.js';

const fixtures: Awaited<ReturnType<typeof observabilityDb>>[] = [];
afterEach(() => { fixtures.splice(0).forEach((f) => { f.close(); }); vi.restoreAllMocks(); });
async function setup() { const f = await observabilityDb(); fixtures.push(f); return f; }
const now = new Date('2026-10-22T15:00:00Z');
const day = 86400000;
const row = (value: number, age: number, serviceId = 1, kind = 'cpu') => ({ serviceId, kind, value, ts: new Date(now.getTime() - age) });
const sample: ResourceMetric = { serviceId: 1, slug: 'web', serverId: null, kind: 'cpu', value: 2.5, ts: 1792681200 };

describe('resource metric history', () => {
  it.each([1, 90])('persists a large collection cycle with %i-day retention without exceeding SQLite parameter limits', async (retentionDays) => {
    const f = await setup(); await f.configure({ retentionDays });
    await persistServiceMetrics(f.db, Array.from({ length: 5000 }, (_, i) => row(100, i * 1000)));
    expect(await f.db.select().from(metrics)).toHaveLength(5000);
    const summaries = await f.db.select().from(metricRollups);
    if (retentionDays === 1) expect(summaries).toEqual([]);
    else for (const tier of [300, 3600]) expect(summaries.filter((r) => r.bucketSeconds === tier).reduce((n, r) => n + r.samples, 0)).toBe(5000);
  });
  it('rolls back all chunks when a later metric insert fails, preserving earlier completed cycles', async () => {
    const f = await setup(); await f.configure({ retentionDays: 90 });
    await persistServiceMetrics(f.db, [row(250, 0)]);
    const priorRollups = await f.db.select().from(metricRollups);
    await f.db.run(sql`CREATE TRIGGER reject_metric_value BEFORE INSERT ON metrics WHEN NEW.value = 999 BEGIN SELECT RAISE(ABORT, 'rejected metric'); END`);
    const cycle = Array.from({ length: 1001 }, (_, i) => row(i === 1000 ? 999 : 100, i * 1000));
    await expect(persistServiceMetrics(f.db, cycle)).rejects.toThrow();
    expect((await f.db.select().from(metrics)).map((r) => r.value)).toEqual([250]);
    expect(await f.db.select().from(metricRollups)).toEqual(priorRollups);
  });
  it('keeps the existing one-day default and archives only after opt-in', async () => {
    const f = await setup();
    await persistServiceMetrics(f.db, [row(250, 0)]);
    expect(await f.db.select().from(metrics)).toHaveLength(1);
    expect(await f.db.select().from(metricRollups)).toEqual([]);
    await f.configure({ retentionDays: 7 });
    await persistServiceMetrics(f.db, [row(350, 1000)]);
    expect((await f.db.select().from(metricRollups)).map((r) => r.bucketSeconds)).toEqual([300]);
  });
  it('keeps weighted historical values after raw samples are pruned', async () => {
    const f = await setup(); await f.configure({ retentionDays: 90 });
    await persistServiceMetrics(f.db, [row(100, 8 * day), row(300, 8 * day - 30000), row(900, 2 * day)]);
    await pruneServiceMetrics(f.db, now);
    expect(await f.db.select().from(metrics)).toEqual([]);
    const points = await readMetricPoints(f.db, 1, 'cpu', 90 * 1440, now);
    expect(points.map((p) => p.value)).toEqual([2, 9]);
    const rolls = await f.db.select().from(metricRollups);
    expect(rolls.some((r) => r.bucketSeconds === 300 && r.ts.getTime() < now.getTime() - 7 * day)).toBe(false);
  });
  it('includes the newest data across a full 24 hours instead of truncating at the first 1000 rows', async () => {
    const f = await setup();
    await f.db.insert(metrics).values(Array.from({ length: 2880 }, (_, i) => ({
      serviceId: 1, kind: 'cpu', value: i === 2879 ? 99900 : 100, ts: new Date(now.getTime() - day + i * 30000),
    })));
    const points = await readMetricPoints(f.db, 1, 'cpu', 1440, now);
    expect(points).toHaveLength(720);
    expect(points[0]!.ts).toBe('2026-10-21T15:00:00.000Z');
    expect(points.at(-1)!.ts).toBe('2026-10-22T14:58:00.000Z');
    expect(points.at(-1)!.value).toBe(250.5);
  });
  it('does not double count raw and summary tiers at a cutoff inside an hour', async () => {
    const f = await setup(); await f.configure({ retentionDays: 90 });
    await persistServiceMetrics(f.db, [
      { serviceId: 1, kind: 'cpu', value: 1000, ts: new Date('2026-10-21T15:00:00Z') },
      { serviceId: 1, kind: 'cpu', value: 1000, ts: new Date('2026-10-21T15:01:00Z') },
      { serviceId: 1, kind: 'cpu', value: 3000, ts: new Date('2026-10-21T15:05:00Z') },
    ]);
    const shifted = new Date('2026-10-22T15:07:00Z');
    await pruneServiceMetrics(f.db, shifted);
    const points = await readMetricPoints(f.db, 1, 'cpu', 90 * 1440, shifted);
    expect(points).toHaveLength(1); expect(points[0]!.value).toBeCloseTo(50 / 3);
  });
  it('separates tenants and memory units, rejects invalid samples and excludes future data', async () => {
    const f = await setup(); await f.configure({ retentionDays: 30 });
    await f.db.insert(services).values({ id: 2, slug: 'other', name: 'Other', ownerUserId: 2 });
    await persistServiceMetrics(f.db, [row(4 * 1024 ** 2, 2 * day, 1, 'memory'), row(99999, 2 * day, 2), row(NaN, 0), row(-1, 0)]);
    await f.db.insert(metrics).values(row(999, -day));
    await pruneServiceMetrics(f.db, now);
    expect((await readMetricPoints(f.db, 1, 'memory', 30 * 1440, now)).map((p) => p.value)).toEqual([4]);
    expect(await readMetricPoints(f.db, 1, 'cpu', 30 * 1440, now)).toEqual([]);
  });
  it('prunes summaries outside the selected retention', async () => {
    const f = await setup(); await f.configure({ retentionDays: 30 });
    await persistServiceMetrics(f.db, [row(100, 31 * day), row(200, 20 * day)]);
    await pruneServiceMetrics(f.db, now);
    expect((await f.db.select().from(metricRollups)).map((r) => r.sum)).toEqual([200]);
  });
  it('preserves archives and raw sampling when a configured key is unavailable', async () => {
    const f = await setup(); await f.configure({ retentionDays: 30 });
    await persistServiceMetrics(f.db, [row(100, 2 * day)]);
    const count = (await f.db.select().from(metricRollups)).length;
    await f.db.update(configEntries).set({ value: 'unreadable envelope' });
    await persistServiceMetrics(f.db, [row(200, 0)]);
    await expect(pruneServiceMetrics(f.db, now)).rejects.toThrow();
    expect(await f.db.select().from(metricRollups)).toHaveLength(count);
    expect(await f.db.select().from(metrics)).toHaveLength(2);
  });
  it('accepts a 90-day request and preserves omitted PATCH fields', () => {
    expect(metricQuery.parse({ minutes: '999999' }).minutes).toBe(129600);
    expect(observabilityPatch.parse({ prometheusEnabled: true })).toEqual({ prometheusEnabled: true });
  });
});

describe('operator monitoring API', () => {
  it('audits an operator collector test without recording credentials or receiver payloads', async () => {
    const f = await setup(); const app = await buildTestApp({ db: f.db });
    const result = { ok: true, status: 200, samples: 2, error: null };
    app.decorate('observability', { status: () => ({ lastAttemptAt: null, lastSuccessAt: null, result: null }), exportNow: vi.fn(async () => result) });
    await app.register(statsRoutes);
    const response = await app.inject({ method: 'POST', url: '/observability/test', headers: asUser() });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual(result);
    const entries = await f.db.select().from(auditLog).where(eq(auditLog.action, 'observability.export_tested'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ userId: 1, meta: { ok: true, status: 200, samples: 2 } });
    await app.close();
  });

  it('encrypts collector credentials and keeps them when another setting is changed', async () => {
    const f = await setup();
    const app = await buildTestApp({ db: f.db }); await app.register(statsRoutes);
    const first = await app.inject({ method: 'PATCH', url: '/observability', headers: asUser(), payload: {
      retentionDays: 30, otlpEndpoint: 'https://collector.example/v1/metrics', otlpAuthorization: 'Bearer fixture-secret',
    } });
    expect(first.statusCode).toBe(200); expect(first.body).not.toContain('fixture-secret');
    const second = await app.inject({ method: 'PATCH', url: '/observability', headers: asUser(), payload: { prometheusEnabled: true } });
    expect(second.statusCode).toBe(200); expect(second.json().settings).toMatchObject({ retentionDays: 30, prometheusEnabled: true, hasOtlpAuthorization: true });
    const stored = (await f.db.select().from(configEntries))[0]!;
    expect(stored.isSecret).toBe(true); expect(stored.value).not.toContain('fixture-secret');
    expect((await readObservabilitySettings(f.db)).otlpAuthorization).toBe('Bearer fixture-secret');
    await app.close();
  });
  it.each(['/observability', '/prometheus'])('refuses anonymous and non-operator access to %s', async (url) => {
    const f = await setup(); const app = await buildTestApp({ db: f.db }); await app.register(statsRoutes);
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ url, headers: asUser({ id: 2, isOperator: false }) })).statusCode).toBe(403);
    await app.close();
  });
  it('requires opt-in for Prometheus and exposes only fresh samples with explicit units', async () => {
    const f = await setup(); const app = await buildTestApp({ db: f.db }); await app.register(statsRoutes);
    expect((await app.inject({ url: '/prometheus', headers: asUser() })).statusCode).toBe(404);
    await f.configure({ prometheusEnabled: true });
    const recent = new Date();
    await f.db.insert(metrics).values([
      { serviceId: 1, kind: 'cpu', value: 250, ts: recent },
      { serviceId: 1, kind: 'memory', value: 12345, ts: recent },
      { serviceId: 1, kind: 'cpu', value: 9900, ts: new Date(recent.getTime() - day) },
    ]);
    const r = await app.inject({ url: '/prometheus', headers: asUser() });
    expect(r.statusCode).toBe(200); expect(r.headers['content-type']).toContain('version=0.0.4');
    expect(r.body).toContain('cpu_percent{service_id="1",service="web",server_id="panel"} 2.5');
    expect(r.body).toContain('memory_bytes{service_id="1",service="web",server_id="panel"} 12345');
    expect(r.body).not.toContain(' 99\n');
    await app.close();
  });
  it.each([
    { retentionDays: 0 }, { retentionDays: 91 }, { logQueueMaxMb: 0 },
    { otlpEndpoint: 'file:///etc/passwd' }, { otlpEndpoint: 'https://user:pass@collector.example' },
    { otlpEndpoint: 'https://collector.example/#fragment' }, { otlpAuthorization: 'Bearer x\r\nInjected: value' },
  ])('rejects invalid monitoring settings before persisting', async (payload) => {
    const f = await setup(); const app = await buildTestApp({ db: f.db }); await app.register(statsRoutes);
    expect((await app.inject({ method: 'PATCH', url: '/observability', headers: asUser(), payload })).statusCode).toBe(400);
    expect(await f.db.select().from(configEntries)).toEqual([]);
    await app.close();
  });
  it('keeps service visibility checks for long history windows', async () => {
    const f = await setup(); const app = await buildTestApp({ db: f.db }); await app.register(metricRoutes);
    expect((await app.inject({ url: '/1/metrics?minutes=129600', headers: asUser({ id: 2, isOperator: false }) })).statusCode).toBe(404);
    expect((await app.inject({ url: '/1/metrics?minutes=129600', headers: asUser() })).statusCode).toBe(200);
    await app.close();
  });
});

describe('standard metrics export', () => {
  it('omits stale, future and non-resource samples from export', async () => {
    const f = await setup();
    await f.db.insert(metrics).values([row(250, 1000), row(99900, day), row(1, -10000), row(1, 1000, 1, 'status')]);
    expect(await resourceMetrics(f.db, now)).toEqual([expect.objectContaining({ kind: 'cpu', value: 2.5 })]);
  });
  it('escapes Prometheus label values and emits a trailing newline', () => {
    const result = prometheusMetrics([{ ...sample, slug: 'line"\\\nnext' }]);
    expect(result).toContain('service="line\\"\\\\\\nnext"'); expect(result.endsWith('\n')).toBe(true);
    expect(prometheusMetrics([])).toContain('# TYPE ninedeploy_service_cpu_percent gauge');
  });
  it('encodes OTLP/HTTP JSON gauge values, nanoseconds and per-service identity', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    const cfg = { ...OBSERVABILITY_DEFAULTS, otlpEndpoint: 'https://collector.example/v1/metrics', otlpAuthorization: 'Bearer fixture' };
    const r = await exportOtlpMetrics(cfg, [sample, { ...sample, kind: 'memory', value: 12345 }], undefined, f);
    expect(r).toEqual({ ok: true, status: 200, samples: 2, error: null });
    const call = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[1].headers).toMatchObject({ Authorization: 'Bearer fixture', 'Content-Type': 'application/json' });
    const gauges = JSON.parse(String(call[1].body)).resourceMetrics[0].scopeMetrics[0].metrics;
    expect(gauges[0].gauge.dataPoints[0]).toMatchObject({ asDouble: 2.5, timeUnixNano: String(BigInt(sample.ts) * 1000000000n) });
    expect(gauges[1].unit).toBe('By');
    expect(otlpMetrics([]).resourceMetrics[0]!.scopeMetrics[0]!.metrics).toEqual([]);
  });
  it.each([
    [200, '{"partialSuccess":{"rejectedDataPoints":"1"}}', 'partial_rejection'],
    [200, 'invalid json', 'transport_or_protocol_error'],
    [503, '{}', 'http_503'],
    [200, 'x'.repeat(17000), 'response_too_large'],
  ])('reports collector rejection without exposing its response body', async (status, body, error) => {
    const cfg = { ...OBSERVABILITY_DEFAULTS, otlpEndpoint: 'https://collector.example/v1/metrics' };
    expect(await exportOtlpMetrics(cfg, [sample], undefined, async () => new Response(body, { status }))).toMatchObject({ ok: false, error });
  });
  it('does not send without a collector and reports network failures', async () => {
    const f = vi.fn(async () => { throw new Error('secret receiver error'); });
    expect(await exportOtlpMetrics(OBSERVABILITY_DEFAULTS, [sample], undefined, f)).toMatchObject({ error: 'not_configured' });
    expect(f).not.toHaveBeenCalled();
    expect(await exportOtlpMetrics({ ...OBSERVABILITY_DEFAULTS, otlpEndpoint: 'https://collector.example' }, [sample], undefined, f))
      .toMatchObject({ error: 'transport_or_protocol_error' });
  });
});
