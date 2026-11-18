/** N03: public settings routes, real Traefik, failed writes/acks and a hard panel kill. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectOwnedSmokeResource, removeOwnedSmokeResource } from './lib/owned-smoke-resources.mjs';

const image = process.argv.find(a => a.startsWith('--image='))?.slice(8);
assert.match(image ?? '', /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, 'Pass --image=<locally built candidate>');
const proof = resolve(process.argv.find(a => a.startsWith('--proof='))?.slice(8) ?? `.temp_files/proxy-settings-${randomBytes(6).toString('hex')}`);
mkdirSync(proof, { recursive: true });
const owner = randomBytes(16).toString('hex');
const daemon = `nd-proxy-proof-${owner.slice(0, 12)}`;
const panel = `${daemon}-panel`;
const volume = `${daemon}-data`;
const label = `ninedeploy.proof=${owner}`;
const cases = [];
const created = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
const cli = (args, timeout = 120_000) => spawnSync('docker', args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 2 << 20 });
function docker(args, timeout) {
  const r = cli(args, timeout);
  assert.equal(r.status, 0, (r.stderr || r.error?.message || '').slice(-1200));
  return (r.stdout ?? '').trim();
}
function owned(name) {
  assert.equal(inspectOwnedSmokeResource(cli, 'container', name, owner).status, 'owned', `Refusing to touch unowned ${name}`);
}
function inner(args, timeout) { owned(daemon); return docker(['exec', daemon, 'docker', '-H', 'tcp://127.0.0.1:2375', ...args], timeout); }
async function until(fn, message, ms = 120_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (err) { last = err; }
    await pause(250);
  }
  throw new Error(`${message}: ${last?.message ?? 'deadline exceeded'}`);
}
const report = name => { cases.push(name); console.log(`PASS ${name}`); };
let base;
let token;
async function api(path, method = 'GET', body) {
  const r = await fetch(base + path, {
    method, headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body && { 'content-type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(65_000),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { /* text only */ }
  return { status: r.status, data, text };
}
function panelExec(script, ...args) { owned(panel); return docker(['exec', '-w', '/app/apps/server', panel, 'node', '--input-type=module', '-e', script, ...args]); }
function visitor() {
  // Node 26 fetch derives Host from the URL. Use an explicit HTTP request to
  // exercise virtual-host routing without changing DNS or the host machine.
  return JSON.parse(panelExec(`import http from 'node:http';const q=http.get({hostname:'127.0.0.1',port:80,path:'/',headers:{Host:'proxy-proof.test'},timeout:5000},r=>{let text='';r.on('data',c=>{text+=c;if(text.length>1048576)q.destroy(new Error('visitor response exceeded bound'));});r.on('end',()=>console.log(JSON.stringify({status:r.statusCode,text})));});q.on('timeout',()=>q.destroy(new Error('visitor timeout')));q.on('error',e=>{console.error(e.message);process.exitCode=1;});`));
}
function journalExists(key) {
  return panelExec(`import {createDb,settings} from '@ninedeploy/db';import {eq} from 'drizzle-orm';const {db,client}=createDb({url:'file:/data/ninedeploy.db'});try{console.log(Boolean(await db.query.settings.findFirst({where:eq(settings.key,process.argv[1])})));}finally{client.close();}`, key) === 'true';
}
async function ready() { await until(async () => (await api('/health')).status === 200, 'panel readiness'); }
const result = { owner, image, cases, realProxy: true, cleanup: false };
try {
  docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  docker(['volume', 'create', '--label', label, volume]);
  created.push(['volume', volume]);
  docker(['run', '-d', '--name', daemon, '--label', label, '--privileged', '-p', '127.0.0.1::3000', '-v', `${volume}:/data`, 'docker:28-dind', 'dockerd', '--host=tcp://0.0.0.0:2375']);
  created.push(['container', daemon]);
  await until(() => cli(['exec', daemon, 'docker', '-H', 'tcp://127.0.0.1:2375', 'info']).status === 0, 'isolated daemon readiness');
  // All application/proxy mutations below target this disposable daemon only.
  inner(['pull', 'traefik:3'], 300_000);
  inner(['pull', 'nginx:1.27-alpine'], 300_000);
  result.traefikImage = inner(['image', 'inspect', 'traefik:3', '--format', '{{.Id}}']);
  result.candidateId = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  docker(['run', '-d', '--name', panel, '--label', label, '--user', '0', '--network', `container:${daemon}`, '-v', `${volume}:/data`,
    '-e', 'DOCKER_HOST=tcp://127.0.0.1:2375', '-e', `NINEDEPLOY_JWT_SECRET=${randomBytes(32).toString('hex')}`,
    '-e', `NINEDEPLOY_MASTER_KEY=${randomBytes(32).toString('hex')}`, '-e', 'NINEDEPLOY_SETUP_TOKEN=n03-owned-fixture',
    '-e', 'NINEDEPLOY_JWT_ACCESS_TTL=2h', image]);
  created.push(['container', panel]);
  const binding = JSON.parse(docker(['inspect', daemon, '--format', '{{json .NetworkSettings.Ports}}']))['3000/tcp'][0];
  base = `http://127.0.0.1:${binding.HostPort}`;
  await ready();
  const registered = await api('/v1/auth/register', 'POST', { email: 'proxy-proof@example.test', password: 'Proxy-Proof-012345!', name: 'Proof', setupToken: 'n03-owned-fixture' });
  assert.equal(registered.status, 200, registered.text);
  token = registered.data.tokens.accessToken;
  const svc = await api('/v1/services', 'POST', { name: 'proxy-proof', type: 'docker', image: 'nginx:1.27-alpine', port: 80 });
  assert.ok([200, 201].includes(svc.status), svc.text);
  const id = svc.data.id ?? svc.data.service.id;
  const deployed = await api(`/v1/services/${id}/deploys`, 'POST', {});
  assert.ok([200, 201, 202].includes(deployed.status), deployed.text);
  await until(async () => {
    const r = await api(`/v1/services/${id}/deploys`);
    const row = (Array.isArray(r.data) ? r.data : r.data.deploys)[0];
    assert.notEqual(row?.status, 'failed', row?.error);
    return row?.status === 'running';
  }, 'application deployment', 300_000);
  const domain = await api(`/v1/services/${id}/domains`, 'POST', { hostname: 'proxy-proof.test', ssl: false });
  assert.ok([200, 201].includes(domain.status), domain.text);
  const did = domain.data.id ?? domain.data.domain.id;
  const fa = `/v1/domains/${did}/forward-auth`;
  const maintenance = `/v1/services/${id}/maintenance`;
  const pages = `/v1/services/${id}/error-pages`;
  await until(() => visitor().status === 200, 'initial visitor route');
  report('unaffected visitor reaches the deployed application');

  // A failed rename is real filesystem I/O, not a mocked render.
  // A directory at the destination prevents atomic replacement even when the panel runs as root.
  owned(panel);
  docker(['exec', panel, 'sh', '-ec', 'cp /data/traefik/dynamic/ninedeploy.yml /data/traefik/dynamic/prior-proof.yml; rm /data/traefik/dynamic/ninedeploy.yml; mkdir /data/traefik/dynamic/ninedeploy.yml']);
  const failedWrite = await api(fa, 'PUT', { forwardAuth: { minRole: 'viewer' } });
  assert.equal(failedWrite.status, 503, failedWrite.text);
  assert.equal((await api(fa)).data.error.code, 'proxy_setting_unconfirmed');
  assert.equal(journalExists(`proxy_apply_domain:${did}:forward_auth`), true);
  owned(panel);
  docker(['exec', panel, 'sh', '-ec', 'rmdir /data/traefik/dynamic/ninedeploy.yml; mv /data/traefik/dynamic/prior-proof.yml /data/traefik/dynamic/ninedeploy.yml']);
  docker(['restart', panel]);
  await ready();
  assert.equal((await api(fa)).data.forwardAuth, null);
  assert.equal(visitor().status, 200);
  report('real atomic-write failure stays unconfirmed; restart restores previous routing');
  assert.equal((await api(fa, 'PUT', { forwardAuth: { minRole: 'viewer' } })).status, 200);
  assert.equal(visitor().status, 401);
  assert.equal((await api(fa, 'PUT', { forwardAuth: null })).status, 200);
  assert.equal(visitor().status, 200);
  report('retry confirms forward auth and actual visitor denial; confirmed disable opens the app');

  assert.equal((await api(maintenance, 'PUT', { maintenance: { title: 'Proof maintenance' } })).status, 200);
  assert.equal(visitor().status, 503);
  assert.match(visitor().text, /Proof maintenance/);
  assert.equal((await api(maintenance, 'PUT', { maintenance: null })).status, 200);
  assert.equal(visitor().status, 200);
  report('confirmed maintenance changes visitor traffic and clears on disable');

  // Pausing Traefik loses both HTTP/TLS acknowledgements after the file write.
  inner(['pause', 'ninedeploy-traefik']);
  const lostAck = await api(pages, 'PUT', { pages: { '502': '<h1>Unconfirmed page</h1>' } });
  assert.equal(lostAck.status, 503, lostAck.text);
  assert.equal((await api(pages)).data.error.code, 'proxy_setting_unconfirmed');
  inner(['unpause', 'ninedeploy-traefik']);
  owned(panel); docker(['restart', panel]); await ready();
  assert.deepEqual((await api(pages)).data.pages, {});
  assert.equal(visitor().status, 200);
  report('real acknowledgement timeout cannot claim applied; restart restores the previous pages');

  // Hard-kill while the durable record exists and the proxy cannot acknowledge.
  // Warm the new process's reachability preflight while Traefik is healthy;
  // the pause below must happen at application, after that admission guard.
  assert.equal((await api(pages, 'PUT', { pages: { '502': '<h1>Preflight control</h1>' } })).status, 200);
  assert.equal((await api(pages, 'PUT', { pages: {} })).status, 200);
  inner(['pause', 'ninedeploy-traefik']);
  const interrupted = api(pages, 'PUT', { pages: { '502': '<h1>Interrupted page</h1>' } }).catch(() => undefined);
  await until(() => journalExists(`proxy_apply_service:${id}:error_pages`), 'durable pending journal');
  owned(panel); docker(['kill', '--signal', 'KILL', panel]);
  await interrupted;
  inner(['unpause', 'ninedeploy-traefik']);
  owned(panel); docker(['start', panel]); await ready();
  assert.deepEqual((await api(pages)).data.pages, {});
  assert.equal(journalExists(`proxy_apply_service:${id}:error_pages`), false);
  assert.equal(visitor().status, 200);
  report('hard-killed in-flight apply aborts safely from its durable record');
  assert.equal((await api(pages, 'PUT', { pages: { '502': '<h1>Confirmed custom page</h1>' } })).status, 200);
  const detail = (await api(`/v1/services/${id}`)).data;
  // Make the real backend answer 502. Stopping it instead would test the
  // proxy's separate network dial timeout rather than this page contract.
  inner(['exec', detail.runtimeId, 'sh', '-ec', 'printf \'server { listen 80; location / { return 502 "backend failure"; } }\\n\' > /etc/nginx/conf.d/default.conf; nginx -s reload']);
  const errorPage = await until(() => { const r = visitor(); return r.status === 502 && r; }, 'backend error response', 30_000);
  assert.match(errorPage.text, /Confirmed custom page/);
  report('confirmed custom error page is served to an actual visitor');
} catch (err) {
  result.failure = err instanceof Error ? err.message : String(err);
  if (inspectOwnedSmokeResource(cli, 'container', panel, owner).status === 'owned') {
    writeFileSync(`${proof}/panel.log`, cli(['logs', '--tail', '180', panel]).stdout ?? '');
  }
  throw err;
} finally {
  const cleanup = [];
  for (const [kind, name] of created.reverse()) cleanup.push(removeOwnedSmokeResource(cli, kind, name, owner, { removeAnonymousVolumes: true }));
  result.cleanup = cleanup.every(s => s === 'removed');
  result.cleanupResults = cleanup;
  writeFileSync(`${proof}/result.json`, JSON.stringify(result, null, 2));
  assert.equal(result.cleanup, true, 'Owned fixture cleanup is incomplete');
}
