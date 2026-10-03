import type { FastifyPluginAsync } from 'fastify';
import { BuildCachePlugin } from '../kernel/plugins/buildCachePlugin.js';
import { audit } from '../lib/audit.js';

/**
 * Build Cache HTTP surface — Sprint 3, Gap G-01 (PR-A).
 *
 * Single endpoint, mounted under `/v1/build-cache` and protected by the
 * standard `app.authenticate` hook:
 *
 *   - `GET /stats` returns the per-backend counters and the merged
 *     totals. Pulls the running `BuildCachePlugin` off the kernel so we
 *     exercise the same `aggregateStats()` the deploy pipeline will use
 *     in Sprint 4 (PR #16 wires BuildKit; PR-A only proves the
 *     contract).
 *
 * The plugin is the source of truth for the counters; this module is
 * the source of truth for the HTTP shape. Splitting them keeps the
 * plugin's `init()` lifecycle free of Fastify concerns.
 */
const PLUGIN_ID = 'build-cache';

interface BackendStats {
  name: string;
  entries: number;
  totalBytes: number;
  hits: number;
  misses: number;
  stores: number;
  evictions: number;
}

interface AggregateStats {
  backends: BackendStats[];
  totals: Omit<BackendStats, 'name'>;
}

export const buildCacheRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  // Pull the running plugin off the kernel so we exercise the same
  // `aggregateStats()` the deploy pipeline will use. Falling back to a
  // fresh instance keeps the test-only `app.kernel` stub happy.
  const plugin = (): BuildCachePlugin | undefined => {
    const p = app.kernel.getPlugin(PLUGIN_ID);
    return p instanceof BuildCachePlugin ? p : undefined;
  };

  app.get('/stats', async () => {
    const p = plugin();
    const stats: AggregateStats = p
      ? await p.aggregateStats(app.kernel)
      : {
          backends: [],
          totals: { entries: 0, totalBytes: 0, hits: 0, misses: 0, stores: 0, evictions: 0 },
        };
    return stats;
  });

  /**
   * Sprint 4 G-01 PR-B: the deploy pipeline records a successful
   * build's digest here so the next build can chain. The plugin's
   * `deploy:after` hook calls this in addition to the in-process
   * `IBuildCache.store()` so an external operator (e.g. a CI runner
   * that already produced the image) can also publish a digest.
   *
   * Operator-gated: any authenticated member writing shared keys would
   * poison digests that other services' builds chain from.
   */
  app.post<{ Body: { cacheName?: string; key: string; digest: string; sizeBytes?: number } }>(
    '/store',
    { preHandler: app.requireOperator },
    async (req) => {
      const { cacheName, key, digest, sizeBytes } = req.body ?? ({} as Record<string, unknown>);
      if (typeof key !== 'string' || key.length === 0) {
        return { ok: false, error: '`key` is required' };
      }
      if (typeof digest !== 'string' || !digest.startsWith('sha256:')) {
        return { ok: false, error: '`digest` must be a sha256:hex string' };
      }
      const targetName = cacheName ?? 'inline';
      const cache = app.kernel.registry.getBuildCache(targetName);
      if (!cache) {
        return { ok: false, error: `Build cache "${targetName}" is not registered` };
      }
      const blob = Buffer.from(JSON.stringify({ digest, ts: Date.now() }));
      const ref = await cache.store(key, blob);
      // r286: a digest written here is what every later build chaining on
      // `key` trusts — record who published it.
      void audit(app.db, req.user!.id, 'buildcache.store', key, { backend: cache.name, digest: ref.digest });
      return {
        ok: true,
        backend: cache.name,
        ref: { digest: ref.digest, sizeBytes: sizeBytes ?? ref.sizeBytes, storedAt: ref.storedAt },
      };
    },
  );
};
