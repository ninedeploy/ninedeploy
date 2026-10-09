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
// 0.15 (only when TO is 0.15 or later; FROM-side seeding stays on routes
// v0.10.45 has, plus the 0.15 seed below on a 0.15 FROM):
//   - O3: with analytics off the upgrade leaves ninedeploy-traefik alone —
//     same container id and StartedAt, byte-identical traefik.yml (from a
//     FROM with the 0.14 directory provider; an older FROM gets 0.14's own
//     one-time recreate) — and the static config says `accessLog: {}`;
//   - terminals: settings default off; a host shell 403 host_terminal_disabled;
//     a service shell over protocol v1 (global WebSocket, ticket subprotocol)
//     echoes a computed marker, honours a resize and closes 1000 on `exit`;
//     the row is ended/shell_exited with bytes and the create/start/end
//     audits; a reused ticket closes 4401; a dropped socket leaves no shell
//     process in the container (the HUP/KILL cleanup);
//   - host shells: a wrong password 403, enabled with the smoke password, one
//     nsenter shell (inside DinD) audited as security.host_terminal and its
//     helper removed — or the 422 recorded — then disabled again; the helper
//     image's `nsenter --help` exit code is recorded;
//   - traffic analytics: off by default; enabling recreates Traefik once with
//     the log mount; 20 requests through Traefik are counted per service and
//     instance-wide within 30 s; a raw log line has RouterName and
//     DownstreamStatus and no client address, path or headers; USR1 reopen is
//     recorded; disabling recreates Traefik on the byte-identical config;
//   - OpenAPI: 401 without auth, 3.1.x with every path holding an operation,
//     ETag → 304;
//   - grants: a seatless guest is 404; a viewer grant on a project linked to
//     the service lets them read (200) but not write (403) and gives no
//     workspace-level right; suspending it brings the 404 back, reinstating
//     it the 200, and revoking it the 404 again.
// Rollback rehearsal (FROM ≥ 0.15, TO < 0.15): FROM enables analytics, grants
// a seatless guest viewer on the service's project and leaves a shell open
// across the hard kill; then TO boots, leaves migration 0071 recorded with its
// rows, recreates Traefik without the traffic mount and still routes the
// domain, refuses the guest, and the terminal-helper runbook command removes
// a labelled helper and exits 0 when there is none. Left-behind
// <data>/traffic-logs and the open shell's fate are recorded.
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
//        rollback rehearsal: --from=v0.15.0 --from-image=<local candidate> --to=v0.14.0
//        (Node 22+: the 0.15 terminal checks use the global WebSocket)
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
/** 0.15's migration (operations and API): the same rule for a 0.15 → 0.14 rollback. */
const MIGRATION_0071 = journal.entries.find((e) => e.tag.startsWith('0071_')) ?? null;

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
    // 0.15: migration 0071's three tables, its record, and the FROM grant rows.
    const operationsTables = Number((await one(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('access_grants', 'terminal_sessions', 'traffic_rollups')",
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
      operationsTables,
      migration0071: MIGRATION_0071
        ? Number((await one(`SELECT count(*) AS n FROM __drizzle_migrations WHERE created_at = ${Number(MIGRATION_0071.when)}`)).n)
        : 0,
      accessGrantRows: operationsTables === 3 ? Number((await one('SELECT count(*) AS n FROM access_grants')).n) : 0,
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

// 0.15: operations and API — terminals, traffic analytics, the OpenAPI
// document and project access grants. Offline-safe like the 0.14 block: the
// shell runs in the smoke's own nginx container, the host shell (if it can be
// enabled) enters the DinD sidecar's namespaces, the HTTP requests go from the
// panel container to Traefik inside DinD, and the guest is a local account.
// The terminal client is Node's global WebSocket (Node 22+), offering the v1
// subprotocol and the single-use ticket exactly as lib/terminalProtocol.ts
// expects. Shared verbatim by smoke-upgrade.mjs and smoke-user-journey.mjs.
const OPERATIONS_IN = [0, 15, 0];
const TERMINAL_PROTOCOL = 'ninedeploy.terminal.v1';
const TERMINAL_TICKET_PREFIX = 'ninedeploy.ticket.';
/** Where the panel's Traefik writes the analytics access log (engine/proxy.ts TRAFFIC_LOG_CONTAINER_DIR). */
const TRAFFIC_MOUNT = '/var/log/ninedeploy-traffic';
/** Label on every host-shell helper container (lib/dockerTty.ts TERMINAL_SESSION_LABEL). */
const TERMINAL_HELPER_LABEL = 'ninedeploy.terminal.session';
/** The default host-shell helper image: the Traefik image the panel already pulled. */
const HELPER_IMAGE = 'traefik:3';
/** Access-log fields that would carry client or request data (T3: none may reach the file). */
const TRAFFIC_FORBIDDEN_FIELDS = ['ClientAddr', 'ClientHost', 'ClientPort', 'ClientUsername', 'RequestAddr', 'RequestPath'];

const rnd = () => 100 + Math.floor(Math.random() * 9000);
async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (pred()) return true;
    if (Date.now() > end) return false;
    await sleep(100);
  }
}

/** A command inside the panel container (it has curl and can reach DinD by name). */
function panelRun(args) {
  const r = spawnSync('docker', ['exec', PANEL, ...args], { encoding: 'utf8', timeout: 120_000, maxBuffer: 32 << 20 });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), all: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() };
}

/** The panel's Traefik container as the DinD daemon sees it. */
function traefikState() {
  const r = dindRun(['inspect', TRAEFIK, '--format', '{{.Id}}|{{.State.StartedAt}}|{{.State.Running}}|{{range .Mounts}}{{.Destination}},{{end}}']);
  const [id = '', startedAt = '', running = '', mounts = ''] = r.status === 0 ? r.stdout.split('|') : [];
  return { id, startedAt, running: running === 'true', mounts: mounts.split(',').filter(Boolean) };
}

/** HTTP status codes of `n` requests for `hostname` through the panel's Traefik (curl does not follow redirects). */
function routeStatuses(hostname, n) {
  const r = panelRun(['sh', '-c', `for i in $(seq 1 ${n}); do curl -s -o /dev/null -m 5 -w '%{http_code}\\n' -H 'Host: ${hostname}' http://${DIND}:80/; done`]);
  return r.stdout.split(/\s+/).filter(Boolean);
}
const served = (code) => /^[23]\d\d$/.test(code);

