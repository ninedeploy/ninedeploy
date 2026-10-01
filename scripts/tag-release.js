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
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });

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

// 2. Tag must not already exist (re-tagging after a botched release is
// delete-and-recreate by hand, never a silent move).
const tagExists = sh('git', ['tag', '-l', tag]).trim();
if (tagExists === tag) {
  die(`tag ${tag} already exists — delete it explicitly first (git tag -d ${tag} && git push origin :refs/tags/${tag}).`);
}

// 3. Provenance: what the commitish ACTUALLY contains (not the working tree).
const show = (file) => sh('git', ['show', `${commitish}:${file}`]);
const pkg = JSON.parse(show('package.json')).version;
const versionTs = show('apps/server/src/version.ts');
const versionMatch = versionTs.match(/export const VERSION = '([^']*)';/);
if (!versionMatch) die(`could not read VERSION from ${commitish}:apps/server/src/version.ts`);
const changelogHead = versionTs.match(/version: '([^']*)',/);
if (pkg !== bare) die(`package.json on ${commitish} says ${pkg}, tag says ${bare}.`);
if (versionMatch[1] !== bare) die(`version.ts VERSION on ${commitish} says ${versionMatch[1]}, tag says ${bare}.`);
if (!changelogHead || changelogHead[1] !== bare) {
  die(`CHANGELOG[0].version on ${commitish} says ${changelogHead ? changelogHead[1] : '?'}, tag says ${bare} — fill the changelog entry first.`);
}
if (versionTs.includes('Placeholder')) {
  die(`version.ts on ${commitish} still carries a Placeholder stub — fill it before tagging.`);
}

// 4. The gate that would have caught the 0.10.30 escape: typecheck the exact
// tree being tagged. Uses the WORKING tree (identical, per check 1).
console.log(`Typechecking the server before tagging ${tag}…`);
try {
  sh('pnpm', ['--filter', '@ninedeploy/server', 'exec', 'tsc', '--noEmit'], { stdio: 'inherit' });
} catch {
  die('server typecheck failed — the tag would fail publish-image the same way. Fix first.');
}

sh('git', ['tag', tag, commitish], { stdio: 'inherit' });
console.log(`✓ Tagged ${tag} on ${commitish} (provenance verified). Push it: git push origin ${tag}`);
