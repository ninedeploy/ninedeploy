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
// 0.13 (only when TO is 0.13 or later), still without a real GitHub:
//   - GET /v1/github-apps answers [] on the upgraded data;
//   - the PAT source seeded on FROM (dummy token, POST /v1/sources exists on
//     v0.10.45) still lists unchanged and its live test answers ok:false,
//     never a 500;
//   - a Gitea source's baseUrl round-trips; a malformed or unreadable App
//     key is refused with 400; the manifest flow refuses the localhost origin.
//
// 0.14 (only when TO is 0.14 or later; FROM-side seeding stays on routes
// v0.10.45 has — the postgres and the domain above):
//   - the panel's Traefik static config names the file-provider directory and
//     the FROM domain's router is in dynamic/ninedeploy.yml; the Traefik log
//     has no file-provider error;
//   - custom dynamic config: bad YAML and a `svc_x` collision 400, a valid
//     `custom-hello` middleware 200 through the DinD preflight;
//   - uploaded certificates: the server-test fixture 201 and listed, a
//     mismatched key 400;
//   - public access on the FROM postgres: configured:false, refusals 400, a
//     sidecar on :15432, DELETE removes it; a TLS-terminate attempt recorded;
//   - a one-chunk plain-SQL import completes behind a pre-import backup;
//   - secret managers: both unconfigured, a Vault on vault.invalid tests
//     ok:false, a bad AWS region 400, /v1/settings/vault unchanged.
// Rollback rehearsal (FROM ≥ 0.14, TO < 0.14): FROM enables public access on
// the postgres and saves a custom config; then TO boots, leaves migration
// 0070 recorded and its rows alone, puts Traefik back on `filename:`, still
// lists the domain, leaves the nd-dbpub sidecar running — and the runbook's
// `docker rm -f $(docker ps -aq --filter label=ninedeploy.public-db)` removes it.
//
// Topology: the user-journey smoke's validated DinD pattern — the panel gets
// DOCKER_HOST=tcp://<dind>:2375, so its Traefik/runtime work lands inside the
// sidecar, never on the host daemon. The data volume is mounted at /data in
// the sidecar as well, so a bind mount the panel asks for (Traefik's config
// directory, the nd-dbpub config, the preflight) resolves to the panel's real
// files, as it does on a host install.
//
// Usage: node scripts/smoke-upgrade.mjs [--from=v0.10.35] [--to=v0.10.37] [--to-image=<local image ref>] [--from-image=<local image ref>]
//        (--to defaults to the repo's current VERSION)
//        rollback rehearsal: --from=v0.14.0 --from-image=<local candidate> --to=v0.13.0
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
import { createHash, randomBytes } from 'node:crypto';

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
// --from-image=<ref> does the same for the FROM side, for a rollback rehearsal
// (--from=<candidate> --from-image=<local ref> --to=<previous release>).
const FROM_IMAGE = arg('from-image');
const image = (tag) =>
  TO_IMAGE && tag === TO ? TO_IMAGE : FROM_IMAGE && tag === FROM ? FROM_IMAGE : `ghcr.io/ninedeploy/ninedeploy:${tag}`;

const PANEL_PORT = 4641;
const suffix = randomBytes(4).toString('hex');
const NET = `nd-upgrade-${suffix}`;
const DIND = `nd-upgrade-dind-${suffix}`;
const PANEL = `nd-upgrade-panel-${suffix}`;
const VOLUME = `nd-upgrade-data-${suffix}`;
const JWT = randomBytes(32).toString('hex');
const MASTER = randomBytes(32).toString('hex');
const journal = JSON.parse(readFileSync(new URL('../packages/db/src/migrations/meta/_journal.json', import.meta.url), 'utf8'));
/** 0.14's migration (network and data access): a rollback must leave its record and tables alone. */
const MIGRATION_0070 = journal.entries.find((e) => e.tag.startsWith('0070_')) ?? null;

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
/** 0.13 GitHub App / Gitea checks run only against a TO that has them. */
const GITHUB_APP_IN = [0, 13, 0];

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
    // 0.14: migration 0070's four tables, its journal record, and the public
    // access rows a 0.14 FROM seeded (a rollback must leave all of it alone).
    const networkTables = Number((await one(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('database_public_access', 'tls_certificates', 'database_imports', 'secret_providers')",
    )).n);
    return {
      label,
      migrations: Number((await one('SELECT count(*) AS n FROM __drizzle_migrations')).n),
      distinctMigrations: Number((await one('SELECT count(DISTINCT hash) AS n FROM __drizzle_migrations')).n),
      orphanProjectEnv: Number((await one(
        "SELECT count(*) AS n FROM env_vars WHERE scope = 'project' AND scope_key NOT IN (SELECT id FROM projects)",
      )).n),
      networkTables,
      migration0070: MIGRATION_0070
        ? Number((await one(`SELECT count(*) AS n FROM __drizzle_migrations WHERE created_at = ${Number(MIGRATION_0070.when)}`)).n)
        : 0,
      publicAccessRows: networkTables === 4 ? Number((await one('SELECT count(*) AS n FROM database_public_access')).n) : 0,
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
  if (role === 'from' && FROM_IMAGE) return;
  const r = spawnSync('docker', ['pull', image(tag)], { encoding: 'utf8', timeout: 900_000, maxBuffer: 8 << 20 });
  if (r.status === 0) return;
  const why = (r.stderr || r.error?.message || '').trim().split(/\r?\n/).slice(-3).join(' | ');
  fail(role === 'from'
    ? `the FROM release image ${image(tag)} cannot be pulled (${why}). ${tag} is a published release, so installed servers pin this image — investigate the registry before releasing anything else.`
    : `the TO image ${image(tag)} cannot be pulled (${why}) — it was not pushed, or not under this tag.`);
}

