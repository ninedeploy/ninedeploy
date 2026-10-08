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
// 0.12 features, exercised on the upgraded panel against FROM-era data (the
// seed uses only routes every supported FROM has — /databases, service env,
// /alerts — so --from=v0.10.45 and --from=v0.11.2 both work):
//   - the managed postgres seeded on FROM reports `configured: false` (the
//     built-in daily/7 schedule), and a policy PUT round-trips through GET;
//   - preview-only env create/list works on the upgraded service, and its
//     production env reads back exactly as it did on FROM, before and after;
//   - a `disk` alert rule is created and listed next to the FROM cpu rule;
//   - panel self-backup reports disabled defaults and PUT rejects bad input
//     (no S3 here: nothing is ever run against a destination).
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

/** A service's production env as GET /env serializes it (secrets masked), in a stable order. */
const prodEnvOf = async (token, id) => {
  const r = await api(`/v1/services/${id}/env`, { token });
  if (r.status !== 200 || !Array.isArray(r.json)) fail(`service #${id} env read failed: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json
    .map(({ id: varId, key, value, isSecret }) => ({ id: varId, key, value, isSecret }))
    .sort((a, b) => a.key.localeCompare(b.key));
};
const sameEnv = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

  // 0.12 seed — FROM-era state the new features must read correctly. Only
  // routes that exist on every supported FROM (checked against v0.10.45).
  for (const body of [
    { key: 'UPGRADE_PLAIN', value: `plain-${suffix}` },
    { key: 'UPGRADE_SECRET', value: `secret-${suffix}`, isSecret: true },
  ]) {
    const r = await api(`/v1/services/${serviceId}/env`, { method: 'POST', token, body });
    if (r.status !== 200 && r.status !== 201) fail(`${FROM}: service env ${body.key} create failed: ${r.status} ${r.text.slice(0, 200)}`);
  }
  const envBefore = await prodEnvOf(token, serviceId);
  if (envBefore.length !== 2) fail(`${FROM}: expected 2 service env vars, read ${envBefore.length}`);
  const pg = await api('/v1/databases', { method: 'POST', token, body: { name: `upgrade-pg-${suffix}`, engine: 'postgres' } });
  if (pg.status !== 200 && pg.status !== 201) fail(`${FROM}: postgres create failed: ${pg.status} ${pg.text.slice(0, 300)}`);
  const databaseId = pg.json?.id;
  if (!databaseId || pg.json?.status !== 'running') fail(`${FROM}: postgres #${databaseId} reported '${pg.json?.status}' (wanted running)`);
  const cpuRule = await api('/v1/alerts', { method: 'POST', token, body: { name: `upgrade-cpu-${suffix}`, metric: 'cpu', operator: '>', threshold: 95 } });
  if (cpuRule.status !== 200 && cpuRule.status !== 201) fail(`${FROM}: cpu alert rule create failed: ${cpuRule.status} ${cpuRule.text.slice(0, 200)}`);
  const cpuRuleId = cpuRule.json?.id;
  step(`seeded 2 service env vars, managed postgres #${databaseId} (no backup policy) and cpu alert rule #${cpuRuleId}`);

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

  // ── 0.12 features on FROM-era data ──────────────────────────────────────
  // Per-database backup policy: no row yet → the built-in schedule, unchanged.
  const policyPath = `/v1/databases/${databaseId}/backup-policy`;
  const policy0 = await api(policyPath, { token });
  if (policy0.status !== 200) fail(`backup-policy GET on postgres #${databaseId} answered ${policy0.status} ${policy0.text.slice(0, 200)}`);
  if (policy0.json?.configured !== false || policy0.json?.enabled !== true || policy0.json?.cron !== null || policy0.json?.retainCount !== 7) {
    fail(`postgres #${databaseId} seeded on ${FROM} should keep the built-in daily/7 schedule, got ${policy0.text.slice(0, 300)}`);
  }
  step(`postgres #${databaseId} from ${FROM} reports configured:false (built-in daily, keep 7)`);
  const badCron = await api(policyPath, { method: 'PUT', token, body: { cron: 'not a cron', retainCount: 3, localOnly: true } });
  if (badCron.status !== 400) fail(`backup-policy PUT with an invalid cron answered ${badCron.status} (wanted 400)`);
  const wantPolicy = { enabled: true, cron: '30 3 * * *', retainCount: 3, localOnly: true };
  const put = await api(policyPath, { method: 'PUT', token, body: wantPolicy });
  if (put.status !== 200) fail(`backup-policy PUT answered ${put.status} ${put.text.slice(0, 300)}`);
  const policy1 = (await api(policyPath, { token })).json;
  for (const [k, v] of Object.entries({ ...wantPolicy, configured: true, destinationId: null })) {
    if (policy1?.[k] !== v) fail(`backup-policy GET after PUT: ${k} is ${JSON.stringify(policy1?.[k])}, wanted ${JSON.stringify(v)}`);
  }
  if (!policy1.nextRunAt) fail('backup-policy GET after PUT: an enabled policy has no nextRunAt');
  step(`backup policy round-trips (${wantPolicy.cron}, keep ${wantPolicy.retainCount}, local only; next ${policy1.nextRunAt}); an invalid cron is refused`);

  // Preview-only env: production env must read back exactly as on FROM.
  const envAfter = await prodEnvOf(token, serviceId);
  if (!sameEnv(envAfter, envBefore)) fail(`production env changed across the upgrade: ${JSON.stringify(envBefore)} → ${JSON.stringify(envAfter)}`);
  const previewPath = `/v1/services/${serviceId}/env/preview`;
  const preview0 = await api(previewPath, { token });
  if (preview0.status !== 200 || !Array.isArray(preview0.json) || preview0.json.length !== 0) {
    fail(`preview env of an upgraded service should start empty: ${preview0.status} ${preview0.text.slice(0, 200)}`);
  }
  const pv = await api(previewPath, { method: 'POST', token, body: { key: 'PREVIEW_ONLY', value: `preview-${suffix}` } });
  if (pv.status !== 200 && pv.status !== 201) fail(`preview env create failed: ${pv.status} ${pv.text.slice(0, 200)}`);
  const previews = (await api(previewPath, { token })).json;
  if (!Array.isArray(previews) || previews.length !== 1 || previews[0].key !== 'PREVIEW_ONLY' || previews[0].value !== `preview-${suffix}`) {
    fail(`preview env list after create: ${JSON.stringify(previews)}`);
  }
  if (!sameEnv(await prodEnvOf(token, serviceId), envBefore)) fail('a preview-only variable leaked into the production env');
  step(`service #${serviceId} production env unchanged from ${FROM} (${envBefore.length} vars); preview-only var created and listed without touching it`);

  // Alert metrics: a `disk` rule next to the FROM-era cpu rule.
  const disk = await api('/v1/alerts', { method: 'POST', token, body: { name: `upgrade-disk-${suffix}`, metric: 'disk', operator: '>', threshold: 90 } });
  if (disk.status !== 200 && disk.status !== 201) fail(`disk alert rule create failed: ${disk.status} ${disk.text.slice(0, 200)}`);
  const rules = await api('/v1/alerts', { token });
  const ruleList = Array.isArray(rules.json) ? rules.json : [];
  if (!ruleList.some((r) => r.id === disk.json?.id && r.metric === 'disk')) fail(`the disk alert rule #${disk.json?.id} is not listed`);
  if (!ruleList.some((r) => r.id === cpuRuleId && r.metric === 'cpu')) fail(`the ${FROM} cpu alert rule #${cpuRuleId} is gone from the list`);
  step(`disk alert rule #${disk.json.id} created and listed next to the ${FROM} cpu rule #${cpuRuleId}`);

  // Panel self-backup: off by default after an upgrade; bad input refused.
  // No S3 destination exists here, so nothing is ever run or enabled.
  const pb = await api('/v1/system/panel-backup', { token });
  if (pb.status !== 200) fail(`panel-backup GET answered ${pb.status} ${pb.text.slice(0, 200)}`);
  const pbs = pb.json?.settings;
  if (pbs?.enabled !== false || pbs?.destinationId !== null || pbs?.hasPassphrase !== false || pb.json?.lastRun !== null) {
    fail(`panel-backup should report disabled defaults after the upgrade, got ${pb.text.slice(0, 300)}`);
  }
  for (const [label, body] of [
    ['enabling without a destination', { enabled: true }],
    ['an invalid cron', { cron: 'not a cron' }],
    ['retain 0', { retain: 0 }],
  ]) {
    const r = await api('/v1/system/panel-backup', { method: 'PUT', token, body });
    if (r.status !== 400) fail(`panel-backup PUT with ${label} answered ${r.status} (wanted 400)`);
  }
  if ((await api('/v1/system/panel-backup', { token })).json?.settings?.enabled !== false) fail('a refused panel-backup PUT changed the settings');
  step('panel self-backup reports enabled:false; PUT refuses a missing destination, a bad cron and retain 0');

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

  console.log(`\n✓ Upgrade green: ${FROM} → ${TO} keeps users, services, history, domains and running apps; migrates; recovers the interrupted deploy; deploys again; 0.12 backup policy, preview env, disk alert and panel-backup defaults work on the upgraded data`);
}

main()
  .catch((err) => { console.error(`\n✗ upgrade smoke aborted: ${err?.message ?? err}`); process.exitCode = 1; })
  .finally(() => {
    for (const c of [PANEL, DIND]) docker(['rm', '-f', c], { allowFail: true });
    docker(['volume', 'rm', VOLUME], { allowFail: true });
    docker(['network', 'rm', NET], { allowFail: true });
  });
