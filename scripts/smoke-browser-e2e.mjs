#!/usr/bin/env node
// S7 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): browser journeys on the
// PUBLISHED image, driven through the real web panel with Playwright (e2e/).
// The API-level loop is scripts/smoke-user-journey.mjs; this proves the same
// product through the screens a person uses: the setup form (setup-token link,
// Let's Encrypt box left unticked), the deploy wizard, the Turkish locale, and
// every visited page at phone width (no overflow, no console errors, no API
// 4xx/5xx).
//
// The panel, its Docker-in-Docker daemon, and a read-only Git HTTP server
// share a disposable network. Only the panel is published, on loopback.
// NINEDEPLOY_PUBLIC_URL matches that browser origin. Cleanup targets the
// containers, network, volume, and Git directory created by this run.
//
// Usage:
//   pnpm --dir e2e install && pnpm --dir e2e exec playwright install chromium
//   node scripts/smoke-browser-e2e.mjs [--image=...] [--keep] [-- <playwright args>]
// --keep leaves the containers running and prints the panel URL (debugging).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSwarmGitRepository, gitHttpServerCode } from './lib/smoke-git-repository.mjs';

const repoVersion = /export const VERSION = '([^']*)';/.exec(
  readFileSync(new URL('../apps/server/src/version.ts', import.meta.url), 'utf8'),
)?.[1];
const IMAGE = process.argv.find((a) => a.startsWith('--image='))?.slice('--image='.length)
  ?? `ghcr.io/ninedeploy/ninedeploy:v${repoVersion}`;
const KEEP = process.argv.includes('--keep');
const dash = process.argv.indexOf('--');
const PW_ARGS = dash === -1 ? [] : process.argv.slice(dash + 1);
// biome-ignore lint/suspicious/noUndeclaredEnvVars: This standalone Docker smoke runs outside the Turbo cache.
const PANEL_PORT = Number(process.env.ND_E2E_PORT ?? 4650);
const ORIGIN = `http://127.0.0.1:${PANEL_PORT}`;
const suffix = randomBytes(4).toString('hex');
const NET = `nd-e2e-${suffix}`;
const DIND = `nd-e2e-dind-${suffix}`;
const PANEL = `nd-e2e-panel-${suffix}`;
const GIT = `nd-e2e-git-${suffix}`;
const VOLUME = `nd-e2e-data-${suffix}`;
const SETUP_TOKEN = randomBytes(18).toString('hex');
const E2E_DIR = new URL('../e2e/', import.meta.url);
const PROOF_DIR = fileURLToPath(new URL('../.temp_files/', import.meta.url));
let gitRoot;

const docker = (args, opts = {}) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: opts.timeout ?? 120_000, maxBuffer: 8 << 20 });
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')} -> ${r.status}: ${(r.stderr ?? '').slice(0, 300)}`);
  return (r.stdout ?? '').trim();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { throw new Error(msg); };
const step = (msg) => console.log(`• ${msg}`);

