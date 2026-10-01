import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const newVersion = process.argv[2];
if (!newVersion || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(newVersion)) {
  console.error('Usage: node scripts/bump-version.js <version> (e.g. 0.2.3)');
  process.exit(1);
}

// OWNER POLICY (Ersin, 2026-09-16): NineDeploy never crosses 1.0.0 — when
// the 0.9.x line fills (0.9.99) it rolls to 0.10.0, then 0.11.0, forever.
// A major bump is a product-positioning decision, not a script accident.
const [maj] = newVersion.split('.').map(Number);
if (maj >= 1) {
  console.error('Refusing ' + newVersion + ': the project stays on the 0.x line by owner policy (0.9.99 rolls to 0.10.0, never 1.0.0).');
  process.exit(1);
}

const rootDir = process.cwd();

/** Resolve a repo-relative path and refuse anything that escapes the repo
 * root — defense-in-depth even though every caller passes a fixed literal. */
function resolveInRoot(rel) {
  const target = path.resolve(rootDir, rel);
  if (!target.startsWith(rootDir + path.sep)) {
    throw new Error(`Refusing path outside the repo root: ${rel}`);
  }
  return target;
}

// 1. All package.json files
const packageJsons = [
  'package.json',
  'apps/cli/package.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'packages/db/package.json',
  'packages/mcp/package.json',
  'packages/plugin-sdk/package.json',
  'packages/schemas/package.json',
  'packages/sdk/package.json',
  'website/package.json',
];

for (const rel of packageJsons) {
  const file = resolveInRoot(rel);
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.version = newVersion;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`✓ Updated ${rel} → ${newVersion}`);
}

// 2. Code files with hardcoded version strings
function replaceInFile(rel, regex, replacement, critical = false) {
  const file = resolveInRoot(rel);
  const content = readFileSync(file, 'utf8');
  // Report the truth instead of a green tick: a pattern that matches nothing
  // silently rots the file while this script claims it was synchronized.
  // `critical` files are load-bearing for the release (version.ts feeds the
  // panel's self-reported VERSION): a silent miss would desync the 10
  // package.jsons from the panel and ship a mislabeled image — r475 made
  // that exit 1 instead of a warning.
  if (!regex.test(content)) {
    if (critical) {
      console.error(`✗ ${rel}: pattern did not match — the panel's VERSION would stay stale. Refusing.`);
      process.exit(1);
    }
    console.warn(`⚠ ${rel}: pattern did not match anything — file left untouched`);
    return;
  }
  writeFileSync(file, content.replace(regex, replacement));
  console.log(`✓ Synchronized ${rel}`);
}

replaceInFile('apps/server/src/version.ts', /export const VERSION = '.*?';/, `export const VERSION = '${newVersion}';`, true);

// 3. Prepend a new ChangelogEntry stub so CHANGELOG[0].version === VERSION
//    (guarded by test/version.test.ts: "ABOUT links to the changelog")
function prependChangelogEntry() {
  const file = resolveInRoot('apps/server/src/version.ts');
  const content = readFileSync(file, 'utf8');
  // Idempotent: re-running the bump for the same version must not stack a
  // second stub (v0.10.0 shipped with two "Placeholder" entries on the About
  // page because the script ran more than once).
  if (content.includes(`version: '${newVersion}',`)) {
    console.log(`✓ version.ts already has a ChangelogEntry for v${newVersion} — not adding a stub`);
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const stub = `{\n    version: '${newVersion}',\n    date: '${today}',\n    title: 'Release ${newVersion}',\n    changes: [\n      'Placeholder — fill in from CHANGELOG.md before tagging',\n    ],\n  },\n`;
  // Insert BEFORE the first object in the CHANGELOG array by matching the start
  // of the array. The pattern `changes: [` is unambiguous — it appears at the
  // ChangelogEntry interface boundary, not inside the `changes` string array.
  // Using `indexOf` avoids any regex anchoring issues across OS line endings.
  const marker = 'changes: [';
  const markerPos = content.indexOf(marker);
  if (markerPos === -1) {
    console.warn('⚠ version.ts: could not find "changes: [" in version.ts — skipping CHANGELOG stub');
    return;
  }
  // Walk back to the opening `{` of the first ChangelogEntry.
  // The `{` of the first entry is always immediately before `\n    version:`.
  const beforeVersion = content.lastIndexOf('\n    version:', markerPos);
  if (beforeVersion === -1) {
    console.warn('⚠ version.ts: could not find start of first ChangelogEntry — skipping CHANGELOG stub');
    return;
  }
  const entryStart = content.lastIndexOf('{', beforeVersion);
  if (entryStart === -1) {
    console.warn('⚠ version.ts: could not find opening brace of first ChangelogEntry — skipping CHANGELOG stub');
    return;
  }
  const newContent = content.slice(0, entryStart) + stub + content.slice(entryStart);
  writeFileSync(file, newContent);
  console.log(`✓ Prepended ChangelogEntry stub for v${newVersion} to version.ts`);
}
prependChangelogEntry();

// NOTE: do NOT add a `/version: '.*?',/` rule for version.ts here — that shape
// is the ChangelogEntry literal inside the file, and rewriting its FIRST
// occurrence would relabel the newest changelog entry instead of anything
// meant to track the released version. ABOUT.version reads the VERSION
// constant, so there is nothing else to sync in that file.
// The CLI and the MCP server read their version from their own package.json
// at runtime (r195), so there is no literal to rewrite in their sources; the
// package.json bump above is what they report.
// The --version occurrences in these files are INSTALL COMMANDS users copy;
// a silent miss pins copiers to the previous release (r476: critical).
replaceInFile('apps/web/src/routes/About.tsx', /--version v\d+\.\d+\.\d+/g, `--version v${newVersion}`, true);
replaceInFile('docs/QUICKSTART.md', /--version v\d+\.\d+\.\d+/g, `--version v${newVersion}`, true);
replaceInFile('website/src/pages/Home.tsx', /<span className="tag font-bold">v\d+\.\d+\.\d+<\/span>/, `<span className="tag font-bold">v${newVersion}</span>`);
replaceInFile('website/src/components/Layout.tsx', /v\d+\.\d+\.\d+ GA/g, `v${newVersion} GA`);
replaceInFile('README.md', /Release-\d+\.\d+\.\d+-blue/, `Release-${newVersion}-blue`);
replaceInFile('README.md', /--version v\d+\.\d+\.\d+/, `--version v${newVersion}`, true);
replaceInFile('README.md', /newest release tag \(\*\*\d+\.\d+\.\d+\*\*\)/, `newest release tag (**${newVersion}**)`);

// r475 closing assertion: the banner must not print over a desync. Every
// package.json AND the panel's VERSION literal now have to say the same
// thing — a partial bump (a pattern miss above, a concurrent edit) exits 1.
const finalTs = readFileSync(resolveInRoot('apps/server/src/version.ts'), 'utf8');
const tsMatch = finalTs.match(/export const VERSION = '([^']*)';/);
if (!tsMatch || tsMatch[1] !== newVersion) {
  console.error(`✗ version.ts reports '${tsMatch ? tsMatch[1] : '?'}' after the bump (expected ${newVersion}) — refusing.`);
  process.exit(1);
}
for (const rel of packageJsons) {
  const v = JSON.parse(readFileSync(resolveInRoot(rel), 'utf8')).version;
  if (v !== newVersion) {
    console.error(`✗ ${rel} reports ${v} after the bump (expected ${newVersion}) — refusing.`);
    process.exit(1);
  }
}

console.log(`\n🎉 Successfully bumped all monorepo packages and code to v${newVersion}\n`);
