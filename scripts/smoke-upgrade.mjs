#!/usr/bin/env node
// r580: the upgrade smoke — proves an in-place panel upgrade on the PUBLISHED
// images, which unit tests cannot: boot the FROM release on a fresh data
// volume, put real state in it (an operator, a deployed service, deploy
// history, an orphaned project secret, a deploy cut off mid-build by a hard
// kill), then boot the TO release on the SAME volume with the SAME secrets and
// check that it migrates, keeps everything, and still deploys.
//
// What it asserts after the upgrade:
//   - /health answers with the TO version (migrations ran at boot);
//   - the operator signs in with the old password; the service, its deploy
//     history and its domain are still there;
//   - the app container kept running through the panel swap (apps do not
//     depend on the panel process);
//   - the deploy interrupted by the kill is not left `building`;
//   - a fresh deploy goes green on the upgraded panel;
//   - every journal migration is recorded, and none twice.
//
// Topology: the user-journey smoke's validated DinD pattern — the panel gets
// DOCKER_HOST=tcp://<dind>:2375, so its Traefik/runtime work lands inside the
// sidecar, never on the host daemon.
//
// Usage: node scripts/smoke-upgrade.mjs [--from=v0.10.35] [--to=v0.10.37] [--to-image=<local image ref>]
//        (--to defaults to the repo's current VERSION)
//
// r581: release-publish.yml runs this between pushing `:vX.Y.Z` and
// publishing it (GitHub Release + `:latest`), with --from set to the highest
// published release below the new tag. Both images are pulled up front so a
// missing one fails with its name instead of as a `docker run` error.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const repoVersion = /export const VERSION = '([^']*)';/.exec(
  readFileSync(new URL('../apps/server/src/version.ts', import.meta.url), 'utf8'),
)?.[1];
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const FROM = arg('from') ?? 'v0.10.35';
const TO = arg('to') ?? (repoVersion ? `v${repoVersion}` : null);
if (!TO) {
  console.error('could not derive VERSION from apps/server/src/version.ts — pass --to=vX.Y.Z');
  process.exit(1);
}
// --to-image=<ref> runs the TO side from a locally built image (a release
// candidate) instead of the registry; --to then names the version it reports.
const TO_IMAGE = arg('to-image');
const image = (tag) => (TO_IMAGE && tag === TO ? TO_IMAGE : `ghcr.io/ninedeploy/ninedeploy:${tag}`);

const PANEL_PORT = 4641;
const suffix = randomBytes(4).toString('hex');
const NET = `nd-upgrade-${suffix}`;
const DIND = `nd-upgrade-dind-${suffix}`;
const PANEL = `nd-upgrade-panel-${suffix}`;
const VOLUME = `nd-upgrade-data-${suffix}`;
const JWT = randomBytes(32).toString('hex');
const MASTER = randomBytes(32).toString('hex');

/** r541 shipped in 0.10.37: from there on a project delete no longer orphans its secrets. */
const R541_FIXED_IN = [0, 10, 37];
const semver = (tag) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag) ?? []).slice(1).map(Number);
const olderThan = (tag, [a, b, c]) => {
  const [x = 0, y = 0, z = 0] = semver(tag);
  return x !== a ? x < a : y !== b ? y < b : z < c;
};

const docker = (args, opts = {}) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: opts.timeout ?? 300_000, maxBuffer: 8 << 20 });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`docker ${args.join(' ')} -> ${r.status}: ${(r.stderr ?? '').slice(0, 300)}`);
  return (r.stdout ?? '').trim();
};
const dind = (args) => docker(['exec', DIND, 'docker', '-H', 'tcp://127.0.0.1:2375', ...args], { allowFail: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exitCode = 1; throw new Error(msg); };
const step = (s) => console.log(`  ${s}`);

async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${PANEL_PORT}${p}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, json, text };
}

function startPanel(tag) {
  docker(['rm', '-f', PANEL], { allowFail: true });
  docker(['run', '-d', '--name', PANEL, '--network', NET, '-p', `127.0.0.1:${PANEL_PORT}:3000`,
    '-v', `${VOLUME}:/data`,
    '-e', `NINEDEPLOY_JWT_SECRET=${JWT}`,
    '-e', `NINEDEPLOY_MASTER_KEY=${MASTER}`,
    '-e', `DOCKER_HOST=tcp://${DIND}:2375`,
    image(tag)]);
}

