import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWithBuildKit } from '../../src/engine/builders/buildkit.js';
import { InlineBuildCache } from '../../src/kernel/drivers/inlineBuildCache.js';
import { BuildCachePlugin } from '../../src/kernel/plugins/buildCachePlugin.js';
import { buildCacheKey } from '../../src/lib/buildCacheKey.js';
import { buildCacheRoutes } from '../../src/modules/buildCache.js';
import { asUser, buildTestApp, captureAudits, type createFakeDb } from '../helpers.js';

/** F944: the route accepts only the full pointer digest the drivers can store (F864). */
const DIGEST = `sha256:${'de'.repeat(32)}`;
/** F996: the pullable image reference a CI publish may attach to `DIGEST`. */
const REF = `registry.example.test/ninedeploy/web@${DIGEST}`;

// F996: the builder half of the round-trip test runs `docker buildx` through
// lib/exec - never for real here. Everything else in exec stays the original.
const exec = vi.hoisted(() => ({
  run: vi.fn(async (..._args: unknown[]): Promise<void> => {
    throw new Error('exec.run is not expected in this test');
  }),
  capture: vi.fn(async (..._args: unknown[]): Promise<string> => {
    throw new Error('exec.capture is not expected in this test');
  }),
}));
vi.mock('../../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/exec.js')>()),
  run: exec.run,
  capture: exec.capture,
}));

/** The repo's error envelope for a 400 (lib/errors.ts badRequest). */
const refused = (message: RegExp) => ({ error: { code: expect.any(String), message: expect.stringMatching(message) } });

