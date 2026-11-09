#!/usr/bin/env node
// Native macOS prerequisites and the two independent dependency graphs.
// This never starts the panel, Docker, Electron or a deployment.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSupportedNodeVersion } from './check-node-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const allowed = new Set(['--help', '--check', '--install', '--docker']);
if (args.includes('--help')) {
  console.log('Usage: node scripts/dev-macos.mjs [--check | --install] [--docker]');
  console.log('Default: check macOS, Node, pinned pnpm, Git and Xcode Command Line Tools.');
  console.log('--install: install both frozen lockfiles; build the workspace and desktop.');
  console.log('--docker: also require a reachable Linux Docker engine.');
  process.exit(0);
}
if (args.some(arg => !allowed.has(arg)) || (args.includes('--check') && args.includes('--install'))) {
  console.error('Invalid arguments. Run with --help.');
  process.exit(2);
}
if (process.platform !== 'darwin') {
  console.error('Run this setup on the Mac itself. See docs/MACOS_DEVELOPMENT.md.');
  process.exit(1);
}
if (!isSupportedNodeVersion(process.versions.node)) {
  console.error('Unsupported Node version. Install the version in .node-version, then retry.');
  process.exit(1);
}

function run(command, commandArgs, cwd = root, capture = false) {
  const result = spawnSync(command, commandArgs, { cwd, shell: false,
    stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    console.error(`Failed: ${command} ${commandArgs.join(' ')}. See docs/MACOS_DEVELOPMENT.md.`);
    process.exit(result.status && result.status > 0 ? result.status : 1);
  }
  return capture ? result.stdout.trim() : '';
}

run('git', ['--version']);
run('xcode-select', ['-p']);
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const pinnedPnpm = manifest.packageManager.replace(/^pnpm@/, '');
const actualPnpm = run('pnpm', ['--version'], root, true);
if (actualPnpm !== pinnedPnpm) {
  console.error(`Use pnpm ${pinnedPnpm} from package.json; current version is ${actualPnpm}.`);
  process.exit(1);
}
if (args.includes('--docker')) {
  const engine = run('docker', ['info', '--format', '{{.OSType}}'], root, true);
  if (engine !== 'linux') {
    console.error('The panel runtime needs a Linux Docker engine. Check the selected Docker context.');
    process.exit(1);
  }
  run('docker', ['compose', 'version']);
}
console.log(`macOS prerequisites passed (${process.arch}, Node ${process.versions.node}, pnpm ${actualPnpm}).`);
if (args.includes('--install')) {
  run('pnpm', ['install', '--frozen-lockfile']);
  run('pnpm', ['build']);
  const desktop = resolve(root, 'desktop');
  run('pnpm', ['install', '--frozen-lockfile'], desktop);
  run('pnpm', ['typecheck'], desktop);
  run('pnpm', ['test'], desktop);
  run('pnpm', ['build'], desktop);
  console.log('Dependencies and builds ready. DMG, Keychain and installed-app acceptance remain manual; see docs/MACOS_DEVELOPMENT.md.');
}
