import type { FastifyPluginAsync } from 'fastify';
import { MetricHistoryPlugin } from '../kernel/plugins/metricHistory.js';
import { audit } from '../lib/audit.js';

/**
 * Metric History HTTP surface — Sprint 3, Gap G-09 (PR-A).
 *
 * Two endpoints, both mounted under `/v1/metric-history` and protected
 * by the standard `app.authenticate` hook:
 *
 *   - `GET /` returns the plugin's runtime view: the active backend,
 *     the enabled flag, the events list, the retention window, and the
 *     last-flush marker. The actual schema is owned by the plugin
 *     itself (`configSchema`); this route is just a convenience
 *     aggregator so an operator does not have to read individual
 *     `config-center` keys.
 *
 *   - `POST /flush` runs the built-in backend's retention sweep
 *     synchronously and returns the number of rows trimmed. Future
 *     PRs may add `prometheus` / `influxdb` flush semantics; today
 *     they are no-ops.
 *
 * The plugin is the source of truth for the configuration; this
 * module is the source of truth for the HTTP shape. Splitting them
 * keeps the plugin's `init()` lifecycle free of Fastify concerns and
 * mirrors the `configPresets` / `domainPresets` pattern.
 */
const PLUGIN_ID = 'metric-history';
const NS = `plugin:${PLUGIN_ID}`;

interface MetricHistoryStatus {
  enabled: boolean;
  backend: 'builtin' | 'prometheus' | 'influxdb';
  events: string[];
  retentionDays: number;
  lastFlush: { ts: number; backend: string; count: number };
}

const DEFAULT_EVENTS = [
  'deployment.status_changed',
  'service.health_changed',
  'backup.completed',
  'alert.triggered',
];

const KNOWN_BACKENDS = ['builtin', 'prometheus', 'influxdb'] as const;

function isKnownBackend(value: unknown): value is 'builtin' | 'prometheus' | 'influxdb' {
  return typeof value === 'string' && (KNOWN_BACKENDS as readonly string[]).includes(value);
}

export const metricHistoryRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  // Pull the running plugin instance off the kernel so we exercise the
  // SAME `runRetention()` the boot path uses. Falling back to a fresh
  // instance keeps the test-only `api.kernel` stub happy.
  const plugin = (): MetricHistoryPlugin | undefined => {
    const p = app.kernel.getPlugin(PLUGIN_ID);
    return p instanceof MetricHistoryPlugin ? p : undefined;
  };

  // ── GET /v1/metric-history — current configuration snapshot ────────
  app.get('/', async () => {
    const [enabled, backend, events, retention, lastFlush] = await Promise.all([
      app.kernel.configCenter.get<boolean>(`${NS}:enabled`, true),
      app.kernel.configCenter.get<string>(`${NS}:backend`, 'builtin'),
      app.kernel.configCenter.get<string[]>(`${NS}:events`, DEFAULT_EVENTS),
      app.kernel.configCenter.get<number>(`${NS}:retention_days`, 30),
      app.kernel.configCenter.get<{ ts: number; backend: string; count: number }>(
        `${NS}:last_flush`,
        { ts: 0, backend: 'builtin', count: 0 },
      ),
    ]);
    const status: MetricHistoryStatus = {
      enabled,
      backend: isKnownBackend(backend) ? backend : 'builtin',
      events: Array.isArray(events) ? events : DEFAULT_EVENTS,
      retentionDays: typeof retention === 'number' && retention > 0 ? retention : 30,
      lastFlush: lastFlush ?? { ts: 0, backend: 'builtin', count: 0 },
    };
    return status;
  });

  // ── POST /v1/metric-history/flush — run built-in retention sweep ──
  // Operator-gated: the sweep deletes rows instance-wide, a destructive
  // global action that any authenticated member must not be able to trigger.
  app.post('/flush', { preHandler: app.requireOperator }, async (req) => {
    const p = plugin();
    const deleted = p ? await p.runRetention(app.kernel) : 0;
    app.kernel.events.emitCustom('metric.flush.completed', {
      backend: 'builtin',
      deleted,
      ts: Date.now(),
      actorUserId: req.user?.id ?? null,
    });
    // r286: an instance-wide delete of metric history left no audit trail.
    void audit(app.db, req.user!.id, 'metric.flush', 'metric-history', { backend: 'builtin', deleted });
    return { ok: true, backend: 'builtin' as const, deleted };
  });
};