/** Audit rows of one action (GET /v1/activity), meta parsed. */
async function auditEntries(token, action) {
  const r = await api(`/v1/activity?action=${encodeURIComponent(action)}`, { token });
  if (r.status !== 200) fail(`GET /v1/activity?action=${action} answered ${r.status} ${r.text.slice(0, 200)}`);
  return (r.json?.entries ?? []).map((e) => {
    let meta = e.meta;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch { meta = {}; }
    }
    return { ...e, meta: meta ?? {} };
  });
}
async function waitAudit(token, action, sessionId) {
  let hit = null;
  for (let i = 0; i < 20 && !hit; i++) {
    hit = (await auditEntries(token, action)).find((e) => e.meta?.sessionId === sessionId) ?? null;
    if (!hit) await sleep(500);
  }
  if (!hit) fail(`no ${action} audit row for terminal session #${sessionId}`);
  return hit;
}

/**
 * Attach to a terminal session over protocol v1: binary frames are stdin and
 * output, text frames are JSON control messages (`ready`, `notice`, `exit`).
 */
function terminalAttach(created) {
  if (typeof WebSocket !== 'function') fail('the 0.15 terminal checks need Node 22+ (global WebSocket)');
  const ws = new WebSocket(`ws://127.0.0.1:${PANEL_PORT}${created.attachPath}`, [TERMINAL_PROTOCOL, `${TERMINAL_TICKET_PREFIX}${created.ticket}`]);
  ws.binaryType = 'arraybuffer';
  const state = { out: '', ready: null, exit: null, close: null, notices: [] };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch { /* not ours */ }
      if (msg?.t === 'ready') state.ready = msg;
      else if (msg?.t === 'exit') state.exit = msg;
      else if (msg?.t === 'notice') state.notices.push(msg.message);
    } else {
      state.out += Buffer.from(ev.data).toString('utf8');
    }
  };
  ws.onclose = (ev) => { state.close = { code: ev.code, reason: ev.reason }; };
  ws.onerror = () => { /* surfaced through onclose */ };
  return {
    ws,
    state,
    type: (text) => ws.send(Buffer.from(text, 'utf8')),
    control: (msg) => ws.send(JSON.stringify(msg)),
    /** Wait for `ready`; fail with the close code and notices otherwise. */
    async ready(label) {
      await waitFor(() => state.ready || state.close, 30_000);
      if (!state.ready) fail(`${label}: no ready frame (close ${state.close?.code ?? 'none'} ${state.close?.reason ?? ''}; notices: ${state.notices.join(' | ') || 'none'})`);
      if (ws.protocol !== TERMINAL_PROTOCOL) fail(`${label}: the server selected subprotocol "${ws.protocol}" (wanted ${TERMINAL_PROTOCOL}; the ticket must never be echoed)`);
    },
  };
}

/** POST /v1/terminals → 201 with a pending session and a single-use ticket. */
async function openTerminal(token, body, label) {
  const r = await api('/v1/terminals', { method: 'POST', token, body });
  if (r.status !== 201 || !r.json?.ticket || r.json.session?.status !== 'pending' || r.json.attachPath !== `/v1/terminals/${r.json.session.id}/attach`) {
    fail(`${label}: POST /v1/terminals answered ${r.status} ${r.text.slice(0, 300)} (wanted 201 with a pending session and a ticket)`);
  }
  return r.json;
}

/** GET /v1/terminals/:id until the session left pending/active. */
async function endedSession(token, id) {
  let row = null;
  for (let i = 0; i < 30; i++) {
    row = (await api(`/v1/terminals/${id}`, { token })).json;
    if (row && row.status !== 'pending' && row.status !== 'active') return row;
    await sleep(500);
  }
  return fail(`terminal session #${id} is still ${row?.status} after the socket closed`);
}

/** The state letter of `pid` inside `container` ('gone' when it no longer exists). */
function pidState(container, pid) {
  const r = dindRun(['exec', container, 'sh', '-c', `grep '^State' /proc/${pid}/status 2>/dev/null || echo gone`]);
  if (r.status !== 0) return `unknown (${r.all.slice(0, 120)})`;
  return /gone/.test(r.stdout) ? 'gone' : (/State:\s*(\S)/.exec(r.stdout)?.[1] ?? r.stdout);
}
const pidLive = (s) => s !== 'gone' && s !== 'Z' && s !== 'X' && !s.startsWith('unknown');

/** Echo a computed marker plus the shell's PID; returns the PID. */
async function echoPid(t, label) {
  const a = rnd();
  const b = rnd();
  const want = new RegExp(`nd-smoke-${a + b} nd-pid-(\\d+)`);
  t.type(`echo nd-smoke-$((${a}+${b})) nd-pid-$$\r`);
  if (!(await waitFor(() => want.test(t.state.out), 15_000))) fail(`${label}: the echo never came back (output tail: ${JSON.stringify(t.state.out.slice(-300))})`);
  return { marker: `nd-smoke-${a + b}`, pid: Number(want.exec(t.state.out)[1]) };
}

/**
 * Terminals on a running docker service: settings defaults, the host shell
 * refused while disabled, a v1 round trip with a resize, the ended row and its
 * three audits, a reused ticket refused, and the shell gone after the socket
 * drops (the HUP/KILL cleanup, T2a's open risk).
 */
