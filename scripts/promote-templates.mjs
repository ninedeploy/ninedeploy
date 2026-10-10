#!/usr/bin/env node
/**
 * Promote runtime-verified mirror templates into the bundled registry.
 *
 *   node scripts/promote-templates.mjs \
 *     --mirror=templates-mirror.json   (buildTemplateMirror.ts output)
 *     --results=smoke-results.json     (smoke-template-runtime.mjs --out=…)
 *     [--date=2026-10-10]              (verifiedAt; default: today)
 *     [--dry-run]
 *
 * Only entries that passed the smoke are added, each marked runtimeVerified
 * with the date of the run. An id the registry already has is never replaced:
 * a deployed service keeps pointing at the definition it was created from,
 * and changing one is a deliberate edit, not a bulk promotion.
 */
import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const mirrorFile = opt('mirror', null);
const resultsFile = opt('results', null);
const date = opt('date', new Date().toISOString().slice(0, 10));
const dryRun = args.includes('--dry-run');
if (!mirrorFile || !resultsFile || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  process.stderr.write('Usage: node scripts/promote-templates.mjs --mirror=bundle.json --results=results.json [--date=YYYY-MM-DD] [--dry-run]\n');
  process.exit(2);
}

const registryUrl = new URL('../apps/server/src/templates/registry.json', import.meta.url);
const rawRegistry = await readFile(registryUrl, 'utf8');
const crlf = rawRegistry.includes('\r\n');
const registry = JSON.parse(rawRegistry);
const mirror = JSON.parse(await readFile(mirrorFile, 'utf8'));
const results = JSON.parse(await readFile(resultsFile, 'utf8'));

const smokeEnv = JSON.parse(await readFile(new URL('./template-smoke-env.json', import.meta.url), 'utf8'));
const mirrorById = new Map(mirror.templates.map((t) => [t.id, t]));
const known = new Set(registry.templates.map((t) => t.id));
const added = [];
const skipped = [];
for (const result of results.results) {
  if (!result.ok) continue;
  const template = mirrorById.get(result.id);
  if (!template) {
    skipped.push(`${result.id} (not in the mirror bundle)`);
    continue;
  }
  if (known.has(template.id)) {
    skipped.push(`${result.id} (already in the registry)`);
    continue;
  }
  const { requires, ...rest } = template;
  // Values the smoke had to pin ship as the template's env defaults.
  const pinned = Object.entries(smokeEnv[template.id] ?? {}).filter(([key]) => !(rest.env ?? []).some((e) => e.key === key));
  if (pinned.length > 0) rest.env = [...(rest.env ?? []), ...pinned.map(([key, value]) => ({ key, value, secret: false }))];
  registry.templates.push({
    ...rest,
    ...(requires ? { requires: requires.replace(/\s*·\s*not runtime-verified/, '') } : {}),
    runtimeVerified: true,
    verifiedAt: date,
  });
  known.add(template.id);
  added.push(template.id);
}

process.stdout.write(`${added.length} added, ${skipped.length} skipped, registry now ${registry.templates.length}\n`);
for (const line of skipped) process.stdout.write(`  skipped ${line}\n`);
if (dryRun || added.length === 0) process.exit(0);

registry.updated = date;
const body = `${JSON.stringify(registry, null, 2)}\n`;
await writeFile(registryUrl, crlf ? body.replace(/\n/g, '\r\n') : body);
process.stdout.write('registry.json written\n');
