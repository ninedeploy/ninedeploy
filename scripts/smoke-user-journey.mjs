#!/usr/bin/env node
// r477: the user-journey smoke — the product's core loop, proven on the
// PUBLISHED image rather than the source tree: register the first admin,
// create a docker-image service, wait for its deployment to go green, read
// its logs, route a domain, then tear everything down. Unit and route tests
// cover each hop; this proves they still compose on the artifact a user
// actually pulls (it has caught image-layer drift before — r468's sandbox
// was proven exactly this way).
//
// Topology: privileged docker:28-dind sidecar (the validated DinD pattern —
// the panel gets plain DOCKER_HOST=tcp://..., NOT NINEDEPLOY_DOCKER_HOST)
// and the panel image under test with strong throwaway secrets.
//
// Usage: node scripts/smoke-user-journey.mjs [--image=ghcr.io/ninedeploy/ninedeploy:vX.Y.Z]

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';

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

const docker = (args, opts = {}) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: opts.timeout ?? 120_000, maxBuffer: 8 << 20 });
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')} -> ${r.status}: ${(r.stderr ?? '').slice(0, 300)}`);
  return (r.stdout ?? '').trim();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function main() {
  console.log(`User-journey smoke against ${IMAGE}`);
  step(`topology: network ${NET}, dind ${DIND}, panel ${PANEL} (:${PANEL_PORT})`);

  // ── bring up DinD + panel ───────────────────────────────────────────────
  // r581: pull the image under test on its own, with a pull-sized timeout —
  // folded into `docker run` it shared the 2-minute run budget, and on a
  // fresh CI runner (release-publish.yml's smoke job) the multi-arch pull is
  // the slow part. A tag that cannot be pulled is named as such.
  const pulled = spawnSync('docker', ['pull', IMAGE], { encoding: 'utf8', timeout: 900_000, maxBuffer: 8 << 20 });
  if (pulled.status !== 0) {
    fail(`cannot pull ${IMAGE}: ${(pulled.stderr || pulled.error?.message || '').trim().split(/\r?\n/).slice(-3).join(' | ')}`);
  }
  try {
    docker(['network', 'create', NET], { quiet: true });
    docker(['rm', '-f', DIND], { quiet: true });
    docker(['rm', '-f', PANEL], { quiet: true });
    docker(['run', '-d', '--name', DIND, '--network', NET, '--privileged', 'docker:28-dind',
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

  console.log('\n✓ User journey green: boot → register → create → deploy → logs → domain → signed webhook redeploy → compose stack → teardown');
}

main()
  .catch((err) => { console.error(`
✗ journey aborted: ${err?.message ?? err}`); process.exitCode = 1; })
  .finally(() => {
    for (const c of [PANEL, DIND]) { try { docker(['rm', '-f', c], { quiet: true }); } catch { /* best effort */ } }
    try { docker(['network', 'rm', NET], { quiet: true }); } catch { /* best effort */ }
  });