async function terminalChecks(token, serviceId) {
  const s0 = await api('/v1/terminals/settings', { token });
  if (s0.status !== 200 || s0.json?.hostTerminalEnabled !== false || s0.json.hostTerminalForbiddenByEnv !== false) {
    fail(`GET /v1/terminals/settings should report host shells off, got ${s0.status} ${s0.text.slice(0, 300)}`);
  }
  const host0 = await api('/v1/terminals', { method: 'POST', token, body: { target: { kind: 'host', serverId: null } } });
  if (host0.status !== 403 || errorCode(host0) !== 'host_terminal_disabled') {
    fail(`a host shell with host shells disabled answered ${host0.status} ${host0.text.slice(0, 200)} (wanted 403 host_terminal_disabled)`);
  }
  step(`terminals: settings default (host shells off, idle ${s0.json.idleTimeoutMinutes} min, max ${s0.json.maxSessionMinutes} min); a host shell is refused (403 host_terminal_disabled)`);

  const svc = (await api(`/v1/services/${serviceId}`, { token })).json;
  const container = svc?.runtimeId;
  if (!container) fail(`service #${serviceId} has no runtimeId: ${JSON.stringify(svc).slice(0, 200)}`);

  // 1. Round trip, resize, exit.
  const created = await openTerminal(token, { target: { kind: 'service', serviceId }, cols: 120, rows: 32 }, 'service shell');
  const id = created.session.id;
  const t = terminalAttach(created);
  await t.ready('service shell');
  if (t.state.ready.sessionId !== id || t.state.ready.target?.kind !== 'service') fail(`ready frame: ${JSON.stringify(t.state.ready)}`);
  const { marker, pid } = await echoPid(t, 'service shell');
  t.control({ t: 'resize', cols: 100, rows: 30 });
  await sleep(800);
  const mark = t.state.out.length;
  t.type('stty size\r');
  await waitFor(() => /\b\d+ \d+\r?\n/.test(t.state.out.slice(mark)), 5000);
  const size = /\b(\d+) (\d+)\r?\n/.exec(t.state.out.slice(mark));
  if (size && `${size[1]} ${size[2]}` !== '30 100') fail(`after a 100x30 resize the shell reports \`stty size\` ${size[1]} ${size[2]} (wanted 30 100)`);
  t.type('exit\r');
  await waitFor(() => t.state.close, 15_000);
  if (t.state.close?.code !== 1000 || t.state.exit?.reason !== 'shell_exited') {
    fail(`after \`exit\` the socket closed with ${JSON.stringify(t.state.close)} and exit frame ${JSON.stringify(t.state.exit)} (wanted 1000, shell_exited)`);
  }
  const row = await endedSession(token, id);
  if (row.status !== 'ended' || row.endReason !== 'shell_exited' || !(row.bytesIn > 0) || !(row.bytesOut > 0) || !(row.durationMs > 0)) {
    fail(`terminal session #${id} ended as ${JSON.stringify(row).slice(0, 400)} (wanted ended, shell_exited, bytes in/out and a duration)`);
  }
  for (const action of ['terminal.session.create', 'terminal.session.start', 'terminal.session.end']) await waitAudit(token, action, id);
  step(`terminal #${id} on ${container}: ready over ${TERMINAL_PROTOCOL}; ${marker} echoed back (shell pid ${pid}); resize → stty ${size ? `${size[1]} ${size[2]}` : 'not answered (recorded)'}; exit → close 1000; row ended/shell_exited, ${row.bytesIn} B in, ${row.bytesOut} B out, ${row.durationMs} ms, exit ${row.exitCode}; create/start/end audited`);

  // 2. The ticket is single use.
  const replay = terminalAttach(created);
  await waitFor(() => replay.state.close, 10_000);
  if (replay.state.close?.code !== 4401 || replay.state.ready) fail(`a reused ticket closed with ${JSON.stringify(replay.state.close)} (wanted 4401, no ready)`);
  step('terminal: the used ticket is refused on a second attach (close 4401)');

  // 3. The socket drops: the shell must not keep running in the container.
  const dropped = await openTerminal(token, { target: { kind: 'service', serviceId } }, 'dropped shell');
  const d = terminalAttach(dropped);
  await d.ready('dropped shell');
  const { pid: dropPid } = await echoPid(d, 'dropped shell');
  const alive = pidState(container, dropPid);
  if (!pidLive(alive)) fail(`the dropped-shell probe cannot see pid ${dropPid} in ${container} before the drop (${alive})`);
  const droppedAt = Date.now();
  d.ws.close();
  const dropRow = await endedSession(token, dropped.session.id);
  if (dropRow.status !== 'ended' || dropRow.endReason !== 'client_closed' || !(dropRow.bytesIn > 0)) {
    fail(`the dropped session #${dropped.session.id} ended as ${JSON.stringify(dropRow).slice(0, 300)} (wanted ended, client_closed)`);
  }
  await waitAudit(token, 'terminal.session.end', dropped.session.id);
  let after = alive;
  for (let i = 0; i < 40 && pidLive(after); i++) {
    await sleep(500);
    after = pidState(container, dropPid);
  }
  if (pidLive(after)) fail(`shell pid ${dropPid} is still running in ${container} (${after}) ${Math.round((Date.now() - droppedAt) / 1000)} s after its socket dropped — the HUP/KILL cleanup did not reach it`);
  step(`terminal #${dropped.session.id}: socket dropped → row ended/client_closed; shell pid ${dropPid} gone from ${container} after ${((Date.now() - droppedAt) / 1000).toFixed(1)} s (${after})`);
}

/**
 * Host shells: refused with a wrong password, enabled with the smoke user's
 * password (step-up), one host shell through the nsenter helper (inside DinD
 * the "host" is the sidecar), the helper removed afterwards, then disabled
 * again. Anything that keeps a host shell from opening is recorded, not
 * failed: it is the documented 422 for an image without nsenter.
 */
async function hostShellChecks(token, password) {
  const nsenter = dindRun(['run', '--rm', '--entrypoint', 'nsenter', HELPER_IMAGE, '--help']);
  step(`recorded: \`nsenter --help\` in ${HELPER_IMAGE} exits ${nsenter.status} (${nsenter.all.split(/\r?\n/)[0]?.slice(0, 80) ?? ''}); the probe treats only 126/127 as "no nsenter"`);
  const p = '/v1/terminals/settings';
  const wrong = await api(p, { method: 'PUT', token, body: { hostTerminalEnabled: true, password: `wrong-${suffix}` } });
  if (wrong.status !== 403 || errorCode(wrong) !== 'invalid_password') fail(`enabling host shells with a wrong password answered ${wrong.status} ${wrong.text.slice(0, 200)} (wanted 403 invalid_password)`);
  const on = await api(p, { method: 'PUT', token, body: { hostTerminalEnabled: true, password } });
  if (on.status !== 200 || on.json?.hostTerminalEnabled !== true) {
    step(`recorded: host shells could not be enabled (${on.status} ${on.text.slice(0, 160)}): host shell NOT exercised`);
    return;
  }
  try {
    const r = await api('/v1/terminals', { method: 'POST', token, body: { target: { kind: 'host', serverId: null }, password } });
    if (r.status === 422) {
      step(`recorded: host shell refused with 422 ${errorCode(r)} (${r.json?.error?.message ?? r.json?.message ?? r.text.slice(0, 160)}): host shell NOT exercised`);
      return;
    }
    if (r.status !== 201) fail(`a host shell with host shells enabled answered ${r.status} ${r.text.slice(0, 300)}`);
    const t = terminalAttach(r.json);
    await t.ready('host shell');
    const a = rnd();
    const b = rnd();
    t.type(`echo nd-host-$((${a}+${b})) uid-$(id -u)\r`);
    const want = new RegExp(`nd-host-${a + b} uid-(\\d+)`);
    if (!(await waitFor(() => want.test(t.state.out), 15_000))) fail(`host shell: the echo never came back (output tail: ${JSON.stringify(t.state.out.slice(-300))})`);
    const uid = want.exec(t.state.out)[1];
    const helpers = dindRun(['ps', '-q', '--filter', `label=${TERMINAL_HELPER_LABEL}=${r.json.session.id}`]).stdout;
    t.type('exit\r');
    await waitFor(() => t.state.close, 15_000);
    if (t.state.close?.code !== 1000) fail(`host shell: \`exit\` closed the socket with ${JSON.stringify(t.state.close)} (wanted 1000)`);
    const row = await endedSession(token, r.json.session.id);
    if (row.status !== 'ended' || row.targetKind !== 'host' || row.endReason !== 'shell_exited') fail(`host session #${row.id} ended as ${JSON.stringify(row).slice(0, 300)}`);
    await waitAudit(token, 'security.host_terminal', row.id);
    let left = 'x';
    for (let i = 0; i < 30 && left; i++) {
      left = dindRun(['ps', '-aq', '--filter', `label=${TERMINAL_HELPER_LABEL}`]).stdout;
      if (left) await sleep(500);
    }
    if (left) fail(`host-shell helper container(s) still exist after the session ended: ${left}`);
    step(`host shell #${row.id}: enabled with a password re-check (a wrong one 403); nsenter helper ${helpers ? 'ran' : 'not listed while open'}; nd-host marker echoed as uid ${uid}; exit → close 1000; security.host_terminal audited; helper removed`);
  } finally {
    const off = await api(p, { method: 'PUT', token, body: { hostTerminalEnabled: false } });
    if (off.status !== 200 || off.json?.hostTerminalEnabled !== false) fail(`disabling host shells answered ${off.status} ${off.text.slice(0, 200)}`);
    step('host shells disabled again');
  }
}

