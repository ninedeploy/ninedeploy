/** N04 host-loss acceptance. Every mutation is confined to labelled disposable daemons/containers. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectOwnedSmokeResource, removeOwnedSmokeResource } from './lib/owned-smoke-resources.mjs';

const image = process.argv.find(a => a.startsWith('--image='))?.slice(8);
const node = process.argv.includes('--node');
const rustfs = process.argv.includes('--rustfs');
const continuous = node || rustfs || process.argv.includes('--continuous');
assert.match(image ?? '', /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, 'Pass --image=<local candidate>');
const proof = resolve(process.argv.find(a => a.startsWith('--proof='))?.slice(8) ?? '.temp_files/pitr-remote');
mkdirSync(proof, { recursive: true });
const owner = randomBytes(16).toString('hex'), tag = `nd-pitr-proof-${owner.slice(0, 12)}`, label = `ninedeploy.proof=${owner}`;
const created = [], cases = [], result = { owner, image, continuous, node, cases, cleanup: false };
const storeCfg = { endpoint: 'https://pitr-store:9443', region: 'us-east-1', bucket: 'archive', accessKeyId: 'fixture', secretAccessKey: 'fixture-secret' };
const rustfsImage = 'rustfs/rustfs:1.0.4';
const cli = (a, ms = 120_000) => spawnSync('docker', a, { encoding: 'utf8', windowsHide: true, timeout: ms, maxBuffer: 8 << 20 });
function docker(a, ms) { const r = cli(a, ms); assert.equal(r.status, 0, (r.stderr || r.error?.message || '').slice(-2000)); return r.stdout.trim(); }
function owned(name) { assert.equal(inspectOwnedSmokeResource(cli, 'container', name, owner).status, 'owned'); }
function exec(name, args, ms) { owned(name); return docker(['exec', name, ...args], ms); }
async function daemon(name) {
  docker(['run', '-d', '--name', name, '--label', label, '--network', tag, '--privileged', 'docker:28-dind', 'dockerd', '--host=tcp://0.0.0.0:2375']); created.push(['container', name]);
  for (let i = 0; ; i++) {
    if (cli(['exec', name, 'docker', '-H', 'tcp://127.0.0.1:2375', 'info']).status === 0) break;
    if (i >= 120) throw new Error('Disposable daemon did not start'); await new Promise(r => setTimeout(r, 500));
  }
}
function copy(from, to) { docker(['cp', from, to]); }
function worker(name, network) {
  docker(['run', '-d', '--name', name, '--label', label, '--user', '0', '--network', network,
    '-e', `NINEDEPLOY_JWT_SECRET=${randomBytes(32).toString('hex')}`, '-e', 'DOCKER_HOST=tcp://127.0.0.1:2375', '-e', 'NINEDEPLOY_DATA_DIR=/tmp/recovery-data', '-e', 'NODE_EXTRA_CA_CERTS=/tmp/cert.pem',
    '-e', `NINEDEPLOY_MASTER_KEY=${randomBytes(32).toString('hex')}`, '--entrypoint', 'node', image, '-e', 'setInterval(()=>{}, 3600000)']); created.push(['container', name]);
  exec(name, ['mkdir', '-p', '/app/scripts/lib']);
  copy(resolve('scripts/lib/pitr-remote-fixture.mjs'), `${name}:/app/scripts/lib/pitr-remote-fixture.mjs`);
  copy(resolve('scripts/lib/pitr-stream-produce.mjs'), `${name}:/app/scripts/lib/pitr-stream-produce.mjs`);
  copy(resolve('scripts/lib/pitr-node-fixture.mjs'), `${name}:/app/scripts/lib/pitr-node-fixture.mjs`);
  copy(resolve('scripts/recover-pitr-checkpoint.mjs'), `${name}:/app/scripts/recover-pitr-checkpoint.mjs`);
  copy(`${proof}/cert.pem`, `${name}:/tmp/cert.pem`);
}
const passed = (s) => { cases.push(s); console.log(`PASS ${s}`); };
try {
  result.imageId = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  docker(['network', 'create', '--label', label, tag]); created.push(['network', tag]);
  const source = `${tag}-source`, producer = `${tag}-producer`, store = `${tag}-store`, target = `${tag}-target`, recovery = `${tag}-recovery`;
  await daemon(source);
  exec(source, ['sh', '-ec', 'openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=pitr-store -addext subjectAltName=DNS:pitr-store -keyout /tmp/key.pem -out /tmp/cert.pem && test -s /tmp/cert.pem && test -s /tmp/key.pem']);
  writeFileSync(`${proof}/cert.pem`, `${exec(source, ['cat', '/tmp/cert.pem'])}\n`); writeFileSync(`${proof}/fixture-key.pem`, `${exec(source, ['cat', '/tmp/key.pem'])}\n`, { mode: 0o600 });
  if (rustfs) {
    const imageId = docker(['image', 'inspect', rustfsImage, '--format', '{{.Id}}']);
    result.provider = { image: rustfsImage, imageId, transport: 'HTTPS' };
    const data = `${tag}-s3-data`, tls = `${proof}/rustfs-tls`;
    mkdirSync(tls);
    copyFileSync(`${proof}/cert.pem`, `${tls}/rustfs_cert.pem`);
    copyFileSync(`${proof}/fixture-key.pem`, `${tls}/rustfs_key.pem`);
    docker(['volume', 'create', '--label', label, data]); created.push(['volume', data]);
    // The bridge has no published S3 ports. Credentials and the CA are disposable.
    docker(['run', '-d', '--name', store, '--user', '0', '--network', tag, '--network-alias', 'pitr-store', '--label', label,
      '--mount', `type=volume,src=${data},dst=/data`, '--mount', `type=bind,src=${tls},dst=/tls,readonly`,
      '-e', 'RUSTFS_ADDRESS=0.0.0.0:9443', '-e', 'RUSTFS_TLS_PATH=/tls', '-e', 'RUSTFS_CONSOLE_ENABLE=false',
      '-e', `RUSTFS_ACCESS_KEY=${storeCfg.accessKeyId}`, '-e', `RUSTFS_SECRET_KEY=${storeCfg.secretAccessKey}`, imageId]);
    created.push(['container', store]);
  } else {
    docker(['run', '-d', '--name', store, '--user', '0', '--network', tag, '--network-alias', 'pitr-store', '--label', label, '--entrypoint', 'node', image, '-e', 'setInterval(()=>{},3600000)']); created.push(['container', store]);
    exec(store, ['mkdir', '-p', '/app/scripts/lib']);
    copy(resolve('scripts/lib/pitr-remote-fixture.mjs'), `${store}:/app/scripts/lib/pitr-remote-fixture.mjs`);
    copy(`${proof}/cert.pem`, `${store}:/tmp/cert.pem`); copy(`${proof}/fixture-key.pem`, `${store}:/tmp/key.pem`);
    exec(store, ['sh', '-c', 'node /app/scripts/lib/pitr-remote-fixture.mjs store >/tmp/store.log 2>&1 &']);
  }
  worker(producer, `container:${source}`);
  if (rustfs) {
    copy(resolve('scripts/lib/pitr-provider-check.mjs'), `${producer}:/app/scripts/lib/pitr-provider-check.mjs`);
    result.provider.bootstrap = JSON.parse(exec(producer, ['node', '/app/scripts/lib/pitr-provider-check.mjs'], 90_000));
    passed('RustFS accepted signed HTTPS bucket creation and rejected a request signed with the wrong secret');
    passed('RustFS listed 201 escaped keys across two pages and the isolated pagination prefix was emptied');
  }
  let nodeAgent;
  if (node) {
    nodeAgent = `${tag}-agent`;
    worker(nodeAgent, `container:${source}`);
    const token = randomBytes(32).toString('hex'), control = randomBytes(32).toString('hex');
    writeFileSync(`${proof}/node-agent.json`, JSON.stringify({ tokenHash: createHash('sha256').update(token).digest('hex'), control }), { mode: 0o600 });
    writeFileSync(`${proof}/node-panel.json`, JSON.stringify({ token, control }), { mode: 0o600 });
    copy(`${proof}/node-agent.json`, `${nodeAgent}:/tmp/node-fixture.json`);
    copy(`${proof}/node-panel.json`, `${producer}:/tmp/node-fixture.json`);
    exec(nodeAgent, ['sh', '-c', 'node /app/scripts/lib/pitr-node-fixture.mjs agent >/tmp/node-agent.log 2>&1 &']);
  }
  exec(source, ['docker', '-H', 'tcp://127.0.0.1:2375', 'pull', 'postgres:18'], 300_000);
  const produce = exec(producer, node ? ['env', 'DOCKER_HOST=tcp://127.0.0.1:1', 'node', '/app/scripts/lib/pitr-node-fixture.mjs', 'produce'] : ['node', '/app/scripts/lib/pitr-remote-fixture.mjs', continuous ? 'stream-produce' : 'produce'], 600_000);
  writeFileSync(`${proof}/produce.log`, produce); copy(`${producer}:/tmp/receipt.json`, `${proof}/receipt.json`);
  const receipt = JSON.parse(readFileSync(`${proof}/receipt.json`, 'utf8')); result.receipt = receipt;
  if (node) {
    assert.equal(receipt.nodeArchive, true); assert.equal(receipt.nodeLocalDockerUnavailable, true); passed('node archive control and sealed export work with no panel Docker daemon');
    assert.equal(receipt.nodeCheckpointVerified, true); passed('node self-contained checkpoint mode uploads a verified recovery set');
    assert.equal(receipt.nodeKillSwitchRefused, true); passed('live node-owner kill switch refuses production and preserves the verified remote head');
    assert.equal(receipt.nodeDisableVerified, true); passed('disabling node archiving removes only its local archive and preserves SQL data and remote recovery');
    owned(nodeAgent); assert.equal(removeOwnedSmokeResource(cli, 'container', nodeAgent, owner, { removeAnonymousVolumes: true }), 'removed');
  }
  if (continuous) {
    assert.equal(receipt.orphanCollection, true); passed('old unpublished objects are retired through the archive head, deleted only after grace, and foreign keys survive');
    assert.equal(receipt.incremental, true); passed('new closed WAL ships without replacing the base anchor');
    assert.equal(receipt.rollover, true); passed('three real base generations hand off with overlapping WAL');
    assert.equal(receipt.retention, true); passed('expired generation deleted after grace while two recovery generations remain');
    assert.equal(receipt.staleWriterRefused, true); passed('stale conditional writer cannot replace the remote index');
  } else {
    passed('encrypted base and WAL checkpoint uploaded and verified through HTTPS S3 requests');
    assert.equal(receipt.missingSourceWalRefused, true); passed('missing source WAL refuses a new checkpoint and preserves the verified recovery set');
    assert.equal(receipt.extraTablespaceRefused, true); passed('a real additional PostgreSQL tablespace is refused instead of omitted from a checkpoint');
  }
  owned(producer); assert.equal(removeOwnedSmokeResource(cli, 'container', producer, owner, { removeAnonymousVolumes: true }), 'removed');
  owned(source); assert.equal(removeOwnedSmokeResource(cli, 'container', source, owner, { removeAnonymousVolumes: true }), 'removed');
  result.sourceHostRemoved = true;
  result.remoteAgeSecondsAtHostLoss = Math.max(0, (Date.now() - Date.parse(receipt.through)) / 1000);
  passed('source daemon, database, archive volumes, panel database and source master key removed');
  await daemon(target);
  assert.equal(exec(target, ['docker', '-H', 'tcp://127.0.0.1:2375', 'volume', 'ls', '-q']), '');
  worker(recovery, `container:${target}`);
  const input = { cfg: storeCfg, key: receipt.key,
    passphrase: 'off-host-n04-recovery-passphrase', targetTime: receipt.point, volumeName: 'nd-db-restored-data', newPassword: 'new-independent-password', ...(continuous ? { expectedRows: receipt.selectedRows } : {}) };
  writeFileSync(`${proof}/recovery.json`, JSON.stringify(input), { mode: 0o600 }); copy(`${proof}/recovery.json`, `${recovery}:/tmp/recovery.json`);
  const started = Date.now();
  const out = exec(recovery, ['node', '/app/scripts/recover-pitr-checkpoint.mjs', '/tmp/recovery.json'], 600_000);
  result.restoreWallMs = Date.now() - started; writeFileSync(`${proof}/recovery-result.json`, out); copy(`${proof}/recovery-result.json`, `${recovery}:/tmp/recovery-result.json`);
  const verification = exec(recovery, ['node', '/app/scripts/lib/pitr-remote-fixture.mjs', 'verify'], 120_000);
  writeFileSync(`${proof}/verify.log`, verification);
  passed(`clean-daemon selected-time recovery contains ${input.expectedRows ?? 'one,two'}; later writes absent; new password accepted`);
  exec(target, ['docker', '-H', 'tcp://127.0.0.1:2375', 'rm', '-f', 'nd-db-proof-recovered']);
  const latest = { ...input, targetTime: null, volumeName: 'nd-db-latest-data', expectedRows: receipt.checkpointRows };
  writeFileSync(`${proof}/latest.json`, JSON.stringify(latest), { mode: 0o600 }); copy(`${proof}/latest.json`, `${recovery}:/tmp/recovery.json`);
  const latestOut = exec(recovery, ['node', '/app/scripts/recover-pitr-checkpoint.mjs', '/tmp/recovery.json'], 600_000);
  writeFileSync(`${proof}/latest-result.json`, latestOut); copy(`${proof}/latest-result.json`, `${recovery}:/tmp/recovery-result.json`);
  writeFileSync(`${proof}/latest-verify.log`, exec(recovery, ['node', '/app/scripts/lib/pitr-remote-fixture.mjs', 'verify'], 120_000));
  result.verifiedCheckpointRowsLost = 0;
  result.postCheckpointFaultFixtureRowsExcluded = receipt.postCheckpointFaultFixtureRows;
  passed(`latest-point recovery contains every row captured by the verified ${continuous ? 'stream' : 'checkpoint'}`);
  const faults = continuous ? ['wrong-passphrase', 'missing-index', 'missing-wal', 'damaged-wal', 'damaged-index'] : ['wrong-passphrase', 'missing-object', 'damaged-object'];
  for (const fault of faults) {
    const next = { ...input, targetTime: null, volumeName: `nd-db-${fault}-data`, ...(fault === 'wrong-passphrase' ? { passphrase: 'this-is-the-wrong-passphrase' } : continuous ? {} : { key: `${receipt.key}/${fault === 'missing-object' ? 'missing' : 'corrupt'}.ndpc` }) };
    if (fault === 'missing-index') next.key = receipt.key.replace(receipt.archiveId, '00000000-0000-4000-8000-000000000001');
    if (fault === 'missing-wal' || fault === 'damaged-wal') {
      exec(recovery, ['node', '--input-type=module', '-e', "import {s3GetToFile,s3Delete,s3PutFile} from '/app/apps/server/dist/lib/s3.js';import {readFile,writeFile} from 'node:fs/promises';const c=JSON.parse(process.argv[1]),k=process.argv[2];await s3GetToFile(c,k,'/tmp/good-wal');if(process.argv[3]==='missing-wal')await s3Delete(c,k);else {const b=await readFile('/tmp/good-wal');b[b.length-1]^=1;await writeFile('/tmp/bad-wal',b);await s3PutFile(c,k,'/tmp/bad-wal');}", JSON.stringify(input.cfg), receipt.latestWalKey, fault]);
    }
    if (fault === 'damaged-object' || fault === 'damaged-index') {
      exec(recovery, ['node', '--input-type=module', '-e', "import {s3Put} from '/app/apps/server/dist/lib/s3.js';await s3Put(JSON.parse(process.argv[1]),process.argv[2],'corrupt');", JSON.stringify(input.cfg), next.key]);
    }
    writeFileSync(`${proof}/${fault}.json`, JSON.stringify(next), { mode: 0o600 }); copy(`${proof}/${fault}.json`, `${recovery}:/tmp/fault.json`);
    owned(recovery); const r = cli(['exec', recovery, 'node', '/app/scripts/recover-pitr-checkpoint.mjs', '/tmp/fault.json'], 120_000);
    assert.notEqual(r.status, 0); assert.equal(exec(target, ['docker', '-H', 'tcp://127.0.0.1:2375', 'volume', 'ls', '-q', '--filter', `name=^${next.volumeName}$`]), '');
    passed(`${fault} is refused before creating a target data volume`);
    if (fault === 'missing-wal' || fault === 'damaged-wal') exec(recovery, ['node', '--input-type=module', '-e', "import {s3PutFile} from '/app/apps/server/dist/lib/s3.js';await s3PutFile(JSON.parse(process.argv[1]),process.argv[2],'/tmp/good-wal');", JSON.stringify(input.cfg), receipt.latestWalKey]);
  }
} catch (err) {
  result.error = err.message; console.error(err.message); process.exitCode = 1;
  const store = `${tag}-store`;
  if (rustfs && inspectOwnedSmokeResource(cli, 'container', store, owner).status === 'owned') {
    const logs = cli(['logs', '--tail', '80', store]);
    writeFileSync(`${proof}/provider.log`, (logs.stdout + logs.stderr).replaceAll(storeCfg.secretAccessKey, '[fixture credential]'));
  }
}
finally {
  const cleanup = [];
  for (const [kind, name] of created.reverse()) {
    const check = inspectOwnedSmokeResource(cli, kind, name, owner);
    if (check.status === 'unavailable') { cleanup.push('already absent'); continue; }
    cleanup.push(removeOwnedSmokeResource(cli, kind, name, owner, { removeAnonymousVolumes: true }));
  }
  result.cleanupResults = cleanup; result.cleanup = cleanup.every(s => s === 'removed' || s === 'already absent');
  if (rustfs && result.cleanup) {
    for (const file of [`${proof}/fixture-key.pem`, `${proof}/rustfs-tls/rustfs_key.pem`]) rmSync(file, { force: true });
  }
  if (!result.cleanup) process.exitCode = 1;
  writeFileSync(`${proof}/result.json`, JSON.stringify(result, null, 2));
}
