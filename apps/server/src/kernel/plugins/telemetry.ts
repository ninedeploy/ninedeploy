import { createHmac } from 'node:crypto';
import type { KernelContext, KernelPlugin } from '../types.js';

/**
 * Telemetry & Real-Time Audit Streamer plugin.
 *
 * Two jobs:
 *
 * 1. **Local re-emit (always on).** Subscribes to the kernel event
 *    firehose via `onCustom('*', …)` and republishes each event under
 *    the typed `telemetry.recorded` channel. `telemetry.recorded` itself
 *    is filtered out so a downstream listener cannot trigger a
 *    recursion. The local channel is what the UI's "live" panel and
 *    any other in-process plugin subscribes to — it is independent of
 *    the optional remote exporter below.
 *
 * 2. **Optional remote export (when `export_endpoint` is set).** When
 *    the operator points the plugin at an OTLP / Prometheus remote-write
 *    style URL, every `telemetry.recorded` is POSTed to that URL with
 *    an HMAC-SHA256 signature in `X-NineDeploy-Signature` so the
 *    consumer can verify the body. Network and 5xx failures are
 *    surfaced as `telemetry.export.error` custom events so the audit
 *    pipeline picks them up — the firehose never throws.
 *
 * The wildcard listener ONLY emits the typed `telemetry.recorded` event
 * (no direct export call). The typed listener is the single export
 * point, so every record is exported exactly once even when a
 * non-custom producer emits `telemetry.recorded` directly.
 *
 * Contract:
 *   - This plugin owns NO retention setting. It used to declare
 *     `metrics_retention_days` (default 30) and claim the housekeeping pass
 *     read it; nothing did. The `metrics` table is deliberately a 24-hour
 *     ring trimmed by `plugins/collector.ts`, matching the 1440-minute cap
 *     that `GET /services/:id/metrics` accepts — a longer window would store
 *     rows no endpoint can return. Long-lived history is the
 *     `metric-history` plugin's job, and its `retention_days` key is real.
 *   - `export_endpoint` empty / missing → the local re-emit still
 *     works, the network call is a silent no-op.
 *   - The plugin NEVER throws. Every error path lands on
 *     `telemetry.export.error` and the audit bus is otherwise
 *     untouched.
 *   - `destroy()` clears every subscription registered in `init()`.
 */
export class TelemetryStreamerPlugin implements KernelPlugin {
  readonly id = 'telemetry-streamer';
  readonly name = 'Telemetry & Real-Time Audit Streamer';
  readonly version = '1.1.0';
  readonly description =
    'Re-emits every kernel event as a typed `telemetry.recorded` channel for the live panel, and optionally POSTs each record to a remote OTLP / Prometheus endpoint with an HMAC signature. (G-10)';
  readonly author = 'NineDeploy Core';
  readonly icon = 'Activity';
  readonly isOfficial = true;

  readonly configSchema = [
    {
      key: 'export_endpoint',
      type: 'string' as const,
      isSecret: false,
      label: 'Remote Prometheus/OTLP Endpoint',
      category: 'plugin:telemetry-streamer',
      description: 'Optional HTTP push endpoint. When set, every telemetry record is POSTed here with an HMAC signature.',
      tags: ['telemetry', 'export'],
    },
    {
      key: 'export_signing_secret',
      type: 'string' as const,
      isSecret: true,
      label: 'Export HMAC Signing Secret',
      category: 'plugin:telemetry-streamer',
      description:
        'Shared secret used to sign the export body (`X-NineDeploy-Signature: sha256=<hex>`). Empty = unsigned export.',
      tags: ['telemetry', 'export', 'secret', 'auth'],
    },
    {
      key: 'export_timeout_ms',
      type: 'number' as const,
      isSecret: false,
      label: 'Export HTTP Timeout (ms)',
      category: 'plugin:telemetry-streamer',
      defaultValue: 5_000,
      description: 'Per-request timeout for the export POST.',
      tags: ['telemetry', 'export', 'http'],
    },
  ];

