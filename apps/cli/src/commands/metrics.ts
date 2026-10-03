/**
 * `ninedeploy metrics {show,flush}` — Sprint 3, Gap G-09, PR-A.
 *
 * Operator-side view of the `metric-history` kernel plugin. The plugin
 * itself is the source of truth (it owns the schema); this module is
 * just a thin CLI surface that calls the same HTTP module the panel
 * uses, so the values an operator sees here are the same values the
 * audit pipeline writes.
 *
 *   - `show` prints the active backend, enabled flag, event list,
 *     retention window, and the last-flush marker.
 *   - `flush` runs the built-in retention sweep and reports the number
 *     of `metric.archived` rows trimmed.
 */
import type { NineDeployClient } from '../client.js';
import { error, header, info, success } from '../lib/format.js';

export interface MetricHistoryStatus {
  enabled: boolean;
  backend: 'builtin' | 'prometheus' | 'influxdb';
  events: string[];
  retentionDays: number;
  lastFlush: { ts: number; backend: string; count: number };
}

// ── `ninedeploy metrics show` ──────────────────────────────────────────────

/** Pure entry point — same shape used by the CLI action and the unit test. */
export async function metricsShow(client: NineDeployClient): Promise<MetricHistoryStatus> {
  return await client.metricHistory.get();
}

export async function metricsShowAction(client: NineDeployClient): Promise<void> {
  header('Metric history');
  let status: MetricHistoryStatus;
  try {
    status = await metricsShow(client);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  info(`Enabled:      ${status.enabled ? 'yes' : 'no'}`);
  info(`Backend:      ${status.backend}`);
  info(`Retention:    ${status.retentionDays} day(s)`);
  info(`Events:       ${status.events.join(', ') || '(none)'}`);
  const lastTs = status.lastFlush?.ts ? new Date(status.lastFlush.ts).toISOString() : 'never';
  info(`Last flush:   ${lastTs} (backend=${status.lastFlush?.backend ?? 'builtin'})`);
}

// ── `ninedeploy metrics flush` ────────────────────────────────────────────

/** Pure entry point — same shape used by the CLI action and the unit test. */
export async function metricsFlush(client: NineDeployClient): Promise<{ ok: boolean; backend: 'builtin'; deleted: number }> {
  return await client.metricHistory.flush();
}

export async function metricsFlushAction(client: NineDeployClient): Promise<void> {
  header('Metric history flush');
  let result: Awaited<ReturnType<typeof metricsFlush>>;
  try {
    result = await metricsFlush(client);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  success(`Flushed built-in backend — ${result.deleted} row(s) trimmed`);
}
