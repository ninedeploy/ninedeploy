import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, createDb } from '@ninedeploy/db';
import { MetricHistoryPlugin } from '../../src/kernel/plugins/metricHistory.js';
import { createFakeDb } from '../helpers.js';

interface FakeKernel {
  events: {
    on: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    emitCustom: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    onCustom: ReturnType<typeof vi.fn>;
    listenerCount: ReturnType<typeof vi.fn>;
    removeAllListeners: ReturnType<typeof vi.fn>;
  };
  configCenter: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
  registry: { getDomainProvider: ReturnType<typeof vi.fn> };
  hooks: { tap: ReturnType<typeof vi.fn>; call: ReturnType<typeof vi.fn>; hasListeners: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> };
  menuRegistry: { registerMenuItem: ReturnType<typeof vi.fn>; unregisterMenuItem: ReturnType<typeof vi.fn>; getItemsForSlot: ReturnType<typeof vi.fn>; getAllItems: ReturnType<typeof vi.fn>; getPluginMenus: ReturnType<typeof vi.fn>; purgePluginMenus: ReturnType<typeof vi.fn> };
  db: ReturnType<typeof createFakeDb>;
  state: string;
  config: unknown;
}

function newKernel(): FakeKernel {
  return {
    events: {
      on: vi.fn().mockReturnValue(() => {}),
      emit: vi.fn(),
      emitCustom: vi.fn(),
      once: vi.fn().mockReturnValue(() => {}),
      onCustom: vi.fn().mockReturnValue(() => {}),
      listenerCount: vi.fn().mockReturnValue(0),
      removeAllListeners: vi.fn(),
    },
    configCenter: { get: vi.fn(), set: vi.fn() },
    registry: { getDomainProvider: vi.fn() },
    hooks: { tap: vi.fn(), call: vi.fn(), hasListeners: vi.fn().mockReturnValue(false), clear: vi.fn() },
    menuRegistry: { registerMenuItem: vi.fn(), unregisterMenuItem: vi.fn(), getItemsForSlot: vi.fn().mockReturnValue([]), getAllItems: vi.fn().mockReturnValue([]), getPluginMenus: vi.fn().mockReturnValue([]), purgePluginMenus: vi.fn().mockReturnValue(0) },
    db: createFakeDb(),
    state: 'READY',
    config: {},
  } as unknown as FakeKernel;
}

beforeEach(() => {
  // Default: plugin enabled, builtin backend, default event list. The
  // fake `configCenter.get` returns whatever vi.fn() resolves to
  // (undefined by default), so we install a per-test default that
  // honors the second argument — a real IConfigCenter does the same.
});

