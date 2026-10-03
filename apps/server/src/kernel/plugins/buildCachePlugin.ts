import type { KernelContext, KernelPlugin } from '../types.js';

/**
 * Build Cache plugin — Sprint 3, Gap G-01 (PR-A).
 *
 * Owns the operator-facing configuration of the layer cache — which
 * backend is active (`inline` / `registry` / `s3`), and each backend's
 * connection settings — plus the aggregated hit/miss counters behind
 * `GET /v1/build-cache/stats`.
 *
 * It deliberately does NOT perform cache lookups of its own. The build
 * itself publishes `build.cache.hit` / `.miss` / `.error` through the sink
 * the worker passes to `runDeployment`, because only the builder knows the
 * real cache key (`lib/buildCacheKey.ts`). See the note in `init()`.
 *
 * The plugin NEVER throws — that is the same defensive pattern
 * `domain-presets`, `metric-history` and `sticky-session` use.
 *
 * Contract:
 *   - `enabled` (default `true`) is the master switch. When `false`,
 *     the listener is set up but every event short-circuits before the
 *     cache backend.
 *   - `cache_name` (default `inline`) picks which `IBuildCache` the deploy
 *     worker uses. All three backends are registered at boot
 *     (`plugins/kernel.ts`); a backend with no connection settings saved is
 *     a cold cache that always misses. Unknown / unset values fall back to
 *     the first registered cache rather than throwing.
 *   - The `registry_*` / `s3_*` keys are read lazily on every cache call, so
 *     saving them in the panel takes effect without a restart.
 *   - `destroy()` clears every subscription registered in `init()`.
 */
export class BuildCachePlugin implements KernelPlugin {
  readonly id = 'build-cache';
  readonly name = 'Build Cache';
  readonly version = '0.1.0';
  readonly description =
    'Configures the inline / registry / S3 layer cache and aggregates its hit-rate counters. (G-01)';
  readonly author = 'NineDeploy Core';
  readonly icon = 'Layers';
  readonly isOfficial = true;

  readonly configSchema = [
    {
      key: 'enabled',
      type: 'boolean' as const,
      isSecret: false,
      label: 'Enable Build Cache',
      category: 'plugin:build-cache',
      defaultValue: true,
      description: 'Master switch. When false, the plugin observes deploy:before but never queries the cache.',
      tags: ['build', 'cache'],
    },
    {
      key: 'cache_name',
      type: 'string' as const,
      isSecret: false,
      label: 'Active Cache Backend',
      category: 'plugin:build-cache',
      defaultValue: 'inline',
      description:
        'Stable name of the `IBuildCache` to use: `inline` (in-memory LRU), `registry` (OCI registry) or `s3`. Unknown / empty values fall back to the first registered cache.',
      tags: ['build', 'cache', 'backend'],
    },
    // ── registry backend ────────────────────────────────────────────────
    {
      key: 'registry_url',
      type: 'string' as const,
      isSecret: false,
      label: 'Registry Base URL',
      category: 'plugin:build-cache',
      defaultValue: '',
      description:
        'Base URL of the OCI registry backing `cache_name=registry`, e.g. https://registry.example.com. Empty = the registry backend stays cold (every lookup misses).',
      tags: ['build', 'cache', 'registry'],
    },
    {
      key: 'registry_repo',
      type: 'string' as const,
      isSecret: false,
      label: 'Registry Repository',
      category: 'plugin:build-cache',
      defaultValue: 'ninedeploy/build-cache',
      description: 'Repository namespace the cache markers are pushed under.',
      tags: ['build', 'cache', 'registry'],
    },
    {
      key: 'registry_username',
      type: 'string' as const,
      isSecret: false,
      label: 'Registry Username',
      category: 'plugin:build-cache',
      defaultValue: '',
      description: 'Basic-auth username. Leave empty for an anonymous registry.',
      tags: ['build', 'cache', 'registry', 'auth'],
    },
    {
      key: 'registry_password',
      type: 'string' as const,
      isSecret: true,
      label: 'Registry Password',
      category: 'plugin:build-cache',
      description: 'Basic-auth password / token. Only sent when a username is also set.',
      tags: ['build', 'cache', 'registry', 'secret', 'auth'],
    },
    // ── s3 backend ──────────────────────────────────────────────────────
    {
      key: 's3_endpoint',
      type: 'string' as const,
      isSecret: false,
      label: 'S3 Endpoint',
      category: 'plugin:build-cache',
      defaultValue: '',
      description:
        'S3-compatible endpoint backing `cache_name=s3`, e.g. https://s3.eu-central-1.amazonaws.com. Empty = the S3 backend stays cold.',
      tags: ['build', 'cache', 's3'],
    },
    {
      key: 's3_region',
      type: 'string' as const,
      isSecret: false,
      label: 'S3 Region',
      category: 'plugin:build-cache',
      defaultValue: 'us-east-1',
      tags: ['build', 'cache', 's3'],
    },
    {
      key: 's3_bucket',
      type: 'string' as const,
      isSecret: false,
      label: 'S3 Bucket',
      category: 'plugin:build-cache',
      defaultValue: '',
      tags: ['build', 'cache', 's3'],
    },
    {
      key: 's3_access_key_id',
      type: 'string' as const,
      isSecret: false,
      label: 'S3 Access Key ID',
      category: 'plugin:build-cache',
      defaultValue: '',
      tags: ['build', 'cache', 's3', 'auth'],
    },
    {
      key: 's3_secret_access_key',
      type: 'string' as const,
      isSecret: true,
      label: 'S3 Secret Access Key',
      category: 'plugin:build-cache',
      tags: ['build', 'cache', 's3', 'secret', 'auth'],
    },
    {
      key: 's3_prefix',
      type: 'string' as const,
      isSecret: false,
      label: 'S3 Key Prefix',
      category: 'plugin:build-cache',
      defaultValue: 'build-cache/',
      description: 'Object-key prefix so two operators can share one bucket.',
      tags: ['build', 'cache', 's3'],
    },
  ];