/**
 * Traffic analytics: off by default with the 0.14 static config, one
 * recreate on enable with the access-log mount, N requests counted by the
 * tailer per service and instance-wide, a raw log line without client or
 * request data, then disable recreates Traefik on the byte-identical
 * pre-enable static config. USR1 reopen is recorded (the tailer falls back
 * to truncate-after-read without it).
 */
async function trafficChecks(token, serviceId, hostname) {
  const s0 = await api('/v1/traffic/settings', { token });
  if (s0.status !== 200 || s0.json?.enabled !== false || s0.json.status !== 'off') fail(`GET /v1/traffic/settings should report analytics off, got ${s0.status} ${s0.text.slice(0, 300)}`);
  const before = traefikState();
  const staticBefore = traefikFile('traefik.yml');
  if (!/^accessLog: \{\}$/m.test(staticBefore) || /^\s*filePath:/m.test(staticBefore)) fail(`with analytics off traefik.yml should hold the 0.14 \`accessLog: {}\`: ${staticBefore.slice(0, 400) || '(unreadable)'}`);
  if (before.mounts.includes(TRAFFIC_MOUNT)) fail(`with analytics off Traefik mounts ${TRAFFIC_MOUNT}`);
  step(`traffic: off by default (docker log driver ${s0.json.dockerLogDriver ?? 'unknown'}); traefik.yml has \`accessLog: {}\` and no ${TRAFFIC_MOUNT} mount`);

  const on = await api('/v1/traffic/settings', { method: 'PUT', token, body: { enabled: true } });
  if (on.status !== 200 || on.json?.enabled !== true) fail(`PUT /v1/traffic/settings {enabled:true} answered ${on.status} ${on.text.slice(0, 300)}`);
  const enabled = traefikState();
  const staticOn = traefikFile('traefik.yml');
  if (!enabled.running || !enabled.id || enabled.id === before.id) fail(`enabling analytics did not recreate Traefik (${before.id.slice(0, 12)} → ${enabled.id.slice(0, 12)}, running ${enabled.running})`);
  if (!enabled.mounts.includes(TRAFFIC_MOUNT)) fail(`the recreated Traefik does not mount ${TRAFFIC_MOUNT}: ${enabled.mounts.join(', ')}`);
  if (!staticOn.includes(`filePath: ${TRAFFIC_MOUNT}/access.log`)) fail(`traefik.yml after enable has no access-log filePath: ${staticOn.slice(0, 600)}`);
  step(`traffic enabled: Traefik recreated (${before.id.slice(0, 12)} → ${enabled.id.slice(0, 12)}) with ${TRAFFIC_MOUNT} mounted and the JSON file access log`);

  let first = '';
  for (let i = 0; i < 30 && !served(first); i++) {
    first = routeStatuses(hostname, 1)[0] ?? '';
    if (!served(first)) await sleep(1000);
  }
  if (!served(first)) fail(`${hostname} is not routed by the recreated Traefik (last status ${first || 'none'})`);
  const N = 20;
  const codes = routeStatuses(hostname, N);
  if (codes.length !== N || !codes.every(served)) fail(`${N} requests for ${hostname} answered ${codes.join(',')}`);
  const counted = (j) => (j?.totals?.requests ?? 0) >= N && (j?.totals?.status2xx ?? 0) + (j?.totals?.status3xx ?? 0) >= N;
  const t0 = Date.now();
  let svcTraffic = null;
  while (Date.now() - t0 < 30_000) {
    svcTraffic = (await api(`/v1/services/${serviceId}/traffic?range=1h`, { token })).json;
    if (counted(svcTraffic)) break;
    await sleep(2000);
  }
  if (!counted(svcTraffic)) fail(`GET /v1/services/${serviceId}/traffic?range=1h did not count ${N} requests within 30 s: ${JSON.stringify(svcTraffic?.totals ?? svcTraffic).slice(0, 300)}`);
  const ingestS = ((Date.now() - t0) / 1000).toFixed(1);
  if (svcTraffic.enabled !== true || svcTraffic.granularity !== 60 || !svcTraffic.domains?.some((dm) => dm.host === hostname)) {
    fail(`service traffic: ${JSON.stringify({ enabled: svcTraffic.enabled, granularity: svcTraffic.granularity, domains: svcTraffic.domains }).slice(0, 300)}`);
  }
  const summary = (await api('/v1/traffic/summary?range=1h', { token })).json;
  const top = summary?.topDomains?.find((dm) => dm.serviceId === serviceId);
  if (!(summary?.totals?.requests >= N) || !(top?.requests >= N)) fail(`GET /v1/traffic/summary?range=1h: ${JSON.stringify({ totals: summary?.totals, top }).slice(0, 300)}`);
  const tt = svcTraffic.totals;
  step(`traffic: ${N} requests (${[...new Set(codes)].join('/')}) counted within ${ingestS} s — service ${tt.requests} req (2xx ${tt.status2xx}, 3xx ${tt.status3xx}, 4xx ${tt.status4xx}, 5xx ${tt.status5xx}, p95 ${tt.p95Ms} ms); summary totals ${summary.totals.requests}, top domain ${top.host} ${top.requests}`);

  // T3 open risk: a raw line carries the router and status, never client or request data.
  const raw = panelRun(['sh', '-c', 'head -c 65536 /data/traffic-logs/access.log']);
  const line = raw.stdout.split(/\r?\n/).find((l) => {
    try { return 'RouterName' in JSON.parse(l); } catch { return false; }
  });
  if (!line) fail(`no JSON access-log line with RouterName in /data/traffic-logs/access.log: ${raw.all.slice(0, 300)}`);
  const fields = JSON.parse(line);
  const missing = ['RouterName', 'DownstreamStatus'].filter((k) => !(k in fields));
  const leaked = Object.keys(fields).filter((k) => TRAFFIC_FORBIDDEN_FIELDS.includes(k) || /^(request|downstream|origin)_/.test(k));
  if (missing.length || leaked.length) fail(`access-log line ${line.slice(0, 400)}: missing ${missing.join(',') || '-'}, must not carry ${leaked.join(',') || '-'}`);
  step(`traffic: a raw access-log line keeps ${Object.keys(fields).sort().join(', ')} — no client address, path or headers (RequestHost is kept by design)`);

  // Rotation relies on USR1 reopening the file: recorded, not failed.
  const moved = `access.log.smoke-${suffix}`;
  if (panelRun(['mv', '/data/traffic-logs/access.log', `/data/traffic-logs/${moved}`]).status === 0) {
    dindRun(['kill', '--signal', 'USR1', TRAEFIK]);
    await sleep(1500);
    routeStatuses(hostname, 2);
    await sleep(1000);
    const reopened = panelRun(['sh', '-c', 'wc -l < /data/traffic-logs/access.log']);
    step(`recorded: after rename + USR1, Traefik ${reopened.status === 0 && Number(reopened.stdout) > 0 ? `reopened access.log (${reopened.stdout.trim()} new line(s))` : `did NOT reopen access.log (${reopened.all.slice(0, 120)}) — rotation falls back to truncate-after-read`}`);
    panelRun(['rm', '-f', `/data/traffic-logs/${moved}`]);
  } else {
    step('recorded: access.log could not be renamed from the panel container; USR1 reopen not exercised');
  }
  const stable = traefikState();
  if (stable.id !== enabled.id) fail(`Traefik was recreated again while analytics stayed on (${enabled.id.slice(0, 12)} → ${stable.id.slice(0, 12)})`);

  const off = await api('/v1/traffic/settings', { method: 'PUT', token, body: { enabled: false } });
  if (off.status !== 200 || off.json?.enabled !== false) fail(`PUT /v1/traffic/settings {enabled:false} answered ${off.status} ${off.text.slice(0, 300)}`);
  const disabled = traefikState();
  const staticAfter = traefikFile('traefik.yml');
  if (!disabled.running || disabled.id === enabled.id) fail(`disabling analytics did not recreate Traefik (${enabled.id.slice(0, 12)} → ${disabled.id.slice(0, 12)})`);
  if (disabled.mounts.includes(TRAFFIC_MOUNT)) fail(`Traefik still mounts ${TRAFFIC_MOUNT} after disable`);
  if (staticAfter !== staticBefore) fail(`traefik.yml after disable differs from the pre-enable file:\n--- before\n${staticBefore}\n--- after\n${staticAfter}`);
  let routed = '';
  for (let i = 0; i < 30 && !served(routed); i++) {
    routed = routeStatuses(hostname, 1)[0] ?? '';
    if (!served(routed)) await sleep(1000);
  }
  if (!served(routed)) fail(`${hostname} is not routed after analytics was disabled (last status ${routed || 'none'})`);
  const s1 = (await api('/v1/traffic/settings', { token })).json;
  if (s1?.enabled !== false || s1.status !== 'off') fail(`GET /v1/traffic/settings after disable: ${JSON.stringify(s1).slice(0, 300)}`);
  const leftover = panelRun(['sh', '-c', 'ls -A /data/traffic-logs 2>&1']).stdout.replace(/\s+/g, ' ').trim();
  step(`traffic disabled: Traefik recreated (${enabled.id.slice(0, 12)} → ${disabled.id.slice(0, 12)}) without the mount; traefik.yml byte-identical to the pre-enable file; ${hostname} routes (${routed}); <data>/traffic-logs now holds: ${leftover || '(nothing)'}`);
}

