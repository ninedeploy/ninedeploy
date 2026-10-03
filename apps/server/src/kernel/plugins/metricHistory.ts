import { auditLog, type DB } from '@ninedeploy/db';
import { and, eq, lt } from 'drizzle-orm';
import type { DomainEvents, KernelContext, KernelPlugin } from '../types.js';

/**
 * Metric History plugin — Sprint 3, Gap G-09 (PR-A).
 *
 * Watches the kernel event firehose and writes a per-event snapshot to a
 * pluggable backend so an operator can keep a long-running history of
 * deploys, health transitions, backups, and alerts without depending on
 * NineDeploy's hot audit_log retention window. This PR ships three
 * backends:
 *
 *   • `builtin`   — every snapshot lands in the existing `audit_log`
 *                   table as a `metric.archived` row. Always available,
 *                   no extra config. The default.
 *   • `prometheus`— a stub that records a counter on a per-event basis
 *                   in-process. Exposed as a setting so a future PR can
 *                   wire it to a real pushgateway endpoint without
 *                   changing this plugin's shape.
 *   • `influxdb`  — a stub that records a counter on a per-event basis
 *                   in-process. Same upgrade path as `prometheus`.
 *
 * The plugin is intentionally minimal: it does NOT batch, retry, or
 * push over the network. PR-B will add the transport layer. PR-A's job
 * is to make the history shape and the pluggable-backend contract
 * stable so the rest of the panel can rely on the published events
 * without waiting for the wire layer.
 *
 * Contract:
 *   - `enabled` (default `true`) is the master switch. When `false`,
 *     the listener is set up but every event short-circuits before the
 *     backend.
 *   - `backend` (`builtin` | `prometheus` | `influxdb`, default
 *     `builtin`) selects which sink receives the snapshot. Unknown
 *     values fall back to `builtin` rather than throwing — a
 *     misconfigured plugin must never crash the audit firehose.
 *   - `events` is the JSON array of `DomainEvents` keys the plugin
 *     archives. Default: the four events we ship support for
 *     (`deployment.status_changed`, `service.health_changed`,
 *     `backup.completed`, `alert.triggered`). A future PR can add
 *     more without touching this file — the bus is already a typed
 *     pub/sub.
 *   - `retention_days` (default 30) only affects the `builtin` backend:
 *     a `/v1/housekeeping` pass trims rows older than the cutoff on
 *     startup. Other backends are expected to do their own retention.
 *   - Every successful archive publishes a `metric.archived` custom
 *     event so the audit pipeline picks the snapshot up. A failure is
 *     published as `metric.archive.failed` with the reason — same
 *     defensive pattern `domain-presets` and `config-presets` use.
 *   - The in-process counters for `prometheus` / `influxdb` are exposed
 *     through `count(name)` so tests (and a future /v1/metrics route)
 *     can read them without parsing configCenter.
 *   - `destroy()` clears every subscription registered in `init()`.
 */

// ─── Backend protocol ─────────────────────────────────────────────────────

/** Public shape of a metric snapshot. Stable for PR-B. */
export interface MetricSnapshot {
  /** Domain event name that produced this snapshot (e.g. "deployment.status_changed"). */
  event: keyof DomainEvents | string;
  /** Unix-millisecond timestamp at which the plugin observed the event. */
  ts: number;
  /** Opaque payload as carried by the event bus. */
  data: Record<string, unknown>;
  /** Name of the backend that accepted the snapshot (`builtin` | `prometheus` | `influxdb`). */
  backend: MetricBackendName;
}

/** Backend identifiers — the JSON-typed config field. */
export type MetricBackendName = 'builtin' | 'prometheus' | 'influxdb';

/** Strategy every backend implements. Kept tiny on purpose. */
export interface MetricBackend {
  readonly name: MetricBackendName;
  /** Persist one snapshot. Must NOT throw on transient I/O — PR-A's
   *  backends are in-process and a future network backend should swallow
   *  `fetch` errors itself and log them. */
  archive(ctx: KernelContext, snapshot: Omit<MetricSnapshot, 'backend'>): Promise<void>;
}

// ─── Built-in backend (audit_log row) ─────────────────────────────────────

class BuiltinBackend implements MetricBackend {
  readonly name: MetricBackendName = 'builtin';