  readonly menuItems = [
    {
      id: 'build-cache-command',
      slot: 'command:palette' as const,
      label: 'Build Cache',
      route: '/settings?section=plugins',
      icon: 'Layers',
      order: 91,
      permission: 'admin' as const,
    },
  ];

  private unsubs: Array<() => void> = [];

  init(ctx: KernelContext): void {
    // `deploy:before` is a SYNCHRONOUS hook (see `HookDefinitions`). The
    // plugin listens with `events.on` because the cache is a firehose
    // event, not a hook — we want to observe every trigger without
    // becoming part of the build pipeline's stop-the-world checkpoints.
    // NOTE: this plugin does NOT synthesise a cache key of its own. It used
    // to answer `service.deploying` by looking up `service:<id>:no-commit`,
    // a key the build path never stores under (the builder keys by
    // `buildCacheKey()` -> `ndbuild:<hash>`), so every deploy published a
    // `build.cache.miss` that could not have been anything else. The REAL
    // hit / miss / error is published by the build itself: the worker hands
    // `runDeployment` an `onBuildCacheEvent` sink that emits
    // `build.cache.hit|miss|error` with the key the build actually consulted.
    // Keeping a second, fabricated source of the same event names is how a
    // panel ends up showing a 0% hit rate on a cache that is working.
    const unsub = ctx.events.on('service.deploying', () => {
      // Observed only to keep the subscription (and `destroy()`) symmetric
      // with `service.deployed`; the lookup that matters happens inside the
      // builder, which owns the real key.
    });
    this.unsubs.push(unsub);

    // Sprint 4 G-01 PR-B: also subscribe to the post-deploy hook so a
    // successful build can be recorded in the cache. The deploy
    // pipeline fires this with `{ serviceId, imageDigest }`; we
    // forward the digest into the active cache so the next build
    // hits.
    const postUnsub = ctx.events.on('service.deployed', (payload) => {
      const record = payload as { serviceId?: number; status?: string };
      if (record.status !== 'success') return;
      if (typeof record.serviceId !== 'number') return;
      // No digest available on the event itself in PR-B; the build
      // pipeline calls POST /v1/build-cache/store directly when the
      // BuildKit path produces a digest. This listener exists for
      // symmetry with the pre-deploy path and is the hook Sprint 5's
      // CI integration will fire.
    });
    this.unsubs.push(postUnsub);
  }

  destroy(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  /**
   * Exposed for tests + the `/v1/build-cache/stats` route. Resolves the
   * active cache per the config-center rules, then merges stats across
   * all registered caches when the operator did not pin a specific
   * one.
   */
  async aggregateStats(ctx: KernelContext): Promise<{
    backends: Array<{
      name: string;
      entries: number;
      totalBytes: number;
      hits: number;
      misses: number;
      stores: number;
      evictions: number;
    }>;
    totals: {
      entries: number;
      totalBytes: number;
      hits: number;
      misses: number;
      stores: number;
      evictions: number;
    };
  }> {
    const backends = ctx.registry.listBuildCaches();
    if (backends.length === 0) {
      return {
        backends: [],
        totals: { entries: 0, totalBytes: 0, hits: 0, misses: 0, stores: 0, evictions: 0 },
      };
    }
    const rows = await Promise.all(
      backends.map(async (b) => {
        const s = await b.stats();
        return { name: b.name, ...s };
      }),
    );
    const totals = rows.reduce(
      (acc, r) => ({
        entries: acc.entries + r.entries,
        totalBytes: acc.totalBytes + r.totalBytes,
        hits: acc.hits + r.hits,
        misses: acc.misses + r.misses,
        stores: acc.stores + r.stores,
        evictions: acc.evictions + r.evictions,
      }),
      { entries: 0, totalBytes: 0, hits: 0, misses: 0, stores: 0, evictions: 0 },
    );
    return { backends: rows, totals };
  }
}