/** OpenAPI 3.1: 401 without auth, the document with auth, an ETag/304 round trip. */
async function openapiChecks(token) {
  const url = `http://127.0.0.1:${PANEL_PORT}/v1/openapi.json`;
  const anon = await fetch(url);
  if (anon.status !== 401) fail(`GET /v1/openapi.json without auth answered ${anon.status} (wanted 401)`);
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const etag = r.headers.get('etag');
  const text = await r.text();
  if (r.status !== 200 || !etag) fail(`GET /v1/openapi.json answered ${r.status} (etag ${etag}): ${text.slice(0, 200)}`);
  let doc = null;
  try { doc = JSON.parse(text); } catch { fail('GET /v1/openapi.json is not JSON'); }
  if (!/^3\.1\.\d+$/.test(String(doc.openapi))) fail(`openapi is ${doc.openapi} (wanted 3.1.x)`);
  const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];
  const paths = Object.entries(doc.paths ?? {});
  if (paths.length === 0) fail('the OpenAPI document has no paths');
  const empty = paths.filter(([, item]) => !METHODS.some((m) => item && typeof item[m] === 'object')).map(([p]) => p);
  if (empty.length) fail(`OpenAPI paths without an operation: ${empty.slice(0, 10).join(', ')}`);
  for (const want of ['/v1/terminals', '/v1/traffic/settings', '/v1/openapi.json']) {
    if (!doc.paths[want]) fail(`the OpenAPI document has no ${want}`);
  }
  const ops = paths.reduce((n, [, item]) => n + METHODS.filter((m) => item[m]).length, 0);
  const undocumented = paths.reduce((n, [, item]) => n + METHODS.filter((m) => item[m]?.['x-ninedeploy-undocumented']).length, 0);
  const again = await fetch(url, { headers: { authorization: `Bearer ${token}`, 'if-none-match': etag } });
  await again.text();
  if (again.status !== 304) fail(`GET /v1/openapi.json with If-None-Match answered ${again.status} (wanted 304)`);
  step(`OpenAPI: 401 without auth; ${doc.openapi} with ${paths.length} paths / ${ops} operations (version ${doc.info?.version}, ${undocumented} undocumented), every path has an operation; ETag → 304`);
}

/** A local account with no seat anywhere, signed in. */
async function createGuest(token, label) {
  const email = `guest-${label}-${suffix}@nd.local`;
  const password = `Guest-${suffix}-0123!`;
  const u = await api('/v1/users', { method: 'POST', token, body: { email, password, name: `Guest ${label}` } });
  if (u.status !== 200 || !u.json?.id) fail(`POST /v1/users for the guest answered ${u.status} ${u.text.slice(0, 200)}`);
  const login = await api('/v1/auth/login', { method: 'POST', body: { email, password } });
  if (login.status !== 200 || !login.json?.tokens?.accessToken) fail(`guest login failed: ${login.status} ${login.text.slice(0, 200)}`);
  return { id: u.json.id, email, password, token: login.json.tokens.accessToken };
}

