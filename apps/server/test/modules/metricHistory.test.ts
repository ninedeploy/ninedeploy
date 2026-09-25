import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricHistoryPlugin } from '../../src/kernel/plugins/metricHistory.js';
import { metricHistoryRoutes } from '../../src/modules/metricHistory.js';
import { asUser, buildTestApp, captureAudits, type createFakeDb } from '../helpers.js';

async function newApp() {
  const a = await buildTestApp();
  // The real kernel already has a working configCenter. Register a
  // MetricHistoryPlugin so the route's `app.kernel.getPlugin()` lookup
  // succeeds, and stub its runRetention so the test does not need a
  // real audit_log to write to.
  const plugin = new MetricHistoryPlugin();
  await a.kernel.registerPlugin(plugin);
  await a.register(metricHistoryRoutes);
  return { app: a, plugin };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /v1/metric-history', () => {
  it('returns the default config snapshot', async () => {
    const { app } = await newApp();
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      enabled: boolean;
      backend: string;
      events: string[];
      retentionDays: number;
      lastFlush: { ts: number; backend: string; count: number };
    };
    expect(body.enabled).toBe(true);
    expect(body.backend).toBe('builtin');
    expect(body.events).toContain('deployment.status_changed');
    expect(body.events).toContain('alert.triggered');
    expect(body.retentionDays).toBe(30);
  });

  it('rejects unauthenticated callers', async () => {
    const { app } = await newApp();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(401);
  });

  it('coerces an unknown backend back to builtin (defensive default)', async () => {
    const { app } = await newApp();
    // Set a non-typed value through the real configCenter to exercise the
    // `isKnownBackend` fallback branch.
    await app.kernel.configCenter.set('plugin:metric-history:backend', 'mystery-backend', {
      isSecret: false,
      category: 'plugin:metric-history',
      pluginId: 'metric-history',
    });
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { backend: string };
    expect(body.backend).toBe('builtin');
  });

  it('returns the configured non-default event list', async () => {
    const { app } = await newApp();
    await app.kernel.configCenter.set('plugin:metric-history:events', ['alert.triggered'], {
      isSecret: false,
      category: 'plugin:metric-history',
      pluginId: 'metric-history',
    });
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: string[] };
    expect(body.events).toEqual(['alert.triggered']);
  });

  it('falls back to the default event list when the stored value is not an array', async () => {
    const { app } = await newApp();
    await app.kernel.configCenter.set('plugin:metric-history:events', 'not-an-array', {
      isSecret: false,
      category: 'plugin:metric-history',
      pluginId: 'metric-history',
    });
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: string[] };
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events).toContain('deployment.status_changed');
  });

  it('falls back to 30 days when the configured retention is not a positive number', async () => {
    const { app } = await newApp();
    await app.kernel.configCenter.set('plugin:metric-history:retention_days', -1, {
      isSecret: false,
      category: 'plugin:metric-history',
      pluginId: 'metric-history',
    });
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { retentionDays: number };
    expect(body.retentionDays).toBe(30);
  });

  it('returns the last-flush marker when it was previously written', async () => {
    const { app } = await newApp();
    await app.kernel.configCenter.set('plugin:metric-history:last_flush', {
      ts: 1700000000000,
      backend: 'builtin',
      count: 5,
    });
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { lastFlush: { ts: number; count: number } };
    expect(body.lastFlush.ts).toBe(1700000000000);
    expect(body.lastFlush.count).toBe(5);
  });

  it('falls back to a stub last-flush when the stored value is null', async () => {
    const { app } = await newApp();
    // Delete the marker so `get()` returns its default (the nullish default
    // we test the `??` fallback on by setting the value to null explicitly).
    await app.kernel.configCenter.set('plugin:metric-history:last_flush', null as never, {
      isSecret: false,
      category: 'plugin:metric-history',
      pluginId: 'metric-history',
    });
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { lastFlush: { ts: number; count: number } };
    expect(body.lastFlush).toBeDefined();
  });

  it('returns disabled=false when the enabled flag is set to false', async () => {
    const { app } = await newApp();
    await app.kernel.configCenter.set('plugin:metric-history:enabled', false, {
      isSecret: false,
      category: 'plugin:metric-history',
      pluginId: 'metric-history',
    });
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });
});

describe('POST /v1/metric-history/flush', () => {
  it('runs the built-in retention sweep and returns the deleted count', async () => {
    const { app, plugin } = await newApp();
    // Stub the plugin's runRetention so the test does not need a real DB.
    vi.spyOn(plugin, 'runRetention').mockResolvedValue(7);
    const res = await app.inject({ method: 'POST', url: '/flush', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; backend: string; deleted: number };
    expect(body).toEqual({ ok: true, backend: 'builtin', deleted: 7 });
    expect(plugin.runRetention).toHaveBeenCalledOnce();
  });

  it('r286: the instance-wide delete writes a metric.flush audit row', async () => {
    const { app, plugin } = await newApp();
    vi.spyOn(plugin, 'runRetention').mockResolvedValue(7);
    const audits = captureAudits(app.db as ReturnType<typeof createFakeDb>);
    const res = await app.inject({ method: 'POST', url: '/flush', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(audits).toEqual([expect.objectContaining({ action: 'metric.flush', meta: expect.objectContaining({ deleted: 7 }) })]);
  });

  it('emits a metric.flush.completed event with the actor user id', async () => {
    const { app, plugin } = await newApp();
    vi.spyOn(plugin, 'runRetention').mockResolvedValue(0);
    const emitSpy = vi.fn();
    app.kernel.events.emitCustom = emitSpy as never;
    const res = await app.inject({ method: 'POST', url: '/flush', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(emitSpy).toHaveBeenCalledWith(
      'metric.flush.completed',
      expect.objectContaining({ backend: 'builtin', deleted: 0 }),
    );
  });

  it('rejects unauthenticated callers', async () => {
    const { app } = await newApp();
    const res = await app.inject({ method: 'POST', url: '/flush' });
    expect(res.statusCode).toBe(401);
  });

  it('is operator-gated — a member cannot trigger instance-wide retention deletion', async () => {
    // The sweep destroys history other tenants rely on; a destructive global
    // action must not be invokable by any authenticated account.
    const { app, plugin } = await newApp();
    vi.spyOn(plugin, 'runRetention').mockResolvedValue(7);
    const res = await app.inject({
      method: 'POST',
      url: '/flush',
      headers: asUser({ id: 7, isOperator: false }),
    });
    expect(res.statusCode).toBe(403);
    expect(plugin.runRetention).not.toHaveBeenCalled();
  });

  it('returns deleted=0 when the metric-history plugin is not registered', async () => {
    // Re-create the app WITHOUT the plugin to exercise the `p ? ... : 0`
    // fallback in the flush route.
    const a = await buildTestApp();
    await a.register(metricHistoryRoutes);
    const res = await a.inject({ method: 'POST', url: '/flush', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { deleted: number };
    expect(body.deleted).toBe(0);
  });
});
