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
// 0.15 (only when /health reports 0.15 or later): a compose service refused as
// a terminal target (422 use_container_target); terminals (host shell refused
// while disabled, a protocol-v1 round trip over the global WebSocket with a
// resize, the ended row and its audits, a reused ticket 4401, no shell left
// after a dropped socket); a host shell enabled with a password re-check (or
// the 422 recorded) and disabled again; traffic analytics (one recreate on
// enable, 20 requests counted per service and instance-wide, a raw log line
// without client or request data, disable back to the identical static
// config); the OpenAPI document (401, 3.1.x, ETag/304); and a viewer grant for
// a seatless guest (read 200, write 403, no workspace rights, suspended → 404,
// reinstated → 200, revoked → 404).
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

// 0.15: operations and API — terminals, traffic analytics, the OpenAPI
// document and project access grants. Offline-safe like the 0.14 block: the
// shell runs in the smoke's own nginx container, the host shell (if it can be
// enabled) enters the DinD sidecar's namespaces, the HTTP requests go from the
// panel container to Traefik inside DinD, and the guest is a local account.
// The terminal client is Node's global WebSocket (Node 22+), offering the v1
// subprotocol and the single-use ticket exactly as lib/terminalProtocol.ts
// expects. Shared verbatim by smoke-upgrade.mjs and smoke-user-journey.mjs.
const OPERATIONS_IN = [0, 15, 0];
/** 0.15.6: KeyDB and Dragonfly managed engines. */
const REDIS_FAMILY_IN = [0, 15, 6];
// 0.15.7: the catalog grew to 305 templates, 175 of them stacks converted from
// the Coolify catalog. They were started with plain `docker compose` before
// they were listed; this sends one through the panel's own deploy pipeline.
const CATALOG_IN = [0, 15, 7];
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

/**
 * 0.15.6: KeyDB and Dragonfly are real containers that must start, answer to
 * their password, hold data across a backup and a restore, pass the backup
 * drill, and be deleted. Data goes through the API's own credentials and the
 * engine's own client inside the DinD daemon, so this proves the flags and
 * images the panel picked, not a mock.
 */
async function catalogChecks(token) {
  const list = await api('/v1/templates', { token });
  if (list.status !== 200 || !Array.isArray(list.json)) fail(`template list failed: ${list.status} ${list.text.slice(0, 200)}`);
  if (list.json.length < 300) fail(`the template catalog has ${list.json.length} entries (wanted 300 or more)`);
  const converted = list.json.filter((t) => t.id.startsWith('coolify-') && t.runtimeVerified === true);
  if (converted.length < 150) fail(`only ${converted.length} verified Coolify-converted templates are listed (wanted 150 or more)`);
  const categories = new Set(list.json.map((t) => t.category));
  for (const spelling of ['Ai', 'Cms', 'Devtools', 'Databases']) {
    if (categories.has(spelling)) fail(`the catalog lists the category "${spelling}", which should have been mapped to an existing one`);
  }
  step(`catalog lists ${list.json.length} templates (${converted.length} verified stacks from the Coolify catalog)`);

  // A converted stack, through the panel's compose pipeline rather than a bare `docker compose up`.
  const detail = await api('/v1/templates/coolify-apprise-api', { token });
  if (detail.status !== 200 || !detail.json?.composeContent || detail.json.runtimeVerified !== true) {
    fail(`coolify-apprise-api detail: ${detail.status} ${detail.text.slice(0, 200)}`);
  }
  const deploy = await api('/v1/templates/coolify-apprise-api/deploy', { method: 'POST', token, body: {} });
  if (deploy.status !== 200 && deploy.status !== 201) fail(`coolify-apprise-api deploy was refused: ${deploy.status} ${deploy.text.slice(0, 300)}`);
  const serviceId = deploy.json?.serviceId;
  let status = null;
  for (let i = 0; i < 150; i++) {
    const runs = await api(`/v1/services/${serviceId}/deploys`, { token });
    const all = Array.isArray(runs.json) ? runs.json : (runs.json?.deploys ?? []);
    status = all[0]?.status ?? status;
    if (['running', 'failed', 'cancelled', 'superseded'].includes(status)) break;
    await sleep(2000);
  }
  if (status !== 'running') fail(`the converted stack coolify-apprise-api deployed as '${status}'`);
  step('a stack converted from the Coolify catalog deployed through the panel');
  const del = await api(`/v1/services/${serviceId}`, { method: 'DELETE', token });
  if (del.status !== 200 && del.status !== 204) fail(`deleting the converted stack failed: ${del.status} ${del.text.slice(0, 200)}`);
}

