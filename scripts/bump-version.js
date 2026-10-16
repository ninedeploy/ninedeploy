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
// r477: shared with tag-release.js — the list has one home so an 11th
// package cannot ship at a stale version with every gate green.
import { PACKAGE_JSONS as packageJsons } from './lib/package-list.mjs';

// r573: two phases. Every rewrite below is PLANNED in memory first and only
// written once all of them are known to apply. The package.json files used to
// be rewritten before the critical-pattern checks ran, so a miss (r475/r476
// exit 1) left a half-bumped tree behind: ten manifests on the new version,
// version.ts and the install docs on the old one.
/** abs path → { rel, content, notes[] } — the staged result of every rewrite. */
const staged = new Map();
const failures = [];

function current(rel) {
  const file = resolveInRoot(rel);
  return staged.has(file) ? staged.get(file).content : readFileSync(file, 'utf8');
}

function stage(rel, content, note) {
  const file = resolveInRoot(rel);
  const entry = staged.get(file) ?? { rel, content, notes: [] };
  entry.content = content;
  entry.notes.push(note);
  staged.set(file, entry);
}

for (const rel of packageJsons) {
  const json = JSON.parse(current(rel));
  json.version = newVersion;
  stage(rel, `${JSON.stringify(json, null, 2)}\n`, `✓ Updated ${rel} → ${newVersion}`);
}

// 2. Code files with hardcoded version strings
function replaceInFile(rel, regex, replacement, critical = false) {
  const content = current(rel);
  // Report the truth instead of a green tick: a pattern that matches nothing
  // silently rots the file while this script claims it was synchronized.
  // `critical` files are load-bearing for the release (version.ts feeds the
  // panel's self-reported VERSION): a silent miss would desync the 10
  // package.jsons from the panel and ship a mislabeled image — r475 made
  // that exit 1 instead of a warning (r573: before anything is written).
  // `search`, not `test`: a /g regex's `test` is stateful (lastIndex).
  if (content.search(regex) === -1) {
    if (critical) {
      failures.push(`✗ ${rel}: pattern ${regex} did not match — the release would ship it stale.`);
      return;
    }
    console.warn(`⚠ ${rel}: pattern did not match anything — file left untouched`);
    return;
  }
  stage(rel, content.replace(regex, replacement), `✓ Synchronized ${rel}`);
}

replaceInFile('apps/server/src/version.ts', /export const VERSION = '.*?';/, `export const VERSION = '${newVersion}';`, true);

// 3. Prepend a new ChangelogEntry stub so CHANGELOG[0].version === VERSION
//    (guarded by test/version.test.ts: "ABOUT links to the changelog").
//    The entries live in apps/server/src/changelog.json (version.ts imports
//    it), so this is a JSON edit, not a source-text splice.
const CHANGELOG_JSON = 'apps/server/src/changelog.json';
function prependChangelogEntry() {
  let entries;
  try {
    entries = JSON.parse(current(CHANGELOG_JSON));
  } catch (err) {
    failures.push(`✗ ${CHANGELOG_JSON}: not readable as JSON (${String(err).split('\n')[0]}) — the release would ship without a changelog entry.`);
    return;
  }
  if (!Array.isArray(entries)) {
    failures.push(`✗ ${CHANGELOG_JSON}: expected a JSON array of changelog entries.`);
    return;
  }
  // Idempotent: re-running the bump for the same version must not stack a
  // second stub (v0.10.0 shipped with two "Placeholder" entries on the About
  // page because the script ran more than once).
  if (entries.some((e) => e && e.version === newVersion)) {
    console.log(`✓ changelog.json already has an entry for v${newVersion} — not adding a stub`);
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  entries.unshift({
    version: newVersion,
    date: today,
    title: `Release ${newVersion}`,
    changes: ['Placeholder — fill in from CHANGELOG.md before tagging'],
  });
  stage(CHANGELOG_JSON, `${JSON.stringify(entries, null, 2)}\n`, `✓ Prepended changelog stub for v${newVersion} to ${CHANGELOG_JSON}`);
}
// Only meaningful once the VERSION literal itself was found.
if (failures.length === 0) prependChangelogEntry();

// ABOUT.version reads the VERSION constant, so there is nothing else to sync
// in version.ts.
// The CLI and the MCP server read their version from their own package.json
// at runtime (r195), so there is no literal to rewrite in their sources; the
// package.json bump above is what they report.
// The --version occurrences in these files are INSTALL COMMANDS users copy;
// a silent miss pins copiers to the previous release (r476: critical).
replaceInFile('apps/web/src/routes/About.tsx', /--version v\d+\.\d+\.\d+/g, `--version v${newVersion}`, true);
replaceInFile('docs/QUICKSTART.md', /--version v\d+\.\d+\.\d+/g, `--version v${newVersion}`, true);
replaceInFile('README.md', /Release-\d+\.\d+\.\d+-blue/, `Release-${newVersion}-blue`);
replaceInFile('README.md', /--version v\d+\.\d+\.\d+/, `--version v${newVersion}`, true);
replaceInFile('README.md', /newest release tag \(\*\*\d+\.\d+\.\d+\*\*\)/, `newest release tag (**${newVersion}**)`);

if (failures.length > 0) {
  for (const f of failures) console.error(f);
  console.error('Refusing: nothing was written — fix the pattern(s) above and re-run.');
  process.exit(1);
}

// Write phase: every rewrite above applied in memory.
for (const { rel, content, notes } of staged.values()) {
  writeFileSync(resolveInRoot(rel), content);
  for (const note of notes) console.log(note);
}

// r475 closing assertion: the banner must not print over a desync. Every
// package.json AND the panel's VERSION literal now have to say the same
// thing — a partial bump (a concurrent edit, a failed write) exits 1.
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
