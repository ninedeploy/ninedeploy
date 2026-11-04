// Kernel acceptance only. Never run against a developer or production Docker daemon.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, readdirSync, appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPersistentPortNftState, persistentPortFingerprint } from '../apps/server/src/lib/persistentPortNft.ts';
import { PersistentPortPublicationPending } from '../apps/server/src/lib/persistentPortPublication.ts';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.env.DOCKER_HOST, 'unix:///var/run/docker.sock');
assert.equal(process.env.DOCKER_CONTEXT, 'default');
const root = fileURLToPath(new URL('..', import.meta.url)), proof = resolve(root, '.temp_files/persistent-port-native');
process.chdir(root);
mkdirSync(proof, { recursive: true });
const name = `ndpi-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 180000, maxBuffer: 8 << 20 }).trim();
const inside = (...args) => docker('exec', name, ...args);
const innerDocker = (...args) => inside('docker', ...args);
const nodeImage = 'node:26.12.1-alpine';
const fixture = '/workspace/scripts/fixtures/persistent-port-runtime.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const end = Date.now() + 30000; let last; do { try { return await check(); } catch (error) { last = error; await delay(200); } } while (Date.now() < end); throw last; }
const spec = { serviceId: 1, owner: 'a'.repeat(32), revision: 1, mark: 0x4e440001,
  target: { id: 'b'.repeat(64), ipv4: '172.29.0.2' }, bindings: [
    { hostIp: '10.6.6.9', hostPort: 5060, containerPort: 5060, protocol: 'tcp' },
    { hostIp: '10.6.6.9', hostPort: 5060, containerPort: 5060, protocol: 'udp' },
    { hostIp: '10.6.6.9', hostPort: 3478, containerPort: 3478, protocol: 'udp' },
    { hostIp: '10.6.6.9', hostPort: 10000, hostPortEnd: 10100, containerPort: 10000, protocol: 'udp' },
  ] };
let created = false;
const observations = [];
try {
  docker('run', '-d', '--privileged', '--name', name, '-e', 'DOCKER_TLS_CERTDIR=', '-v', `${root}:/workspace:ro`, '-v', `${proof}:/proof`, 'docker:29-dind', '--iptables=true');
  created = true;
  await until(() => innerDocker('info'));
  inside('apk', 'add', '--no-cache', 'nftables', 'conntrack-tools', 'tcpdump', 'iproute2', 'util-linux');
  docker('exec', '-d', name, 'sh', '-c', 'tcpdump -l -nn -i any udp port 5060 or tcp port 5060 or udp port 3478 > /proof/packets.log 2>&1');
  inside('ip', 'addr', 'add', '10.6.6.9/32', 'dev', 'lo');
  innerDocker('network', 'create', '--subnet=172.29.0.0/24', 'backend');
  const run = (container, network, ip, args, extra = []) => innerDocker('run', '-d', '--name', container, '--network', network, ...(ip ? ['--ip', ip] : []), '-v', '/workspace:/workspace:ro', '-v', '/proof:/proof', ...extra, nodeImage, 'node', fixture, ...args);
  run('old', 'backend', '172.29.0.2', ['server', 'old']);
  run('new', 'backend', '172.29.0.3', ['server', 'new']);
  run('keeper', 'host', null, ['keeper']);
  spec.target.id = innerDocker('inspect', 'old', '--format', '{{.Id}}');
  const candidate = { id: innerDocker('inspect', 'new', '--format', '{{.Id}}'), ipv4: '172.29.0.3' };
  inside('iptables', '-S', 'DOCKER-FORWARD'); // Refuse unsupported Docker forwarding topology.
  inside('iptables', '-N', 'NDPI_TEST');
  inside('iptables', '-I', 'DOCKER-FORWARD', '1', '-j', 'NDPI_TEST');
  const route = target => {
    writeFileSync(resolve(proof, 'dynamic.next'), `http:\n  routers:\n    web:\n      rule: Host(\`pbx.test\`)\n      service: web\n  services:\n    web:\n      loadBalancer:\n        servers:\n          - url: http://${target}:3000\n`);
    renameSync(resolve(proof, 'dynamic.next'), resolve(proof, 'dynamic.yml'));
  };
  route('172.29.0.2');
  innerDocker('run', '-d', '--name', 'proxy', '--network', 'backend', '-p', '10.6.6.9:8080:80', '-v', '/proof:/config:ro', 'traefik:3', '--entrypoints.web.address=:80', '--providers.file.directory=/config', '--providers.file.watch=true', '--accesslog=true', '--log.level=INFO');
  writeFileSync(resolve(proof, 'images.json'), innerDocker('image', 'inspect', nodeImage, 'traefik:3', '--format', '{{json .RepoDigests}}'));
  innerDocker('run', '-d', '--name', 'client', '--network', 'none', '-v', '/workspace:/workspace:ro', '-v', '/proof:/proof', nodeImage, 'sleep', '180');
  // Model an external routed client, not another Docker bridge destination.
  // Docker 29 correctly drops replies to unpublished ports on protected bridges
  // in raw PREROUTING; weakening that protection would hide an invalid fixture.
  const clientPid = innerDocker('inspect', 'client', '--format', '{{.State.Pid}}');
  assert.match(clientPid, /^[1-9][0-9]*$/);
  inside('ip', 'link', 'add', 'ndpi-client', 'type', 'veth', 'peer', 'name', 'ndpi-peer');
  inside('ip', 'link', 'set', 'ndpi-peer', 'netns', clientPid);
  inside('ip', 'addr', 'add', '172.28.0.1/24', 'dev', 'ndpi-client');
  inside('ip', 'link', 'set', 'ndpi-client', 'up');
  for (const args of [
    ['link', 'set', 'ndpi-peer', 'name', 'eth0'],
    ['addr', 'add', '172.28.0.2/24', 'dev', 'eth0'],
    ['link', 'set', 'eth0', 'up'],
    ['route', 'add', 'default', 'via', '172.28.0.1'],
  ]) inside('nsenter', '-t', clientPid, '-n', 'ip', ...args);
  const probe = expected => JSON.parse(innerDocker('exec', 'client', 'node', fixture, 'probe', expected, '172.28.0.2'));
  const webTarget = expected => innerDocker('exec', 'client', 'node', fixture, 'web-probe', expected);
  await until(() => webTarget('old'));
  let loseWebAck = false, loseKernelAck = false;
  innerDocker('run', '-d', '--name', 'port-worker', '--network', 'host', '--cap-add=NET_ADMIN', '-e', 'ND_PORT_WORKER_FIXTURE=1', '-v', '/workspace:/workspace:ro', '-v', '/proof:/proof', '-v', '/var/run/docker.sock:/var/run/docker.sock', nodeImage, 'sleep', '360');
  innerDocker('exec', 'port-worker', 'apk', 'add', '--no-cache', 'nftables', 'iptables', 'util-linux', 'conntrack-tools', 'docker-cli');
  const hostNamespace = inside('readlink', '/proc/self/ns/net');
  const workerNamespaces = [], workerCalls = [];
  const worker = (kind, desired, targetId, controls = {}) => new Promise((accept, reject) => {
    const trace = controls.trace ?? randomBytes(8).toString('hex');
    const child = spawn('docker', ['exec', '-i', name, 'docker', 'exec', '-i', 'port-worker', 'node', '/workspace/scripts/fixtures/persistent-port-host-worker.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', result, failure, completed = false;
    const timer = setTimeout(() => { child.stdin.destroy(); child.kill('SIGTERM'); reject(new Error('Host worker response deadline')); }, 40000);
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stderr.on('data', data => appendFileSync(resolve(proof, 'worker-stderr.log'), data));
    child.stdout.on('data', data => {
      buffer += data.toString();
      if (buffer.length > 262144) { failure = new Error('Oversized worker response'); child.stdin.destroy(); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); let message;
        try { message = JSON.parse(line); } catch { failure = new Error('Invalid worker response'); child.stdin.destroy(); return; }
        if (message.type === 'web') {
          const c = message.challenge;
          try { assert.equal(c.version, 1); assert.match(c.token, /^[a-f0-9]{32}$/); assert.equal(c.serviceId, desired.serviceId); assert.equal(c.owner, desired.owner); assert.equal(c.revision, desired.revision); assert.equal(c.targetId, desired.target.id); assert.equal(c.fingerprint, persistentPortFingerprint(desired)); }
          catch (error) { failure = error; child.stdin.destroy(); continue; }
          (async () => {
            route(desired.target.ipv4); await until(() => webTarget(desired.target.id === candidate.id ? 'new' : 'old'));
            if (loseWebAck) child.stdin.end();
            else if (!completed && !child.stdin.destroyed) child.stdin.write(JSON.stringify({ type: 'ack', ack: { ...c, loaded: true } }) + '\n');
          })().catch(error => { failure = error; child.stdin.destroy(); });
        } else if (message.type === 'done') {
          try { assert.equal(message.networkNamespace, hostNamespace); } catch (error) { failure = error; }
          workerNamespaces.push(message.networkNamespace); result = message.result; child.stdin.end();
        } else if (message.type === 'error') failure = message.pending ? new PersistentPortPublicationPending(message.message) : new Error(message.message);
        else { failure = new Error('Unknown worker response'); child.stdin.destroy(); }
      }
    });
    child.on('close', () => { completed = true; clearTimeout(timer); const error = failure ?? (!result ? new PersistentPortPublicationPending('Worker exited without a completion acknowledgement') : undefined); workerCalls.push({ kind, trace, completed: !!result, pending: error instanceof PersistentPortPublicationPending }); if (error) reject(error); else accept(result); });
    child.stdin.write(JSON.stringify({ type: 'start', trace, directory: controls.directory, fault: controls.fault ?? (loseKernelAck ? 'kernel-ack' : undefined), request: { version: 1, kind, spec: desired, ...(targetId === undefined ? {} : { targetId }) } }) + '\n');
  });
  const authority = {
    readJournal: async () => (await worker('inspect', spec)).journal,
    ready: async desired => {
      const runtime = JSON.parse(innerDocker('inspect', desired.target.id))[0]; assert.equal(runtime.Id, desired.target.id); assert.equal(runtime.State.Running, true);
      const status = innerDocker('exec', desired.target.id, 'node', '-e', "fetch('http://127.0.0.1:3000/ready').then(r=>console.log(r.status))"); assert.equal(status, '200', 'Candidate is not ready');
    },
  };
  const createPublisher = () => ({
    promote: async desired => (await worker('promote', desired)).journal,
    recover: async desired => (await worker('recover', desired)).journal,
    rollbackPending: async desired => (await worker('rollback', desired)).journal,
    retireDrained: async (desired, targetId) => (await worker('retire', desired, targetId)).retired,
  });
  const publisher = createPublisher();
  await until(() => authority.ready(spec));
  await publisher.promote(spec);
  observations.push(await until(() => probe('old')));
  innerDocker('exec', '-d', 'client', 'node', fixture, 'hold', 'old', '172.28.0.2');
  innerDocker('exec', '-d', 'client', 'node', fixture, 'sample');
  await until(() => assert.ok(existsSync(resolve(proof, 'hold-ready'))));
  const next = { ...spec, target: candidate, revision: 2 };
  await assert.rejects(() => publisher.promote(next), /Candidate is not ready/);
  assert.equal((await authority.readJournal()).pending, null);
  observations.push(probe('old'));
  innerDocker('exec', 'new', 'touch', '/tmp/ready');
  loseWebAck = true;
  await assert.rejects(() => publisher.promote(next), PersistentPortPublicationPending);
  const unresolved = await authority.readJournal();
  assert.equal(unresolved.pending.revision, 2); assert.equal(unresolved.committed.revision, 1);
  assert.deepEqual(unresolved.retained.map(target => target.id).sort(), [spec.target.id, candidate.id].sort());
  await assert.rejects(() => publisher.retireDrained(next, spec.target.id), PersistentPortPublicationPending);
  observations.push(probe('new'));
  loseWebAck = false;
  const recovered = createPublisher();
  await recovered.recover(next);
  assert.equal(await recovered.retireDrained(next, spec.target.id), false);
  await recovered.promote({ ...spec, revision: 3 });
  observations.push(probe('old'));
  await until(() => webTarget('old'));

  // A candidate can fail after the port publication but before the web ACK.
  // Keep its existing flows while restoring fresh traffic to the healthy old
  // target through a new, durable rollback revision.
  const interrupted = { ...spec, target: candidate, revision: 4 };
  loseKernelAck = true;
  await assert.rejects(() => recovered.promote(interrupted), PersistentPortPublicationPending);
  loseKernelAck = false;
  observations.push(probe('new'));
  innerDocker('exec', '-d', 'client', 'node', fixture, 'hold', 'new', '172.28.0.2', 'candidate');
  await until(() => assert.ok(existsSync(resolve(proof, 'candidate-hold-ready'))));
  innerDocker('exec', 'new', 'node', '-e', 'require("node:fs").unlinkSync("/tmp/ready")');
  await assert.rejects(() => createPublisher().recover(interrupted), PersistentPortPublicationPending);
  const rollback = { ...spec, revision: 5 };
  await createPublisher().rollbackPending(rollback);
  observations.push(probe('old')); await until(() => webTarget('old'));
  assert.equal(await createPublisher().retireDrained(rollback, candidate.id), false);

  // Kill a real target-host worker while its local nft child survives. The
  // unfenced control must let a competing worker inspect before nft commits.
  inside('ip', 'addr', 'add', '10.6.6.8/32', 'dev', 'lo');
  const workerFenceResults = [];
  for (const kind of ['fenced', 'unfenced']) {
    const directory = '/proof/worker-fence-' + kind, trace = randomBytes(8).toString('hex'), inspectTrace = randomBytes(8).toString('hex');
    const claim = { ...spec, serviceId: kind === 'fenced' ? 2 : 3, owner: 'd'.repeat(32), revision: 1, mark: kind === 'fenced' ? 0x4e440002 : 0x4e440003,
      bindings: [{ hostIp: '10.6.6.8', hostPort: kind === 'fenced' ? 15060 : 25060, containerPort: 5060, protocol: 'udp' }] };
    const table = 'ndpi_s' + claim.serviceId;
    const parent = worker('promote', claim, undefined, { directory, trace, fault: kind === 'fenced' ? 'fenced-child' : 'unfenced-child' }).catch(error => error);
    await until(() => innerDocker('exec', 'port-worker', 'test', '-f', directory + '/child-ready'));
    const pid = innerDocker('exec', 'port-worker', 'cat', directory + '/' + trace + '.pid'); assert.match(pid, /^[1-9][0-9]*$/); assert.ok(Number(pid) > 1);
    innerDocker('exec', 'port-worker', 'kill', '-KILL', pid);
    assert.ok(await parent instanceof PersistentPortPublicationPending);
    const successor = worker('inspect', claim, undefined, { directory, trace: inspectTrace });
    await until(() => innerDocker('exec', 'port-worker', 'test', '-f', directory + '/' + inspectTrace + '.pid'));
    if (kind === 'fenced') assert.throws(() => innerDocker('exec', 'port-worker', 'flock', '--nonblock', directory + '/authority.lock', 'true'));
    else {
      const before = await successor; assert.equal(before.journal.pending.revision, 1);
      const tables = JSON.parse(inside('nft', '-j', 'list', 'tables')); assert.ok(!tables.nftables.some(x => x.table?.name === table));
    }
    innerDocker('exec', 'port-worker', 'touch', directory + '/release');
    await until(() => assert.ok(innerDocker('exec', 'port-worker', 'cat', directory + '/events.log').includes('mutator-finish')));
    const inspected = await successor; assert.equal(inspected.journal.pending.revision, 1); assert.equal(inspected.journal.committed, null);
    const events = innerDocker('exec', 'port-worker', 'cat', directory + '/events.log').trim().split('\n');
    assert.deepEqual(events, kind === 'fenced' ? ['mutator-enter', 'mutator-finish', 'competitor-finish'] : ['mutator-enter', 'competitor-finish', 'mutator-finish']);
    const nftState = JSON.parse(inside('nft', '-j', 'list', 'table', 'ip', table)); assertPersistentPortNftState(claim, nftState);
    writeFileSync(resolve(proof, 'worker-fence-' + kind + '-nft.json'), JSON.stringify(nftState));
    workerFenceResults.push({ kind, events, claim, actualNftChildCommitted: true, recoveredPendingIntent: true });
  }
  writeFileSync(resolve(proof, 'target-host-worker.json'), JSON.stringify({ hostNamespace, workerNamespaces, workerCalls, workerFenceResults }, null, 2));

  // Prove that a surviving mutator, rather than its killed parent, owns the
  // OS lock. The unfenced control must let a competing writer enter early.
  innerDocker('run', '-d', '--name', 'authority', '-v', '/workspace:/workspace:ro', '-v', '/proof:/proof', nodeImage, 'sleep', '180');
  innerDocker('exec', 'authority', 'apk', 'add', '--no-cache', 'util-linux');
  const lockFixture = '/workspace/scripts/fixtures/persistent-port-lock.mjs';
  const lockResults = [];
  const existsInHelper = path => innerDocker('exec', 'authority', 'node', '-e', 'if(!require("node:fs").existsSync(process.argv[1]))process.exit(1)', path);
  for (const kind of ['fenced', 'unfenced']) {
    const dir = `/proof/locks/${kind}`;
    innerDocker('exec', '-d', 'authority', 'node', lockFixture, 'parent', dir, kind);
    await until(() => existsInHelper(`${dir}/mutator-ready`));
    const pid = innerDocker('exec', 'authority', 'cat', `${dir}/parent.pid`);
    assert.match(pid, /^[1-9][0-9]*$/); assert.ok(Number(pid) > 1);
    innerDocker('exec', 'authority', 'kill', '-KILL', pid);
    innerDocker('exec', '-d', 'authority', 'node', lockFixture, 'competitor', dir);
    await until(() => existsInHelper(`${dir}/competitor-attempt`));
    if (kind === 'unfenced') await until(() => existsInHelper(`${dir}/competitor-entered`));
    else {
      await delay(250);
      assert.throws(() => existsInHelper(`${dir}/competitor-entered`));
    }
    innerDocker('exec', 'authority', 'touch', `${dir}/release`);
    await until(() => existsInHelper(`${dir}/competitor-entered`));
    const events = await until(() => {
      const lines = innerDocker('exec', 'authority', 'cat', `${dir}/events.log`).split('\n');
      assert.ok(lines.includes('mutator-finish')); return lines;
    });
    assert.equal(events.indexOf('mutator-finish') < events.indexOf('competitor-enter'), kind === 'fenced');
    lockResults.push({ kind, events });
  }
  innerDocker('exec', 'authority', 'node', lockFixture, 'guards', '/proof/locks/guards');
  const guards = JSON.parse(innerDocker('exec', 'authority', 'cat', '/proof/locks/guards/guards.json'));
  writeFileSync(resolve(proof, 'host-authority.json'), JSON.stringify({ lockResults, guards }, null, 2));
  // Remove only this fixture's private root-owned directories so the runner
  // can archive the public proof files without weakening lock permissions.
  innerDocker('exec', 'authority', 'node', '-e', 'require("node:fs").rmSync("/proof/locks",{recursive:true,force:true})');
  writeFileSync(resolve(proof, 'finish'), 'finish');
  await until(() => { assert.ok(existsSync(resolve(proof, 'hold-result.json'))); assert.ok(existsSync(resolve(proof, 'candidate-hold-result.json'))); assert.ok(existsSync(resolve(proof, 'web-result.json'))); });
  const held = JSON.parse(readFileSync(resolve(proof, 'hold-result.json'))), web = JSON.parse(readFileSync(resolve(proof, 'web-result.json')));
  const candidateHeld = JSON.parse(readFileSync(resolve(proof, 'candidate-hold-result.json')));
  assert.ok(held.count > 10); assert.ok(web.count > 10);
  assert.ok(candidateHeld.count > 5);
  writeFileSync(resolve(proof, 'publication.json'), JSON.stringify(await authority.readJournal()));
  writeFileSync(resolve(proof, 'result.json'), JSON.stringify({ passed: true, durableJournalStore: true, kernelAuthorityIntegration: true, targetHostWorker: true, workerFenceResults, observations, held, candidateHeld, web, unreadyHeld: true, uncertainAckRetained: true, recoveryFromDisk: true, activeFlowRetirementBlocked: true, unconfirmedRollback: true, rollbackCandidateWasUnready: true, productionIntegration: false, monosipDatabaseMigration: false }, null, 2));
} finally {
  try {
  if (created) {
    for (const kind of ['fenced', 'unfenced']) {
      try { writeFileSync(resolve(proof, `lock-${kind}-events.log`), innerDocker('exec', 'authority', 'cat', `/proof/locks/${kind}/events.log`)); } catch {}
    }
    try { innerDocker('exec', 'authority', 'node', '-e', 'require("node:fs").rmSync("/proof/locks",{recursive:true,force:true})'); } catch {}
    for (const [file, args] of [['nft.json', ['nft', '-j', 'list', 'ruleset']], ['iptables.txt', ['iptables-save', '-c']], ['conntrack.txt', ['conntrack', '-L']], ['routes.txt', ['ip', 'route']]]) {
      try { writeFileSync(resolve(proof, file), inside(...args)); } catch {}
    }
    for (const container of ['old', 'new', 'keeper', 'proxy', 'client', 'authority']) { try { writeFileSync(resolve(proof, `${container}.log`), innerDocker('logs', container)); } catch {} }
    docker('rm', '-f', '-v', name);
    assert.ok(!docker('ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'));
    writeFileSync(resolve(proof, 'cleanup.json'), JSON.stringify({ ownedDaemonRemoved: name }));
  }
  } finally {
    // Preserve private 0700 worker state. Only regular, top-level synthetic
    // proof files are eligible for the runner-owned upload directory.
    const exported = resolve(root, '.temp_files/persistent-port-native-public');
    mkdirSync(exported, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(proof, { withFileTypes: true })) {
      if (entry.isFile() && /\.(json|log|txt|nft|yml)$/.test(entry.name)) copyFileSync(resolve(proof, entry.name), resolve(exported, entry.name));
    }
  }
}