async function waitHealthy(wantVersion) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await api('/health');
      if (r.status === 200 && r.json?.status === 'ok') {
        if (r.json.version !== wantVersion) fail(`/health reports ${r.json.version}, expected ${wantVersion}`);
        return r.json;
      }
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  try { console.log(docker(['logs', '--tail', '40', PANEL], { allowFail: true })); } catch { /* best effort */ }
  return fail(`panel ${wantVersion} never answered /health ok`);
}

const deploysOf = async (token, id) => {
  const r = await api(`/v1/services/${id}/deploys`, { token });
  return Array.isArray(r.json) ? r.json : (r.json?.deploys ?? []);
};

async function waitDeploy(token, serviceId, pick, label) {
  const TERMINAL = new Set(['running', 'failed', 'cancelled', 'superseded']);
  let last = null;
  for (let i = 0; i < 180; i++) {
    const d = pick(await deploysOf(token, serviceId));
    last = d?.status ?? last;
    if (TERMINAL.has(last)) return d;
    await sleep(2000);
  }
  return fail(`${label}: deploy never finished (last status ${last})`);
}

/** Copy the stopped panel's SQLite file out and query it with the repo's libSQL client. */
async function inspectDb(label) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nd-upgrade-'));
  const file = path.join(dir, 'ninedeploy.db');
  docker(['cp', `${PANEL}:/data/ninedeploy.db`, file]);
  const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
  const { createClient } = require('@libsql/client');
  const client = createClient({ url: `file:${file.replace(/\\/g, '/')}` });
  try {
    const one = async (q) => (await client.execute(q)).rows[0];
    return {
      label,
      migrations: Number((await one('SELECT count(*) AS n FROM __drizzle_migrations')).n),
      distinctMigrations: Number((await one('SELECT count(DISTINCT hash) AS n FROM __drizzle_migrations')).n),
      orphanProjectEnv: Number((await one(
        "SELECT count(*) AS n FROM env_vars WHERE scope = 'project' AND scope_key NOT IN (SELECT id FROM projects)",
      )).n),
    };
  } finally {
    client.close();
    // Windows can hold the file handle a moment past close(); a leftover
    // temp copy is harmless, a failed smoke over it is not.
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
  }
}

/**
 * r581: pull both panel images before anything is created. A missing FROM
 * image means a PUBLISHED release has no image behind it — every server
 * pinned to it is broken, which is louder news than this upgrade. A missing
 * TO image means the publish job did not push what it claims to have pushed.
 */
function pullOrFail(tag, role) {
  if (role === 'to' && TO_IMAGE) return; // a local candidate is not pulled
  const r = spawnSync('docker', ['pull', image(tag)], { encoding: 'utf8', timeout: 900_000, maxBuffer: 8 << 20 });
  if (r.status === 0) return;
  const why = (r.stderr || r.error?.message || '').trim().split(/\r?\n/).slice(-3).join(' | ');
  fail(role === 'from'
    ? `the FROM release image ${image(tag)} cannot be pulled (${why}). ${tag} is a published release, so installed servers pin this image — investigate the registry before releasing anything else.`
    : `the TO image ${image(tag)} cannot be pulled (${why}) — it was not pushed, or not under this tag.`);
}