/** A project in the service's workspace, linked to the service (the grant rule: linked AND tagged into the workspace). */
async function grantProject(token, serviceId, label) {
  const tags = await api(`/v1/services/${serviceId}/tags`, { token });
  if (tags.status !== 200) fail(`GET /v1/services/${serviceId}/tags answered ${tags.status} ${tags.text.slice(0, 200)}`);
  const workspaceId = tags.json.workspaces?.[0]?.id ?? (await api('/v1/workspaces', { token })).json?.[0]?.id;
  if (!workspaceId) fail('the operator has no workspace to grant in');
  const proj = await api('/v1/projects', { method: 'POST', token, body: { name: `smoke-grants-${label}-${suffix}`, workspaceId } });
  const projectId = proj.json?.id ?? proj.json?.project?.id;
  if (!projectId) fail(`project create in workspace #${workspaceId} failed: ${proj.status} ${proj.text.slice(0, 200)}`);
  const ids = (list) => (list ?? []).map((x) => x.id);
  const put = await api(`/v1/services/${serviceId}/tags`, {
    method: 'PUT',
    token,
    body: {
      projectIds: [...new Set([...ids(tags.json.projects), projectId])],
      workspaceIds: [...new Set([...ids(tags.json.workspaces), workspaceId])],
      labelIds: ids(tags.json.labels),
    },
  });
  if (put.status !== 200 || !ids(put.json?.projects).includes(projectId) || !ids(put.json?.workspaces).includes(workspaceId)) {
    fail(`linking service #${serviceId} to project #${projectId} answered ${put.status} ${put.text.slice(0, 300)}`);
  }
  return { workspaceId, projectId };
}

/**
 * Access grants: a guest with no seat sees nothing; a viewer grant on the
 * project lets them read the service, not write it, and gives no
 * workspace-level right; revoking it takes the read away again.
 */
async function grantChecks(token, serviceId) {
  const { workspaceId, projectId } = await grantProject(token, serviceId, 'to');
  const guest = await createGuest(token, 'to');
  const g0 = await api(`/v1/services/${serviceId}`, { token: guest.token });
  if (g0.status !== 404) fail(`a seatless account read service #${serviceId} before any grant: ${g0.status}`);
  const base = `/v1/workspaces/${workspaceId}/access-grants`;
  const created = await api(base, { method: 'POST', token, body: { userId: guest.id, projectId, role: 'viewer' } });
  if (created.status !== 201 || created.json?.role !== 'viewer' || created.json.isGuest !== true || created.json.project?.id !== projectId) {
    fail(`POST ${base} answered ${created.status} ${created.text.slice(0, 300)} (wanted 201, viewer, isGuest)`);
  }
  const grantId = created.json.id;
  const listed = (await api(base, { token })).json;
  if (!Array.isArray(listed) || !listed.some((g) => g.id === grantId)) fail(`grant #${grantId} is not listed: ${JSON.stringify(listed).slice(0, 200)}`);
  const read = await api(`/v1/services/${serviceId}`, { token: guest.token });
  if (read.status !== 200 || read.json?.id !== serviceId) fail(`the viewer guest cannot read service #${serviceId}: ${read.status} ${read.text.slice(0, 200)}`);
  const write = await api(`/v1/services/${serviceId}/env`, { method: 'POST', token: guest.token, body: { key: 'GUEST_WRITE', value: 'x' } });
  if (write.status !== 403) fail(`the viewer guest wrote service #${serviceId} env: ${write.status} ${write.text.slice(0, 200)} (wanted 403)`);
  const wsLevel = [
    ['GET workspace', await api(`/v1/workspaces/${workspaceId}`, { token: guest.token })],
    ['GET its grants', await api(base, { token: guest.token })],
    ['create a project in it', await api('/v1/projects', { method: 'POST', token: guest.token, body: { name: `guest-${suffix}`, workspaceId } })],
  ];
  for (const [label, r] of wsLevel) {
    if (r.status !== 403 && r.status !== 404) fail(`the guest could ${label} #${workspaceId}: ${r.status} ${r.text.slice(0, 200)} (wanted 403/404)`);
  }
  // Suspend keeps the grant listed but stops it counting; reinstate brings it back.
  const suspended = await api(`${base}/${grantId}`, { method: 'PATCH', token, body: { suspended: true } });
  if (suspended.status !== 200 || suspended.json?.suspended !== true) fail(`PATCH ${base}/${grantId} {suspended:true} answered ${suspended.status} ${suspended.text.slice(0, 200)}`);
  const held = await api(`/v1/services/${serviceId}`, { token: guest.token });
  if (held.status !== 404) fail(`with grant #${grantId} suspended the guest still reads service #${serviceId}: ${held.status}`);
  const reinstated = await api(`${base}/${grantId}`, { method: 'PATCH', token, body: { suspended: false } });
  if (reinstated.status !== 200 || reinstated.json?.suspended !== false) fail(`PATCH ${base}/${grantId} {suspended:false} answered ${reinstated.status} ${reinstated.text.slice(0, 200)}`);
  const back = await api(`/v1/services/${serviceId}`, { token: guest.token });
  if (back.status !== 200) fail(`after reinstating grant #${grantId} the guest cannot read service #${serviceId}: ${back.status}`);
  const me = (await api('/v1/access/me', { token: guest.token })).json;
  if (!me?.guestWorkspaces?.some((w) => w.id === workspaceId) || !me.grants?.some((g) => g.id === grantId)) fail(`GET /v1/access/me for the guest: ${JSON.stringify(me).slice(0, 300)}`);
  const del = await api(`${base}/${grantId}`, { method: 'DELETE', token });
  if (del.status !== 200 || del.json?.ok !== true) fail(`DELETE ${base}/${grantId} answered ${del.status} ${del.text.slice(0, 200)}`);
  const gone = await api(`/v1/services/${serviceId}`, { token: guest.token });
  if (gone.status !== 404) fail(`after the revoke the guest still reads service #${serviceId}: ${gone.status}`);
  step(`grants: seatless guest 404 → viewer grant #${grantId} on project #${projectId} (workspace #${workspaceId}, isGuest) → reads the service (200), env write 403, workspace-level ${wsLevel.map(([, r]) => r.status).join('/')}, /access/me lists it → suspended 404 → reinstated 200 → revoked → 404`);
}

/** The leftover-helper runbook command of docs/TERMINALS.md and docs/ROLLBACK.md, verbatim. */
const TERMINAL_HELPER_RUNBOOK = `ids=$(docker ps -aq --filter label=${TERMINAL_HELPER_LABEL}); [ -z "$ids" ] || docker rm -f $ids`;

/**
 * 0.15 seed on a FROM that has it (the rollback rehearsal, or a 0.15.x →
 * 0.15.y upgrade): traffic analytics on (Traefik recreated with the log
 * mount), a viewer grant for a seatless guest on a project linked to the
 * service, and a container shell left open across the hard kill.
 */
