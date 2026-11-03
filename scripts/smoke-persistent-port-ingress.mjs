// Kernel acceptance only. Never run against a developer or production Docker daemon.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { persistentPortForwardRules, renderPersistentPortNft } from '../apps/server/src/lib/persistentPortNft.ts';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.env.DOCKER_HOST, 'unix:///var/run/docker.sock');
assert.equal(process.env.DOCKER_CONTEXT, 'default');
const root = process.cwd(), proof = resolve('.temp_files/persistent-port-native');
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
  for (const rule of persistentPortForwardRules(spec, [spec.target, candidate])) inside('iptables', '-A', 'NDPI_TEST', ...rule);
  const publish = next => { writeFileSync(resolve(proof, 'rules.nft'), renderPersistentPortNft(next, next.revision > 1)); inside('nft', '-f', '/proof/rules.nft'); };
  publish(spec);
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
  observations.push(await until(() => probe('old')));
  const webTarget = expected => innerDocker('exec', 'client', 'node', fixture, 'web-probe', expected);
  await until(() => webTarget('old'));
  innerDocker('exec', '-d', 'client', 'node', fixture, 'hold', 'old', '172.28.0.2');
  innerDocker('exec', '-d', 'client', 'node', fixture, 'sample');
  await until(() => assert.ok(existsSync(resolve(proof, 'hold-ready'))));
  // Probe readiness from the host namespace; cross-network traffic is intentionally denied.
  const readyStatus = () => innerDocker('exec', 'new', 'node', '-e', "fetch('http://127.0.0.1:3000/ready').then(r=>console.log(r.status))");
  assert.equal(readyStatus(), '503');
  observations.push(probe('old'));
  innerDocker('exec', 'new', 'touch', '/tmp/ready');
  assert.equal(readyStatus(), '200');
  publish({ ...spec, target: candidate, revision: 2 }); route(candidate.ipv4);
  observations.push(probe('new'));
  await until(() => webTarget('new'));
  publish({ ...spec, revision: 3 }); route(spec.target.ipv4);
  observations.push(probe('old'));
  await until(() => webTarget('old'));
  writeFileSync(resolve(proof, 'finish'), 'finish');
  await until(() => { assert.ok(existsSync(resolve(proof, 'hold-result.json'))); assert.ok(existsSync(resolve(proof, 'web-result.json'))); });
  const held = JSON.parse(readFileSync(resolve(proof, 'hold-result.json'))), web = JSON.parse(readFileSync(resolve(proof, 'web-result.json')));
  assert.ok(held.count > 10); assert.ok(web.count > 10);
  writeFileSync(resolve(proof, 'result.json'), JSON.stringify({ passed: true, observations, held, web, productionIntegration: false, monosipDatabaseMigration: false }, null, 2));
} finally {
  if (created) {
    for (const [file, args] of [['nft.json', ['nft', '-j', 'list', 'ruleset']], ['iptables.txt', ['iptables-save', '-c']], ['conntrack.txt', ['conntrack', '-L']], ['routes.txt', ['ip', 'route']]]) {
      try { writeFileSync(resolve(proof, file), inside(...args)); } catch {}
    }
    for (const container of ['old', 'new', 'keeper', 'proxy', 'client']) { try { writeFileSync(resolve(proof, `${container}.log`), innerDocker('logs', container)); } catch {} }
    docker('rm', '-f', '-v', name);
    assert.ok(!docker('ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'));
    writeFileSync(resolve(proof, 'cleanup.json'), JSON.stringify({ ownedDaemonRemoved: name }));
  }
}