// 0.13: the GitHub App and Gitea surfaces, checked without a real GitHub.
// Every call here either answers from the panel's own validation or never
// leaves it (`.invalid` hosts are reserved and never resolve), so the smoke
// stays offline-safe. Shared verbatim by smoke-upgrade.mjs and
// smoke-user-journey.mjs.
const errorCode = (r) => r.json?.error?.code ?? r.json?.code ?? null;
async function githubSurfaceChecks(token) {
  const apps = await api('/v1/github-apps', { token });
  if (apps.status !== 200 || !Array.isArray(apps.json) || apps.json.length !== 0) {
    fail(`GET /v1/github-apps should answer [] on a panel with no App, got ${apps.status} ${apps.text.slice(0, 200)}`);
  }
  // A malformed key is refused by the schema; a PEM-shaped key that is not
  // a key is refused before anything is sent to GitHub (the webhook secret
  // skips the public-origin check, so this reaches the key parser).
  const notPem = await api('/v1/github-apps', { method: 'POST', token, body: { name: `smoke-${suffix}`, appId: 1, privateKey: 'not a pem' } });
  if (notPem.status !== 400) fail(`a manual GitHub App with a non-PEM key answered ${notPem.status} (wanted 400): ${notPem.text.slice(0, 200)}`);
  const badPem = await api('/v1/github-apps', {
    method: 'POST',
    token,
    body: {
      name: `smoke-${suffix}`,
      appId: 1,
      webhookSecret: `whsec-${suffix}`,
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nbm90IGEga2V5\n-----END RSA PRIVATE KEY-----',
    },
  });
  if (badPem.status !== 400 || errorCode(badPem) !== 'github_app_bad_key') {
    fail(`a manual GitHub App with an unreadable PEM answered ${badPem.status} ${badPem.text.slice(0, 200)} (wanted 400 github_app_bad_key)`);
  }
  if ((await api('/v1/github-apps', { token })).json?.length !== 0) fail('a refused GitHub App create left a row behind');
  // GitHub cannot reach a localhost panel, so the one-click setup refuses to start.
  const manifest = await api('/v1/github-apps/manifest', { method: 'POST', token, body: { target: 'user' } });
  if (manifest.status !== 400 || errorCode(manifest) !== 'panel_origin_local') {
    fail(`the manifest flow on a localhost panel answered ${manifest.status} ${manifest.text.slice(0, 200)} (wanted 400 panel_origin_local)`);
  }
  // An unknown App webhook key is a 404, never a deploy.
  const hook = await api(`/v1/hooks/github-app/${'0'.repeat(32)}`, { method: 'POST', body: { zen: 'smoke' } });
  if (hook.status !== 404) fail(`an unknown GitHub App webhook key answered ${hook.status} (wanted 404)`);
  step('GitHub Apps: none listed; a non-PEM and an unreadable PEM key are refused (400); manifest refused on a localhost origin; unknown App hook 404');

  // Gitea base URL: create, list, change, refuse http and non-Gitea, clear.
  const base = `https://gitea-${suffix}.invalid`;
  const gt = await api('/v1/sources', { method: 'POST', token, body: { name: `smoke-gitea-${suffix}`, type: 'gitea', token: `gitea-${suffix}`, baseUrl: base } });
  if (gt.status !== 200 || gt.json?.baseUrl !== base) fail(`Gitea source create with baseUrl answered ${gt.status} ${gt.text.slice(0, 200)}`);
  const giteaId = gt.json.id;
  const listedGitea = (await api('/v1/sources', { token })).json?.find((s) => s.id === giteaId);
  if (listedGitea?.baseUrl !== base) fail(`Gitea source #${giteaId} lists baseUrl ${listedGitea?.baseUrl} (wanted ${base})`);
  const moved = await api(`/v1/sources/${giteaId}`, { method: 'PATCH', token, body: { baseUrl: `${base}/git/` } });
  if (moved.status !== 200 || moved.json?.baseUrl !== `${base}/git`) fail(`Gitea baseUrl PATCH answered ${moved.status} ${moved.text.slice(0, 200)}`);
  const insecure = await api(`/v1/sources/${giteaId}`, { method: 'PATCH', token, body: { baseUrl: `http://gitea-${suffix}.invalid` } });
  if (insecure.status !== 400) fail(`an http Gitea baseUrl answered ${insecure.status} (wanted 400 without NINEDEPLOY_ALLOW_PRIVATE_EGRESS)`);
  const notGitea = await api('/v1/sources', { method: 'POST', token, body: { name: `smoke-gh-${suffix}`, type: 'github', token: 'x', baseUrl: base } });
  if (notGitea.status !== 400) fail(`a baseUrl on a github source answered ${notGitea.status} (wanted 400)`);
  const cleared = await api(`/v1/sources/${giteaId}`, { method: 'PATCH', token, body: { baseUrl: null } });
  if (cleared.status !== 200 || cleared.json?.baseUrl !== null) fail(`clearing the Gitea baseUrl answered ${cleared.status} ${cleared.text.slice(0, 200)}`);
  const giteaTest = await api(`/v1/sources/${giteaId}/test`, { token });
  if (giteaTest.status !== 200 || giteaTest.json?.ok !== false || !/base URL/.test(giteaTest.json?.error ?? '')) {
    fail(`the Gitea test without a base URL answered ${giteaTest.status} ${giteaTest.text.slice(0, 200)}`);
  }
  const giteaDel = await api(`/v1/sources/${giteaId}`, { method: 'DELETE', token });
  if (giteaDel.status !== 200 && giteaDel.status !== 204) fail(`Gitea source delete answered ${giteaDel.status}`);
  step('Gitea source: baseUrl round-trips through create, list and PATCH; http and non-Gitea refused; cleared baseUrl tests ok:false');
}