async function main() {
  console.log(`Upgrade smoke: ${image(FROM)} → ${image(TO)}`);
  step(`topology: network ${NET}, dind ${DIND}, panel ${PANEL} (:${PANEL_PORT}), volume ${VOLUME}`);
  const journal = JSON.parse(readFileSync(new URL('../packages/db/src/migrations/meta/_journal.json', import.meta.url), 'utf8'));

  pullOrFail(FROM, 'from');
  pullOrFail(TO, 'to');
  step(`pulled ${image(FROM)} and ${image(TO)}`);

  // ── bring up DinD ───────────────────────────────────────────────────────
  docker(['network', 'create', NET]);
  docker(['volume', 'create', VOLUME]);
  docker(['run', '-d', '--name', DIND, '--network', NET, '--privileged', 'docker:28-dind', 'dockerd', '--host=tcp://0.0.0.0:2375']);
  for (let i = 0; i < 45; i++) {
    if (dind(['version', '--format', '{{.Server.Version}}'])) break;
    await sleep(1000);
    if (i === 44) fail('dind daemon never became reachable');
  }

  // ── FROM: boot and seed real state ──────────────────────────────────────
  startPanel(FROM);
  const fromHealth = await waitHealthy(FROM.replace(/^v/, ''));
  step(`${FROM} up (db ${fromHealth.db})`);

  const email = `upgrade-${suffix}@nd.local`;
  const password = 'Upgrade-0123456!';
  const reg = await api('/v1/auth/register', { method: 'POST', body: { email, password, name: 'Upgrade' } });
  if (reg.status !== 200 || !reg.json?.tokens?.accessToken) fail(`register failed: ${reg.status} ${reg.text.slice(0, 200)}`);
  let token = reg.json.tokens.accessToken;

  const svc = await api('/v1/services', { method: 'POST', token, body: { name: 'upgrade-web', type: 'docker', image: 'nginx:1.27-alpine', port: 80 } });
  const serviceId = svc.json?.id ?? svc.json?.service?.id;
  if (!serviceId) fail(`service create failed: ${svc.status} ${svc.text.slice(0, 300)}`);
  await api(`/v1/services/${serviceId}/deploys`, { method: 'POST', token, body: {} });
  const first = await waitDeploy(token, serviceId, (all) => all[0], FROM);
  if (first.status !== 'running') fail(`${FROM}: first deploy ended as '${first.status}'`);
  const dom = await api(`/v1/services/${serviceId}/domains`, { method: 'POST', token, body: { hostname: `upgrade-${suffix}.test` } });
  if (dom.status !== 200 && dom.status !== 201) fail(`${FROM}: domain create failed: ${dom.status}`);
  step(`service #${serviceId} deployed (#${first.id}) with a domain`);

  // The 0.10.35 project-delete left project-scoped secrets behind; r541's
  // migration must clean exactly these up.
  const proj = await api('/v1/projects', { method: 'POST', token, body: { name: `orphan-${suffix}` } });
  const projectId = proj.json?.id ?? proj.json?.project?.id;
  if (!projectId) fail(`project create failed: ${proj.status} ${proj.text.slice(0, 200)}`);
  const env = await api(`/v1/projects/${projectId}/env`, { method: 'POST', token, body: { key: 'SHARED_SECRET', value: 's3cret', isSecret: true } });
  if (env.status !== 200 && env.status !== 201) fail(`project env create failed: ${env.status} ${env.text.slice(0, 200)}`);
  await api(`/v1/projects/${projectId}`, { method: 'DELETE', token });

  // A second service whose deploy is killed mid-build: a large image keeps it
  // in `building` long enough to cut the panel off underneath it.
  const slow = await api('/v1/services', { method: 'POST', token, body: { name: 'upgrade-slow', type: 'docker', image: 'python:3.12', port: 8000 } });
  const slowId = slow.json?.id ?? slow.json?.service?.id;
  if (!slowId) fail(`slow service create failed: ${slow.status}`);
  await api(`/v1/services/${slowId}/deploys`, { method: 'POST', token, body: {} });
  let interrupted = null;
  for (let i = 0; i < 60 && !interrupted; i++) {
    const d = (await deploysOf(token, slowId))[0];
    if (d && (d.status === 'building' || d.status === 'deploying')) interrupted = d;
    else await sleep(500);
  }
  if (!interrupted) fail(`${FROM}: the slow deploy never reached building`);
  docker(['kill', PANEL]);
  step(`deploy #${interrupted.id} cut off mid-${interrupted.status} by a hard kill`);

  const before = await inspectDb(FROM);
  step(`${FROM} db: ${before.migrations} migrations recorded, ${before.orphanProjectEnv} orphaned project secret(s)`);
  // r581: only a FROM older than the r541 fix can orphan the secret — the CI
  // gate starts from the newest published release, which already cleans up.
  // The post-upgrade "no orphans" assertion below holds either way.
  if (olderThan(FROM, R541_FIXED_IN)) {
    if (before.orphanProjectEnv < 1) fail(`${FROM}: expected the project delete to orphan its secret (got ${before.orphanProjectEnv}) — the seed did not exercise r541`);
  } else {
    step(`${FROM} already includes r541 — the project delete left ${before.orphanProjectEnv} orphaned secret(s)`);
  }
  const appContainers = dind(['ps', '--filter', 'status=running', '--format', '{{.Names}}']);

  // ── TO: same volume, same secrets ───────────────────────────────────────
  startPanel(TO);
  const toHealth = await waitHealthy(TO.replace(/^v/, ''));
  step(`${TO} up on the same volume (db ${toHealth.db})`);

  const login = await api('/v1/auth/login', { method: 'POST', body: { email, password } });
  if (login.status !== 200 || !login.json?.tokens?.accessToken) fail(`login after upgrade failed: ${login.status} ${login.text.slice(0, 200)}`);
  token = login.json.tokens.accessToken;
  step('operator signs in with the pre-upgrade password');

  const svcAfter = await api(`/v1/services/${serviceId}`, { token });
  if (svcAfter.status !== 200) fail(`service #${serviceId} missing after upgrade: ${svcAfter.status}`);
  const history = await deploysOf(token, serviceId);
  if (!history.some((d) => d.id === first.id && d.status === 'running')) fail('deploy history lost the pre-upgrade green deploy');
  const domains = await api(`/v1/services/${serviceId}/domains`, { token });
  const domainList = Array.isArray(domains.json) ? domains.json : (domains.json?.domains ?? []);
  if (!domainList.some((d) => d.hostname === `upgrade-${suffix}.test`)) fail('domain lost across the upgrade');
  step('service, deploy history and domain intact');

  const stillRunning = dind(['ps', '--filter', 'status=running', '--format', '{{.Names}}']);
  const lost = appContainers.split('\n').filter((n) => n && !n.includes('traefik') && !stillRunning.split('\n').includes(n));
  if (lost.length) fail(`app containers stopped by the panel swap: ${lost.join(', ')}`);
  step('app containers kept running through the panel swap');

  let after = null;
  for (let i = 0; i < 30; i++) {
    after = (await deploysOf(token, slowId)).find((d) => d.id === interrupted.id);
    if (after && after.status !== 'building' && after.status !== 'deploying') break;
    await sleep(1000);
  }
  if (!after || after.status === 'building' || after.status === 'deploying') {
    fail(`interrupted deploy #${interrupted.id} still '${after?.status}' 30 s after the upgraded boot (r524)`);
  }
  step(`interrupted deploy #${interrupted.id} settled as '${after.status}'`);

  await api(`/v1/services/${serviceId}/deploys`, { method: 'POST', token, body: {} });
  const redeploy = await waitDeploy(token, serviceId, (all) => all.find((d) => d.id !== first.id), TO);
  if (redeploy.status !== 'running') fail(`${TO}: redeploy ended as '${redeploy.status}'`);
  step(`redeploy #${redeploy.id} green on ${TO}`);

  docker(['stop', PANEL]);
  const post = await inspectDb(TO);
  if (post.migrations !== journal.entries.length) fail(`${post.migrations} migrations recorded, journal has ${journal.entries.length}`);
  if (post.distinctMigrations !== post.migrations) fail('a migration was recorded twice');
  if (post.orphanProjectEnv !== 0) fail(`${post.orphanProjectEnv} orphaned project secret(s) survived the upgrade (r541)`);
  step(`${TO} db: all ${post.migrations} journal migrations recorded once, orphaned project secrets removed`);

  console.log(`\n✓ Upgrade green: ${FROM} → ${TO} keeps users, services, history, domains and running apps; migrates; recovers the interrupted deploy; deploys again`);
}

main()
  .catch((err) => { console.error(`\n✗ upgrade smoke aborted: ${err?.message ?? err}`); process.exitCode = 1; })
  .finally(() => {
    for (const c of [PANEL, DIND]) docker(['rm', '-f', c], { allowFail: true });
    docker(['volume', 'rm', VOLUME], { allowFail: true });
    docker(['network', 'rm', NET], { allowFail: true });
  });
