import type { FastifyPluginAsync } from 'fastify';
import { isBuildCacheRef, isContentDigest } from '../kernel/drivers/inlineBuildCache.js';
import { BuildCachePlugin } from '../kernel/plugins/buildCachePlugin.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';

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
   *
   * F996: the optional `ref` is the pullable `<repo>@sha256:<64 hex>` image the
   * digest belongs to. Only an entry carrying one yields `--cache-from` on the
   * next build (F864); without it the publish counts for stats only. Every
   * refusal is a 400 `{ error }` and writes nothing (was 200 `{ ok: false }`).
   */
  app.post<{ Body: { cacheName?: string; key: string; digest: string; ref?: string; sizeBytes?: number } }>(
    '/store',
    { preHandler: app.requireOperator },
    async (req) => {
      const { cacheName, key, digest, ref, sizeBytes } = req.body ?? ({} as Record<string, unknown>);
      if (typeof key !== 'string' || key.length === 0) {
        throw badRequest('`key` is required', 'invalid_key');
      }
      // F944: the drivers take only a full `sha256:<64 lowercase hex>` as a marker
      // pointer (F864); a mere `sha256:` prefix was stored as a placeholder hash
      // (inline/registry) or a marker every lookup misses (S3), reported `ok: true`.
      if (!isContentDigest(digest)) {
        throw badRequest('`digest` must be a sha256:<64 lowercase hex> content digest', 'invalid_digest');
      }
      // F996: same rule as the drivers' markerPointer, but refused instead of
      // silently dropped, so the caller learns the entry would not chain.
      if (ref !== undefined && !(isBuildCacheRef(ref) && ref.endsWith(`@${digest}`))) {
        throw badRequest('`ref` must be a <repo>@sha256:<64 hex> image reference naming `digest`', 'invalid_ref');
      }
      const targetName = cacheName ?? 'inline';
      const cache = app.kernel.registry.getBuildCache(targetName);
      if (!cache) {
        throw badRequest(`Build cache "${targetName}" is not registered`, 'unknown_build_cache');
      }
      const marker = ref === undefined ? { digest, ts: Date.now() } : { digest, ref, ts: Date.now() };
      const stored = await cache.store(key, Buffer.from(JSON.stringify(marker)));
      // r286: a digest written here is what every later build chaining on
      // `key` trusts — record who published it.
      void audit(app.db, req.user!.id, 'buildcache.store', key, {
        backend: cache.name,
        digest: stored.digest,
        ...(stored.ref ? { ref: stored.ref } : {}),
      });
      return {
        ok: true,
        backend: cache.name,
        ref: {
          digest: stored.digest,
          sizeBytes: sizeBytes ?? stored.sizeBytes,
          storedAt: stored.storedAt,
          ...(stored.ref ? { ref: stored.ref } : {}),
        },
      };
    },
  );
};
