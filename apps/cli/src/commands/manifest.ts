/**
 * `ninedeploy manifest {init,validate,show,apply}` — the project-side CLI
 * for the `.ninedeploy` file. The first three work without server auth;
 * `apply` is wired to a panel endpoint once the server-side handler ships
 * (see docs/NINEDEPLOY_MANIFEST.md for the rollout plan).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  formatManifestYaml,
  ManifestParseError,
  ManifestValidationError,
  parseManifestYaml,
  starterManifest,
  detectProjectKind,
  type NinedeployManifest,
  type ProjectKind,
} from '@ninedeploy/sdk';
import { scanForSecrets } from '@ninedeploy/schemas';
import type { NineDeployClient } from '../client.js';
import { c, error, header, info, success } from '../lib/format.js';
import { prompt } from '../prompts.js';

const MANIFEST_FILENAMES = ['.ninedeploy', '.ninedeploy.yml', '.ninedeploy.yaml'] as const;

/** Resolve the manifest file in `cwd`, or null when none exists. */
function findManifest(cwd: string): string | null {
  for (const name of MANIFEST_FILENAMES) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ── `ninedeploy manifest init` ────────────────────────────────────────────

export async function manifestInit(cwd: string): Promise<void> {
  header('Manifest init');

  const existing = findManifest(cwd);
  if (existing) {
    error(`A manifest already exists at ${existing}. Refusing to overwrite.`);
    return;
  }

  // Detect project kind from the files in cwd.
  let kind: ProjectKind = 'unknown';
  try {
    const files = await readdir(cwd);
    kind = detectProjectKind(files);
  } catch {
    // Empty / unreadable cwd — fall through to unknown.
  }

  const detectedLabel: Record<ProjectKind, string> = {
    'node-npm': 'Node.js (npm)',
    'node-pnpm': 'Node.js (pnpm)',
    python: 'Python',
    go: 'Go',
    static: 'Static SPA (Vite)',
    unknown: 'Unknown / other',
  };
  info(`Detected project kind: ${detectedLabel[kind]}`);

  const override = await prompt(
    'Override detected kind? (node-npm | node-pnpm | python | go | static | unknown, leave empty to keep)',
    '',
  );
  const finalKind = (override.trim() || kind) as ProjectKind;

  const manifest = starterManifest(finalKind);
  const yaml = formatManifestYaml(manifest);

  // Default to `.ninedeploy`. Allow opting into the yml suffix via a hint.
  const filename = (await prompt('Filename (.ninedeploy, .ninedeploy.yml, …)', '.ninedeploy'))
    .trim() || '.ninedeploy';
  const out = resolve(cwd, filename);
  writeFileSync(out, yaml, 'utf8');

  success(`Wrote ${filename}`);
  console.log();
  console.log(c.dim(yaml.split('\n').slice(0, 12).join('\n')));
  console.log(c.dim('…'));
  console.log();
  info('Edit the file to match your project, then commit it.');
  info('Run `ninedeploy manifest validate` to check it before pushing.');
}

// ── `ninedeploy manifest validate` ────────────────────────────────────────

export function manifestValidate(cwd: string): void {
  header('Manifest validate');
  const file = findManifest(cwd);
  if (!file) {
    error(`No .ninedeploy (or .yml/.yaml) found in ${cwd}`);
    return;
  }
  const text = readFileSync(file, 'utf8');
  // Run the secret scan before schema validation: a credential-shaped
  // value in the file is more dangerous than a schema mistake (the
  // former leaks through git history; the latter only breaks the build).
  // Matches the server's loader so the CLI's verdict mirrors what the
  // deploy will do.
  const hits = scanForSecrets(text);
  if (hits.length > 0) {
    error(`Secret-pattern matches in ${file}:`);
    for (const h of hits) {
      console.log(`  ${c.yellow('•')} ${h.patternId}: ${h.description} → ${h.redacted}`);
    }
    console.log(c.dim('Move these values to the panel env vault; the manifest is committed to the repo.'));
    process.exitCode = 1;
    return;
  }
  try {
    parseManifestYaml(text);
  } catch (err) {
    if (err instanceof ManifestParseError) {
      error(`YAML parse error in ${file}:`);
      console.log(c.dim((err as ManifestParseError).message));
    } else if (err instanceof ManifestValidationError) {
      const v = err as ManifestValidationError;
      error(`Schema validation failed for ${file}:`);
      for (const issue of v.issues) {
        console.log(`  ${c.yellow('•')} ${issue.path || '<root>'}: ${issue.message}`);
      }
    } else {
      throw err;
    }
    process.exitCode = 1;
    return;
  }
  success(`Valid: ${file}`);
}

// ── `ninedeploy manifest show` ────────────────────────────────────────────

export function manifestShow(cwd: string): void {
  header('Manifest show');
  const file = findManifest(cwd);
  if (!file) {
    error(`No .ninedeploy (or .yml/.yaml) found in ${cwd}`);
    return;
  }
  const text = readFileSync(file, 'utf8');
  // Same secret scan as `validate`, but as a warning here: the operator
  // probably just wants to peek at the parsed contents, and a noisy error
  // would be more friction than the situation warrants. A non-zero
  // exitCode is still set so CI can fail the build.
  const hits = scanForSecrets(text);
  let manifest: NinedeployManifest;
  try {
    manifest = parseManifestYaml(text);
  } catch (err) {
    if (err instanceof ManifestParseError) error(`Parse error: ${(err as ManifestParseError).message}`);
    else if (err instanceof ManifestValidationError) error(`Validation failed: ${(err as ManifestValidationError).message}`);
    else throw err;
    process.exitCode = 1;
    return;
  }
  if (hits.length > 0) {
    info(`⚠️  ${hits.length} secret-pattern match${hits.length === 1 ? '' : 'es'} in ${file} (the manifest is committed to the repo):`);
    for (const h of hits) {
      console.log(`  ${c.yellow('•')} ${h.patternId}: ${h.description} → ${h.redacted}`);
    }
    process.exitCode = 1;
  }
  // Print as key/value lines for human consumption. The structured YAML
  // is also kept (file already exists on disk) — `show` is a debug aid.
  const lines: string[] = [];
  if (manifest.runtime) {
    lines.push(`runtime.type:    ${manifest.runtime.type}`);
    if (manifest.runtime.version) lines.push(`runtime.version: ${manifest.runtime.version}`);
  }
  if (manifest.build) {
    for (const [k, v] of Object.entries(manifest.build)) {
      if (v) lines.push(`build.${k.padEnd(11)} ${v}`);
    }
  }
  if (manifest.run) {
    if (manifest.run.port) lines.push(`run.port:        ${manifest.run.port}`);
    if (manifest.run.healthcheck) lines.push(`run.healthcheck: ${manifest.run.healthcheck}`);
    if (manifest.run.restart) lines.push(`run.restart:     ${manifest.run.restart}`);
  }
  if (manifest.routes) {
    lines.push(`routes:          ${manifest.routes.length} entr${manifest.routes.length === 1 ? 'y' : 'ies'}`);
    for (const r of manifest.routes) {
      lines.push(`  - ${r.host}${r.path} (ssl=${r.ssl})`);
    }
  }
  if (manifest.database) {
    lines.push(`database:        ${manifest.database.ref} → ${manifest.database.env}`);
  }
  if (manifest.alerts) {
    lines.push(`alerts:          ${manifest.alerts.length} rule${manifest.alerts.length === 1 ? '' : 's'}`);
  }
  if (manifest.notifications) {
    const total =
      manifest.notifications.onDeploy.length +
      manifest.notifications.onFailure.length +
      manifest.notifications.onAlert.length;
    if (total > 0) lines.push(`notifications:   ${total} channel ref${total === 1 ? '' : 's'}`);
  }
  if (manifest.volume?.backups) {
    lines.push(`volume.backups:  ${manifest.volume.backups.schedule} (retention=${manifest.volume.backups.retention})`);
  }
  console.log(lines.join('\n') || c.dim('(empty manifest)'));
}

// ── `ninedeploy manifest apply` ───────────────────────────────────────────

/**
 * Push a parsed `.ninedeploy` manifest to the panel and reconcile its
 * build / run / network sections into the service + build config rows.
 * Routes, alerts, and database attachments still reconcile at deploy
 * time via the pipeline (see docs/NINEDEPLOY_MANIFEST.md §6).
 *
 * The CLI runs the same secret scan as `validate` before sending the
 * body — a manifest with a literal token in it is dangerous to push
 * to the server (it lands in the audit log + DB rows), and the panel's
 * own scan only fires on the file path, not on the JSON body. Refuse
 * early with a clear error instead of round-tripping a payload we know
 * we'll reject server-side.
 */
export async function manifestApply(
  client: NineDeployClient,
  cwd: string,
  serviceId: number,
): Promise<void> {
  header('Manifest apply');
  const file = findManifest(cwd);
  if (!file) {
    error(`No .ninedeploy (or .yml/.yaml) found in ${cwd}`);
    process.exitCode = 1;
    return;
  }
  const text = readFileSync(file, 'utf8');
  const hits = scanForSecrets(text);
  if (hits.length > 0) {
    error(`Secret-pattern matches in ${file}:`);
    for (const h of hits) {
      console.log(`  ${c.yellow('•')} ${h.patternId}: ${h.description} → ${h.redacted}`);
    }
    console.log(c.dim('Move these values to the panel env vault; the manifest is committed to the repo.'));
    process.exitCode = 1;
    return;
  }
  let manifest: NinedeployManifest;
  try {
    manifest = parseManifestYaml(text);
  } catch (err) {
    if (err instanceof ManifestParseError) {
      error(`YAML parse error in ${file}:`);
      console.log(c.dim((err as ManifestParseError).message));
    } else if (err instanceof ManifestValidationError) {
      const v = err as ManifestValidationError;
      error(`Schema validation failed for ${file}:`);
      for (const issue of v.issues) {
        console.log(`  ${c.yellow('•')} ${issue.path || '<root>'}: ${issue.message}`);
      }
    } else {
      throw err;
    }
    process.exitCode = 1;
    return;
  }

  let result: Awaited<ReturnType<NineDeployClient['services']['manifest']['apply']>>;
  try {
    result = await client.services.manifest.apply(serviceId, { manifest });
  } catch (err) {
    error(`Apply failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  success(`Applied ${file} → service ${result.serviceId}`);
  if (result.touched.length === 0) {
    info('No sections changed (the manifest matched the current service + build config).');
    return;
  }
  info(`Touched: ${result.touched.join(', ')}`);
  const serviceKeys = Object.keys(result.diff.service);
  if (serviceKeys.length > 0) {
    console.log();
    console.log(c.bold('  service'));
    for (const k of serviceKeys) {
      const v = (result.diff.service as Record<string, unknown>)[k];
      console.log(`    ${k.padEnd(14)} ${formatValue(v)}`);
    }
  }
  const buildKeys = Object.keys(result.diff.build);
  if (buildKeys.length > 0) {
    console.log();
    console.log(c.bold('  build_config'));
    for (const k of buildKeys) {
      const v = (result.diff.build as Record<string, unknown>)[k];
      console.log(`    ${k.padEnd(16)} ${formatValue(v)}`);
    }
  }
}

function formatValue(v: unknown): string {
  if (v === null) return c.dim('null');
  if (v === undefined) return c.dim('(unset)');
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
