import { getStickyEnabledForService } from '../../engine/proxy.js';
import type { KernelContext, KernelPlugin } from '../types.js';

/**
 * Sticky Session plugin — Sprint 3, Gap G-28 (PR-A).
 *
 * Watches the `service.deployed` audit firehose and, when the
 * operator-enabled flag for the deployed service is on, emits a
 * `proxy.sticky_session.activated` event so the panel's audit log
 * shows the activation. The actual Traefik config is written by
 * `engine/proxy.ts:writeDynamicConfig` — which already runs on every
 * `service.deployed` — and is the only place that can attach the
 * sticky-cookie middleware to the service's routers, so the plugin
 * is intentionally passive for the I/O side and the heavy lifting
 * stays in the engine.
 *
 * Contract:
 *   - The flag lives in the settings table at
 *     `sticky_session:<serviceId>:enabled` and is read via
 *     `getStickyEnabledForService`. String `"true"` / `"1"` count
 *     as enabled, anything else is off. No schema, no migration.
 *   - The plugin NEVER throws. A failure to read the flag is
 *     reported via a `proxy.sticky_session.error` event and the
 *     audit bus is otherwise untouched — same defensive pattern
 *     `domain-presets` and `template-bundles` use.
 *   - `destroy()` clears the single `service.deployed` subscription.
 */
export class StickySessionPlugin implements KernelPlugin {
  readonly id = 'sticky-session';
  readonly name = 'Sticky Session';
  readonly version = '0.1.0';
  readonly description =
    'Routes every request to a service through the same backend container when the operator toggles sticky-session on, using a Traefik sticky-cookie middleware. (G-28)';
  readonly author = 'NineDeploy Core';
  readonly icon = 'Anchor';
  readonly isOfficial = true;

  readonly menuItems = [
    {
      id: 'sticky-session-command',
      slot: 'command:palette' as const,
      label: 'Sticky Session',
      route: '/settings/services',
      icon: 'Anchor',
      order: 95,
      permission: 'admin' as const,
    },
  ];

  private unsubs: Array<() => void> = [];

  init(ctx: KernelContext): void {
    const unsub = ctx.events.on('service.deployed', (payload) => {
      // The audit bridge fans every `service.deployed` event into here.
      // The shape mirrors `DomainEvents['service.deployed']` but the
      // plugin accepts whatever the bridge forwards and pulls out the
      // serviceId defensively so a future schema drift does not break
      // the firehose.
      const record = payload as { serviceId?: number };
      const serviceId = record.serviceId;
      if (typeof serviceId !== 'number') return;
      // Fire-and-forget — the plugin is a passive observer; a slow
      // settings read must not block the deploy pipeline.
      return this.announce(ctx, serviceId);
    });
    this.unsubs.push(unsub);
  }

  destroy(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  private async announce(ctx: KernelContext, serviceId: number): Promise<void> {
    try {
      const enabled = await getStickyEnabledForService(ctx.db, serviceId);
      if (!enabled) return;
      ctx.events.emitCustom('proxy.sticky_session.activated', {
        serviceId,
        cookieName: 'ninedeploy_sticky',
        maxAge: 86400,
        ts: new Date().toISOString(),
      });
    } catch (err) {
      ctx.events.emitCustom('proxy.sticky_session.error', {
        serviceId,
        message: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      });
    }
  }
}