  async archive(ctx: KernelContext, snapshot: Omit<MetricSnapshot, 'backend'>): Promise<void> {
    const db = ctx.db as DB;
    // No schema change — we re-use the existing `audit_log` row with a
    // dedicated `metric.archived` action and the snapshot JSON folded
    // into `meta`. Operators query it via `/v1/activity?action=metric.archived`.
    await db.insert(auditLog).values({
      userId: null,
      action: 'metric.archived',
      entity: String(snapshot.event),
      meta: {
        event: snapshot.event,
        ts: snapshot.ts,
        data: snapshot.data,
        backend: this.name,
      },
    });
  }

  /**
   * Retention sweep for the built-in rows. Mirrors the housekeeping
   * pass `plugins/housekeeping.ts` runs for plain audit rows so an
   * operator who only enables the built-in backend does not need a
   * second cron.
   */
  async prune(db: DB, retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await db
      .delete(auditLog)
      // Typed columns, not a raw sql template: audit_log.ts is INTEGER
      // unix-epoch seconds (mode 'timestamp'), and a raw Date param bypassed
      // the column mapping — it bound as non-numeric text, and SQLite's
      // INTEGER < TEXT ordering made the cutoff match EVERY row, wiping the
      // whole metric history on every boot/flush (r035). lt() goes through
      // the column mapping and binds integer seconds.
      .where(and(eq(auditLog.action, 'metric.archived'), lt(auditLog.ts, cutoff)));
    return result.rowsAffected ?? 0;
  }
}

// ─── Prometheus stub ──────────────────────────────────────────────────────

class PrometheusBackend implements MetricBackend {
  readonly name: MetricBackendName = 'prometheus';
  private readonly counters = new Map<string, number>();

  async archive(_ctx: KernelContext, snapshot: Omit<MetricSnapshot, 'backend'>): Promise<void> {
    const key = String(snapshot.event);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  /** Exposed for tests + a future `/v1/metrics` route. */
  count(name: string): number {
    return this.counters.get(name) ?? 0;
  }
}

// ─── InfluxDB stub ────────────────────────────────────────────────────────

class InfluxBackend implements MetricBackend {
  readonly name: MetricBackendName = 'influxdb';
  private readonly counters = new Map<string, number>();