  readonly menuItems = [
    {
      id: 'telemetry-streamer-command',
      slot: 'command:palette' as const,
      label: 'Telemetry Streamer',
      route: '/settings?section=config',
      icon: 'Activity',
      order: 94,
      permission: 'admin' as const,
    },
  ];

  private unsubs: Array<() => void> = [];

  init(ctx: KernelContext): void {
    // Events the plugin itself emits and events that the kernel uses
    // for bookkeeping. Re-emitting any of these as `telemetry.recorded`
    // would either loop the export path forever (a non-2xx response
    // emits `telemetry.export.error`, which would re-emit as
    // `telemetry.recorded`, which would fetch again, …) or surface
    // kernel plumbing as user-facing audit data.
    const selfOrBookkeeping = new Set<string>([
      'telemetry.recorded', // recursion guard for the local re-emit
      'telemetry.export.error', // do not loop the export on a failure
    ]);
    const internalPrefixes = ['plugin.', 'config.'];

    // 1. Local re-emit. The wildcard handler only emits the typed
    //    `telemetry.recorded` event; it does NOT call `export()` itself
    //    (the typed listener below is the single export point so the
    //    same record is never exported twice).
    const unsubWild = ctx.events.onCustom('*', (payload: unknown, eventName?: string) => {
      if (!eventName) return;
      if (selfOrBookkeeping.has(eventName)) return;
      if (internalPrefixes.some((p) => eventName.startsWith(p))) return;
      ctx.events.emit('telemetry.recorded', {
        sourceEvent: eventName,
        timestamp: new Date().toISOString(),
        data: payload,
      });
    });

    // 2. The single export point. Every `telemetry.recorded` — whether
    //    re-emitted by the wildcard handler above or produced by an
    //    external plugin that bypasses the bridge — passes through here
    //    and is POSTed to the configured endpoint (when set).
    const unsubRecorded = ctx.events.on('telemetry.recorded', (payload) => {
      return this.export(ctx, payload as { sourceEvent?: string; data?: unknown; timestamp?: string });
    });

    this.unsubs.push(unsubWild, unsubRecorded);
  }

  destroy(): void {
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
  }

  /**
   * Exposed for tests: compute the `X-NineDeploy-Signature` header
   * value for a given body and secret, so a unit test can assert the
   * wire format without re-implementing the HMAC.
   */
  static signBody(body: string, secret: string): string {
    const digest = createHmac('sha256', secret).update(body).digest('hex');
    return `sha256=${digest}`;
  }

  private async export(
    ctx: KernelContext,
    record: { sourceEvent?: string; timestamp?: string; data?: unknown },
  ): Promise<void> {
    let endpoint: string;
    let secret: string | null;
    let timeoutMs: number;
    try {
      [endpoint, secret, timeoutMs] = await Promise.all([
        ctx.configCenter.get<string>('plugin:telemetry-streamer:export_endpoint', ''),
        ctx.configCenter.getSecret('plugin:telemetry-streamer:export_signing_secret'),
        ctx.configCenter.get<number>('plugin:telemetry-streamer:export_timeout_ms', 5_000),
      ]);
    } catch (err) {
      ctx.events.emitCustom('telemetry.export.error', {
        reason: `config read failed: ${err instanceof Error ? err.message : String(err)}`,
        ts: Date.now(),
      });
      return;
    }

    if (!endpoint) return;

    const body = JSON.stringify({
      ...record,
      ts: record.timestamp ?? new Date().toISOString(),
    });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (secret) {
      headers['x-ninedeploy-signature'] = TelemetryStreamerPlugin.signBody(body, secret);
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(Math.max(100, timeoutMs)),
      });
      if (res.status < 200 || res.status >= 300) {
        ctx.events.emitCustom('telemetry.export.error', {
          endpoint,
          status: res.status,
          ts: Date.now(),
        });
      }
    } catch (err) {
      ctx.events.emitCustom('telemetry.export.error', {
        endpoint,
        reason: err instanceof Error ? err.message : String(err),
        ts: Date.now(),
      });
    }
  }
}