/** Wire a fake `configCenter.get` that returns the supplied default. */
function withDefaultGet(kernel: FakeKernel, defaults: Record<string, unknown> = {}): FakeKernel {
  (kernel.configCenter.get as ReturnType<typeof vi.fn>).mockImplementation(
    async (key: string, def: unknown) => (key in defaults ? defaults[key] : def),
  );
  return kernel;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('MetricHistoryPlugin', () => {
  it('exposes a stable id, version, and isOfficial flag', () => {
    const p = new MetricHistoryPlugin();
    expect(p.id).toBe('metric-history');
    expect(p.isOfficial).toBe(true);
    expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('declares a 5-key config schema and one command-palette menu item', () => {
    const p = new MetricHistoryPlugin();
    expect(p.configSchema).toHaveLength(5);
    const keys = p.configSchema?.map((c) => c.key) ?? [];
    expect(keys).toEqual(['enabled', 'backend', 'events', 'retention_days', 'last_flush']);
    const item = p.menuItems?.[0];
    expect(item?.slot).toBe('command:palette');
    expect(item?.route).toBe('/settings?section=plugins');
    expect(item?.permission).toBe('admin');
  });

  it('subscribes to the four supported kernel events; destroy releases them', () => {
    const kernel = newKernel();
    const p = new MetricHistoryPlugin();
    p.init(kernel as never);
    expect(kernel.events.on).toHaveBeenCalledTimes(4);
    const events = (kernel.events.on as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(events).toEqual([
      'deployment.status_changed',
      'service.health_changed',
      'backup.completed',
      'alert.triggered',
    ]);
    p.destroy();
  });

  it('archives a deployment.status_changed event into the audit_log table', async () => {
    const kernel = withDefaultGet(newKernel());
    const p = new MetricHistoryPlugin();
    p.init(kernel as never);
    const handler = (kernel.events.on as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (p: unknown) => void;
    handler({ status: 'success', serviceName: 'web' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // last_flush marker is updated on every successful archive
    expect(kernel.configCenter.set).toHaveBeenCalledWith(
      'plugin:metric-history:last_flush',
      expect.objectContaining({ backend: 'builtin' }),
    );
    // metric.archived event is published
    expect(kernel.events.emitCustom).toHaveBeenCalledWith(
      'metric.archived',
      expect.objectContaining({ event: 'deployment.status_changed', backend: 'builtin' }),
    );
  });

  it('is silent when the enabled flag is false', async () => {
    const kernel = withDefaultGet(newKernel(), { 'plugin:metric-history:enabled': false });
    const p = new MetricHistoryPlugin();
    p.init(kernel as never);
    const handler = (kernel.events.on as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (p: unknown) => void;
    handler({ status: 'success' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kernel.events.emitCustom).not.toHaveBeenCalled();
    expect(kernel.configCenter.set).not.toHaveBeenCalled();
  });

  it('falls back to builtin when the configured backend is unknown', async () => {
    const kernel = withDefaultGet(newKernel(), { 'plugin:metric-history:backend': 'not-a-real-backend' });
    const p = new MetricHistoryPlugin();
    p.init(kernel as never);
    const handler = (kernel.events.on as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (p: unknown) => void;
    handler({ status: 'success' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kernel.events.emitCustom).toHaveBeenCalledWith(
      'metric.archived',
      expect.objectContaining({ backend: 'builtin' }),
    );
  });

  it('increments the prometheus counter when backend=prometheus', async () => {
    const kernel = withDefaultGet(newKernel(), { 'plugin:metric-history:backend': 'prometheus' });
    const p = new MetricHistoryPlugin();
    p.init(kernel as never);
    const handler = (kernel.events.on as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (p: unknown) => void;
    handler({ status: 'success' });
    handler({ status: 'success' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.count('deployment.status_changed', 'prometheus')).toBe(2);
  });

  it('increments the influxdb counter when backend=influxdb', async () => {
    const kernel = withDefaultGet(newKernel(), { 'plugin:metric-history:backend': 'influxdb' });
    const p = new MetricHistoryPlugin();
    p.init(kernel as never);
    const handler = (kernel.events.on as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (p: unknown) => void;
    handler({ status: 'success' });
    handler({ status: 'success' });
    handler({ status: 'failed' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.count('deployment.status_changed', 'influxdb')).toBe(3);
  });

  it('count() returns 0 for the built-in backend (in-process counters only exist on stubs)', () => {
    const p = new MetricHistoryPlugin();
    // The built-in backend writes to audit_log, not to an in-process counter.
    expect(p.count('deployment.status_changed', 'builtin')).toBe(0);
  });

  it('is silent when the configured event list excludes the observed event', async () => {
    const kernel = withDefaultGet(newKernel(), { 'plugin:metric-history:events': ['alert.triggered'] });
    const p = new MetricHistoryPlugin();
    p.init(kernel as never);
    const handler = (kernel.events.on as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (p: unknown) => void;
    handler({ status: 'success' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kernel.events.emitCustom).not.toHaveBeenCalled();
  });

  it('coerces a null payload to an empty object before archiving', async () => {
    const kernel = withDefaultGet(newKernel());
    const p = new MetricHistoryPlugin();
    p.init(kernel as never);
    const handler = (kernel.events.on as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (p: unknown) => void;
    handler(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kernel.events.emitCustom).toHaveBeenCalledWith(
      'metric.archived',
      expect.objectContaining({ event: 'deployment.status_changed' }),
    );
  });

  it('emits metric.archive.failed when the backend throws', async () => {
    const kernel = withDefaultGet(newKernel());
    (kernel.configCenter.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'));
    const p = new MetricHistoryPlugin();
    p.init(kernel as never);
    const handler = (kernel.events.on as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (p: unknown) => void;
    handler({ status: 'failed' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kernel.events.emitCustom).toHaveBeenCalledWith(
      'metric.archive.failed',
      expect.objectContaining({ event: 'deployment.status_changed', reason: 'disk full' }),
    );
  });

  it('falls back to String() when a non-Error is thrown', async () => {
    const kernel = withDefaultGet(newKernel());
    (kernel.configCenter.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce('plain string');
    const p = new MetricHistoryPlugin();
    p.init(kernel as never);
    const handler = (kernel.events.on as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (p: unknown) => void;
    handler({ status: 'failed' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kernel.events.emitCustom).toHaveBeenCalledWith(
      'metric.archive.failed',
      expect.objectContaining({ event: 'deployment.status_changed', reason: 'plain string' }),
    );
  });

  it('count() returns 0 for an event that was never archived (default branch)', () => {
    const p = new MetricHistoryPlugin();
    expect(p.count('never-archived', 'prometheus')).toBe(0);
    expect(p.count('never-archived', 'influxdb')).toBe(0);
  });

  // r035 regression: prune() once bound a raw Date param inside a raw sql
  // template against the INTEGER unix-seconds audit_log.ts column. The param
  // serialized as non-numeric text, SQLite's INTEGER < TEXT ordering made the
  // cutoff match EVERY row, and every boot/flush wiped the whole metric
  // history. This test runs the real prune against a real in-memory libSQL
  // database (a fake db cannot observe driver binding semantics): exactly the
  // stale row must go; fresh and non-metric rows must survive.
  it('prunes exactly the stale metric rows — fresh and non-metric rows survive', async () => {
    const { db, client, ready } = createDb({ url: ':memory:' });
    await ready;
    await client.execute(`CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      entity TEXT,
      meta TEXT,
      ts INTEGER NOT NULL DEFAULT (unixepoch())
    )`);

    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const insertRow = (action: string, entity: string, ageMs: number) =>
      db.insert(auditLog).values({ userId: null, action, entity, meta: {}, ts: new Date(now - ageMs) });
    await insertRow('metric.archived', 'fresh', 0);
    await insertRow('metric.archived', 'stale', 40 * DAY);
    await insertRow('deployment.created', 'app', 0);

    const plugin = new MetricHistoryPlugin();
    const kernel = {
      db,
      configCenter: { get: async (_key: string, def: unknown) => def },
      events: { on: () => () => {}, emitCustom: () => {} },
    };
    const deleted = await plugin.runRetention(kernel as never);

    expect(deleted).toBe(1);
    const left = await db.select().from(auditLog);
    expect(left.map((r) => `${r.action}:${r.entity}`).sort()).toEqual([
      'deployment.created:app',
      'metric.archived:fresh',
    ]);
  });
});