  async archive(_ctx: KernelContext, snapshot: Omit<MetricSnapshot, 'backend'>): Promise<void> {
    const key = String(snapshot.event);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  /** Exposed for tests + a future `/v1/metrics` route. */
  count(name: string): number {
    return this.counters.get(name) ?? 0;
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────

export class MetricHistoryPlugin implements KernelPlugin {
  readonly id = 'metric-history';
  readonly name = 'Metric History';
  readonly version = '0.1.0';
  readonly description =
    'Archives kernel events (deploys, health changes, backups, alerts) to a pluggable backend (builtin, prometheus, influxdb) so an operator can keep a long-running history. (G-09)';
  readonly author = 'NineDeploy Core';
  readonly icon = 'LineChart';
  readonly isOfficial = true;

  readonly configSchema = [
    {
      key: 'enabled',
      type: 'boolean' as const,
      isSecret: false,
      label: 'Enable Metric History',
      category: 'plugin:metric-history',
      defaultValue: true,
      description: 'Master switch. When false, the plugin observes events but never archives.',
      tags: ['metric', 'history'],
    },
    {
      key: 'backend',
      type: 'enum' as const,
      isSecret: false,
      label: 'Archive Backend',
      category: 'plugin:metric-history',
      defaultValue: 'builtin',
      options: ['builtin', 'prometheus', 'influxdb'],
      description:
        'Which sink receives the snapshot. Unknown values fall back to `builtin` (defensive default — a misconfigured plugin must never break the audit firehose).',
      tags: ['metric', 'history', 'backend'],
    },
    {
      key: 'events',
      type: 'json' as const,
      isSecret: false,
      label: 'Archived Event Names',
      category: 'plugin:metric-history',
      defaultValue: ['deployment.status_changed', 'service.health_changed', 'backup.completed', 'alert.triggered'],
      description: 'JSON array of DomainEvents keys the plugin should archive.',
      tags: ['metric', 'history', 'events'],
    },
    {
      key: 'retention_days',
      type: 'number' as const,
      isSecret: false,
      label: 'Built-in Backend Retention (days)',
      category: 'plugin:metric-history',
      defaultValue: 30,
      description:
        'How long `builtin` snapshots stay in the audit_log table. Other backends are expected to enforce their own retention.',
      tags: ['metric', 'history', 'retention'],
    },
    {
      key: 'last_flush',
      type: 'json' as const,
      isSecret: false,
      label: 'Last Flush Snapshot',
      category: 'plugin:metric-history',
      defaultValue: { ts: 0, backend: 'builtin', count: 0 },
      description: 'Read-only timestamp + count of the most recent archive batch. Populated by the plugin; not user-editable.',
      tags: ['metric', 'history', 'diagnostic'],
    },
  ];

  readonly menuItems = [
    {
      id: 'metric-history-command',
      slot: 'command:palette' as const,
      label: 'Metric History',
      route: '/settings?section=plugins',
      icon: 'LineChart',
      order: 93,
      permission: 'admin' as const,
    },
  ];

  /** Backends are static for PR-A — the JSON `backend` setting picks one. */
  private readonly backends: Record<MetricBackendName, MetricBackend> = {
    builtin: new BuiltinBackend(),
    prometheus: new PrometheusBackend(),
    influxdb: new InfluxBackend(),
  };

  private unsubs: Array<() => void> = [];

  init(ctx: KernelContext): void {
    const targets: Array<keyof DomainEvents> = [
      'deployment.status_changed',
      'service.health_changed',
      'backup.completed',
      'alert.triggered',
    ];

    for (const eventName of targets) {
      const unsub = ctx.events.on(eventName, (payload) => {
        // Fire-and-forget — the audit bus must not block on the backend.
        return this.handle(ctx, eventName, payload);
      });
      this.unsubs.push(unsub);
    }

    // Run the built-in retention sweep once at boot so a fresh operator
    // does not have to wait for housekeeping to trim the metric rows.
    void this.runRetention(ctx).catch(() => undefined);
  }

  destroy(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  /** Exposed for tests + a future `/v1/metrics` route. */
  count(name: string, backend: MetricBackendName = 'prometheus'): number {
    const sink = this.backends[backend];
    if (sink instanceof PrometheusBackend || sink instanceof InfluxBackend) {
      return sink.count(name);
    }
    return 0;
  }

  /** Exposed for tests so the built-in prune pass can be exercised
   *  without waiting for housekeeping. */
  async runRetention(ctx: KernelContext): Promise<number> {
    const backend = this.backends.builtin;
    if (!(backend instanceof BuiltinBackend)) return 0;
    const retention = await ctx.configCenter.get<number>('plugin:metric-history:retention_days', 30);
    return backend.prune(ctx.db as DB, Math.max(1, retention));
  }

  private async handle(
    ctx: KernelContext,
    eventName: keyof DomainEvents,
    payload: DomainEvents[typeof eventName],
  ): Promise<void> {
    try {
      const [enabled, backendName, events] = await Promise.all([
        ctx.configCenter.get<boolean>('plugin:metric-history:enabled', true),
        ctx.configCenter.get<string>('plugin:metric-history:backend', 'builtin'),
        ctx.configCenter.get<string[]>('plugin:metric-history:events', [
          'deployment.status_changed',
          'service.health_changed',
          'backup.completed',
          'alert.triggered',
        ]),
      ]);

      if (!enabled) return;
      if (!Array.isArray(events) || !events.includes(eventName)) return;

      const resolved = (['builtin', 'prometheus', 'influxdb'] as MetricBackendName[]).includes(
        backendName as MetricBackendName,
      )
        ? (backendName as MetricBackendName)
        : ('builtin' as const);
      const backend = this.backends[resolved];

      const snapshot: Omit<MetricSnapshot, 'backend'> = {
        event: eventName,
        ts: Date.now(),
        data: (payload ?? {}) as Record<string, unknown>,
      };
      await backend.archive(ctx, snapshot);

      // Record the last-flush marker for operators who want to see
      // "are we still archiving?" at a glance.
      await ctx.configCenter.set('plugin:metric-history:last_flush', {
        ts: snapshot.ts,
        backend: resolved,
        count: 1,
      });

      ctx.events.emitCustom('metric.archived', {
        event: eventName,
        backend: resolved,
        ts: snapshot.ts,
      });
    } catch (err) {
      ctx.events.emitCustom('metric.archive.failed', {
        event: eventName,
        reason: err instanceof Error ? err.message : String(err),
        ts: Date.now(),
      });
    }
  }
}