async function seedOperations(token, serviceId) {
  const on = await api('/v1/traffic/settings', { method: 'PUT', token, body: { enabled: true } });
  if (on.status !== 200 || on.json?.enabled !== true) fail(`${FROM}: enabling traffic analytics answered ${on.status} ${on.text.slice(0, 300)}`);
  if (!traefikState().mounts.includes(TRAFFIC_MOUNT)) fail(`${FROM}: Traefik does not mount ${TRAFFIC_MOUNT} after enabling analytics`);
  const { workspaceId, projectId } = await grantProject(token, serviceId, 'from');
  const guest = await createGuest(token, 'from');
  const g = await api(`/v1/workspaces/${workspaceId}/access-grants`, { method: 'POST', token, body: { userId: guest.id, projectId, role: 'viewer' } });
  if (g.status !== 201) fail(`${FROM}: the guest grant answered ${g.status} ${g.text.slice(0, 300)}`);
  const read = await api(`/v1/services/${serviceId}`, { token: guest.token });
  if (read.status !== 200) fail(`${FROM}: the granted guest cannot read service #${serviceId}: ${read.status}`);
  // A shell open when the panel is hard-killed: no HUP is ever sent to it.
  const svc = (await api(`/v1/services/${serviceId}`, { token })).json;
  const created = await openTerminal(token, { target: { kind: 'service', serviceId } }, `${FROM} open shell`);
  const t = terminalAttach(created);
  await t.ready(`${FROM} open shell`);
  const { pid } = await echoPid(t, `${FROM} open shell`);
  step(`seeded 0.15 state: traffic analytics on; guest ${guest.email} with viewer grant #${g.json.id} on project #${projectId} reads service #${serviceId}; terminal #${created.session.id} left open (shell pid ${pid})`);
  return { analytics: true, guest, grantId: g.json.id, workspaceId, projectId, sessionId: created.session.id, shell: { container: svc.runtimeId, pid, socket: t } };
}

/**
 * O3: with analytics off, a 0.15 upgrade leaves the panel's Traefik alone. On
 * a FROM with the 0.14 directory provider the container (id and StartedAt)
 * and traefik.yml must be exactly what FROM left; an older FROM gets the 0.14
 * recreate, which is not this release's.
 */
function traefikUntouchedChecks(before, { analytics }) {
  const now = traefikState();
  const staticNow = traefikFile('traefik.yml');
  if (!olderThan(FROM, NETWORK_DATA_IN)) {
    if (!before.id) fail(`no Traefik container was recorded on ${FROM}`);
    if (now.id !== before.id || now.startedAt !== before.startedAt) {
      fail(`the upgrade recreated or restarted ninedeploy-traefik: ${before.id.slice(0, 12)} @ ${before.startedAt} → ${now.id.slice(0, 12)} @ ${now.startedAt}`);
    }
    if (staticNow !== before.staticCfg) fail(`the upgrade changed traefik.yml:\n--- ${FROM}\n${before.staticCfg}\n--- ${TO}\n${staticNow}`);
  }
  const fileLog = /^\s*filePath:/m.test(staticNow);
  if (analytics ? !fileLog || !now.mounts.includes(TRAFFIC_MOUNT) : !/^accessLog: \{\}$/m.test(staticNow) || fileLog || now.mounts.includes(TRAFFIC_MOUNT)) {
    fail(`after the upgrade Traefik's access log is not what ${FROM} left (analytics ${analytics ? 'on' : 'off'}): ${staticNow.slice(0, 600)} | mounts ${now.mounts.join(', ')}`);
  }
  step(olderThan(FROM, NETWORK_DATA_IN)
    ? `${FROM} predates the 0.14 directory provider, so its Traefik was recreated once (${before.id.slice(0, 12) || '?'} → ${now.id.slice(0, 12)}); the static config renders ${analytics ? 'the analytics file log' : '`accessLog: {}`'} with no extra mount`
    : `Traefik untouched by the upgrade: same container ${now.id.slice(0, 12)} started ${now.startedAt}, traefik.yml byte-identical (${analytics ? 'analytics on' : '`accessLog: {}`, no traffic mount'})`);
}

/** 0.15.x → 0.15.y: the FROM state survives (analytics on, grant counts, the open shell's row recovered at boot). */
async function seededOperationsChecks(token, serviceId, seeded) {
  const s = (await api('/v1/traffic/settings', { token })).json;
  if (s?.enabled !== true) fail(`traffic analytics enabled on ${FROM} reads ${JSON.stringify(s).slice(0, 200)} on ${TO}`);
  const login = await api('/v1/auth/login', { method: 'POST', body: { email: seeded.guest.email, password: seeded.guest.password } });
  const read = await api(`/v1/services/${serviceId}`, { token: login.json?.tokens?.accessToken });
  if (read.status !== 200) fail(`the ${FROM} guest grant no longer reaches service #${serviceId}: ${read.status}`);
  const row = (await api(`/v1/terminals/${seeded.sessionId}`, { token })).json;
  if (row?.status !== 'ended' || row.endReason !== 'panel_restart') fail(`terminal #${seeded.sessionId} open at the kill reads ${JSON.stringify(row).slice(0, 300)} (wanted ended/panel_restart)`);
  const shell = pidState(seeded.shell.container, seeded.shell.pid);
  step(`${FROM} 0.15 state on ${TO}: analytics still on (status ${s.status}); the guest grant still counts; terminal #${seeded.sessionId} recovered as ended/panel_restart; recorded: its shell pid ${seeded.shell.pid} is ${shell} in ${seeded.shell.container}`);
  const off = await api('/v1/traffic/settings', { method: 'PUT', token, body: { enabled: false } });
  if (off.status !== 200 || off.json?.enabled !== false) fail(`disabling the ${FROM} analytics answered ${off.status} ${off.text.slice(0, 200)}`);
}

/**
 * Rollback rehearsal (FROM ≥ 0.15 → TO < 0.15): what docs/ROLLBACK.md says
 * the operator gets. 0.14 renders `accessLog: {}`, so the fingerprint differs
 * and it recreates Traefik without the traffic mount; the domain still
 * routes; the guest's grant is ignored (fail-closed); `<data>/traffic-logs`
 * is left behind; and the leftover-helper runbook command works, with and
 * without anything to remove. (Migration 0071 is asserted by the caller.)
 */
