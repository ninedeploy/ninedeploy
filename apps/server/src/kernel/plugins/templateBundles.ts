import type { KernelContext, KernelPlugin } from '../types.js';

/**
 * Template Bundles plugin — Sprint 1, Gap G-04.
 *
 * Listens for `audit.recorded` events whose action is `template.install` and,
 * when the panel already knows about a per-template manifest override, republishes
 * the fact as a typed domain event (`template.bundle.observed`) on the kernel bus.
 *
 * The actual `.ninedeploy` manifest generation lives in a follow-up PR; this
 * plugin's job in this PR is to plug the observation point into the kernel
 * without taking a dependency on the wider template runtime, and to register
 * the config schema so the panel can show the toggle in Settings → Plugins.
 *
 * Contract:
 *   - `enabled` (default `true`) gates the observer. When `false`, the plugin
 *     is registered (so the menu entry and config schema remain visible) but
 *     the audit subscription returns the payload unchanged.
 *   - All other audit actions are ignored.
 *   - The plugin never mutates the audit payload; it only emits a sibling event.
 *   - `destroy()` clears every subscription registered in `init()`.
 */
export class TemplateBundlesPlugin implements KernelPlugin {
  readonly id = 'template-bundles';
  readonly name = 'Template Bundles';
  readonly version = '0.1.0';
  readonly description =
    'Watches template installs and announces per-template manifest overrides as typed domain events. (G-04)';
  readonly author = 'NineDeploy Core';
  readonly icon = 'Layers';
  readonly isOfficial = true;

  readonly configSchema = [
    {
      key: 'enabled',
      type: 'boolean' as const,
      isSecret: false,
      label: 'Enable Template Bundles Observer',
      category: 'plugin:template-bundles',
      defaultValue: true,
      description: 'When enabled, the plugin observes template.install audit events and emits template.bundle.observed.',
      tags: ['templates', 'bundles'],
    },
    {
      key: 'override_count',
      type: 'number' as const,
      isSecret: false,
      label: 'Currently Registered Overrides',
      category: 'plugin:template-bundles',
      defaultValue: 0,
      description:
        'Read-only counter: the number of template installs this observer has republished as `template.bundle.observed` since the counter was last reset.',
      tags: ['templates', 'bundles', 'metric'],
    },
  ];

  readonly menuItems = [
    {
      id: 'template-bundles-command',
      slot: 'command:palette' as const,
      label: 'Template Bundles',
      route: '/settings?section=plugins',
      icon: 'Layers',
      order: 90,
      permission: 'admin' as const,
    },
  ];

  private unsubs: Array<() => void> = [];

  init(ctx: KernelContext): void {
    // Subscribe to the audit firehose (bridged from lib/events.ts). We only care
    // about template installs; everything else passes through untouched.
    const unsub = ctx.events.on('audit.recorded', (payload) => {
      const record = payload as {
        action?: string;
        entity?: string | null;
        actorUserId?: number | null;
        ts?: string;
      };

      if (record.action !== 'template.install') {
        return;
      }

      // Read the enabled toggle from the config center. We do not await it: the
      // observer is a firehose consumer, so it must not block the audit path.
      // The default (`true`) is what we apply when the config row is absent.
      void ctx.configCenter
        .get<boolean>('plugin:template-bundles:enabled', true)
        .then((enabled) => {
          if (!enabled) {
            return;
          }
          // Re-emit as a typed, plugin-friendly event. The downstream
          // manifest-generator (added in a follow-up PR) listens here.
          ctx.events.emitCustom('template.bundle.observed', {
            action: record.action,
            entity: record.entity,
            actorUserId: record.actorUserId ?? null,
            ts: record.ts ?? new Date().toISOString(),
          });
          // `override_count` describes itself in the panel as "updated by the
          // observer when an override is matched" — and nothing ever wrote it,
          // so the counter an operator reads was permanently 0 no matter how
          // many templates they installed. Persisting it here is what makes
          // the number the schema advertises mean something.
          return ctx.configCenter
            .get<number>('plugin:template-bundles:override_count', 0)
            .then((current) =>
              ctx.configCenter.set(
                'plugin:template-bundles:override_count',
                (typeof current === 'number' && Number.isFinite(current) ? current : 0) + 1,
              ),
            );
        })
        .catch((err: unknown) => {
          // A config read failure must not crash the audit bus. The error is
          // surfaced through the kernel logger so the operator can see it in
          // the same place as every other kernel warning.
          ctx.events.emitCustom('template.bundle.observer_error', {
            message: err instanceof Error ? err.message : String(err),
            ts: new Date().toISOString(),
          });
        });
    });

    this.unsubs.push(unsub);
  }

  destroy(): void {
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
  }
}
