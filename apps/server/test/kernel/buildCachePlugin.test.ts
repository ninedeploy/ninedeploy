import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildCachePlugin } from '../../src/kernel/plugins/buildCachePlugin.js';
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
  registry: {
    getBuildCache: ReturnType<typeof vi.fn>;
    listBuildCaches: ReturnType<typeof vi.fn>;
  };
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
    registry: { getBuildCache: vi.fn(), listBuildCaches: vi.fn().mockReturnValue([]) },
    hooks: { tap: vi.fn(), call: vi.fn(), hasListeners: vi.fn().mockReturnValue(false), clear: vi.fn() },
    menuRegistry: { registerMenuItem: vi.fn(), unregisterMenuItem: vi.fn(), getItemsForSlot: vi.fn().mockReturnValue([]), getAllItems: vi.fn().mockReturnValue([]), getPluginMenus: vi.fn().mockReturnValue([]), purgePluginMenus: vi.fn().mockReturnValue(0) },
    db: createFakeDb(),
    state: 'READY',
    config: {},
  } as unknown as FakeKernel;
}

function withDefaultGet(kernel: FakeKernel, defaults: Record<string, unknown> = {}): FakeKernel {
  (kernel.configCenter.get as ReturnType<typeof vi.fn>).mockImplementation(
    async (key: string, def: unknown) => (key in defaults ? defaults[key] : def),
  );
  return kernel;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('BuildCachePlugin', () => {
  it('exposes a stable id, version, and isOfficial flag', () => {
    const p = new BuildCachePlugin();
    expect(p.id).toBe('build-cache');
    expect(p.isOfficial).toBe(true);
    expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('declares the backend-selection + per-backend connection keys, and one command-palette menu item', () => {
    const p = new BuildCachePlugin();
    const keys = p.configSchema?.map((c) => c.key) ?? [];
    expect(keys).toEqual([
      'enabled',
      'cache_name',
      'registry_url',
      'registry_repo',
      'registry_username',
      'registry_password',
      's3_endpoint',
      's3_region',
      's3_bucket',
      's3_access_key_id',
      's3_secret_access_key',
      's3_prefix',
    ]);
    // Credentials must be stored encrypted, never as plain config rows.
    const secrets = (p.configSchema ?? []).filter((c) => c.isSecret).map((c) => c.key);
    expect(secrets).toEqual(['registry_password', 's3_secret_access_key']);
    const item = p.menuItems?.[0];
    expect(item?.slot).toBe('command:palette');
    expect(item?.route).toBe('/settings?section=plugins');
    expect(item?.permission).toBe('admin');
  });

  it('subscribes to service.deploying + service.deployed; destroy releases them', () => {
    const kernel = newKernel();
    const p = new BuildCachePlugin();
    p.init(kernel as never);
    // Sprint 4 G-01 PR-B: the plugin also subscribes to
    // `service.deployed` for symmetry with the pre-deploy path. The
    // PR-B deploy pipeline records digests via POST /v1/build-cache/store
    // and the post-deploy listener is the hook Sprint 5's CI integration
    // will fire; the assertion is on the event names, not the call count.
    expect(kernel.events.on).toHaveBeenCalledTimes(2);
    const events = (kernel.events.on as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(events).toContain('service.deploying');
    expect(events).toContain('service.deployed');
    p.destroy();
  });

  // r034. The plugin used to answer `service.deploying` by looking up a key
  // it synthesised itself (`service:<id>:no-commit`). Nothing ever STORES
  // under that key — the builder keys by `buildCacheKey()` → `ndbuild:<hash>`
  // — so every deploy published a `build.cache.miss` that could not have been
  // anything else, and the panel's hit rate was pinned at 0% no matter how
  // well the cache was working. The real observation is published by the
  // build itself through the worker's `onBuildCacheEvent` sink.
  it('never publishes a cache hit/miss of its own on service.deploying', async () => {
    const p = new BuildCachePlugin();
    const kernel = withDefaultGet(newKernel());
    p.init(kernel as never);

    const handler = kernel.events.on.mock.calls.find((c) => c[0] === 'service.deploying')?.[1] as (
      p: unknown,
    ) => void;
    handler({ serviceId: 5 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(kernel.events.emitCustom).not.toHaveBeenCalled();
    // …and it must not have queried a backend behind the operator's back.
    expect(kernel.registry.getBuildCache).not.toHaveBeenCalled();
  });

  it('does not throw when the payload omits serviceId', async () => {
    const p = new BuildCachePlugin();
    const kernel = withDefaultGet(newKernel());
    p.init(kernel as never);
    const handler = kernel.events.on.mock.calls.find((c) => c[0] === 'service.deploying')?.[1] as (
      p: unknown,
    ) => void;
    expect(() => handler({})).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kernel.events.emitCustom).not.toHaveBeenCalled();
  });

  it('aggregateStats returns empty rows when no cache is registered', async () => {
    const kernel = newKernel();
    (kernel.registry.listBuildCaches as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const p = new BuildCachePlugin();
    const stats = await p.aggregateStats(kernel as never);
    expect(stats.backends).toEqual([]);
    expect(stats.totals).toEqual({ entries: 0, totalBytes: 0, hits: 0, misses: 0, stores: 0, evictions: 0 });
  });

  it('aggregateStats sums per-backend counters across multiple caches', async () => {
    const kernel = newKernel();
    const a = { name: 'inline', stats: vi.fn().mockResolvedValue({ entries: 1, totalBytes: 1024, hits: 2, misses: 3, stores: 4, evictions: 5 }) };
    const b = { name: 'registry', stats: vi.fn().mockResolvedValue({ entries: 2, totalBytes: 2048, hits: 3, misses: 4, stores: 5, evictions: 6 }) };
    (kernel.registry.listBuildCaches as ReturnType<typeof vi.fn>).mockReturnValue([a, b]);
    const p = new BuildCachePlugin();
    const stats = await p.aggregateStats(kernel as never);
    expect(stats.backends).toHaveLength(2);
    expect(stats.totals).toEqual({ entries: 3, totalBytes: 3072, hits: 5, misses: 7, stores: 9, evictions: 11 });
  });

});
