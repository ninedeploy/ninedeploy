#!/usr/bin/env node
// r477: the user-journey smoke — the product's core loop, proven on the
// PUBLISHED image rather than the source tree: register the first admin,
// create a docker-image service, wait for its deployment to go green, read
// its logs, route a domain, then tear everything down. Unit and route tests
// cover each hop; this proves they still compose on the artifact a user
// actually pulls (it has caught image-layer drift before — r468's sandbox
// was proven exactly this way).
// 0.12: the managed postgres also gets a backup policy (built-in schedule
// first, then an explicit one read back), and the web service gets a
// preview-only env var that is listed and removed without touching its
// production env. An image older than 0.12 fails at those steps by design.
// 0.13: the GitHub App and Gitea surfaces that need no real GitHub — no App
// listed, bad keys refused, the manifest flow refused on a localhost origin,
// an unknown App hook 404, and a Gitea base URL round-trip.
// 0.14 (only when /health reports 0.14 or later): Traefik reads the
// file-provider directory and routes the journey domain; custom dynamic
// config (bad YAML and a svc_x collision refused, custom-hello applied through
// the DinD preflight); an uploaded fixture certificate (a mismatched key
// refused); public access on the managed postgres (refusals, an nd-dbpub
// sidecar on :15432, DELETE, a recorded TLS-terminate attempt); a one-chunk
// plain-SQL import behind a pre-import backup; the secret managers.
//
// Topology: privileged docker:28-dind sidecar (the validated DinD pattern —
// the panel gets plain DOCKER_HOST=tcp://..., NOT NINEDEPLOY_DOCKER_HOST)
// and the panel image under test with strong throwaway secrets. One named
// data volume is mounted at /data in both, so a bind mount the panel asks the
// daemon for (Traefik's config directory, the nd-dbpub config, the custom
// config preflight) resolves to the panel's real files, as on a host install.
//
// Usage: node scripts/smoke-user-journey.mjs [--image=ghcr.io/ninedeploy/ninedeploy:vX.Y.Z]

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';

// Default to the CURRENT repo version (read from version.ts) — a hardcoded
// tag drifts and a bare run would happily prove the journey on a stale
// artifact (r479).
const repoVersion = /export const VERSION = '([^']*)';/.exec(
  readFileSync(new URL('../apps/server/src/version.ts', import.meta.url), 'utf8'),
)?.[1];
if (!repoVersion) {
  console.error('could not derive VERSION from apps/server/src/version.ts — the smoke refuses to run against an unknown image.');
  process.exit(1);
}
const IMAGE = process.argv.find((a) => a.startsWith('--image='))?.slice('--image='.length)
  ?? `ghcr.io/ninedeploy/ninedeploy:v${repoVersion}`;
const PANEL_PORT = 4640;
const DIND_PORT = 2375;
const suffix = randomBytes(4).toString('hex');
const NET = `nd-journey-${suffix}`;
const DIND = `nd-journey-dind-${suffix}`;
const PANEL = `nd-journey-panel-${suffix}`;
const VOLUME = `nd-journey-data-${suffix}`;

const docker = (args, opts = {}) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: opts.timeout ?? 120_000, maxBuffer: 8 << 20 });
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')} -> ${r.status}: ${(r.stderr ?? '').slice(0, 300)}`);
  return (r.stdout ?? '').trim();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const semver = (tag) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag) ?? []).slice(1).map(Number);
const olderThan = (tag, [a, b, c]) => {
  const [x = 0, y = 0, z = 0] = semver(tag);
  return x !== a ? x < a : y !== b ? y < b : z < c;
};

