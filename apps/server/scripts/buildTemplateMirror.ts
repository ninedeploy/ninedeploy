/**
 * Build a NineDeploy template mirror from a checked-out upstream compose
 * catalog directory.
 *
 * The network/clone step is deliberately left to the operator (git clone or a
 * release tarball) so the tool never fetches arbitrary hosts:
 *
 *   git clone --depth 1 --filter=blob:none --sparse \
 *     https://github.com/coollabsio/coolify /tmp/coolify
 *   git -C /tmp/coolify sparse-checkout set templates/compose
 *
 *   pnpm --filter @ninedeploy/server exec tsx scripts/buildTemplateMirror.ts \
 *     --src /tmp/coolify/templates/compose \
 *     --out ./templates-mirror.json
 *
 * The output bundle is drop-in for the Hub's remote template source: point
 * Settings → `templates_source` at the hosted file URL, or copy it into the
 * panel data directory. Conversion results are validated with the production
 * registry parser before anything is written.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { convertCoolifyComposeFile } from '../src/templates/mirror.js';
import { parseBundle } from '../src/templates/registry.js';

interface Args {
  src: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const src = get('--src');
  const out = get('--out') ?? './templates-mirror.json';
  if (!src) {
    console.error('usage: tsx scripts/buildTemplateMirror.ts --src <templates/compose dir> [--out file.json]');
    process.exit(2);
  }
  return { src: path.resolve(src), out: path.resolve(out) };
}

function main(): void {
  const { src, out } = parseArgs(process.argv.slice(2));

  let files: string[];
  try {
    files = readdirSync(src).filter((f) => /\.ya?ml$/i.test(f)).sort();
  } catch (err) {
    console.error(`cannot read --src directory: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
    return;
  }

  const templates: ReturnType<typeof parseBundle> = [];
  const skips = new Map<string, number>();
  const viaCounts = new Map<string, number>();

  for (const file of files) {
    const raw = readFileSync(path.join(src, file), 'utf8');
    const result = convertCoolifyComposeFile(file, raw);
    if (result.skip) {
      skips.set(result.reason, (skips.get(result.reason) ?? 0) + 1);
      continue;
    }
    templates.push(result.template);
    viaCounts.set(result.mainServiceVia, (viaCounts.get(result.mainServiceVia) ?? 0) + 1);
  }

  // Production-parser gate: an invalid entry here would poison the whole
  // remote bundle at load time, so fail the build instead.
  const validated = parseBundle({ version: 2, updated: new Date().toISOString().slice(0, 10), templates });
  if (validated.length !== templates.length) {
    console.error(`validation dropped entries (${validated.length}/${templates.length}) — refusing to write`);
    process.exit(1);
    return;
  }

  const bundle = { version: 2, updated: new Date().toISOString().slice(0, 10), templates: validated };
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o644 });

  console.log(`converted: ${templates.length} / ${files.length} upstream files`);
  console.log(`main-service heuristics: ${[...viaCounts.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
  const skipLines = [...skips.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `  ${n}× ${r}`);
  if (skipLines.length > 0) console.log(`skips:\n${skipLines.join('\n')}`);
  console.log(`bundle written: ${out} (${bundle.templates.length} templates, version ${bundle.version})`);
  console.log('serve it over HTTPS and set templates_source, or copy it into the panel data directory.');
}

main();