// 0.14: network and data access — the Traefik directory provider, custom
// dynamic config, uploaded certificates, public database access, dump import
// and the secret managers. Offline-safe like the 0.13 block: the Vault address
// is a reserved `.invalid` host, the allow-list is TEST-NET-3, no TLS
// handshake is attempted, and the certificate is the server tests' fixture
// (apps/server/test/fixtures/certs, 2099 expiry). The panel's data volume is
// also mounted at /data in the DinD sidecar, so the containers the panel
// starts there (Traefik, the custom-config preflight, the nd-dbpub sidecar)
// read the files the panel wrote, exactly as on a real host. Shared verbatim
// by smoke-upgrade.mjs and smoke-user-journey.mjs.
const NETWORK_DATA_IN = [0, 14, 0];
const TRAEFIK = 'ninedeploy-traefik';
const PUBLIC_PORT = 15432;
const PUBLIC_TLS_PORT = 15433;
const ALLOW = ['203.0.113.0/24'];
const HELLO_CONFIG = 'http:\n  middlewares:\n    custom-hello:\n      headers:\n        customResponseHeaders:\n          X-NineDeploy-Smoke: hello\n';

/** A command against the DinD daemon: exit status, stdout, and stdout+stderr (container logs use both). */
function dindRun(args) {
  const r = spawnSync('docker', ['exec', DIND, 'docker', '-H', 'tcp://127.0.0.1:2375', ...args], { encoding: 'utf8', timeout: 120_000, maxBuffer: 32 << 20 });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), all: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() };
}
/** A file as the panel's Traefik container sees it under /etc/traefik ('' when it cannot be read). */
const traefikFile = (rel) => {
  const r = dindRun(['exec', TRAEFIK, 'cat', `/etc/traefik/${rel}`]);
  return r.status === 0 ? r.stdout : '';
};
/** Names of DinD containers matching `name` exactly (`running` only, or any state). */
const dindContainer = (name, { running = false } = {}) =>
  dindRun(['ps', ...(running ? [] : ['-a']), '--filter', `name=^${name}$`, ...(running ? ['--filter', 'status=running'] : []), '--format', '{{.Names}}']).stdout;
/** Traefik log lines that say the file provider could not load a dynamic file. */
const ERROR_LEVEL = /\bERR\b|\bFTL\b|level=(error|fatal)|"level":"(error|fatal)"/i;
const FILE_PROVIDER = /providerName=file|\/etc\/traefik\/dynamic|building configuration|cannot (unmarshal|decode)|yaml:/i;
const traefikFileProviderErrors = () =>
  dindRun(['logs', TRAEFIK]).all.split(/\r?\n/).filter((l) => ERROR_LEVEL.test(l) && FILE_PROVIDER.test(l)).map((l) => l.slice(0, 300));
const certFixture = (name) => readFileSync(new URL(`../apps/server/test/fixtures/certs/${name}`, import.meta.url), 'utf8');

