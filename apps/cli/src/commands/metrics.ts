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
import { observabilityPatch, type ObservabilityPatch } from '@ninedeploy/schemas';
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

/** Infrastructure resource settings are separate from the kernel event archive above. */
export async function resourceMetricsSettingsAction(client: NineDeployClient): Promise<void> {
  try {
    const { settings, exportStatus } = await client.stats.observability.get();
    header('Resource history and metrics export');
    info('History: ' + settings.retentionDays + ' day(s)');
    info('Prometheus: ' + (settings.prometheusEnabled ? '/v1/stats/prometheus (operator bearer required)' : 'disabled'));
    info('OTLP: ' + (settings.otlpEndpoint || 'disabled'));
    info('Collector authorization: ' + (settings.hasOtlpAuthorization ? 'saved' : 'not set'));
    info('Log queue: ' + settings.logQueueMaxMb + ' MiB per destination');
    info('Last export: ' + (exportStatus.lastAttemptAt ?? 'never'));
  } catch (err) { error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; }
}

export async function resourceMetricsConfigureAction(client: NineDeployClient, opts: {
  retentionDays?: string; prometheus?: string; otlpEndpoint?: string; otlpAuthorizationEnv?: string; clearOtlpAuthorization?: boolean; logQueueMb?: string;
}): Promise<void> {
  try {
    if (opts.prometheus !== undefined && !['on', 'off'].includes(opts.prometheus)) throw new Error('--prometheus must be on or off');
    const patch: ObservabilityPatch = {};
    if (opts.retentionDays !== undefined) patch.retentionDays = Number(opts.retentionDays);
    if (opts.prometheus !== undefined) patch.prometheusEnabled = opts.prometheus === 'on';
    if (opts.otlpEndpoint !== undefined) patch.otlpEndpoint = opts.otlpEndpoint;
    if (opts.logQueueMb !== undefined) patch.logQueueMaxMb = Number(opts.logQueueMb);
    if (opts.clearOtlpAuthorization) patch.otlpAuthorization = '';
    if (opts.otlpAuthorizationEnv) {
      if (opts.clearOtlpAuthorization) throw new Error('Choose a credential environment variable or clear the saved credential');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.otlpAuthorizationEnv)) throw new Error('Invalid credential environment-variable name');
      const value = process.env[opts.otlpAuthorizationEnv];
      if (!value) throw new Error('The selected credential environment variable is empty');
      patch.otlpAuthorization = value;
    }
    const parsed = observabilityPatch.safeParse(patch);
    if (!parsed.success) throw new Error('Invalid monitoring settings: ' + parsed.error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message).join('; '));
    await client.stats.observability.update(parsed.data);
    success('Monitoring settings saved');
  } catch (err) { error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; }
}
