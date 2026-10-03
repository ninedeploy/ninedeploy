/**
 * `ninedeploy build-cache stats` — Sprint 3, Gap G-01, PR-A.
 *
 * Operator-side view of the build cache plugin. The plugin is the
 * source of truth (it owns the schema and the cache registration);
 * this module is just a thin CLI surface that calls the same HTTP
 * endpoint the panel will use, so the values an operator sees here
 * are the same values the deploy pipeline will read.
 */
import type { NineDeployClient } from '../client.js';
import { error, header, info, success } from '../lib/format.js';

export interface BuildCacheBackendStats {
  name: string;
  entries: number;
  totalBytes: number;
  hits: number;
  misses: number;
  stores: number;
  evictions: number;
}

export interface BuildCacheStats {
  backends: BuildCacheBackendStats[];
  totals: Omit<BuildCacheBackendStats, 'name'>;
}

// ── `ninedeploy build-cache stats` ────────────────────────────────────────

/** Pure entry point — same shape used by the CLI action and the unit test. */
export async function buildCacheStats(client: NineDeployClient): Promise<BuildCacheStats> {
  return await client.buildCache.stats();
}

export async function buildCacheStatsAction(client: NineDeployClient): Promise<void> {
  header('Build cache stats');
  let result: BuildCacheStats;
  try {
    result = await buildCacheStats(client);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  if (result.backends.length === 0) {
    info('No build-cache backends are registered. PR-A ships the inline driver; install one via Settings → Plugins.');
    return;
  }
  for (const b of result.backends) {
    info(`Backend: ${b.name}`);
    info(`  entries:   ${b.entries}`);
    info(`  bytes:     ${b.totalBytes}`);
    info(`  hits:      ${b.hits}`);
    info(`  misses:    ${b.misses}`);
    info(`  stores:    ${b.stores}`);
    info(`  evictions: ${b.evictions}`);
  }
  info('Totals:');
  info(`  entries:   ${result.totals.entries}`);
  info(`  bytes:     ${result.totals.totalBytes}`);
  info(`  hits:      ${result.totals.hits}`);
  info(`  misses:    ${result.totals.misses}`);
  info(`  stores:    ${result.totals.stores}`);
  info(`  evictions: ${result.totals.evictions}`);
  success(`Done. Hit rate: ${hitRate(result.totals)}%`);
}

function hitRate(t: { hits: number; misses: number }): string {
  const total = t.hits + t.misses;
  if (total === 0) return '0.0';
  return ((t.hits / total) * 100).toFixed(1);
}