/** A raw `application/octet-stream` request (import chunks). */
async function apiRaw(p, { method = 'PUT', token, body }) {
  const r = await fetch(`http://127.0.0.1:${PANEL_PORT}${p}`, {
    method,
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
    body,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, json, text };
}

/** The panel's Traefik reads a file-provider DIRECTORY and the generated routes route `hostname`. */
async function traefikDirectoryChecks(hostname) {
  let staticCfg = '';
  let routes = '';
  for (let i = 0; i < 60; i++) {
    staticCfg = traefikFile('traefik.yml');
    routes = traefikFile('dynamic/ninedeploy.yml');
    if (/^\s*directory:\s*\/etc\/traefik\/dynamic\b/m.test(staticCfg) && routes.includes(hostname)) break;
    await sleep(1000);
  }
  if (!/^\s*directory:\s*\/etc\/traefik\/dynamic\b/m.test(staticCfg)) {
    fail(`the panel's Traefik static config has no file-provider directory: ${staticCfg.slice(0, 400) || '(traefik.yml not readable in the traefik container)'}`);
  }
  if (/^\s*filename:/m.test(staticCfg)) fail('the panel\'s Traefik static config still names a single dynamic file');
  if (!routes.includes(hostname)) fail(`dynamic/ninedeploy.yml does not route ${hostname}: ${routes.slice(0, 400) || '(missing)'}`);
  step(`Traefik reads the directory provider (/etc/traefik/dynamic); dynamic/ninedeploy.yml routes ${hostname}`);
}

/** Custom dynamic config: refusals are 400, a valid `custom-` middleware passes the preflight and loads. */
async function customConfigChecks(token) {
  const p = '/v1/traefik/custom-config';
  const initial = await api(p, { token });
  if (initial.status !== 200) fail(`GET ${p} answered ${initial.status} ${initial.text.slice(0, 200)}`);
  const broken = await api(p, { method: 'PUT', token, body: { content: 'http:\n  routers: [unclosed\n' } });
  if (broken.status !== 400 || errorCode(broken) !== 'invalid_custom_config') {
    fail(`a custom config that is not YAML answered ${broken.status} ${broken.text.slice(0, 200)} (wanted 400 invalid_custom_config)`);
  }
  const collide = 'http:\n  services:\n    svc_x:\n      loadBalancer:\n        servers:\n          - url: "http://127.0.0.1:1"\n';
  const dry = await api(`${p}/validate`, { method: 'POST', token, body: { content: collide } });
  if (dry.status !== 200 || dry.json?.ok !== false) fail(`validate on a generated-name collision answered ${dry.status} ${dry.text.slice(0, 200)} (wanted 200 ok:false)`);
  const collision = await api(p, { method: 'PUT', token, body: { content: collide } });
  if (collision.status !== 400 || errorCode(collision) !== 'invalid_custom_config') {
    fail(`a custom config defining svc_x answered ${collision.status} ${collision.text.slice(0, 200)} (wanted 400 invalid_custom_config)`);
  }
  // The preflight runs a throwaway Traefik inside DinD (traefik:3, the image
  // the panel's own Traefik already pulled); 503 = docker unreachable, 422 = refused.
  const saved = await api(p, { method: 'PUT', token, body: { content: HELLO_CONFIG } });
  if (saved.status !== 200 || saved.json?.status !== 'applied') fail(`a valid custom-hello middleware answered ${saved.status} ${saved.text.slice(0, 400)} (wanted 200 applied)`);
  const state = (await api(p, { token })).json;
  if (state?.status !== 'applied' || state.sha256 !== saved.json.sha256 || state.content !== HELLO_CONFIG) {
    fail(`GET ${p} after the save: ${JSON.stringify(state).slice(0, 300)}`);
  }
  if (!traefikFile('dynamic/custom.yml').includes('custom-hello')) fail('dynamic/custom.yml is not visible to the panel\'s Traefik after the save');
  await sleep(3000);
  const errors = traefikFileProviderErrors();
  if (errors.length) fail(`Traefik logged file-provider errors:\n    ${errors.slice(0, 5).join('\n    ')}`);
  step(`custom config: bad YAML and a svc_x collision refused (400); custom-hello saved through the preflight (sha ${saved.json.sha256.slice(0, 12)}…); no file-provider error in the Traefik log`);
  const cleared = await api(p, { method: 'DELETE', token });
  if (cleared.status !== 200 || cleared.json?.cleared !== true) fail(`DELETE ${p} answered ${cleared.status} ${cleared.text.slice(0, 200)}`);
  if ((await api(p, { token })).json?.status !== 'none') fail('the custom config still reports a status after DELETE');
  step('custom config cleared (status none)');
}

/** Uploaded certificates: the fixture is accepted and listed, a mismatched key is refused. */
async function customCertificateChecks(token) {
  const p = '/v1/traefik/certificates/custom';
  const certPem = certFixture('valid.crt');
  const mismatch = await api(p, { method: 'POST', token, body: { name: `smoke-mismatch-${suffix}`, certPem, keyPem: certFixture('other.key') } });
  if (mismatch.status !== 400) fail(`a certificate with a key that does not match answered ${mismatch.status} ${mismatch.text.slice(0, 200)} (wanted 400)`);
  const up = await api(p, { method: 'POST', token, body: { name: `smoke-cert-${suffix}`, certPem, keyPem: certFixture('valid.key') } });
  if (up.status !== 201 || !up.json?.hostnames?.includes('app.example.test') || up.json.expired !== false) {
    fail(`the fixture certificate upload answered ${up.status} ${up.text.slice(0, 300)} (wanted 201 for app.example.test)`);
  }
  const listed = (await api(p, { token })).json;
  if (!Array.isArray(listed) || !listed.some((c) => c.id === up.json.id && c.fingerprint === up.json.fingerprint)) {
    fail(`the uploaded certificate #${up.json.id} is not listed: ${JSON.stringify(listed).slice(0, 300)}`);
  }
  if (!traefikFile('dynamic/certificates.yml').includes('BEGIN CERTIFICATE')) fail('dynamic/certificates.yml is not visible to the panel\'s Traefik after the upload');
  const del = await api(`${p}/${up.json.id}`, { method: 'DELETE', token });
  if (del.status !== 200) fail(`certificate delete answered ${del.status} ${del.text.slice(0, 200)}`);
  if ((await api(p, { token })).json?.some((c) => c.id === up.json.id)) fail(`certificate #${up.json.id} is still listed after DELETE`);
  step(`custom certificates: a mismatched key refused (400); the fixture uploaded (201, ${up.json.hostnames.join(', ')}), listed, written to certificates.yml and deleted`);
}

/** Public access on one postgres: refusals, a sidecar on :15432, DELETE, and a recorded TLS-terminate attempt. */
async function publicAccessChecks(token, databaseId, { seeded = false } = {}) {
  const dbRow = (await api(`/v1/databases/${databaseId}`, { token })).json;
  if (!dbRow?.slug) fail(`GET /v1/databases/${databaseId} has no slug: ${JSON.stringify(dbRow).slice(0, 200)}`);
  const sidecar = `nd-dbpub-${dbRow.slug}`;
  const p = `/v1/databases/${databaseId}/public-access`;
  const g0 = await api(p, { token });
  if (g0.status !== 200) fail(`GET ${p} answered ${g0.status} ${g0.text.slice(0, 200)}`);
  if (seeded) {
    // A 0.14+ FROM enabled it before the upgrade: it must still be up.
    if (g0.json?.enabled !== true || g0.json.status !== 'running' || g0.json.port !== PUBLIC_PORT) fail(`public access seeded on the FROM side: ${g0.text.slice(0, 300)}`);
    if ((await api(p, { method: 'DELETE', token })).status !== 200) fail('DELETE of the FROM-seeded public access failed');
  } else if (g0.json?.configured !== false || g0.json.supported !== true || g0.json.status !== 'off') {
    fail(`postgres #${databaseId} should report public access configured:false, got ${g0.text.slice(0, 300)}`);
  }
  for (const [label, body] of [
    ['an empty allow-list', { enabled: true, port: PUBLIC_PORT, ipAllowlist: [] }],
    ['0.0.0.0/0', { enabled: true, port: PUBLIC_PORT, ipAllowlist: ['0.0.0.0/0'] }],
    ['port 443', { enabled: true, port: 443, ipAllowlist: ALLOW }],
  ]) {
    const r = await api(p, { method: 'PUT', token, body });
    if (r.status !== 400) fail(`public access PUT with ${label} answered ${r.status} ${r.text.slice(0, 200)} (wanted 400)`);
  }
  if (dindContainer(sidecar)) fail(`a refused public access PUT left ${sidecar} behind`);
  const on = await api(p, { method: 'PUT', token, body: { enabled: true, port: PUBLIC_PORT, ipAllowlist: ALLOW, tlsMode: 'none' } });
  if (on.status !== 200 || on.json?.enabled !== true || on.json.port !== PUBLIC_PORT || on.json.status !== 'running' || JSON.stringify(on.json.ipAllowlist) !== JSON.stringify(ALLOW)) {
    fail(`public access PUT on :${PUBLIC_PORT} answered ${on.status} ${on.text.slice(0, 400)}`);
  }
  if (dindContainer(sidecar, { running: true }) !== sidecar) fail(`${sidecar} is not running in the daemon after the PUT`);
  const ports = dindRun(['port', sidecar]).stdout;
  if (!new RegExp(`:${PUBLIC_PORT}\\b`).test(ports)) fail(`docker port ${sidecar} does not publish ${PUBLIC_PORT}: ${ports || '(none)'}`);
  const summary = (await api(`/v1/databases/${databaseId}`, { token })).json?.publicAccess;
  if (summary?.enabled !== true || summary.port !== PUBLIC_PORT) fail(`GET /v1/databases/${databaseId} publicAccess is ${JSON.stringify(summary)}`);
  const goneAfter = async (label) => {
    const off = await api(p, { method: 'DELETE', token });
    if (off.status !== 200 || off.json?.ok !== true) fail(`${label}: public access DELETE answered ${off.status} ${off.text.slice(0, 200)}`);
    for (let i = 0; i < 15 && dindContainer(sidecar); i++) await sleep(1000);
    if (dindContainer(sidecar)) fail(`${label}: ${sidecar} still exists after DELETE`);
  };
  await goneAfter(`:${PUBLIC_PORT}`);
  const g1 = (await api(p, { token })).json;
  if (g1?.configured !== true || g1.enabled !== false || g1.status !== 'off') fail(`public access after DELETE: ${JSON.stringify(g1).slice(0, 300)}`);
  step(`public access: empty allow-list, 0.0.0.0/0 and port 443 refused (400); ${sidecar} ran publishing ${ports.split(/\r?\n/)[0]}; DELETE removed it (configured, enabled:false)`);
  // TLS terminate for postgres rides Traefik's Postgres STARTTLS support, which
  // the design marks unverified: the answer is recorded, no handshake is tried.
  const tls = await api(p, { method: 'PUT', token, body: { enabled: true, port: PUBLIC_TLS_PORT, ipAllowlist: ALLOW, tlsMode: 'terminate' } });
  step(`recorded: postgres tlsMode=terminate on :${PUBLIC_TLS_PORT} answered ${tls.status} (status ${tls.json?.status ?? '-'}, ${tls.status === 200 ? 'expected' : `UNEXPECTED: ${tls.text.slice(0, 200)}`})`);
  if (tls.status === 200 && !new RegExp(`:${PUBLIC_TLS_PORT}\\b`).test(dindRun(['port', sidecar]).stdout)) fail(`the terminate-mode sidecar does not publish ${PUBLIC_TLS_PORT}`);
  await goneAfter(`terminate :${PUBLIC_TLS_PORT}`);
}

/** A one-chunk plain-SQL import into the postgres completes, behind a pre-import backup. */
async function importChecks(token, databaseId) {
  const dbRow = (await api(`/v1/databases/${databaseId}`, { token })).json;
  const container = dbRow?.containerName ?? dbRow?.host;
  if (!container) fail(`GET /v1/databases/${databaseId} names no container: ${JSON.stringify(dbRow).slice(0, 200)}`);
  const rows = 3;
  const sql = Buffer.from(
    "CREATE TABLE smoke_t (id integer PRIMARY KEY, label text NOT NULL);\nINSERT INTO smoke_t (id, label) VALUES (1, 'one'), (2, 'two'), (3, 'three');\n",
    'utf8',
  );
  const base = `/v1/databases/${databaseId}/imports`;
  const created = await api(base, {
    method: 'POST',
    token,
    body: { source: 'upload', sizeBytes: sql.length, sha256: createHash('sha256').update(sql).digest('hex'), filename: 'smoke.sql', options: {} },
  });
  if (created.status !== 201 || created.json?.status !== 'uploading' || !(created.json.chunkSize >= sql.length)) {
    fail(`import create answered ${created.status} ${created.text.slice(0, 300)} (wanted 201 uploading)`);
  }
  const importId = created.json.id;
  const chunk = await apiRaw(`${base}/${importId}/chunks/0`, { token, body: sql });
  if (chunk.status !== 200 || chunk.json?.status !== 'pending' || chunk.json.receivedBytes !== sql.length) {
    fail(`import chunk 0 answered ${chunk.status} ${chunk.text.slice(0, 300)} (wanted 200 pending)`);
  }
  const start = await api(`${base}/${importId}/start`, { method: 'POST', token });
  if (start.status !== 202) fail(`import start answered ${start.status} ${start.text.slice(0, 300)} (wanted 202)`);
  let row = start.json;
  for (let i = 0; i < 180 && (row?.status === 'pending' || row?.status === 'running'); i++) {
    await sleep(1000);
    row = (await api(`${base}/${importId}`, { token })).json;
  }
  if (row?.status !== 'completed' || row.format !== 'pg_plain' || typeof row.safetyBackupId !== 'number') {
    fail(`import #${importId} ended as ${JSON.stringify(row).slice(0, 400)} (wanted completed pg_plain with a safety backup)`);
  }
  const count = dindRun(['exec', container, 'psql', '-U', 'nine', '-d', 'app', '-tAc', 'select count(*) from smoke_t']);
  if (count.status !== 0 || count.stdout !== String(rows)) fail(`select count(*) from smoke_t in ${container}: ${count.all.slice(0, 200)} (wanted ${rows})`);
  const backups = (await api(`/v1/databases/${databaseId}/backups`, { token })).json;
  const safety = Array.isArray(backups) ? backups.find((b) => b.id === row.safetyBackupId) : null;
  if (safety?.status !== 'completed') fail(`the pre-import backup #${row.safetyBackupId} is ${JSON.stringify(safety)} (wanted completed)`);
  if (!(await api(base, { token })).json?.some((r) => r.id === importId)) fail(`import #${importId} is not listed`);
  step(`import: ${sql.length}-byte plain SQL in one chunk → completed; smoke_t holds ${rows} rows in ${container}; pre-import backup #${safety.id} completed`);
}

/** Secret managers: both unconfigured, a Vault on a reserved host tests ok:false, a bad AWS region is refused. */
async function secretProviderChecks(token) {
  const p = '/v1/settings/secret-providers';
  const legacy0 = await api('/v1/settings/vault', { token });
  if (legacy0.status !== 200) fail(`GET /v1/settings/vault answered ${legacy0.status} ${legacy0.text.slice(0, 200)}`);
  const kinds = (list) => (Array.isArray(list) ? list.map((x) => `${x.kind}:${x.configured}`).sort().join(',') : JSON.stringify(list));
  const l0 = await api(p, { token });
  if (l0.status !== 200 || kinds(l0.json) !== 'aws:false,vault:false') fail(`GET ${p} should list both kinds unconfigured, got ${l0.status} ${l0.text.slice(0, 300)}`);
  const vaultToken = `hvs.smoke${suffix}`;
  const vault = await api(`${p}/vault`, { method: 'PUT', token, body: { config: { address: 'https://vault.invalid', authMethod: 'token' }, credentials: { token: vaultToken } } });
  if (vault.status !== 200 || vault.json?.configured !== true || vault.json.hasCredential !== true) fail(`PUT ${p}/vault answered ${vault.status} ${vault.text.slice(0, 300)}`);
  if (vault.text.includes(vaultToken)) fail('the Vault token was echoed back by PUT');
  const test = await api(`${p}/vault/test`, { method: 'POST', token, body: {} });
  if (test.status !== 200 || test.json?.ok !== false) fail(`the Vault test against vault.invalid answered ${test.status} ${test.text.slice(0, 300)} (wanted 200 ok:false)`);
  if (test.text.includes(vaultToken)) fail('the Vault test result leaked the token');
  const aws = await api(`${p}/aws`, {
    method: 'PUT',
    token,
    body: { config: { region: 'mars-north-1x' }, credentials: { accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: `smoke-${suffix}` } },
  });
  if (aws.status !== 400) fail(`PUT ${p}/aws with a bad region answered ${aws.status} ${aws.text.slice(0, 200)} (wanted 400)`);
  const l1 = (await api(p, { token })).json;
  if (kinds(l1) !== 'aws:false,vault:true') fail(`GET ${p} after the saves: ${JSON.stringify(l1).slice(0, 300)}`);
  const legacy1 = await api('/v1/settings/vault', { token });
  if (legacy1.status !== 200 || legacy1.text !== legacy0.text) fail(`GET /v1/settings/vault changed: ${legacy0.text.slice(0, 200)} → ${legacy1.text.slice(0, 200)}`);
  const del = await api(`${p}/vault`, { method: 'DELETE', token });
  if (del.status !== 200 || del.json?.deleted !== true) fail(`DELETE ${p}/vault answered ${del.status} ${del.text.slice(0, 200)}`);
  if (kinds((await api(p, { token })).json) !== 'aws:false,vault:false') fail('the Vault provider is still configured after DELETE');
  step(`secret managers: both unconfigured; Vault on vault.invalid saved and tests ok:false (${String(test.json.detail).slice(0, 80)}); a bad AWS region refused (400); /v1/settings/vault unchanged; Vault deleted`);
}

/**
 * Rollback rehearsal (FROM ≥ 0.14 → TO < 0.14): what docs/ROLLBACK.md tells
 * the operator to expect, proven. The older release puts its Traefik back on
 * the single-file provider and ignores the 0.14 tables, so the public-db
 * sidecar keeps running until the runbook command removes it. (The domain
 * listing and migration 0070 being left alone are asserted by the caller.)
 */
async function rollbackChecks({ sidecar }) {
  let staticCfg = '';
  for (let i = 0; i < 60; i++) {
    staticCfg = traefikFile('traefik.yml');
    if (/^\s*filename:/m.test(staticCfg)) break;
    await sleep(1000);
  }
  if (!/^\s*filename:/m.test(staticCfg)) fail(`after the rollback Traefik's static config has no \`filename:\`: ${staticCfg.slice(0, 400) || '(traefik.yml not readable in the traefik container)'}`);
  const leftovers = dindRun(['exec', TRAEFIK, 'ls', '/etc/traefik/dynamic']).stdout.split(/\s+/).filter(Boolean);
  step(`rollback: Traefik is back on \`filename:\`; left behind in <data>/traefik/dynamic: ${leftovers.join(', ') || '(nothing)'} (runbook: rm -rf <data>/traefik/dynamic)`);
  if (dindContainer(sidecar, { running: true }) !== sidecar) fail(`after the rollback ${sidecar} is not running (0.13 should not know about it)`);
  // The runbook command, verbatim, inside the DinD sidecar.
  const runbook = spawnSync('docker', [
    'exec', '-e', 'DOCKER_HOST=tcp://127.0.0.1:2375', DIND, 'sh', '-c',
    'docker rm -f $(docker ps -aq --filter label=ninedeploy.public-db)',
  ], { encoding: 'utf8', timeout: 120_000 });
  if (runbook.status !== 0) fail(`the runbook command failed (${runbook.status}): ${(runbook.stderr || runbook.stdout || '').slice(0, 300)}`);
  const remaining = dindRun(['ps', '-aq', '--filter', 'label=ninedeploy.public-db']).stdout;
  if (remaining) fail(`containers labelled ninedeploy.public-db survived the runbook command: ${remaining}`);
  step(`rollback: ${sidecar} kept running on the older release; the runbook command removed it`);
}

async function main() {
  console.log(`Upgrade smoke: ${image(FROM)} → ${image(TO)}`);
  step(`topology: network ${NET}, dind ${DIND}, panel ${PANEL} (:${PANEL_PORT}), volume ${VOLUME}`);

  pullOrFail(FROM, 'from');
  pullOrFail(TO, 'to');
  step(`pulled ${image(FROM)} and ${image(TO)}`);

  // ── bring up DinD ───────────────────────────────────────────────────────
  docker(['network', 'create', NET]);
  docker(['volume', 'create', VOLUME]);
  // The panel's data volume at the same path in the sidecar: the daemon then
  // resolves `-v /data/traefik:/etc/traefik` to the files the panel wrote.
  docker(['run', '-d', '--name', DIND, '--network', NET, '--privileged', '-v', `${VOLUME}:/data`, 'docker:28-dind', 'dockerd', '--host=tcp://0.0.0.0:2375']);
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

  // 0.13 seed: a PAT source with a dummy token (POST /v1/sources and its
  // test route exist on v0.10.45). It must list and test the same afterwards.
  const pat = await api('/v1/sources', { method: 'POST', token, body: { name: `upgrade-pat-${suffix}`, type: 'github', token: `ghp_upgrade${suffix}dummy`, defaultBranch: 'main' } });
  if (pat.status !== 200 && pat.status !== 201) fail(`${FROM}: PAT source create failed: ${pat.status} ${pat.text.slice(0, 200)}`);
  const patSourceId = pat.json?.id;
  if (!patSourceId || pat.json?.hasToken !== true) fail(`${FROM}: PAT source create returned ${pat.text.slice(0, 200)}`);
  step(`seeded PAT source #${patSourceId} (dummy token)`);

  // 0.14 seed, only on a FROM that has it (the rollback rehearsal, or a
  // 0.14.x → 0.14.y upgrade): public access on the postgres and a custom config.
  let seeded014 = null;
  if (!olderThan(FROM, NETWORK_DATA_IN)) {
    const slug = (await api(`/v1/databases/${databaseId}`, { token })).json?.slug;
    if (!slug) fail(`${FROM}: GET /v1/databases/${databaseId} has no slug`);
    const pa = await api(`/v1/databases/${databaseId}/public-access`, { method: 'PUT', token, body: { enabled: true, port: PUBLIC_PORT, ipAllowlist: ALLOW, tlsMode: 'none' } });
    if (pa.status !== 200 || pa.json?.status !== 'running') fail(`${FROM}: public access PUT answered ${pa.status} ${pa.text.slice(0, 300)}`);
    const cc = await api('/v1/traefik/custom-config', { method: 'PUT', token, body: { content: HELLO_CONFIG } });
    if (cc.status !== 200 || cc.json?.status !== 'applied') fail(`${FROM}: custom config PUT answered ${cc.status} ${cc.text.slice(0, 300)}`);
    seeded014 = { sidecar: `nd-dbpub-${slug}` };
    if (dindContainer(seeded014.sidecar, { running: true }) !== seeded014.sidecar) fail(`${FROM}: ${seeded014.sidecar} is not running after the PUT`);
    step(`seeded 0.14 state: public access on postgres #${databaseId} (${seeded014.sidecar} on :${PUBLIC_PORT}) and a custom-hello custom config`);
  }

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

  // ── 0.13 GitHub App + Gitea on FROM-era data (no real GitHub) ──────────
  if (olderThan(TO, GITHUB_APP_IN)) {
    step(`${TO} predates the GitHub App (0.13): GitHub checks skipped`);
  } else {
    const patAfter = (await api('/v1/sources', { token })).json?.find((s) => s.id === patSourceId);
    if (!patAfter || patAfter.type !== 'github' || patAfter.hasToken !== true || patAfter.name !== `upgrade-pat-${suffix}`) {
      fail(`the ${FROM} PAT source #${patSourceId} did not survive the upgrade: ${JSON.stringify(patAfter)}`);
    }
    if (patAfter.baseUrl != null) fail(`the ${FROM} PAT source #${patSourceId} gained a baseUrl: ${patAfter.baseUrl}`);
    // The dummy token is refused by GitHub (or GitHub is unreachable): either way ok:false, never a 500.
    const patTest = await api(`/v1/sources/${patSourceId}/test`, { token });
    if (patTest.status !== 200 || patTest.json?.ok !== false) fail(`the ${FROM} PAT source test answered ${patTest.status} ${patTest.text.slice(0, 200)} (wanted 200 ok:false)`);
    step(`${FROM} PAT source #${patSourceId} lists unchanged; its test answers ok:false (${patTest.json?.status ?? 'unreachable'}) without a 500`);
    await githubSurfaceChecks(token);
  }

  // ── 0.14 network and data access on FROM-era data, or the rollback ─────
  if (!olderThan(TO, NETWORK_DATA_IN)) {
    await traefikDirectoryChecks(`upgrade-${suffix}.test`);
    await customConfigChecks(token);
    await customCertificateChecks(token);
    await publicAccessChecks(token, databaseId, { seeded: seeded014 !== null });
    await importChecks(token, databaseId);
    await secretProviderChecks(token);
  } else if (seeded014) {
    await rollbackChecks(seeded014);
  } else {
    step(`${TO} predates network and data access (0.14): 0.14 checks skipped`);
  }

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
  if (!olderThan(TO, NETWORK_DATA_IN) || seeded014) {
    // Upgrade: 0070 applied once. Rollback: the older release neither re-ran
    // nor removed it, and kept the 0.14 rows it does not read.
    if (post.migration0070 !== 1 || post.networkTables !== 4) {
      fail(`migration 0070: ${post.migration0070} journal record(s), ${post.networkTables}/4 tables (wanted 1 and 4)`);
    }
    if (seeded014 && post.publicAccessRows !== 1) fail(`the FROM public access row is gone (${post.publicAccessRows} rows)`);
    step(`${TO} db: migration 0070 recorded once with its 4 tables${seeded014 ? `; the FROM public access row kept (${post.publicAccessRows})` : ''}`);
  }

  console.log(`\n✓ Upgrade green: ${FROM} → ${TO} keeps users, services, history, domains and running apps; migrates; recovers the interrupted deploy; deploys again; 0.12 backup policy, preview env, disk alert and panel-backup defaults work on the upgraded data; 0.13 GitHub App/Gitea surfaces answer without GitHub${olderThan(TO, NETWORK_DATA_IN) ? (seeded014 ? '; the 0.14 rollback leaves 0070 alone and the runbook removes the public-db sidecar' : '') : '; 0.14 Traefik directory provider, custom config, certificates, public access, import and secret managers work on the upgraded data'}`);
}

main()
  .catch((err) => { console.error(`\n✗ upgrade smoke aborted: ${err?.message ?? err}`); process.exitCode = 1; })
  .finally(() => {
    for (const c of [PANEL, DIND]) docker(['rm', '-f', c], { allowFail: true });
    docker(['volume', 'rm', VOLUME], { allowFail: true });
    docker(['network', 'rm', NET], { allowFail: true });
  });
