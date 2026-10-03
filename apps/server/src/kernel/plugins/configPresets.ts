import type { KernelContext, KernelPlugin } from '../types.js';

/**
 * Config Presets plugin — Sprint 3, Gap G-23 (PR-A).
 *
 * A "preset" is a named bundle of `configCenter` writes an operator can
 * apply to a fresh instance with one call. The plugin owns the schema
 * for the three on-disk shapes (`preset.list`, `preset.<id>.values`,
 * `preset.<id>.description`) and the three custom events the apply
 * flow emits, so the rest of the kernel can subscribe to a "config
 * preset was applied" signal without reaching into the module.
 *
 * Contract:
 *   - `enabled` (default `true`) is the master switch. When `false`,
 *     the schema entries are still registered (so the panel can show
 *     them) but the apply path publishes a `config.preset.disabled`
 *     event instead of doing the writes.
 *   - The plugin NEVER mutates the configCenter; the apply flow lives
 *     in `modules/configPresets.ts` and the plugin only emits events.
 *     This keeps the plugin a passive observer + schema owner — the
 *     same shape `template-bundles` and `domain-presets` use.
 *   - Every preset read goes through `configCenter.get<string[]>` /
 *     `configCenter.get<Record<string, unknown>>` so the panel can
 *     see them under the standard "Configuration Center" tab.
 *   - `destroy()` is a no-op (the plugin registers no listeners),
 *     but is implemented for symmetry with the rest of the kernel.
 */
export class ConfigPresetsPlugin implements KernelPlugin {
  readonly id = 'config-presets';
  readonly name = 'Config Presets';
  readonly version = '0.1.0';
  readonly description =
    'Stores and applies named bundles of configCenter writes so an operator can re-apply a known-good configuration to a fresh instance in one call. (G-23)';
  readonly author = 'NineDeploy Core';
  readonly icon = 'Layers';
  readonly isOfficial = true;

  readonly configSchema = [
    {
      key: 'enabled',
      type: 'boolean' as const,
      isSecret: false,
      label: 'Enable Config Presets',
      category: 'plugin:config-presets',
      defaultValue: true,
      description:
        'When enabled, the HTTP apply endpoint writes each value in the named preset to configCenter and emits a config.preset.applied event.',
      tags: ['config', 'preset', 'automation'],
    },
    {
      key: 'preset.list',
      type: 'json' as const,
      isSecret: false,
      label: 'Registered Preset Names',
      category: 'plugin:config-presets',
      defaultValue: [],
      description: 'Read-only list of preset names that have been registered via POST /v1/config-presets.',
      tags: ['config', 'preset', 'metric'],
    },
    {
      key: 'preset.namespace',
      type: 'string' as const,
      isSecret: false,
      label: 'Preset Key Namespace',
      category: 'plugin:config-presets',
      defaultValue: 'plugin:config-presets',
      description:
        'Top-level key namespace under which per-preset entries (values, description) are stored. Operators with multi-tenant deployments can scope this per workspace.',
      tags: ['config', 'preset', 'namespace'],
    },
  ];

  readonly menuItems = [
    {
      id: 'config-presets-command',
      slot: 'command:palette' as const,
      label: 'Config Presets',
      // Routes to the Config Center section, which is where the panel
      // already renders the `preset.list` / `preset.<id>.values`
      // entries this plugin owns. There is no dedicated `/settings/presets`
      // page, so the previous route was a dead link.
      route: '/settings?section=config',
      icon: 'Layers',
      order: 92,
      permission: 'admin' as const,
    },
  ];

  init(_ctx: KernelContext): void {
    // Passive plugin: the schema above is enough to make the panel render
    // the settings entries. The apply path lives in `modules/configPresets.ts`
    // and emits `config.preset.applied` / `config.preset.failed` events
    // directly; this plugin does not need to listen for anything.
  }

  destroy(): void {
    // No subscriptions to release.
  }
}