async function redisFamilyChecks(token) {
  const dindDocker = (args) => docker(['exec', DIND, 'docker', '-H', `tcp://127.0.0.1:${DIND_PORT}`, ...args]);
  for (const { engine, cli } of [{ engine: 'keydb', cli: 'keydb-cli' }, { engine: 'dragonfly', cli: 'redis-cli' }]) {
    const created = await api('/v1/databases', { method: 'POST', token, body: { name: `journey-${engine}`, engine } });
    if (created.status !== 200 && created.status !== 201) fail(`${engine} database create failed: ${created.status} ${created.text.slice(0, 300)}`);
    const db = created.json;
    if (db?.status !== 'running') fail(`${engine} database reported '${db?.status}' (wanted running)`);
    const creds = await api(`/v1/databases/${db.id}/credentials`, { token });
    if (creds.status !== 200 || !creds.json?.password) fail(`${engine} credentials: ${creds.status} ${creds.text.slice(0, 200)}`);
    const run = (...cmd) => dindDocker(['exec', db.host, cli, '-a', creds.json.password, '--no-auth-warning', ...cmd]);
    // The password is required, and it works.
    const unauthRun = spawnSync('docker', ['exec', DIND, 'docker', '-H', `tcp://127.0.0.1:${DIND_PORT}`, 'exec', db.host, cli, 'PING'], { encoding: 'utf8', timeout: 60_000 });
    const unauth = `${unauthRun.stdout ?? ''}${unauthRun.stderr ?? ''}`;
    if (!/NOAUTH/.test(unauth)) fail(`${engine} answered an unauthenticated PING with "${unauth.slice(0, 80)}" (wanted NOAUTH)`);
    if (run('PING') !== 'PONG') fail(`${engine} did not answer PONG with its password`);
    run('SET', 'journey-key', 'before-backup');

    const backup = await api(`/v1/databases/${db.id}/backups`, { method: 'POST', token, body: {} });
    if (backup.status !== 200 || backup.json?.status !== 'completed' || !(backup.json?.sizeBytes > 0)) {
      fail(`${engine} backup: ${backup.status} ${backup.text.slice(0, 300)}`);
    }
    const drill = await api(`/v1/databases/${db.id}/backups/drill`, { method: 'POST', token, body: { backupId: backup.json.id } });
    if (drill.status !== 200 || drill.json?.status !== 'passed') fail(`${engine} backup drill: ${drill.status} ${drill.text.slice(0, 400)}`);

    run('SET', 'journey-after', 'after-backup');
    const restore = await api(`/v1/databases/${db.id}/backups/${backup.json.id}/restore`, { method: 'POST', token, body: {} });
    if (restore.status !== 200) fail(`${engine} restore: ${restore.status} ${restore.text.slice(0, 300)}`);
    // The restore restarts the container; wait until it answers again.
    let back = '';
    for (let i = 0; i < 30 && back !== 'before-backup'; i++) {
      await sleep(2000);
      try { back = dindDocker(['exec', db.host, cli, '-a', creds.json.password, '--no-auth-warning', 'GET', 'journey-key']); } catch { back = ''; }
    }
    if (back !== 'before-backup') fail(`${engine} lost its data across a restore: journey-key reads "${back}"`);
    if (run('GET', 'journey-after') !== '') fail(`${engine} kept a key written after the backup, so the restore did not replace the data`);

    const del = await api(`/v1/databases/${db.id}`, { method: 'DELETE', token });
    if (del.status !== 200 && del.status !== 204) fail(`${engine} delete failed: ${del.status}`);
    step(`managed ${engine}: started, password enforced, backup #${backup.json.id} (${backup.json.sizeBytes} B) drilled green, restore replaced the data, deleted`);
  }
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
  /** 0.15 operations and API checks run only on an image that has them. */
  const has015 = !olderThan(String(health.version), OPERATIONS_IN);

  // ── register the first admin ────────────────────────────────────────────
  const email = `journey-${suffix}@nd.local`;
  const password = 'Journey-0123456!';
  const reg = await api('/v1/auth/register', { method: 'POST', body: { email, password, name: 'Journey' } });
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
  if (!olderThan(String(health.version), REDIS_FAMILY_IN)) await redisFamilyChecks(token);
  if (!olderThan(String(health.version), CATALOG_IN)) await catalogChecks(token);

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

  // ── 0.15 terminals, traffic analytics, OpenAPI, access grants ──────────
  if (has015) {
    const composeShell = await api('/v1/terminals', { method: 'POST', token, body: { target: { kind: 'service', serviceId: composeId } } });
    if (composeShell.status !== 422 || errorCode(composeShell) !== 'use_container_target') {
      fail(`a terminal on compose service #${composeId} answered ${composeShell.status} ${composeShell.text.slice(0, 200)} (wanted 422 use_container_target)`);
    }
    step(`terminals: compose service #${composeId} refused as a service target (422 use_container_target)`);
    await terminalChecks(token, serviceId);
    await hostShellChecks(token, password);
    await trafficChecks(token, serviceId, `journey-${suffix}.test`);
    await openapiChecks(token);
    await grantChecks(token, serviceId);
  } else {
    step(`${health.version} predates operations and API (0.15): 0.15 checks skipped`);
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

  console.log('\n✓ User journey green: boot → register → create → deploy → logs → domain → signed webhook redeploy → compose stack → managed postgres (+ backup policy) + redis (+ KeyDB and Dragonfly with backup, drill and restore from 0.15.6) → preview-only env → GitHub App/Gitea surfaces → 0.14 Traefik directory, custom config, certificates, public access, import, secret managers (≥0.14) → 0.15 terminals, host shell, traffic analytics, OpenAPI, access grants (≥0.15) → teardown');
}

main()
  .catch((err) => { console.error(`
✗ journey aborted: ${err?.message ?? err}`); process.exitCode = 1; })
  .finally(() => {
    for (const c of [PANEL, DIND]) { try { docker(['rm', '-f', c], { quiet: true }); } catch { /* best effort */ } }
    try { docker(['volume', 'rm', VOLUME], { quiet: true }); } catch { /* best effort */ }
    try { docker(['network', 'rm', NET], { quiet: true }); } catch { /* best effort */ }
  });
