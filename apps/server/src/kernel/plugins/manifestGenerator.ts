import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { buildManifestFromTemplate, type TemplateRegistryEntry } from '@ninedeploy/sdk';
import type { KernelContext, KernelPlugin } from '../types.js';

// Re-export so existing server-side callers (and the unit test) can keep
// importing `buildManifestFromTemplate` from the plugin module. The SDK is
// the canonical source of the helper; the plugin only owns the kernel wiring.
export { buildManifestFromTemplate, type TemplateRegistryEntry };

/**
 * Resolve the on-disk path of the template registry. Done at module load so
 * the path is constant per process and unit tests can patch `readFile`
 * without having to mock `import.meta.url` resolution.
 */
function registryPath(): string {
  // The compiled `dist/` layout moves this file under `apps/server/dist/kernel/plugins/`,
  // so the source-relative path `../templates/registry.json` resolves from
  // `apps/server/src/kernel/plugins/`. We try the source path first, then
  // walk up to find `templates/registry.json` if the source has been bundled.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'templates', 'registry.json'),
    resolve(here, '..', '..', '..', 'templates', 'registry.json'),
    resolve(here, '..', '..', '..', '..', 'apps', 'server', 'src', 'templates', 'registry.json'),
  ];
  // Return the first candidate; the file-read failure path is reported by
  // the caller with a precise error so the operator can fix the layout.
  return candidates[0]!;
}

/**
 * Load the registry, find the template the observer just announced, and run
 * the pure mapper. Throws if the registry is unreadable or the template id
 * is missing — both are configuration mistakes the plugin should surface
 * (it does, via `manifest.generator_error`), not silently swallow.
 */
export async function loadTemplateEntry(
  templateId: string,
  readRegistry: () => Promise<{ templates: TemplateRegistryEntry[] }>,
): Promise<TemplateRegistryEntry | null> {
  const registry = await readRegistry();
  return registry.templates.find((t) => t.id === templateId) ?? null;
}

/**
 * Read the bundled template registry from disk. Exported for tests to swap
 * via `vi.mock('node:fs/promises')`; production code uses the default.
 */
export async function readBundledRegistry(): Promise<{ templates: TemplateRegistryEntry[] }> {
  const raw = await readFile(join(registryPath()), 'utf8');
  return JSON.parse(raw) as { templates: TemplateRegistryEntry[] };
}

/**
 * Manifest Generator plugin — Sprint 1, Gap G-04 (PR #2).
 *
 * Subscribes to the typed `template.bundle.observed` event emitted by the
 * `template-bundles` observer plugin, looks the template up in the bundled
 * registry, and republishes a `manifest.generated` event with the inferred
 * `.ninedeploy` manifest in its payload. File-system writing is intentionally
 * NOT in this PR — a follow-up adds an `auto_write` toggle and a writer that
 * obeys the manifest loader's secret scan before touching disk.
 *
 * Contract:
 *   - `enabled` (default `true`) gates the subscription side-effect. The
 *     plugin is still registered when off (so the schema shows up in
 *     Settings → Plugins), but no manifests are produced.
 *   - The entity format from the observer is `template:<id>`. Anything else
 *     is ignored, so the plugin is robust to future entity shapes.
 *   - The manifest mapper is the pure `buildManifestFromTemplate` helper
 *     above — tests pin that contract independently of the plugin.
 *   - All failure paths land on `manifest.generator_error`; the audit
 *     firehose is never written to.
 */
export class ManifestGeneratorPlugin implements KernelPlugin {
  readonly id = 'manifest-generator';
  readonly name = 'Template Manifest Generator';
  readonly version = '0.1.0';
  readonly description =
    'Subscribes to template.bundle.observed and publishes a typed manifest.generated event with the inferred .ninedeploy payload. (G-04 #2)';
  readonly author = 'NineDeploy Core';
  readonly icon = 'FileCode';
  readonly isOfficial = true;

  readonly configSchema = [
    {
      key: 'enabled',
      type: 'boolean' as const,
      isSecret: false,
      label: 'Enable Manifest Generator',
      category: 'plugin:manifest-generator',
      defaultValue: true,
      description: 'When enabled, the generator reacts to template.bundle.observed and emits manifest.generated.',
      tags: ['templates', 'manifests'],
    },
    {
      key: 'default_host',
      type: 'string' as const,
      isSecret: false,
      label: 'Default Route Host',
      category: 'plugin:manifest-generator',
      defaultValue: '',
      description: 'Default `routes[0].host` written into generated manifests. Empty = panel picks.',
      tags: ['templates', 'manifests', 'routing'],
    },
  ];

  readonly menuItems = [
    {
      id: 'manifest-generator-command',
      slot: 'command:palette' as const,
      label: 'Manifest Generator',
      route: '/settings?section=plugins',
      icon: 'FileCode',
      order: 91,
      permission: 'admin' as const,
    },
  ];

  private unsubs: Array<() => void> = [];

  init(ctx: KernelContext): void {
    const unsub = ctx.events.onCustom('template.bundle.observed', (payload) => {
      const observed = payload as { entity?: string | null; ts?: string };
      const entity = observed.entity ?? '';
      const match = /^template:([a-z0-9-_]+)$/.exec(entity);
      if (!match) {
        // Not a template entity. Stay quiet; other plugins may be listening.
        return;
      }
      const templateId = match[1]!;

      void Promise.all([
        ctx.configCenter.get<boolean>('plugin:manifest-generator:enabled', true),
        ctx.configCenter.get<string>('plugin:manifest-generator:default_host', ''),
      ])
        .then(async ([enabled, defaultHost]) => {
          if (!enabled) return;

          const entry = await loadTemplateEntry(templateId, readBundledRegistry);
          if (!entry) {
            ctx.events.emitCustom('manifest.generator_error', {
              templateId,
              reason: 'template id not found in bundled registry',
              ts: new Date().toISOString(),
            });
            return;
          }

          const manifest = buildManifestFromTemplate(entry, defaultHost);
          ctx.events.emitCustom('manifest.generated', {
            templateId,
            manifest,
            ts: observed.ts ?? new Date().toISOString(),
          });
        })
        .catch((err: unknown) => {
          ctx.events.emitCustom('manifest.generator_error', {
            templateId,
            reason: err instanceof Error ? err.message : String(err),
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