async function newApp() {
  const a = await buildTestApp();
  const plugin = new BuildCachePlugin();
  await a.kernel.registerPlugin(plugin);
  await a.register(buildCacheRoutes);
  return { app: a, plugin };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /v1/build-cache/stats', () => {
  it('returns the merged aggregate stats from the running plugin', async () => {
    const { app, plugin } = await newApp();
    vi.spyOn(plugin, 'aggregateStats').mockResolvedValue({
      backends: [{ name: 'inline', entries: 1, totalBytes: 1024, hits: 4, misses: 6, stores: 5, evictions: 1 }],
      totals: { entries: 1, totalBytes: 1024, hits: 4, misses: 6, stores: 5, evictions: 1 },
    });
    const res = await app.inject({ method: 'GET', url: '/stats', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      backends: [{ name: 'inline', entries: 1, totalBytes: 1024, hits: 4, misses: 6, stores: 5, evictions: 1 }],
      totals: { entries: 1, totalBytes: 1024, hits: 4, misses: 6, stores: 5, evictions: 1 },
    });
    expect(plugin.aggregateStats).toHaveBeenCalledOnce();
  });

  it('returns zeroed totals when the plugin is not registered (defensive default)', async () => {
    const a = await buildTestApp();
    await a.register(buildCacheRoutes);
    const res = await a.inject({ method: 'GET', url: '/stats', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      backends: [],
      totals: { entries: 0, totalBytes: 0, hits: 0, misses: 0, stores: 0, evictions: 0 },
    });
  });

  it('rejects unauthenticated callers', async () => {
    const { app } = await newApp();
    const res = await app.inject({ method: 'GET', url: '/stats' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/build-cache/store', () => {
  it('stores a digest in the active cache and returns the BlobRef', async () => {
    const { app, plugin } = await newApp();
    // The test app's kernel has no build cache registered by default.
    // Register a fake inline driver so the route has something to call.
    const fakeCache = { name: 'inline', store: vi.fn().mockResolvedValue({
      digest: 'sha256:abc', sizeBytes: 8, storedAt: '2026-08-29T00:00:00.000Z',
    }) };
    app.kernel.registry.registerBuildCache(fakeCache as never);
    void plugin;

    const res = await app.inject({
      method: 'POST',
      url: '/store',
      headers: asUser(),
      payload: { key: 'ndbuild:abc', digest: DIGEST, sizeBytes: 4096 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; backend: string; ref: { digest: string; sizeBytes: number } };
    expect(body.ok).toBe(true);
    expect(body.backend).toBe('inline');
    expect(body.ref.sizeBytes).toBe(4096);
    expect(fakeCache.store).toHaveBeenCalledOnce();
  });

  it('r286: publishing a shared digest writes a buildcache.store audit row', async () => {
    const { app } = await newApp();
    const fakeCache = { name: 'inline', store: vi.fn().mockResolvedValue({
      digest: 'sha256:def', sizeBytes: 8, storedAt: '2026-08-29T00:00:00.000Z',
    }) };
    app.kernel.registry.registerBuildCache(fakeCache as never);
    const audits = captureAudits(app.db as ReturnType<typeof createFakeDb>);
    const res = await app.inject({
      method: 'POST',
      url: '/store',
      headers: asUser(),
      payload: { key: 'ndbuild:abc', digest: DIGEST },
    });
    expect(res.statusCode).toBe(200);
    expect(audits).toEqual([
      expect.objectContaining({ action: 'buildcache.store', entity: 'ndbuild:abc', meta: expect.objectContaining({ backend: 'inline' }) }),
    ]);
  });

  it('rejects when key is missing', async () => {
    const { app } = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/store',
      headers: asUser(),
      payload: { digest: DIGEST },
    });
    // F996: a refusal is a 400 (was 200 {ok:false}, which `curl -f` read as success).
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(refused(/key/));
  });

  it('rejects a non-sha256 digest', async () => {
    const { app } = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/store',
      headers: asUser(),
      payload: { key: 'ndbuild:abc', digest: 'md5:deadbeef' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(refused(/sha256/));
  });

  it('F996: every refusal is a 400 that neither stores nor audits', async () => {
    const { app } = await newApp();
    const cache = new InlineBuildCache();
    app.kernel.registry.registerBuildCache(cache);
    const store = vi.spyOn(cache, 'store');
    const audits = captureAudits(app.db as ReturnType<typeof createFakeDb>);
    const cases: Array<[Record<string, unknown> | undefined, RegExp]> = [
      [undefined, /key/],
      [{ key: '', digest: DIGEST }, /key/],
      [{ key: 'k', digest: 'sha256:def' }, /sha256/],
      [{ cacheName: 'nope', key: 'k', digest: DIGEST }, /not registered/],
      [{ key: 'k', digest: DIGEST, ref: `registry.example.test/ninedeploy/web@sha256:${'0'.repeat(64)}` }, /ref/],
      [{ key: 'k', digest: DIGEST, ref: `${REF},type=local,src=/` }, /ref/],
      [{ key: 'k', digest: DIGEST, ref: 'registry.example.test/ninedeploy/web:latest' }, /ref/],
      [{ key: 'k', digest: DIGEST, ref: null }, /ref/],
    ];
    for (const [payload, message] of cases) {
      const res = await app.inject({ method: 'POST', url: '/store', headers: asUser(), payload });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual(refused(message));
    }
    expect(store).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
    expect(await cache.lookup('k')).toBeNull();
  });

  it('F996: a published ref round-trips through the cache and the next build runs with --cache-from', async () => {
    const { app } = await newApp();
    const cache = new InlineBuildCache();
    app.kernel.registry.registerBuildCache(cache);
    const audits = captureAudits(app.db as ReturnType<typeof createFakeDb>);
    const build = { workDir: '/work', dockerfilePath: 'Dockerfile', baseDir: '.', commitSha: 'abc1234', serviceId: 7 };
    const key = buildCacheKey(build);
    const res = await app.inject({ method: 'POST', url: '/store', headers: asUser(), payload: { key, digest: DIGEST, ref: REF } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, backend: 'inline', ref: { digest: DIGEST, ref: REF } });
    expect(audits).toEqual([expect.objectContaining({ action: 'buildcache.store', meta: expect.objectContaining({ ref: REF }) })]);

    exec.run.mockResolvedValue(undefined);
    exec.capture.mockResolvedValue(`sha256:${'9'.repeat(64)}\n`);
    const result = await buildWithBuildKit({ ...build, target: 'ninedeploy/web:abc1234', cache, log: () => {} });
    const args = exec.run.mock.calls[0]?.[1] as string[];
    expect(result.cacheHit).toBe(true);
    expect(args[args.indexOf('--cache-from') + 1]).toBe(`type=registry,ref=${REF}`);
  });

  it('F996: omitting ref keeps the stats-only entry (no ref, no --cache-from)', async () => {
    const { app } = await newApp();
    const cache = new InlineBuildCache();
    app.kernel.registry.registerBuildCache(cache);
    const build = { workDir: '/work', dockerfilePath: 'Dockerfile', baseDir: '.', commitSha: 'def5678', serviceId: 8 };
    const key = buildCacheKey(build);
    const res = await app.inject({ method: 'POST', url: '/store', headers: asUser(), payload: { key, digest: DIGEST } });
    expect(res.statusCode).toBe(200);
    expect(Object.keys((res.json() as { ref: object }).ref).sort()).toEqual(['digest', 'sizeBytes', 'storedAt']);
    expect((await cache.lookup(key))?.ref).toBeUndefined();

    exec.run.mockResolvedValue(undefined);
    exec.capture.mockResolvedValue(`sha256:${'9'.repeat(64)}\n`);
    const result = await buildWithBuildKit({ ...build, target: 'ninedeploy/web:def5678', cache, log: () => {} });
    expect(result.cacheHit).toBe(false);
    expect(exec.run.mock.calls[0]?.[1]).not.toContain('--cache-from');
  });

  it('F944: refuses a digest the drivers cannot use as a pointer, without touching the stored entry', async () => {
    // A mere `sha256:` prefix used to be answered ok:true, audited, and stored
    // as a placeholder hash that overwrote the key's valid pointer (S3: a
    // marker every later lookup misses).
    const { app } = await newApp();
    const cache = new InlineBuildCache();
    app.kernel.registry.registerBuildCache(cache);
    const audits = captureAudits(app.db as ReturnType<typeof createFakeDb>);
    const key = 'ndbuild:f944';
    const ok = await app.inject({ method: 'POST', url: '/store', headers: asUser(), payload: { key, digest: DIGEST } });
    expect(ok.json()).toMatchObject({ ok: true, backend: 'inline', ref: { digest: DIGEST } });
    const store = vi.spyOn(cache, 'store');
    for (const digest of ['sha256:def', `sha256:${'a'.repeat(63)}`, `sha256:${'AB'.repeat(32)}`, `${DIGEST}\n`, `registry.example.test/web@${DIGEST}`]) {
      const res = await app.inject({ method: 'POST', url: '/store', headers: asUser(), payload: { key, digest } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual(refused(/sha256/));
    }
    expect(store).not.toHaveBeenCalled();
    expect((await cache.lookup(key))?.digest).toBe(DIGEST);
    expect(audits).toHaveLength(1);
  });

  it('rejects unauthenticated callers', async () => {
    const { app } = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/store',
      payload: { key: 'k', digest: 'sha256:abc' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('is operator-gated — a member cannot plant digests other builds chain from', async () => {
    // The deploy pipeline resolves the next build's cache from these keys;
    // letting any authenticated member write them poisons shared entries.
    const { app } = await newApp();
    const fakeCache = { name: 'inline', store: vi.fn().mockResolvedValue({
      digest: 'sha256:abc', sizeBytes: 8, storedAt: '2026-08-29T00:00:00.000Z',
    }) };
    app.kernel.registry.registerBuildCache(fakeCache as never);
    const res = await app.inject({
      method: 'POST',
      url: '/store',
      headers: asUser({ id: 7, isOperator: false }),
      payload: { key: 'svc:1', digest: `sha256:${'0'.repeat(64)}` },
    });
    expect(res.statusCode).toBe(403);
    expect(fakeCache.store).not.toHaveBeenCalled();
  });
});
