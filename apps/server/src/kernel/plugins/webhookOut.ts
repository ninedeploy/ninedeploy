import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DomainEvents, KernelContext, KernelPlugin } from '../types.js';

/**
 * Outbound Webhook plugin — Sprint 1, Gap G-06.
 *
 * Posts typed kernel events to a single configured HTTPS endpoint with an
 * HMAC-SHA256 signature in `X-NineDeploy-Signature`. The shape mirrors
 * what GitHub / GitLab / Stripe / Slack expect — easy to drop a small
 * `verify()` snippet into any consumer without reading our docs.
 *
 * Contract:
 *   - `enabled` (default `true`) is the master switch. When `false`, the
 *     listener is set up but every event short-circuits before the network.
 *   - `endpoint` is the absolute URL. Empty/missing → silently skip (a
 *     misconfigured plugin must never crash the audit firehose).
 *   - `signing_secret` is the HMAC key. Missing → silently skip. The
 *     signature is `sha256=<hex>` so a consumer can verify without parsing.
 *   - `events` is a JSON array of event names to forward. Default: the
 *     two we ship support for. Anything not in the list is filtered out.
 *   - Every event subscription is registered in `init()` and released in
 *     `destroy()`; no leaks across `registerPlugin` / `unregisterPlugin`.
 *   - Network failures and non-2xx responses are surfaced as
 *     `webhook.out_error` custom events on the kernel bus so the audit
 *     pipeline picks them up too.
 */
export class WebhookOutPlugin implements KernelPlugin {
  readonly id = 'webhook-out';
  readonly name = 'Outbound Webhook';
  readonly version = '0.1.0';
  readonly description =
    'Posts kernel events (deployment status, alerts, …) to a single HMAC-signed HTTPS endpoint. (G-06)';
  readonly author = 'NineDeploy Core';
  readonly icon = 'Webhook';
  readonly isOfficial = true;

  readonly configSchema = [
    {
      key: 'enabled',
      type: 'boolean' as const,
      isSecret: false,
      label: 'Enable Outbound Webhook',
      category: 'plugin:webhook-out',
      defaultValue: true,
      description: 'Master switch. When false, the plugin observes events but never posts.',
      tags: ['webhook', 'notification'],
    },
    {
      key: 'endpoint',
      type: 'string' as const,
      isSecret: false,
      label: 'Webhook Endpoint URL',
      category: 'plugin:webhook-out',
      description: 'Absolute HTTPS URL the plugin posts events to. Empty = no-op.',
      tags: ['webhook', 'destination'],
    },
    {
      key: 'signing_secret',
      type: 'string' as const,
      isSecret: true,
      label: 'HMAC-SHA256 Signing Secret',
      category: 'plugin:webhook-out',
      description: 'Shared secret used to sign the body. The consumer verifies with the same value.',
      tags: ['webhook', 'secret', 'auth'],
    },
    {
      key: 'events',
      type: 'json' as const,
      isSecret: false,
      label: 'Forwarded Event Names',
      category: 'plugin:webhook-out',
      defaultValue: ['deployment.status_changed', 'alert.triggered'],
      description: 'JSON array of DomainEvents keys the plugin should forward.',
      tags: ['webhook', 'events'],
    },
    {
      key: 'timeout_ms',
      type: 'number' as const,
      isSecret: false,
      label: 'HTTP Timeout (ms)',
      category: 'plugin:webhook-out',
      defaultValue: 10_000,
      description: 'Per-request timeout in milliseconds.',
      tags: ['webhook', 'http'],
    },
  ];

  readonly menuItems = [
    {
      id: 'webhook-out-command',
      slot: 'command:palette' as const,
      label: 'Outbound Webhook',
      route: '/settings?section=plugins',
      icon: 'Webhook',
      order: 92,
      permission: 'admin' as const,
    },
  ];

  private unsubs: Array<() => void> = [];

  init(ctx: KernelContext): void {
    // Two typed events we ship support for. Adding more is a one-liner:
    // subscribe to the next `K extends keyof DomainEvents` and gate it on
    // the config's `events` array inside the shared dispatcher.
    const targets: Array<keyof DomainEvents> = [
      'deployment.status_changed',
      'alert.triggered',
    ];

    for (const eventName of targets) {
      const unsub = ctx.events.on(eventName, (payload) => {
        // r168: RETURN the promise so the event bus attaches its .catch. With
        // `void`, a rejected config read (e.g. SQLITE_BUSY) became an
        // unhandled rejection, and Node terminated the whole panel.
        return this.dispatch(ctx, eventName, payload);
      });
      this.unsubs.push(unsub);
    }
  }

  destroy(): void {
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
  }

  /**
   * Exposed for tests: compute the `X-NineDeploy-Signature` header value
   * for a given body and secret, so a unit test can assert the wire
   * format without re-implementing the HMAC.
   */
  static signBody(body: string, secret: string): string {
    const digest = createHmac('sha256', secret).update(body).digest('hex');
    return `sha256=${digest}`;
  }

  /**
   * Exposed for tests: verify a signature in constant time. Returns `true`
   * when the supplied hex digest matches the recomputed one.
   */
  static verifySignature(body: string, secret: string, headerValue: string): boolean {
    const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    if (headerValue.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(headerValue), Buffer.from(expected));
  }

  private async dispatch(
    ctx: KernelContext,
    eventName: keyof DomainEvents,
    payload: DomainEvents[typeof eventName],
  ): Promise<void> {
    const [enabled, endpoint, secret, events, timeoutMs] = await Promise.all([
      ctx.configCenter.get<boolean>('plugin:webhook-out:enabled', true),
      ctx.configCenter.get<string>('plugin:webhook-out:endpoint', ''),
      ctx.configCenter.getSecret('plugin:webhook-out:signing_secret'),
      ctx.configCenter.get<string[]>('plugin:webhook-out:events', [
        'deployment.status_changed',
        'alert.triggered',
      ]),
      ctx.configCenter.get<number>('plugin:webhook-out:timeout_ms', 10_000),
    ]);

    if (!enabled || !endpoint || !secret) return;
    if (!Array.isArray(events) || !events.includes(eventName)) return;

    const body = JSON.stringify({
      event: eventName,
      ts: new Date().toISOString(),
      data: payload,
    });
    const signature = WebhookOutPlugin.signBody(body, secret);

    let status: number | undefined;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ninedeploy-event': eventName,
          'x-ninedeploy-signature': signature,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
    } catch (err) {
      ctx.events.emitCustom('webhook.out_error', {
        event: eventName,
        reason: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      });
      return;
    }

    if (status < 200 || status >= 300) {
      ctx.events.emitCustom('webhook.out_error', {
        event: eventName,
        status,
        ts: new Date().toISOString(),
      });
    }
  }
}
