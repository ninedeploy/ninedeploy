#!/usr/bin/env node
// r475: the tag gate. `git tag vX <commit>` is typed by hand at the end of a
// long release drill, and nothing compared the tag's VALUE to what the
// checkout contains — the 0.10.30 round shipped an unparseable version.ts
// because the last edit landed AFTER release:check, and a mistyped/stale tag
// would publish a mislabeled image (the CI-side provenance step in
// release-publish.yml is the outer guard; this is the local one that saves
// the 15-21 minute round trip).
//
// Usage: pnpm release:tag vX.Y.Z [commit]   (commit defaults to HEAD)
//
// Refuses unless: clean working tree; the tag, every package.json, the
// panel's VERSION literal and CHANGELOG[0] all agree; no Placeholder stub
// survives; the tag does not already exist; and `tsc --noEmit` passes on the
// server (the exact step an unescaped-apostrophe version.ts fails).

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
// On Windows `pnpm` is a .cmd shim, which execFileSync cannot spawn without a
// shell (Node >= 18 EINVALs). The args are static constants — no injection
// surface — so shelling out on win32 only is safe.
const pnpm = (args, opts = {}) =>
  sh('pnpm', args, { shell: process.platform === 'win32', ...opts });

const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const tag = process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  die(`usage: pnpm release:tag vX.Y.Z [commit] — got '${tag ?? ''}'`);
}
const commitish = process.argv[3] ?? 'HEAD';
const bare = tag.slice(1);

// 1. Clean tree — a tag over uncommitted edits is a coin flip.
const status = sh('git', ['status', '--porcelain']);
if (status.trim() !== '') {
  die('working tree is not clean — commit or stash first; a tag must name exactly what was checked.');
}

// r476: the compile/test gates below certify the WORKING tree, so the
// commitish MUST be HEAD — tagging an older SHA would run the gates against
// the wrong tree (false pass AND false block). Check out what you mean.
const head = sh('git', ['rev-parse', 'HEAD']).trim();
let target = '';
try {
  target = sh('git', ['rev-parse', `${commitish}^{commit}`]).trim();
} catch (err) {
  die(`could not resolve commitish '${commitish}' — is it a valid ref? (${String(err).slice(0, 120)})`);
}
if (target !== head) {
  die(`commitish ${commitish} is not HEAD — check out the commit first so the gates certify the tree being tagged.`);
}

// 2. Tag must not already exist (re-tagging after a botched release is
// delete-and-recreate by hand, never a silent move).
const tagExists = sh('git', ['tag', '-l', tag]).trim();
if (tagExists === tag) {
  die(`tag ${tag} already exists — delete it explicitly first (git tag -d ${tag} && git push origin :refs/tags/${tag}).`);
}

// 3. Provenance: what the commit actually contains (== HEAD, per check 1).
const show = (file) => {
  try {
    return sh('git', ['show', `${commitish}:${file}`]);
  } catch (err) {
    die(`could not read ${file} on '${commitish}' — (${String(err).split('\n')[0]}…)`);
  }
};
// r476: ALL TEN package.jsons, not just the root — the workspace packages are
// what packages:publish ships; a partial revert must not slip through.
import { PACKAGE_JSONS as packageJsons } from './lib/package-list.mjs';for (const rel of packageJsons) {
  const v = JSON.parse(show(rel)).version;
  if (v !== bare) die(`${rel} on ${commitish} says ${v}, tag says ${bare}.`);
}
const versionTs = show('apps/server/src/version.ts');
const versionMatch = versionTs.match(/export const VERSION = '([^']*)';/);
if (!versionMatch) die(`could not read VERSION from ${commitish}:apps/server/src/version.ts`);
const changelogHead = versionTs.match(/version: '([^']*)',/);
if (versionMatch[1] !== bare) die(`version.ts VERSION on ${commitish} says ${versionMatch[1]}, tag says ${bare}.`);
if (!changelogHead || changelogHead[1] !== bare) {
  die(`CHANGELOG[0].version on ${commitish} says ${changelogHead ? changelogHead[1] : '?'}, tag says ${bare} — fill the changelog entry first.`);
}
if (versionTs.includes('Placeholder')) {
  die(`version.ts on ${commitish} still carries a Placeholder stub — fill it before tagging.`);
}

// 4. The gates that would have caught the 0.10.30 escape: typecheck (an
// unescaped-apostrophe changelog fails compile) AND the version test (whose
// placeholder/duplicate guard once caught a release note that quoted the
// word "Placeholder" — prose the compile step is blind to). Uses the WORKING
// tree (identical, per check 1).
console.log(`Typechecking the server before tagging ${tag}…`);
try {
  pnpm(['--filter', '@ninedeploy/server', 'exec', 'tsc', '--noEmit'], { stdio: 'inherit' });
} catch {
  die('server typecheck failed — the tag would fail publish-image the same way. Fix first.');
}
console.log('Running the version invariants test…');
try {
  pnpm(['--filter', '@ninedeploy/server', 'exec', 'vitest', 'run', 'test/version.test.ts'], { stdio: 'inherit' });
} catch {
  die('test/version.test.ts failed — fill the changelog entry properly before tagging.');
}

sh('git', ['tag', tag, commitish], { stdio: 'inherit' });
console.log(`✓ Tagged ${tag} on ${commitish} (provenance verified). Push it: git push origin ${tag}`);
