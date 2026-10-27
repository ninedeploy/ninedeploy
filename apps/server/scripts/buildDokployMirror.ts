/**
 * G4.7: build a NineDeploy template bundle from a checked-out Dokploy
 * blueprint catalog (`Dokploy/templates`, MIT), next to the Coolify mirror
 * (`buildTemplateMirror.ts`).
 *
 * The clone is left to the operator so the tool never fetches anything:
 *
 *   git clone --depth 1 https://github.com/Dokploy/templates /tmp/dokploy-templates
 *
 *   pnpm --filter @ninedeploy/server exec tsx scripts/buildDokployMirror.ts \
 *     --src /tmp/dokploy-templates/blueprints \
 *     --out ./templates-dokploy.json
 *
 * Every blueprint either converts faithfully or is skipped with a reason
 * (`src/templates/dokployMirror.ts`). The result is validated with the
 * production registry parser before it is written. Like the Coolify mirror,
 * nothing here is runtime-verified: promote entries into the bundled registry
 * only after `scripts/smoke-template-runtime.mjs` passed for them.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { convertDokployBlueprint } from '../src/templates/dokployMirror.js';
import { parseBundle } from '../src/templates/registry.js';

function parseArgs(argv: string[]): { src: string; out: string } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const src = get('--src');
  if (!src) {
    console.error('usage: tsx scripts/buildDokployMirror.ts --src <templates/blueprints dir> [--out file.json]');
    process.exit(2);
  }
  return { src: path.resolve(src), out: path.resolve(get('--out') ?? './templates-dokploy.json') };
}

function main(): void {
  const { src, out } = parseArgs(process.argv.slice(2));
  let ids: string[];
  try {
    ids = readdirSync(src, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch (err) {
    console.error(`cannot read --src directory: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
    return;
  }

  const templates: ReturnType<typeof parseBundle> = [];
  const skips = new Map<string, number>();
  const skip = (reason: string) => skips.set(reason, (skips.get(reason) ?? 0) + 1);

  for (const id of ids) {
    const dir = path.join(src, id);
    const tomlFile = path.join(dir, 'template.toml');
    const composeFile = path.join(dir, 'docker-compose.yml');
    if (!existsSync(tomlFile) || !existsSync(composeFile)) {
      skip('no template.toml or docker-compose.yml');
      continue;
    }
    let config: unknown;
    try {
      config = parseToml(readFileSync(tomlFile, 'utf8'));
    } catch {
      skip('unparsable template.toml');
      continue;
    }
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      /* meta.json is optional: the id names the template */
    }
    const result = convertDokployBlueprint({ id, meta, config, compose: readFileSync(composeFile, 'utf8') });
    // Reasons are grouped without the blueprint-specific detail in parentheses.
    if (result.skip) skip(result.reason.replace(/ \(.*\)$/, '').replace(/'[^']*'/g, "'…'"));
    else templates.push(result.template);
  }

  // Production-parser gate: an invalid entry would poison the whole bundle.
  const validated = parseBundle({ version: 2, updated: new Date().toISOString().slice(0, 10), templates });
  if (validated.length !== templates.length) {
    console.error(`validation dropped entries (${validated.length}/${templates.length}) — refusing to write`);
    process.exit(1);
    return;
  }
  const bundle = { version: 2, updated: new Date().toISOString().slice(0, 10), templates: validated };
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o644 });

  console.log(`converted: ${templates.length} / ${ids.length} blueprints`);
  const lines = [...skips.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `  ${n}× ${r}`);
  if (lines.length > 0) console.log(`skips:\n${lines.join('\n')}`);
  console.log(`bundle written: ${out} (${bundle.templates.length} templates)`);
}

main();