async function main() {
  if (!existsSync(new URL('node_modules/@playwright/test/package.json', E2E_DIR))) {
    fail('e2e/ has no Playwright: run `pnpm --dir e2e install && pnpm --dir e2e exec playwright install chromium` first');
  }
  console.log(`Browser journeys against ${IMAGE}`);
  step(`topology: network ${NET}, dind ${DIND}, panel ${PANEL} (${ORIGIN})`);

  const local = spawnSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf8', timeout: 30_000 }).status === 0;
  const pulled = local ? { status: 0 } : spawnSync('docker', ['pull', IMAGE], { encoding: 'utf8', timeout: 900_000, maxBuffer: 8 << 20 });
  if (pulled.status !== 0) fail(`cannot pull ${IMAGE}: ${(pulled.stderr || pulled.error?.message || '').trim().split(/\r?\n/).slice(-3).join(' | ')}`);

  docker(['network', 'create', NET]);
  mkdirSync(PROOF_DIR, { recursive: true });
  const proofDirectory = realpathSync(PROOF_DIR);
  gitRoot = mkdtempSync(join(proofDirectory, 'nd-e2e-git-'));
  const repository = createSwarmGitRepository(gitRoot, { envExample: 'DEMO_TOKEN=example-value-for-e2e\n' });
  const preview = repository.publishBranch('n08-preview', { label: 'n08-preview-content' });
  const broken = repository.publishBranch('n08-broken', { label: 'n08-broken',
    dockerfile: 'FROM node:26-slim\nRUN echo N08_EXPECTED_BUILD_FAILURE >&2 && exit 37\n' });
  docker(['run', '-d', '--name', GIT, '--network', NET, '--network-alias', 'migration-old.e2e.test', '--user', '0', '--no-healthcheck',
    '--mount', `type=bind,src=${repository.bare},dst=/repo/repo.git,readonly`,
    '--entrypoint', 'node', IMAGE, '-e', gitHttpServerCode()]);
  docker(['run', '-d', '--name', DIND, '--network', NET, '--privileged', '-v', `${VOLUME}:/data`, 'docker:28-dind',
    'dockerd', '--host=tcp://0.0.0.0:2375']);
  for (let i = 0; i < 45; i++) {
    const probe = spawnSync('docker', ['exec', DIND, 'docker', '-H', 'tcp://127.0.0.1:2375', 'version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 15_000 });
    if (probe.status === 0 && (probe.stdout ?? '').trim()) break;
    if (i === 44) fail('dind daemon never became reachable');
    await sleep(1000);
  }
  docker(['run', '-d', '--name', PANEL, '--network', NET, '--network-alias', 'migration-cutover.e2e.test',
    '--network-alias', 'migration-cutover-compact.e2e.test', '-p', `127.0.0.1:${PANEL_PORT}:3000`,
    '-v', `${VOLUME}:/data`,
    '-e', `NINEDEPLOY_JWT_SECRET=${randomBytes(32).toString('hex')}`,
    '-e', `NINEDEPLOY_MASTER_KEY=${randomBytes(32).toString('hex')}`,
    '-e', `NINEDEPLOY_SETUP_TOKEN=${SETUP_TOKEN}`,
    // The browser's origin: CORS and the terminal's Origin check compare against it.
    '-e', `NINEDEPLOY_PUBLIC_URL=${ORIGIN}`,
    '-e', 'NINEDEPLOY_WILDCARD_DOMAIN=n08.test',
    '-e', 'NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1',
    '-e', 'NINEDEPLOY_JWT_ACCESS_TTL=2h',
    '-e', `DOCKER_HOST=tcp://${DIND}:2375`,
    IMAGE]);

  let health = null;
  for (let i = 0; i < 120 && !health; i++) {
    try {
      const r = await fetch(`${ORIGIN}/health`);
      const json = await r.json().catch(() => null);
      if (r.status === 200 && json?.status === 'ok') health = json;
    } catch { /* booting */ }
    if (!health) await sleep(1000);
  }
  if (!health) fail('panel /health never answered ok');
  step(`/health ok — version ${health.version}`);

  if (KEEP) step(`--keep: setup link ${ORIGIN}/login#setup-token=${SETUP_TOKEN}`);
  const pw = spawnSync('pnpm', ['exec', 'playwright', 'test', ...PW_ARGS], {
    cwd: E2E_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ND_BASE_URL: ORIGIN, ND_SETUP_TOKEN: SETUP_TOKEN, ND_E2E_DIND: DIND, ND_E2E_PANEL: PANEL,
      ND_E2E_GIT: JSON.stringify({ container: GIT, main: repository.first, preview, broken }) },
    timeout: 45 * 60_000,
  });
  if (pw.status !== 0) {
    const logs = spawnSync('docker', ['logs', '--tail', '80', PANEL], { encoding: 'utf8' });
    console.error(`\n--- panel log tail ---\n${(logs.stdout ?? '') + (logs.stderr ?? '')}`);
    fail(`Playwright exited with ${pw.status ?? pw.signal}`);
  }
  console.log('\n✓ Browser journeys green');
}

main()
  .catch((err) => { console.error(`\n✗ browser journeys failed: ${err?.message ?? err}`); process.exitCode = 1; })
  .finally(() => {
    if (KEEP) return;
    // -v: the dind image declares /var/lib/docker a volume; without it every run left that anonymous volume behind.
    for (const c of [PANEL, DIND, GIT]) spawnSync('docker', ['rm', '-f', '-v', c], { encoding: 'utf8' });
    spawnSync('docker', ['volume', 'rm', VOLUME], { encoding: 'utf8' });
    spawnSync('docker', ['network', 'rm', NET], { encoding: 'utf8' });
    if (gitRoot) {
      const resolved = realpathSync(gitRoot);
      if (resolved !== gitRoot || dirname(resolved) !== realpathSync(PROOF_DIR) || !basename(resolved).startsWith('nd-e2e-git-')) {
        fail('refusing cleanup outside the owned browser Git fixture');
      }
      rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
    }
  });
