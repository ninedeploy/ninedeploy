import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { primaryNetworkProxyClient } from './lib/primary-network-proxy-client.mjs';

// This acceptance must never touch a developer's or production Docker daemon.
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use an isolated GitHub Actions runner');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Use a GitHub-hosted runner');
assert.equal(process.env.DOCKER_HOST, 'unix:///var/run/docker.sock', 'Use only the hosted runner daemon');
const image = process.argv.find(arg => arg.startsWith('--image='))?.slice(8);
assert.ok(image && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image), 'Pass --image=<candidate>');
const baseline = process.argv.includes('--expect-regression');
const proof = resolve(process.argv.find(arg => arg.startsWith('--proof='))?.slice(8) ?? '.temp_files/primary-network-readiness');
mkdirSync(proof, { recursive: true });
const owner = `primary-${randomBytes(8).toString('hex')}`, primary = `nd-svc-${owner}`, secondary = `aaa-private-${owner}`;
const app = `nd-${owner}-app`, proxy = `nd-${owner}-proxy`;
const resources = [], cases = [], cleanup = [];
const docker = (args, allowed = false) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 2 << 20, windowsHide: true });
  if (!allowed) assert.equal(r.status, 0, `${args.slice(0, 3)}: ${r.stderr || r.stdout}`);
  return { ...r, out: (r.stdout ?? '').trim() };
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { if (await fn()) return; await pause(200); }
  throw Error(`Timed out: ${description}`);
}
function create(kind, name, args) {
  const command = kind === 'network' ? ['network', 'create'] : ['run', '-d'];
  const id = docker([...command, '--label', `ninedeploy.proof=${owner}`, ...(kind === 'network' ? [name] : ['--name', name]), ...args]).out;
  resources.push({ kind, name, id }); return id;
}
let serial = 0;
function client(network, program) {
  const name = `nd-${owner}-client-${++serial}`;
  return docker(['run', '--rm', '--name', name, '--label', `ninedeploy.proof=${owner}`, '--network', network,
    '--no-healthcheck', '--user', '0', '-e', 'NODE_ENV=test', '-e', 'DOCKER_HOST=unix:///var/run/docker.sock',
    '-v', '/var/run/docker.sock:/var/run/docker.sock', '--entrypoint', 'node', image, '--input-type=module', '-e', program]);
}
const proxyProgram = count => primaryNetworkProxyClient(proxy, count);
let lastProxyObservation;
async function proxyReady(healthy) {
  await until(() => { try { const rows = JSON.parse(client(primary, proxyProgram(1)).out); lastProxyObservation = rows; return healthy ? rows[0] === 200 : rows[0] >= 500; } catch (error) { lastProxyObservation = String(error).slice(-1500); return false; } }, 'proxy routing');
}
async function sample(name, network, expectedReady) {
  const networks = JSON.parse(docker(['inspect', app, '--format', '{{json .NetworkSettings.Networks}}']).out);
  const networkMode = docker(['inspect', app, '--format', '{{.HostConfig.NetworkMode}}']).out;
  const program = `import{dockerBuilder,containerIp}from'/app/apps/server/dist/engine/builders/docker.js';
    const direct=await fetch('http://${app}:8080/ready',{signal:AbortSignal.timeout(2000)});
    const value={address:await containerIp('${app}'),directStatus:direct.status,verdicts:{},errors:{}};
    for(const mode of ['auto','http-strict','tcp']){try{value.verdicts[mode]=await dockerBuilder.isHealthy({runtimeId:'${app}',port:8080,healthPath:'/ready',...(mode==='auto'?{}:{healthCheck:mode})},2000,10000)}catch(e){value.verdicts[mode]=null;value.errors[mode]=e.message}}
    console.log(JSON.stringify(value));`;
  const result = JSON.parse(client(network, program).out.split('\n').at(-1));
  const statuses = JSON.parse(client(primary, proxyProgram(20)).out);
  const expectedIp = networks[primary]?.IPAddress ?? null;
  assert.equal(result.directStatus, 200, 'the application must actually accept requests');
  assert.ok(statuses.every(status => expectedReady ? status === 200 : status >= 500), 'the proxy control must match the injected topology');
  const passed = result.address === expectedIp && Object.values(result.verdicts).every(value => value === expectedReady);
  cases.push({ name, expectedReady, expectedIp, networkMode, concatenatedAddresses: Object.keys(networks).sort().map(key => networks[key].IPAddress).join(''),
    ...result, proxyStatuses: statuses, passed });
}
let failure;
try {
  for (const ref of [image, 'busybox:1.36', 'traefik:3']) if (docker(['image', 'inspect', ref], true).status !== 0) docker(['pull', ref]);
  create('network', primary, []); create('network', secondary, []);
  const appId = create('container', app, ['--network', primary, '--no-healthcheck', '--entrypoint', 'node', image, '-e',
    "const fs=require('node:fs'),s=require('node:http').createServer((q,r)=>setTimeout(()=>r.end('ready'),20));s.listen(8080,'0.0.0.0');process.on('SIGHUP',()=>{s.close(()=>s.listen(8080,fs.readFileSync('/tmp/primary-probe-bind','utf8')));s.closeAllConnections()})"]);
  const config = resolve(proof, 'dynamic.yml');
  writeFileSync(config, JSON.stringify({ http: { routers: { app: { rule: 'Host(`readiness.invalid`)', service: 'app', entryPoints: ['web'] } },
    services: { app: { loadBalancer: { servers: [{ url: `http://${app}:8080` }] } } } } }));
  create('container', proxy, ['--network', primary, '-v', `${config}:/etc/traefik/dynamic.yml:ro`, 'traefik:3',
    '--entrypoints.web.address=:80', '--providers.file.filename=/etc/traefik/dynamic.yml', '--serverstransport.forwardingtimeouts.dialtimeout=500ms']);
  await proxyReady(true); await sample('single-network', primary, true);
  docker(['network', 'connect', secondary, app]);
  await proxyReady(true); await sample('multiple-networks', primary, true);
  docker(['network', 'disconnect', primary, app]);
  docker(['restart', proxy]); // Flush old pooled sockets; evaluate the new topology.
  await proxyReady(false); await sample('primary-detached', secondary, false);
  docker(['network', 'connect', primary, app]); docker(['restart', proxy]);
  await proxyReady(true); await sample('primary-restored', primary, true);
  const privateIp = JSON.parse(docker(['inspect', app, '--format', '{{json .NetworkSettings.Networks}}']).out)[secondary].IPAddress;
  docker(['exec', app, 'node', '-e', `require('node:fs').writeFileSync('/tmp/primary-probe-bind',${JSON.stringify(privateIp)})`]);
  docker(['kill', '--signal', 'HUP', appId]);
  await until(() => { try { return JSON.parse(client(secondary, `const r=await fetch('http://${app}:8080/ready',{signal:AbortSignal.timeout(2000)});console.log(r.status)`).out) === 200; } catch { return false; } }, 'private-only listener');
  docker(['restart', proxy]); await proxyReady(false);
  await sample('primary-present-private-listener', secondary, false);
  if (baseline) {
    assert.equal(cases[0].passed, true, 'baseline single-network control');
    for (const index of [1, 3]) {
      const row = cases[index];
      assert.equal(row.address, row.concatenatedAddresses, 'baseline must reproduce concatenated IPs');
      assert.notEqual(row.verdicts.auto, true); assert.equal(row.verdicts['http-strict'], true); assert.equal(row.verdicts.tcp, true);
    }
    assert.equal(cases[2].address, cases[2].concatenatedAddresses);
    assert.deepEqual(cases[2].verdicts, { auto: true, 'http-strict': true, tcp: true }, 'baseline must falsely accept the unreachable primary');
    assert.equal(cases[4].address, cases[4].concatenatedAddresses);
    assert.notEqual(cases[4].verdicts.auto, true);
    assert.equal(cases[4].verdicts['http-strict'], true); assert.equal(cases[4].verdicts.tcp, true);
  } else assert.ok(cases.every(row => row.passed), 'every readiness decision must agree with the primary-network/proxy control');
} catch (error) { failure = String(error); process.exitCode = 1; }
finally {
  for (const { kind, name, id } of resources.reverse()) {
    try {
      const args = kind === 'network' ? ['network', 'inspect', name] : ['inspect', name];
      const raw = docker(args, true); if (raw.status !== 0) { cleanup.push({ kind, name, missing: true }); continue; }
      const row = JSON.parse(raw.out)[0];
      assert.equal(row.Id, id); assert.equal((kind === 'network' ? row.Labels : row.Config.Labels)['ninedeploy.proof'], owner);
      docker(kind === 'network' ? ['network', 'rm', id] : ['rm', '-fv', id]);
      cleanup.push({ kind, name, removed: true });
    } catch (error) { failure ??= String(error); process.exitCode = 1; cleanup.push({ kind, name, removed: false }); }
  }
  const result = { image, baseline, realDocker: true, cases, cleanup, ...(failure ? { failure, lastProxyObservation } : {}), accepted: !failure };
  writeFileSync(resolve(proof, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