async function api(path, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${PANEL_PORT}${path}`, {
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

const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exitCode = 1; throw new Error(msg); };
const step = (s) => console.log(`  ${s}`);

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

async function main() {
  console.log(`User-journey smoke against ${IMAGE}`);
  step(`topology: network ${NET}, dind ${DIND}, panel ${PANEL} (:${PANEL_PORT})`);

  // ── bring up DinD + panel ───────────────────────────────────────────────
  // r581: pull the image under test on its own, with a pull-sized timeout —
  // folded into `docker run` it shared the 2-minute run budget, and on a
  // fresh CI runner (release-publish.yml's smoke job) the multi-arch pull is
  // the slow part. A tag that cannot be pulled is named as such.
  // A locally built candidate (no registry behind it) is used as it is.
  const local = spawnSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf8', timeout: 30_000 }).status === 0;
  const pulled = local ? { status: 0 } : spawnSync('docker', ['pull', IMAGE], { encoding: 'utf8', timeout: 900_000, maxBuffer: 8 << 20 });
  if (pulled.status !== 0) {
    fail(`cannot pull ${IMAGE}: ${(pulled.stderr || pulled.error?.message || '').trim().split(/\r?\n/).slice(-3).join(' | ')}`);
  }
  try {
    docker(['network', 'create', NET], { quiet: true });
    docker(['rm', '-f', DIND], { quiet: true });
    docker(['rm', '-f', PANEL], { quiet: true });
    docker(['run', '-d', '--name', DIND, '--network', NET, '--privileged', '-v', `${VOLUME}:/data`, 'docker:28-dind',
      'dockerd', '--host=tcp://0.0.0.0:2375']);
    // dockd needs a few seconds to accept connections; probe without throwing.
    for (let i = 0; i < 45; i++) {
      const probe = spawnSync('docker', ['exec', DIND, 'docker', '-H', `tcp://127.0.0.1:${DIND_PORT}`, 'version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 15_000 });
      if (probe.status === 0 && (probe.stdout ?? '').trim().length > 0) break;
      await sleep(1000);
      if (i === 44) fail('dind daemon never became reachable');
    }
    const jwt = randomBytes(32).toString('hex');
    const key = randomBytes(32).toString('hex');
    docker(['run', '-d', '--name', PANEL, '--network', NET, `-p`, `127.0.0.1:${PANEL_PORT}:3000`,
      '-v', `${VOLUME}:/data`,
      '-e', `NINEDEPLOY_JWT_SECRET=${jwt}`,
      '-e', `NINEDEPLOY_MASTER_KEY=${key}`,
      '-e', `DOCKER_HOST=tcp://${DIND}:2375`,
      IMAGE]);
  } catch (err) {
    fail(`bring-up failed: ${err.message}`);
  }

  // ── panel boots ─────────────────────────────────────────────────────────
  // r581: 120 s like the upgrade smoke — a cold CI runner runs every
  // migration on an empty database and 40 s left no margin for it.
  let health = null;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await api('/health');
      if (r.status === 200 && r.json?.status === 'ok') { health = r.json; break; }
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  if (!health) fail('panel /health never answered ok');
  step(`/health ok — version ${health.version}, db ${health.db}`);
  /** 0.14 network and data access checks run only on an image that has them. */
  const has014 = !olderThan(String(health.version), NETWORK_DATA_IN);

  // ── register the first admin ────────────────────────────────────────────
  const email = `journey-${suffix}@nd.local`;
  const reg = await api('/v1/auth/register', { method: 'POST', body: { email, password: 'Journey-0123456!', name: 'Journey' } });
  if (reg.status !== 200 || !reg.json?.tokens?.accessToken) fail(`register failed: ${reg.status} ${reg.text.slice(0, 200)}`);
  const token = reg.json.tokens.accessToken;
  step('first admin registered (operator)');

  // ── create a docker-image service ───────────────────────────────────────
  const svcRes = await api('/v1/services', { method: 'POST', token, body: {
    name: 'journey-web', type: 'docker', image: 'nginx:1.27-alpine', port: 80,
  } });
  if (svcRes.status !== 200 && svcRes.status !== 201) fail(`service create failed: ${svcRes.status} ${svcRes.text.slice(0, 300)}`);
  const serviceId = svcRes.json?.id ?? svcRes.json?.service?.id;
  if (!serviceId) fail(`no service id in response: ${svcRes.text.slice(0, 300)}`);
  step(`service #${serviceId} created (nginx:1.27-alpine)`);

  // ── trigger a deploy and wait for it to go green ────────────────────────
  const depRes = await api(`/v1/services/${serviceId}/deploys`, { method: 'POST', token, body: {} });
  if (depRes.status !== 200 && depRes.status !== 201 && depRes.status !== 202) fail(`deploy trigger failed: ${depRes.status} ${depRes.text.slice(0, 300)}`);
  const deployId = depRes.json?.deploymentId ?? depRes.json?.id;
  step(`deploy #${deployId} triggered`);

  let deployStatus = null;
  // Deployment-row vocabulary: queued/building/deploying in flight; 'running'
  // IS the success terminal (the events layer translates it to 'success' for
  // notifications — see pipeline.ts finalizeDeployment).
  const TERMINAL = new Set(['running', 'failed', 'cancelled', 'superseded']);
  for (let i = 0; i < 150; i++) {
    const list = await api(`/v1/services/${serviceId}/deploys`, { token });
    const all = Array.isArray(list.json) ? list.json : (list.json?.deploys ?? []);
    const d = all.find((x) => (deployId ? x.id === deployId : true)) ?? all[0];
    deployStatus = d?.status ?? deployStatus;
    if (TERMINAL.has(deployStatus)) break;
    await sleep(2000);
  }
  if (deployStatus !== 'running') fail(`deploy ended as '${deployStatus}' (wanted running=success)`);
  step(`deploy green (${deployStatus})`);

  // ── logs readable ───────────────────────────────────────────────────────
  const logs = await api(`/v1/services/${serviceId}/logs?tail=50`, { token });
  if (logs.status !== 200) fail(`logs route answered ${logs.status}`);
  step('logs readable');

  // ── domain routing row created ──────────────────────────────────────────
  const domRes = await api(`/v1/services/${serviceId}/domains`, { method: 'POST', token, body: { hostname: `journey-${suffix}.test` } });
  if (domRes.status !== 200 && domRes.status !== 201) fail(`domain create failed: ${domRes.status} ${domRes.text.slice(0, 300)}`);
  step('domain routed');

  // ── webhook trigger: HMAC-signed push redeploy (the rawBody happy path) ─
  const hookRes = await api(`/v1/services/${serviceId}/webhooks`, { method: 'POST', token, body: {} });
  if (hookRes.status !== 200 && hookRes.status !== 201) fail(`webhook create failed: ${hookRes.status} ${hookRes.text.slice(0, 300)}`);
  // The panel-computed url carries its container-internal origin — address
  // the receiver through OUR mapped port instead.
  const hookUrl = `/v1/hooks/${hookRes.json?.id}`;
  const hookSecret = hookRes.json?.secret;
  if (!hookSecret) fail('webhook create returned no secret');
  const pushBody = JSON.stringify({ ref: 'refs/heads/main', after: randomBytes(20).toString('hex'), repository: { full_name: 'journey/repo' } });
  const sig = `sha256=${createHmac('sha256', hookSecret).update(pushBody).digest('hex')}`;
  const pushRes = await fetch(`http://127.0.0.1:${PANEL_PORT}${hookUrl}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sig },
    body: pushBody,
  });
  if (pushRes.status !== 200) fail(`signed push rejected: ${pushRes.status} ${(await pushRes.text()).slice(0, 200)}`);
  step('signed webhook push accepted');
  let secondDeploy = null;
  for (let i = 0; i < 150; i++) {
    const list = await api(`/v1/services/${serviceId}/deploys`, { token });
    const all = Array.isArray(list.json) ? list.json : (list.json?.deploys ?? []);
    const d = all.find((x) => x.id !== deployId && TERMINAL.has(x.status));
    if (d) { secondDeploy = d; break; }
    if (i % 15 === 0) step(`  …waiting for webhook-triggered deploy (poll ${i}, latest ${all[0]?.id}:${all[0]?.status})`);
    await sleep(2000);
  }
  if (secondDeploy?.status !== 'running') fail(`webhook-triggered deploy ended as '${secondDeploy?.status ?? 'none'}'`);
  step(`webhook-triggered deploy #${secondDeploy.id} green`);

  // ── compose stack: inline content, two services, main resolution ───────
  const composeSvc = await api('/v1/services', { method: 'POST', token, body: {
    name: 'journey-stack', type: 'compose',
    composeService: 'web',
    composeContent: 'services:\n  web:\n    image: nginx:1.27-alpine\n    restart: unless-stopped\n  sidecar:\n    image: redis:7-alpine\n    restart: unless-stopped\n',
  } });
  if (composeSvc.status !== 200 && composeSvc.status !== 201) fail(`compose create failed: ${composeSvc.status} ${composeSvc.text.slice(0, 300)}`);
  const composeId = composeSvc.json?.id ?? composeSvc.json?.service?.id;
  step(`compose service #${composeId} created (web + sidecar)`);
  await api(`/v1/services/${composeId}/deploys`, { method: 'POST', token, body: {} });
  let composeStatus = null;
  for (let i = 0; i < 150; i++) {
    const list = await api(`/v1/services/${composeId}/deploys`, { token });
    const all = Array.isArray(list.json) ? list.json : (list.json?.deploys ?? []);
    composeStatus = all[0]?.status ?? composeStatus;
    if (TERMINAL.has(composeStatus)) break;
    if (i % 15 === 0) step(`  …waiting for compose deploy (poll ${i}: ${composeStatus})`);
    await sleep(2000);
  }
  if (composeStatus !== 'running') fail(`compose deploy ended as '${composeStatus}'`);
  step('compose deploy green');

  // ── managed databases: they must actually START ───────────────────────
  // r680: redis/valkey were passed `--requirepass` BEFORE the image, which
  // `docker run` rejects as an unknown flag — managed redis never started,
  // from 0.2.2 to 0.10.41, and nothing in the release drill created one.
  for (const engine of ['postgres', 'redis']) {
    const created = await api('/v1/databases', { method: 'POST', token, body: { name: `journey-${engine}`, engine } });
    if (created.status !== 200 && created.status !== 201) fail(`${engine} database create failed: ${created.status} ${created.text.slice(0, 300)}`);
    const db = created.json;
    if (db?.status !== 'running') fail(`${engine} database reported '${db?.status}' (wanted running)`);
    const running = docker(['exec', DIND, 'docker', '-H', `tcp://127.0.0.1:${DIND_PORT}`, 'ps', '--filter', 'status=running', '--format', '{{.Names}}']);
    // The API names the container as `host` (the address apps dial).
    if (!db.host || !running.split(/\r?\n/).includes(db.host)) fail(`${engine} container ${db?.host} is not running in the daemon`);
    if (engine === 'postgres') {
      // 0.12: a per-database backup policy on a fresh database — built-in
      // schedule first, then an explicit one that reads back as written.
      const policyPath = `/v1/databases/${db.id}/backup-policy`;
      const initial = await api(policyPath, { token });
      if (initial.status !== 200 || initial.json?.configured !== false) fail(`fresh postgres backup policy: ${initial.status} ${initial.text.slice(0, 200)}`);
      const want = { enabled: true, cron: '15 2 * * *', retainCount: 5, localOnly: true };
      const put = await api(policyPath, { method: 'PUT', token, body: want });
      if (put.status !== 200) fail(`backup policy PUT failed: ${put.status} ${put.text.slice(0, 200)}`);
      const got = (await api(policyPath, { token })).json;
      if (got?.configured !== true || got.cron !== want.cron || got.retainCount !== want.retainCount || got.localOnly !== true) {
        fail(`backup policy did not read back as written: ${JSON.stringify(got)}`);
      }
      step(`postgres backup policy set (${want.cron}, keep ${want.retainCount}, local only)`);
      // 0.14: public access and a dump import on this postgres, before it is deleted.
      if (has014) {
        await publicAccessChecks(token, db.id);
        await importChecks(token, db.id);
      }
    }
    const del = await api(`/v1/databases/${db.id}`, { method: 'DELETE', token });
    if (del.status !== 200 && del.status !== 204) fail(`${engine} database delete failed: ${del.status}`);
    step(`managed ${engine} started, ran and was deleted`);
  }

  // ── 0.12 preview-only env: add, list, remove; production env untouched ─
  const prodKeys = async () => {
    const r = await api(`/v1/services/${serviceId}/env`, { token });
    if (r.status !== 200 || !Array.isArray(r.json)) fail(`service env read failed: ${r.status}`);
    return r.json.map((e) => e.key).sort().join(',');
  };
  const prodBefore = await prodKeys();
  const previewPath = `/v1/services/${serviceId}/env/preview`;
  const pv = await api(previewPath, { method: 'POST', token, body: { key: 'JOURNEY_PREVIEW', value: `preview-${suffix}` } });
  if (pv.status !== 200 && pv.status !== 201) fail(`preview env create failed: ${pv.status} ${pv.text.slice(0, 200)}`);
  const listed = (await api(previewPath, { token })).json;
  if (!Array.isArray(listed) || !listed.some((e) => e.id === pv.json?.id && e.key === 'JOURNEY_PREVIEW')) fail(`preview env not listed: ${JSON.stringify(listed)}`);
  if ((await prodKeys()) !== prodBefore) fail('a preview-only variable showed up in the production env');
  const pvDel = await api(`${previewPath}/${pv.json.id}`, { method: 'DELETE', token });
  if (pvDel.status !== 200 && pvDel.status !== 204) fail(`preview env delete failed: ${pvDel.status} ${pvDel.text.slice(0, 200)}`);
  const afterDel = (await api(previewPath, { token })).json;
  if (!Array.isArray(afterDel) || afterDel.length !== 0) fail(`preview env not empty after delete: ${JSON.stringify(afterDel)}`);
  step('preview-only env var added, listed and removed (production env untouched)');

  // ── 0.13 GitHub App + Gitea surfaces (no real GitHub) ──────────────────
  await githubSurfaceChecks(token);

  // ── 0.14 Traefik directory provider, custom config, certificates, secret managers
  if (has014) {
    await traefikDirectoryChecks(`journey-${suffix}.test`);
    await customConfigChecks(token);
    await customCertificateChecks(token);
    await secretProviderChecks(token);
  } else {
    step(`${health.version} predates network and data access (0.14): 0.14 checks skipped`);
  }

  // ── teardown ────────────────────────────────────────────────────────────
  const delCompose = await api(`/v1/services/${composeId}`, { method: 'DELETE', token });
  if (delCompose.status !== 200 && delCompose.status !== 204) fail(`compose delete failed: ${delCompose.status}`);
  step('compose service deleted');
  const del = await api(`/v1/services/${serviceId}`, { method: 'DELETE', token });
  if (del.status !== 200 && del.status !== 204) { // 204 No Content is the route's own success
    // Diagnose: the panel log usually names the throwing step.
    try { console.log(docker(['logs', '--tail', '25', PANEL])); } catch { /* best effort */ }
    fail(`service delete failed: ${del.status} ${del.text.slice(0, 400)}`);
  }
  step('service deleted');

  console.log('\n✓ User journey green: boot → register → create → deploy → logs → domain → signed webhook redeploy → compose stack → managed postgres (+ backup policy) + redis → preview-only env → GitHub App/Gitea surfaces → 0.14 Traefik directory, custom config, certificates, public access, import, secret managers (≥0.14) → teardown');
}

main()
  .catch((err) => { console.error(`
✗ journey aborted: ${err?.message ?? err}`); process.exitCode = 1; })
  .finally(() => {
    for (const c of [PANEL, DIND]) { try { docker(['rm', '-f', c], { quiet: true }); } catch { /* best effort */ } }
    try { docker(['volume', 'rm', VOLUME], { quiet: true }); } catch { /* best effort */ }
    try { docker(['network', 'rm', NET], { quiet: true }); } catch { /* best effort */ }
  });
