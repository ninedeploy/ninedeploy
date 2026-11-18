/** N05 host-loss drill using the real panel API, two disposable Docker daemons and RustFS. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { inspectOwnedSmokeResource, removeOwnedSmokeResource } from './lib/owned-smoke-resources.mjs';
import { prepareCutover } from './lib/disaster-recovery-cutover.mjs';
import { prepareLostNode } from './lib/disaster-recovery-node.mjs';
import { prepareStaging, stagingInputs } from './lib/disaster-recovery-staging.mjs';

const image = process.argv.find(arg => arg.startsWith('--image='))?.slice(8);
const includeCutover = process.argv.includes('--cutover');
const externalInput = process.argv.includes('--cloudflare-staging') ? stagingInputs(process.env) : null;
assert.ok(!(includeCutover && externalInput), 'Choose either private cutover or Cloudflare staging');
const nodeFixtureImage = process.argv.find(arg => arg.startsWith('--replace-node='))?.slice('--replace-node='.length);
if (nodeFixtureImage !== undefined) assert.match(nodeFixtureImage, /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/);
assert.match(image ?? '', /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, 'Pass --image=<local candidate>');
const root = resolve(process.argv.find(arg => arg.startsWith('--proof='))?.slice(8) ?? '.temp_files/n05-disaster-recovery');
mkdirSync(root, { recursive: true });
const proof = mkdtempSync(join(root, 'run-'));
const owner = randomBytes(16).toString('hex');
const label = `ninedeploy.proof=${owner}`;
const prefix = `nd-n05-${owner.slice(0, 12)}`;
const network = `${prefix}-net`;
const store = `${prefix}-store`;
const resources = [];
const cases = [];
const report = { owner, image, cases, artifacts: {}, sourceRemoved: false, cleanup: false };
const fixture = { endpoint: 'https://pitr-store:9443', region: 'us-east-1', bucket: 'archive', prefix, accessKeyId: 'fixture', secretAccessKey: 'fixture-secret' };
const password = () => `Drill-${randomBytes(18).toString('hex')}!`;
const passphrase = password();
const sourceAccount = { email: 'source-operator@example.test', password: password(), name: 'Source Operator' };
const targetAccount = { email: 'temporary-operator@example.test', password: password(), name: 'Temporary Operator' };
const host = externalInput ? `${prefix}.${externalInput.suffix}` : 'disaster-recovery.test';
const panelBackup = '/v1/system/panel-backup';
const sql = 'SELECT value FROM drill_state ORDER BY id';
let phase = 'initialization';
let external;

const cli = (args, timeout = 60_000, input) => spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout, input, maxBuffer: 6 << 20 });
function docker(args, timeout, input) {
  const result = cli(args, timeout, input);
  if (result.status !== 0) throw new Error((result.stderr || result.error?.message || 'Docker command failed').trim().slice(-1600));
  return result.stdout.trim();
}
function owned(kind, name) {
  const identity = inspectOwnedSmokeResource(cli, kind, name, owner);
  assert.equal(identity.status, 'owned', `Expected an owned ${kind} named ${name}`);
  return identity.id;
}
function remember(kind, name) { resources.push([kind, name]); }
function runContainer(name, args) {
  docker(['run', '-d', '--name', name, '--label', label, ...args]);
  remember('container', name);
}
function remove(kind, name) {
  assert.equal(removeOwnedSmokeResource(cli, kind, name, owner, { removeAnonymousVolumes: true }), 'removed', `Could not remove ${name}`);
}
const absent = (kind, name) => inspectOwnedSmokeResource(cli, kind, name, owner).status === 'unavailable';
function exec(container, args, timeout) { return docker(['exec', owned('container', container), ...args], timeout); }
function inner(site, args, timeout) { return exec(site.daemon, ['docker', '-H', 'tcp://127.0.0.1:2375', ...args], timeout); }
function pass(message) { cases.push(message); console.log(`PASS ${message}`); }
function volume(name) {
  docker(['volume', 'create', '--label', label, name]);
  remember('volume', name);
}
async function poll(description, read, ms = 120_000) {
  const end = Date.now() + ms;
  let error;
  do {
    try { const result = await read(); if (result) return result; }
    catch (err) { error = err; }
    await setTimeout(1000);
  } while (Date.now() < end);
  throw new Error(`${description} did not become ready${error ? `: ${error.message}` : ''}`);
}

async function daemon(role, { image = 'docker:28-dind', alias, socket = false } = {}) {
  const site = { daemon: `${prefix}-${role}-dind`, panel: `${prefix}-${role}-panel`, data: `${prefix}-${role}-data` };
  volume(site.data);
  docker(['run', '-d', '--name', site.daemon, '--label', label, '--network', network, ...(alias ? ['--network-alias', alias] : []),
    '--privileged', '-v', `${site.data}:/data`, image, 'dockerd', '--host=tcp://0.0.0.0:2375',
    ...(socket ? ['--host=unix:///var/run/docker.sock'] : [])]);
  remember('container', site.daemon);
  await poll('Docker daemon', () => inner(site, ['version', '--format', '{{.Server.Version}}'], 5000));
  return site;
}

function stagePublicImages(site) {
  // Prepare the recovery host like an operator would. Only public images
  // cross this step. The source and target still have independent storage.
  const pull = 'set -eu; for image in postgres:18 nginx:1.27-alpine traefik:3; do docker -H tcp://127.0.0.1:2375 pull "$image"; done; touch /tmp/n05-images-ready';
  docker(['exec', '-d', owned('container', site.daemon), 'sh', '-c', `(${pull}) >/tmp/n05-image-pull.log 2>&1`]);
}

async function startStore(source, tls) {
  exec(source.daemon, ['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=pitr-store',
    '-addext', 'subjectAltName=DNS:pitr-store', '-keyout', '/tmp/n05-key.pem', '-out', '/tmp/n05-cert.pem']);
  for (const part of ['cert', 'key']) {
    const pem = exec(source.daemon, ['cat', `/tmp/n05-${part}.pem`]);
    assert.match(pem, /^-----BEGIN /);
    writeFileSync(join(tls, `rustfs_${part}.pem`), `${pem}\n`, { mode: part === 'cert' ? 0o644 : 0o600 });
  }
  const storeVolume = `${prefix}-objects`;
  volume(storeVolume);
  const rustfs = docker(['image', 'inspect', 'rustfs/rustfs:1.0.4', '--format', '{{.Id}}']);
  report.provider = { image: 'rustfs/rustfs:1.0.4', id: rustfs };
  docker(['run', '-d', '--name', store, '--label', label, '--network', network, '--network-alias', 'pitr-store', '--user', '0',
    '--mount', `type=volume,src=${storeVolume},dst=/data`, '--mount', `type=bind,src=${tls},dst=/tls,readonly`,
    '-e', 'RUSTFS_ADDRESS=0.0.0.0:9443', '-e', 'RUSTFS_TLS_PATH=/tls', '-e', 'RUSTFS_CONSOLE_ENABLE=false',
    '-e', `RUSTFS_ACCESS_KEY=${fixture.accessKeyId}`, '-e', `RUSTFS_SECRET_KEY=${fixture.secretAccessKey}`, rustfs]);
  remember('container', store);
}

async function panel(site, cert) {
  const signingKey = randomBytes(32).toString('hex');
  site.setupToken = password();
  docker(['run', '-d', '--name', site.panel, '--label', label, '--network', network, '-p', '127.0.0.1::3000',
    '-v', `${site.data}:/data`, '--mount', `type=bind,src=${cert},dst=/n05-ca.pem,readonly`, '-e', 'NODE_EXTRA_CA_CERTS=/n05-ca.pem',
    '-e', `DOCKER_HOST=tcp://${site.daemon}:2375`, '-e', `NINEDEPLOY_JWT_SECRET=${signingKey}`,
    ...(site.acmeDirectory ? ['-e', `NINEDEPLOY_ACME_CA_SERVER=${site.acmeDirectory}`] : []),
    '-e', 'NINEDEPLOY_JWT_ACCESS_TTL=2h', '-e', `NINEDEPLOY_SETUP_TOKEN=${site.setupToken}`, report.imageId]);
  remember('container', site.panel);
  await waitPanel(site);
}
async function waitPanel(site) {
  // Docker can allocate another host port when a container with a dynamic
  // loopback binding restarts.
  await poll('Panel health', async () => {
    const mapping = docker(['port', owned('container', site.panel), '3000/tcp']);
    assert.match(mapping, /^127\.0\.0\.1:\d+$/);
    site.url = `http://${mapping}`;
    return (await request(site, '/health', { timeout: 3000 })).status === 200;
  });
}

async function request(site, path, { body, method = body ? 'POST' : 'GET', token = site.token, timeout = 120_000, headers = {} } = {}) {
  const response = await fetch(site.url + path, {
    method, signal: AbortSignal.timeout(timeout),
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}
async function api(site, path, options = {}, expected = [200, 201, 202, 204]) {
  const result = await request(site, path, options);
  assert.ok(expected.includes(result.status), `${options.method ?? (options.body ? 'POST' : 'GET')} ${path}: HTTP ${result.status} ${result.data?.error?.code ?? ''} ${result.data?.error?.message ?? ''}`);
  return result.data;
}
async function register(site, account) {
  return (await api(site, '/v1/auth/register', { body: { ...account, setupToken: site.setupToken } })).tokens;
}
async function destination(site) {
  return (await api(site, '/v1/backup-destinations', { body: { name: 'Disaster recovery fixture', ...fixture } })).id;
}
async function deployment(site, service, deployId) {
  const path = `/v1/services/${service.id}/deploys`;
  const id = deployId ?? (await api(site, path, { body: {} })).deploymentId;
  try {
    const item = await poll('Deployment', async () => (await api(site, path)).find(item => item.id === id && ['running', 'failed', 'cancelled', 'superseded'].includes(item.status)), 240_000);
    assert.equal(item.status, 'running', 'Panel deployment did not reach running state');
  } catch (error) {
    const panel = inspectOwnedSmokeResource(cli, 'container', site.panel, owner);
    if (panel.status === 'owned' && Number.isSafeInteger(id) && id > 0) {
      const result = cli(['exec', panel.id, 'tail', '-n', '100', `/data/logs/${id}.log`]);
      if (result.status === 0) {
        const safe = result.stdout.replace(/(?:postgres(?:ql)?|redis|mysql):\/\/[^\s]+/gi, '[database URI]');
        writeFileSync(join(proof, `deployment-${id}.log`), safe);
      }
    }
    throw error;
  }
  const refreshed = await api(site, `/v1/services/${service.id}`);
  assert.ok(refreshed.runtimeId, 'Service has no running container identity');
  return refreshed.runtimeId;
}
function query(site, db, statement) {
  return inner(site, ['exec', '-u', 'postgres', db.containerName, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-U', db.username, '-d', db.database, '-c', statement]);
}
function http(site, file) {
  return exec(site.panel, ['curl', '--noproxy', '*', '-fsS', '--max-time', '10', '-H', `Host: ${host}`, `http://${site.daemon}:80/${file}`]);
}
function fileInVolume(site, volumeName, file, value) {
  inner(site, ['run', '--rm', '--network', 'none', '-v', `${volumeName}:/fixture`, 'alpine:3.24',
    'sh', '-ec', 'printf "%s\n" "$1" > "/fixture/$2"', 'fixture', value, file], 120_000);
}
function traefikFiles(site) {
  const checksums = 'grep -rlF "$1" /data/traefik | sort | while IFS= read -r file; do sha256sum "$file"; done';
  return exec(site.panel, ['sh', '-ec', checksums, 'fixture', host]);
}
function appQuery(site, runtime, alias) {
  // Pass the attachment URI through stdin. The drill never logs the URI or supplies it in host process arguments.
  const runner = 'set -eu; docker exec "$1" printenv "$2" | docker run --rm -i --network "container:$1" --entrypoint sh postgres:18 -ec \'read -r PGURI; exec psql "$PGURI" -XAtq -v ON_ERROR_STOP=1 -c "SELECT value FROM drill_state ORDER BY id"\'';
  return docker(['exec', '-e', 'DOCKER_HOST=tcp://127.0.0.1:2375', owned('container', site.daemon), 'sh', '-ec', runner, 'fixture', runtime, alias], 120_000);
}

const tls = join(proof, 'tls');
const cutoverTls = join(proof, 'cutover-tls');
mkdirSync(tls);
if (includeCutover) mkdirSync(cutoverTls);
const cert = join(tls, 'rustfs_cert.pem');
try {
  console.log(`Disaster recovery evidence: ${proof}`);
  report.imageId = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  docker(['network', 'create', '--label', label, network]);
  remember('network', network);
  const source = await daemon('source');
  const target = await daemon('target');
  stagePublicImages(target);
  await startStore(source, tls);
  phase = 'prepare isolated cutover fixtures';
  const cutoverContext = { docker, runContainer, exec, inner, owned, remove, daemon, api, request, deployment, poll, pass, prefix, network, host, report, proof };
  if (externalInput) external = await prepareStaging(cutoverContext, source, target, externalInput);
  const cutover = external ?? (includeCutover ? await prepareCutover(cutoverContext, source, target, cutoverTls) : null);
  if (cutover) target.acmeDirectory = cutover.directory;
  await panel(source, cert);
  phase = 'source setup';
  const sourceTokens = await register(source, sourceAccount);
  source.token = sourceTokens.accessToken;
  // The production SigV4 client creates the one isolated bucket.
  await poll('RustFS bucket creation', () => exec(source.panel, ['node', '--input-type=module', '-e',
    "import {s3Request} from './apps/server/dist/lib/s3.js';const c=JSON.parse(process.argv[1]);const r=await s3Request(c,'PUT','',undefined,undefined,undefined,AbortSignal.timeout(5000));if(!r.ok)throw Error('Bucket creation HTTP '+r.status);console.log(r.status)", JSON.stringify(fixture)], 10_000));
  const sourceDestination = await destination(source);
  await api(source, `/v1/backup-destinations/${sourceDestination}/test`, { body: {} });
  phase = 'create databases and seed protected rows';
  const dbs = [];
  for (const name of ['orders', 'ledger']) {
    const db = await api(source, '/v1/databases', { body: { name, engine: 'postgres', version: '18' } });
    await poll(`${name} database`, () => query(source, db, 'SELECT 1') === '1');
    query(source, db, `CREATE TABLE drill_state(id integer PRIMARY KEY, value text); INSERT INTO drill_state VALUES (1,'${name}-protected'), (2,'${name}-second');`);
    dbs.push({ ...db, alias: `${name.toUpperCase()}_DATABASE_URL` });
  }

  phase = 'deploy and seed application';
  const service = await api(source, '/v1/services', { body: { name: 'disaster-recovery', type: 'docker', image: 'nginx:1.27-alpine', port: 80, volumeMount: '/usr/share/nginx/html' } });
  const servicePath = `/v1/services/${service.id}`;
  for (const db of dbs) await api(source, `${servicePath}/attachments`, { body: { databaseId: db.id, envAlias: db.alias } });
  const extra = await api(source, `${servicePath}/volumes`, { body: { create: { label: 'assets' }, containerPath: '/usr/share/nginx/html/assets' } });
  const sourceRuntime = await deployment(source, service, extra.deploymentId);
  const domain = await api(source, `${servicePath}/domains`, { body: { hostname: host, ssl: false } });
  const mainVolume = inner(source, ['inspect', sourceRuntime, '--format', '{{range .Mounts}}{{if eq .Destination "/usr/share/nginx/html"}}{{.Name}}{{end}}{{end}}']);
  assert.match(mainVolume, /^nd-svc-/);
  const volumes = [
    { name: mainVolume, file: 'drill.txt', route: 'drill.txt', value: 'protected web content' },
    { name: extra.attachment.volumeName, file: 'drill.txt', route: 'assets/drill.txt', value: 'protected asset content' },
  ];
  for (const v of volumes) fileInVolume(source, v.name, v.file, v.value);
  for (const v of volumes) await poll('Source route', () => http(source, v.route) === v.value);
  for (const db of dbs) assert.equal(appQuery(source, sourceRuntime, db.alias), `${db.name}-protected\n${db.name}-second`);
  const sourceTraefik = traefikFiles(source);
  assert.ok(sourceTraefik, 'Source Traefik config does not contain the route');
  const keyHash = exec(source.panel, ['sha256sum', '/data/master.key']).split(' ')[0];
  assert.match(keyHash, /^[a-f0-9]{64}$/);
  pass('Source route serves two distinct application volumes and both database attachments are readable');

  if (cutover) {
    phase = 'verify source DNS and enroll node';
    await cutover.beforeBackup(source, volumes[0]);
  }

  phase = 'capture remote node backups';
  const lostNode = nodeFixtureImage ? prepareLostNode({ docker, daemon, exec, inner, remove, absent, api, request, deployment,
    poll, pass, prefix, report, query, fileInVolume, appQuery }, nodeFixtureImage) : null;
  const nodeArtifacts = lostNode ? await lostNode.capture(source) : [];

  phase = 'capture remote backups then panel snapshot';
  const remote = new Map();
  for (const db of dbs) {
    db.backup = await api(source, `/v1/databases/${db.id}/backups`, { body: {} });
    assert.equal(db.backup.status, 'completed');
    remote.set(`database ${db.name}`, db.backup.sizeBytes);
  }
  for (const v of volumes) {
    v.backup = await api(source, `/v1/volumes/${v.name}/backups`, { body: { label: 'n05-drill' } });
    assert.equal(v.backup.status, 'completed');
    assert.equal(v.backup.hasRemoteCopy, true);
    remote.set(`volume ${v.name}`, v.backup.sizeBytes);
  }
  await api(source, panelBackup, { method: 'PUT', body: { enabled: false, destinationId: sourceDestination, passphrase, retain: 3 } });
  await api(source, `${panelBackup}/run`, { body: {} });
  const snapshot = await poll('Remote panel snapshot', async () => {
    const status = (await api(source, panelBackup)).lastRun;
    return status && status.status !== 'running' ? status : null;
  });
  assert.equal(snapshot.status, 'completed', snapshot.error ?? '');
  assert.ok(snapshot.key && snapshot.sizeBytes > 0);
  const objects = await api(source, `/v1/backup-destinations/${sourceDestination}/objects`);
  for (const item of [...dbs.map(db => ({ name: db.slug, backup: db.backup, extension: '.dump' })), ...volumes.map(v => ({ ...v, extension: '.tar.gz' })), ...nodeArtifacts]) {
    const matches = objects.filter(o => o.key.startsWith(`${prefix}/${item.name}-`) && o.key.endsWith(item.extension));
    assert.equal(matches.length, 1, `Expected one remote object for ${item.name}`);
    assert.equal(matches[0].sizeBytes, item.backup.sizeBytes);
  }
  for (const item of nodeArtifacts) remote.set(`node ${item.name}`, item.backup.sizeBytes);
  assert.ok(objects.some(o => o.key === snapshot.key && o.sizeBytes === snapshot.sizeBytes), 'Panel snapshot missing from remote inventory');
  report.artifacts = Object.fromEntries([...remote, ['panel snapshot', snapshot.sizeBytes]]);
  assert.ok([...Object.values(report.artifacts)].every(bytes => bytes > 0));
  pass('Two volume archives and two logical dumps reached RustFS before the panel snapshot captured their metadata');

  // Change all payloads after their backups to detect a false success that reads current source state.
  for (const v of volumes) fileInVolume(source, v.name, v.file, 'post-backup change');
  for (const db of dbs) query(source, db, "INSERT INTO drill_state VALUES (3,'post-backup change');");
  for (const v of volumes) assert.equal(http(source, v.route), 'post-backup change');
  for (const db of dbs) assert.match(query(source, db, sql), /post-backup change$/);
  phase = 'fence and remove source';
  await poll('Recovery image preparation', () => exec(target.daemon, ['sh', '-c', 'test -f /tmp/n05-images-ready && echo ready']));
  if (cutover?.stageIngress) await cutover.stageIngress();
  if (lostNode) lostNode.lose(source);
  remove('container', source.panel);
  remove('container', source.daemon);
  remove('volume', source.data);
  for (const [kind, name] of [['container', source.panel], ['container', source.daemon], ['volume', source.data]]) {
    assert.equal(inspectOwnedSmokeResource(cli, kind, name, owner).status, 'unavailable');
  }
  owned('container', store);
  const lostAt = Date.now();
  report.sourceRemoved = true;
  report.snapshotAgeMs = lostAt - Date.parse(snapshot.finishedAt);
  report.backupAgeMs = Object.fromEntries([
    ...dbs.map(db => [`database ${db.name}`, lostAt - Date.parse(db.backup.createdAt)]),
    ...volumes.map(v => [`volume ${v.name}`, lostAt - Date.parse(v.backup.createdAt)]),
  ]);
  assert.ok(Object.values(report.backupAgeMs).every(age => Number.isFinite(age) && age >= 0));
  pass('Source panel, daemon and shared data volume removed while RustFS remained online');
  if (cutover) cutover.fenced(volumes[0]);

  phase = 'restore panel from authenticated remote snapshot';
  assert.equal(inner(target, ['ps', '-aq']), '');
  assert.equal(inner(target, ['volume', 'ls', '-q']), '');
  await panel(target, cert);
  const proxy = 'ninedeploy-traefik';
  const initialProxy = inner(target, ['inspect', proxy, '--format', '{{.Id}}']);
  target.token = (await register(target, targetAccount)).accessToken;
  const targetDestination = await destination(target);
  const restore = { destinationId: targetDestination, key: snapshot.key, passphrase, confirm: snapshot.key.split('/').at(-1) };
  const wrong = await request(target, `${panelBackup}/restore`, { body: { ...restore, passphrase: password() } });
  assert.equal(wrong.status, 400);
  assert.equal((await api(target, '/v1/auth/me')).email, targetAccount.email);
  await api(target, `${panelBackup}/restore`, { body: restore, timeout: 180_000 });
  assert.equal(exec(target.panel, ['sha256sum', '/data/master.key']).split(' ')[0], keyHash);
  assert.equal(traefikFiles(target), sourceTraefik);
  docker(['restart', owned('container', target.panel)], 90_000);
  await waitPanel(target);
  assert.notEqual(inner(target, ['inspect', proxy, '--format', '{{.Id}}']), initialProxy);
  const configDir = exec(target.panel, ['stat', '-c', '%d:%i', '/data/traefik']);
  assert.equal(inner(target, ['exec', proxy, 'stat', '-c', '%d:%i', '/etc/traefik']), configDir);
  report.proxyRecreated = true;
  assert.equal((await request(target, '/v1/auth/me', { token: sourceTokens.accessToken })).status, 401);
  assert.equal((await request(target, '/v1/auth/refresh', { body: { refreshToken: sourceTokens.refreshToken } })).status, 401);
  assert.equal((await request(target, '/v1/auth/me')).status, 401);
  target.token = (await api(target, '/v1/auth/login', { body: { email: sourceAccount.email, password: sourceAccount.password } })).tokens.accessToken;
  const savedService = await api(target, servicePath);
  assert.equal(savedService.slug, service.slug);
  assert.deepEqual((await api(target, `${servicePath}/attachments`)).map(item => item.databaseId).sort(), dbs.map(db => db.id).sort());
  assert.equal(exec(target.panel, ['find', '/data/backups', '-type', 'f']), '', 'The target unexpectedly has local payload backups');
  pass('Panel restored the original login, master key, Traefik files and attachment metadata. Old JWTs were refused');

  phase = 'restore application volumes from RustFS';
  for (const v of volumes) {
    await api(target, '/v1/volumes', { body: { name: v.name } });
    await api(target, `/v1/volumes/${v.name}/backups/${v.backup.id}/restore`, { body: {} });
  }
  pass('Both application volumes restored through the panel from remote copies');

  phase = 'restore database dumps from RustFS';
  for (const db of dbs) {
    const dbPath = `/v1/databases/${db.id}`;
    await api(target, `${dbPath}/start`, { body: {} });
    await poll(`${db.name} target database`, () => query(target, db, 'SELECT 1') === '1');
    await api(target, `${dbPath}/backups/${db.backup.id}/restore`, { body: {} });
    assert.equal(query(target, db, sql), `${db.name}-protected\n${db.name}-second`);
  }
  assert.equal(exec(target.panel, ['find', '/data/backups', '-name', '*.remote']), '', 'A downloaded restore file was left on disk');
  pass('Both remote logical dumps restored their exact protected rows and excluded later writes');

  phase = 'redeploy and verify routed application';
  const runtime = await deployment(target, savedService);
  for (const v of volumes) await poll('Restored application route', () => http(target, v.route) === v.value);
  for (const db of dbs) assert.equal(appQuery(target, runtime, db.alias), `${db.name}-protected\n${db.name}-second`);
  report.recoveryMs = Date.now() - lostAt;
  pass('Redeployed service served both restored files through Traefik and authenticated to both restored databases');
  if (cutover?.reEnroll) {
    phase = 're-enroll surviving node';
    await cutover.reEnroll(target);
  }
  if (cutover) {
    phase = 'change DNS and validate ACME cutover';
    await cutover.verify(target, `${servicePath}/domains/${domain.id}`, volumes);
    (report.externalCutover ?? report.cutover).endToEndMs = Date.now() - lostAt;
  }
  if (lostNode) {
    phase = 're-bootstrap and restore the lost node';
    await lostNode.restore(target);
  }
} catch (error) {
  report.failure = { phase, message: error.message };
  console.error(`${phase}: ${error.message}`);
  process.exitCode = 1;
} finally {
  for (const [kind, name] of resources.reverse()) {
    if (inspectOwnedSmokeResource(cli, kind, name, owner).status === 'owned') {
      removeOwnedSmokeResource(cli, kind, name, owner, { removeAnonymousVolumes: true });
    }
  }
  const results = [['ps', '-aq'], ['volume', 'ls', '-q'], ['network', 'ls', '-q']].map(args => cli([...args, '--filter', `label=${label}`]));
  report.cleanup = results.every(result => result.status === 0 && !result.stdout.trim());
  try {
    if (external) await external.cleanup();
  } catch (error) {
    report.dnsCleanupError = error.message;
    report.cleanup = false;
    console.error(`Cloudflare cleanup: ${error.message}`);
  }
  if (!report.cleanup) process.exitCode = 1;
  rmSync(join(tls, 'rustfs_key.pem'), { force: true });
  if (includeCutover) rmSync(join(cutoverTls, 'pebble-key.pem'), { force: true });
  writeFileSync(join(proof, 'result.json'), JSON.stringify(report, null, 2));
}
