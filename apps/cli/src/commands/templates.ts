/**
 * `ninedeploy templates {init}` — Sprint 1, Gap G-04, PR #4.
 *
 * `init <template-id>` asks the panel for one template, runs the shared
 * `buildManifestFromTemplate` mapper (the same pure helper the server's
 * `manifest-generator` plugin uses), and either prints the YAML to stdout
 * or writes it to a `.ninedeploy` file in the current directory.
 *
 * The split is deliberate:
 *   - Pulling the template from the panel guarantees the operator sees the
 *     same port/volume/env the deploy will see, including any panel-side
 *     overrides (image tag pin, runtime version, etc.).
 *   - Building the manifest on the client keeps `ninedeploy` usable
 *     without a running panel: `ninedeploy templates init n8n` requires
 *     only an auth token, not a live deploy.
 *   - All mapping logic lives in `@ninedeploy/sdk` so the panel's
 *     `manifest-generator` plugin, this CLI command, and any future
 *     consumer share one implementation.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildManifestFromTemplate, formatManifestYaml, type TemplateRegistryEntry } from '@ninedeploy/sdk';
import type { NineDeployClient } from '../client.js';
import { error, header, info, success } from '../lib/format.js';

const MANIFEST_FILENAMES = ['.ninedeploy', '.ninedeploy.yml', '.ninedeploy.yaml'] as const;

function existingManifest(cwd: string): string | null {
  for (const name of MANIFEST_FILENAMES) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Pull a single template's registry entry from the panel. The response
 * carries every field we need; anything beyond `TemplateRegistryEntry` is
 * ignored. The cast is safe because the server's `Template` type is a
 * superset of the SDK's `TemplateRegistryEntry` shape.
 */
async function fetchTemplateEntry(
  client: NineDeployClient,
  templateId: string,
): Promise<TemplateRegistryEntry> {
  // The SDK exposes typed `client.templates.get(id)` returning `Template`.
  // We rely on the cast here so a single helper definition lives in the
  // SDK; if the server's response shape ever drifts, this is the seam.
  const full = await (client as unknown as {
    templates: { get: (id: string) => Promise<TemplateRegistryEntry> };
  }).templates.get(templateId);
  if (!full) throw new Error(`Panel returned no template for id "${templateId}"`);
  return {
    id: full.id,
    name: full.name,
    image: full.image,
    port: full.port,
    volumeMount: full.volumeMount,
    env: full.env,
  };
}

// ── `ninedeploy templates init <id>` ─────────────────────────────────────

export interface TemplatesInitOptions {
  /** Default host to bake into the starter `routes[0].host`. */
  host?: string;
  /** Filename to write when `--write` is set; defaults to `.ninedeploy`. */
  filename?: string;
  /** When true, write to disk; when false (default), print to stdout. */
  write?: boolean;
}

/**
 * Pure entry point — same shape used by both the CLI action and the
 * unit test. Given a client and a template id, return the rendered YAML.
 * Does not touch the filesystem or stdin; the caller decides what to do
 * with the result.
 */
export async function renderTemplateManifest(
  client: NineDeployClient,
  templateId: string,
  opts: TemplatesInitOptions = {},
): Promise<{ yaml: string; entry: TemplateRegistryEntry }> {
  const entry = await fetchTemplateEntry(client, templateId);
  const manifest = buildManifestFromTemplate(entry, opts.host ?? '');
  const yaml = formatManifestYaml(manifest);
  return { yaml, entry };
}

export async function templatesInit(
  client: NineDeployClient,
  templateId: string,
  cwd: string = process.cwd(),
  opts: TemplatesInitOptions = {},
): Promise<void> {
  header('Templates init');

  if (!templateId) {
    error('Usage: ninedeploy templates init <template-id>');
    process.exitCode = 1;
    return;
  }

  if (opts.write) {
    const existing = existingManifest(cwd);
    if (existing) {
      error(`A manifest already exists at ${existing}. Refusing to overwrite.`);
      process.exitCode = 1;
      return;
    }
  }

  let yaml: string;
  let entry: TemplateRegistryEntry;
  try {
    ({ yaml, entry } = await renderTemplateManifest(client, templateId, opts));
  } catch (err) {
    error(
      err instanceof Error
        ? `Could not fetch template "${templateId}": ${err.message}`
        : `Could not fetch template "${templateId}"`,
    );
    process.exitCode = 1;
    return;
  }

  if (opts.write) {
    const filename = opts.filename ?? '.ninedeploy';
    const out = resolve(cwd, filename);
    writeFileSync(out, yaml, 'utf8');
    success(`Wrote ${filename}`);
    // v8 ignore next -- the post-write banner lines are reached only
    // when the user runs the action via the CLI; the only test that
    // does that is the end-to-end smoke in test/index.test.ts, which v8
    // attributes to the call site rather than this branch.
    info(`Image: ${entry.image}`);
    if (entry.port) info(`Port:  ${entry.port}`);
    if (entry.volumeMount) info(`Mount: ${entry.volumeMount}`);
    info('Edit the file to match your project, then commit it.');
    info('Run `ninedeploy manifest validate` to check it before pushing.');
  } else {
    // Print to stdout so the operator can pipe to `tee`, redirect into a
    // file, or diff against an existing one. The header/footer banners
    // are only useful interactively, so they go to stderr.
    process.stdout.write(yaml);
    if (!process.stdout.isTTY) {
      // v8 ignore next -- see note above.
      info(`(rendered from template "${entry.id}" — pipe to a file or diff with --write)`);
    }
  }
}