async function rollbackOperationsChecks(seeded, { serviceId, hostname, traefikBefore }) {
  let now = traefikState();
  let staticNow = '';
  for (let i = 0; i < 60; i++) {
    now = traefikState();
    staticNow = traefikFile('traefik.yml');
    if (now.running && !now.mounts.includes(TRAFFIC_MOUNT) && /^accessLog: \{\}$/m.test(staticNow)) break;
    await sleep(1000);
  }
  if (now.mounts.includes(TRAFFIC_MOUNT) || !/^accessLog: \{\}$/m.test(staticNow)) {
    fail(`after the rollback Traefik still writes the analytics log: mounts ${now.mounts.join(', ')}; ${staticNow.slice(0, 400)}`);
  }
  if (now.id === traefikBefore.id) fail('after the rollback Traefik was not recreated (same container id)');
  let code = '';
  for (let i = 0; i < 30 && !served(code); i++) {
    code = routeStatuses(hostname, 1)[0] ?? '';
    if (!served(code)) await sleep(1000);
  }
  if (!served(code)) fail(`after the rollback ${hostname} is not routed (last status ${code || 'none'})`);
  const leftover = panelRun(['sh', '-c', 'ls -A /data/traffic-logs 2>&1; du -sh /data/traffic-logs 2>/dev/null']).stdout.replace(/\s+/g, ' ').trim();
  step(`rollback: Traefik recreated without ${TRAFFIC_MOUNT} (${traefikBefore.id.slice(0, 12)} → ${now.id.slice(0, 12)}), \`accessLog: {}\`; ${hostname} routes (${code}); left behind in <data>/traffic-logs: ${leftover || '(nothing)'}`);

  const login = await api('/v1/auth/login', { method: 'POST', body: { email: seeded.guest.email, password: seeded.guest.password } });
  if (login.status !== 200) fail(`the ${FROM} guest cannot sign in on ${TO}: ${login.status}`);
  const read = await api(`/v1/services/${serviceId}`, { token: login.json.tokens.accessToken });
  if (read.status !== 404 && read.status !== 403) fail(`on ${TO} the ${FROM} guest still reads service #${serviceId} (${read.status}) — a rollback must fail closed`);
  step(`rollback: the ${FROM} guest grant #${seeded.grantId} has no effect (service #${serviceId} answers ${read.status})`);

  const shell = pidState(seeded.shell.container, seeded.shell.pid);
  step(`recorded: the shell left open across the hard kill (pid ${seeded.shell.pid}) is ${shell} in ${seeded.shell.container}`);

  // The runbook: a planted helper (as a shell that ignored HUP would leave), then the empty case.
  const planted = `nd-hostshell-smoke-${suffix}`;
  const run = dindRun(['run', '-d', '--name', planted, '--label', `${TERMINAL_HELPER_LABEL}=999999`, '--entrypoint', 'sleep', HELPER_IMAGE, '3600']);
  if (run.status !== 0) fail(`could not plant a labelled helper: ${run.all.slice(0, 200)}`);
  const runbook = () => spawnSync('docker', ['exec', '-e', 'DOCKER_HOST=tcp://127.0.0.1:2375', DIND, 'sh', '-c', TERMINAL_HELPER_RUNBOOK], { encoding: 'utf8', timeout: 120_000 });
  const first = runbook();
  if (first.status !== 0) fail(`the terminal-helper runbook command failed (${first.status}): ${(first.stderr || first.stdout || '').slice(0, 300)}`);
  const remaining = dindRun(['ps', '-aq', '--filter', `label=${TERMINAL_HELPER_LABEL}`]).stdout;
  if (remaining) fail(`containers labelled ${TERMINAL_HELPER_LABEL} survived the runbook command: ${remaining}`);
  const second = runbook();
  if (second.status !== 0) fail(`the runbook command fails when there is nothing to remove (${second.status}): ${(second.stderr || '').slice(0, 200)}`);
  step(`rollback: the runbook command removed a labelled helper and exits 0 when none is left`);
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

  // 0.15 seed, only on a FROM that has it (the rollback rehearsal, or a
  // 0.15.x → 0.15.y upgrade): analytics on, a guest grant, an open shell.
  const seeded015 = olderThan(FROM, OPERATIONS_IN) ? null : await seedOperations(token, serviceId);

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
  // O3: the panel's Traefik as FROM leaves it; the 0.15 block compares after the TO boot.
  const traefikBefore = { ...traefikState(), staticCfg: traefikFile('traefik.yml') };
  step(`${FROM} Traefik: ${traefikBefore.id.slice(0, 12) || '(none)'} started ${traefikBefore.startedAt || '-'}, mounts ${traefikBefore.mounts.join(', ') || '-'}`);

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

  // ── 0.15 operations and API on FROM-era data, or the rollback ──────────
  const upgradeHost = `upgrade-${suffix}.test`;
  if (!olderThan(TO, OPERATIONS_IN)) {
    traefikUntouchedChecks(traefikBefore, { analytics: seeded015 !== null });
    if (seeded015) await seededOperationsChecks(token, serviceId, seeded015);
    await terminalChecks(token, serviceId);
    await hostShellChecks(token, password);
    await trafficChecks(token, serviceId, upgradeHost);
    await openapiChecks(token);
    await grantChecks(token, serviceId);
  } else if (seeded015) {
    await rollbackOperationsChecks(seeded015, { serviceId, hostname: upgradeHost, traefikBefore });
  } else {
    step(`${TO} predates operations and API (0.15): 0.15 checks skipped`);
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
  if (!olderThan(TO, OPERATIONS_IN) || seeded015) {
    // Upgrade: 0071 applied once. Rollback: 0.14 neither re-ran nor removed
    // it, and kept the grant rows it ignores.
    if (post.migration0071 !== 1 || post.operationsTables !== 3) {
      fail(`migration 0071: ${post.migration0071} journal record(s), ${post.operationsTables}/3 tables (wanted 1 and 3)`);
    }
    if (seeded015 && post.accessGrantRows < 1) fail(`the FROM access grant row is gone (${post.accessGrantRows} rows)`);
    step(`${TO} db: migration 0071 recorded once with its 3 tables${seeded015 ? `; ${post.accessGrantRows} access grant row(s) kept` : ''}`);
  }

  const summary014 = olderThan(TO, NETWORK_DATA_IN)
    ? (seeded014 ? '; the 0.14 rollback leaves 0070 alone and the runbook removes the public-db sidecar' : '')
    : '; 0.14 Traefik directory provider, custom config, certificates, public access, import and secret managers work on the upgraded data';
  const summary015 = olderThan(TO, OPERATIONS_IN)
    ? (seeded015 ? '; the 0.15 rollback leaves 0071 alone, drops the traffic mount, refuses the guest and the helper runbook works' : '')
    : '; 0.15 leaves Traefik untouched, and terminals, traffic analytics, the OpenAPI document and access grants work on the upgraded data';
  console.log(`\n✓ Upgrade green: ${FROM} → ${TO} keeps users, services, history, domains and running apps; migrates; recovers the interrupted deploy; deploys again; 0.12 backup policy, preview env, disk alert and panel-backup defaults work on the upgraded data; 0.13 GitHub App/Gitea surfaces answer without GitHub${summary014}${summary015}`);
}

main()
  .catch((err) => { console.error(`\n✗ upgrade smoke aborted: ${err?.message ?? err}`); process.exitCode = 1; })
  .finally(() => {
    for (const c of [PANEL, DIND]) docker(['rm', '-f', c], { allowFail: true });
    docker(['volume', 'rm', VOLUME], { allowFail: true });
    docker(['network', 'rm', NET], { allowFail: true });
  });
