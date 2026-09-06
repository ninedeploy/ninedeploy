import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+.*$/.test(newVersion)) {
  console.error('Usage: node scripts/bump-version.js <version> (e.g. 0.2.3)');
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
function replaceInFile(rel, regex, replacement) {
  const file = resolveInRoot(rel);
  const content = readFileSync(file, 'utf8');
  // Report the truth instead of a green tick: a pattern that matches nothing
  // silently rots the file while this script claims it was synchronized.
  if (!regex.test(content)) {
    console.warn(`⚠ ${rel}: pattern did not match anything — file left untouched`);
    return;
  }
  writeFileSync(file, content.replace(regex, replacement));
  console.log(`✓ Synchronized ${rel}`);
}

replaceInFile('apps/server/src/version.ts', /export const VERSION = '.*?';/, `export const VERSION = '${newVersion}';`);

// 3. Prepend a new ChangelogEntry stub so CHANGELOG[0].version === VERSION
//    (guarded by test/version.test.ts: "ABOUT links to the changelog")
function prependChangelogEntry() {
  const file = resolveInRoot('apps/server/src/version.ts');
  const content = readFileSync(file, 'utf8');
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
replaceInFile('apps/cli/src/index.ts', /\.version\('.*?'\)/, `.version('${newVersion}')`);
replaceInFile('packages/mcp/src/index.ts', /version: '.*?'/, `version: '${newVersion}'`);
replaceInFile('apps/web/src/routes/About.tsx', /--version v\d+\.\d+\.\d+/g, `--version v${newVersion}`);
replaceInFile('docs/QUICKSTART.md', /--version v\d+\.\d+\.\d+/g, `--version v${newVersion}`);
replaceInFile('website/src/pages/Home.tsx', /<span className="tag font-bold">v\d+\.\d+\.\d+<\/span>/, `<span className="tag font-bold">v${newVersion}</span>`);
replaceInFile('website/src/components/Layout.tsx', /v\d+\.\d+\.\d+ GA/g, `v${newVersion} GA`);
replaceInFile('README.md', /Release-\d+\.\d+\.\d+-blue/, `Release-${newVersion}-blue`);
replaceInFile('README.md', /--version v\d+\.\d+\.\d+/, `--version v${newVersion}`);
replaceInFile('README.md', /newest release tag \(\*\*\d+\.\d+\.\d+\*\*\)/, `newest release tag (**${newVersion}**)`);

console.log(`\n🎉 Successfully bumped all monorepo packages and code to v${newVersion}\n`);
