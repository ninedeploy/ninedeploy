// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Standalone hosted acceptance is not a cached Turbo task.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use an isolated GitHub Actions runner');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Use a GitHub-hosted runner');
assert.equal(process.env.DOCKER_HOST, 'unix:///var/run/docker.sock', 'Use only the hosted runner daemon');
const image = process.argv.find(arg => arg.startsWith('--image='))?.slice(8);
assert.ok(image && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image), 'Pass --image=<candidate>');
const proof = resolve(process.argv.find(arg => arg.startsWith('--proof='))?.slice(8) ?? '.temp_files/serving-traffic');
mkdirSync(proof, { recursive: true });
const owner = `serving-${randomBytes(8).toString('hex')}`, slug = owner, network = `nd-${owner}`, resources = [], cleanup = [];
const docker = (args, allowed = false) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 2 << 20, windowsHide: true });
  if (!allowed) assert.equal(result.status, 0, `${args.slice(0, 3)}: ${result.stderr || result.stdout}`);
  return { ...result, out: (result.stdout ?? '').trim() };
};
function container(name, args) {
  const id = docker(['run', '-d', '--name', name, '--label', `ninedeploy.proof=${owner}`, ...args]).out;
  resources.push({ kind: 'container', id, name }); return id;
}
let failure, imageId, evidence;
try {
  imageId = docker(['image', 'inspect', image, '--format', '{{.Id}}']).out;
  assert.notEqual(docker(['inspect', 'ninedeploy-proxy'], true).status, 0, 'Refuse an existing proxy');
  if (docker(['image', 'inspect', 'traefik:3'], true).status !== 0) docker(['pull', 'traefik:3']);
  const networkId = docker(['network', 'create', '--label', `ninedeploy.proof=${owner}`, network]).out;
  resources.push({ kind: 'network', name: network, id: networkId });
  const serving = [0, 1].map(index => {
    const name = `${slug}-9${index ? '-r2' : ''}`;
    const id = container(name, ['--network', network, '--no-healthcheck', '--label', 'ninedeploy.managed=service', '--label', 'ninedeploy.service=7', '--label', 'ninedeploy.deployment=9',
      '--entrypoint', 'node', image, '-e', "require('node:http').createServer((q,r)=>r.end(require('node:os').hostname())).listen(8080,'0.0.0.0')"]);
    return { name, id, port: 8080 };
  });
  const config = JSON.stringify({ http: { routers: {
    [`${slug}_1`]: { rule: 'Host(`serving.invalid`)', service: 'serving', entryPoints: ['web'] },
    unrelated_1: { rule: 'Host(`unrelated.invalid`)', service: 'serving', entryPoints: ['web'] },
  }, services: { serving: { loadBalancer: { servers: serving.map(target => ({ url: `http://${target.name}:${target.port}` })) } } } } });
  const input = { purpose: 'autoscale', requestId: randomBytes(16).toString('hex'), nodeId: 2, serviceId: 7, deploymentId: 9, slug, durationMs: 1000, routingConfig: config, serving };
  const client = container(`nd-${owner}-client`, ['--network', network, '--user', '0', '--no-healthcheck', '-e', 'NODE_ENV=test', '-e', 'DOCKER_HOST=unix:///var/run/docker.sock',
    '-e', 'DOCKER_CONTEXT=default', '-e', 'NINEDEPLOY_AGENT_PROXY_TRAFFIC=on', '-e', `PROOF_INPUT=${JSON.stringify(input)}`, '-e', `PROOF_OWNER=${owner}`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', `${proof}:/proof`, '--entrypoint', 'node', image, '-e', 'setInterval(()=>{},1000)']);
  docker(['exec', client, 'node', '--input-type=module', '-e', `import{withRoutingAck}from'/app/apps/server/dist/lib/proxyRoutingAck.js';import{writeFileSync}from'node:fs';writeFileSync('/proof/dynamic.yml',withRoutingAck(${JSON.stringify(config)}));`]);
  container('ninedeploy-proxy', ['--network', network, '-v', `${proof}:/proof:ro`, 'traefik:3', '--entrypoints.web.address=:80', '--entrypoints.websecure.address=:443',
    '--api=true', '--providers.file.filename=/proof/dynamic.yml', '--providers.providersThrottleDuration=100ms', '--accesslog=true', '--log.level=ERROR']);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const ready = docker(['exec', client, 'node', '-e', "const h=require('node:http');const q=h.get({hostname:'ninedeploy-proxy',headers:{host:'serving.invalid'}},r=>{r.resume();r.on('end',()=>process.exit(r.statusCode===200?0:1))});q.setTimeout(1000,()=>q.destroy());q.on('error',()=>process.exit(1))"], true);
    if (ready.status === 0) break;
    assert.ok(Date.now() < deadline, 'Proxy fixture did not become ready');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  docker(['cp', 'scripts/fixtures/serving-traffic-agent.mjs', `${client}:/tmp/serving-traffic-proof.mjs`]);
  docker(['exec', client, 'node', '/tmp/serving-traffic-proof.mjs']);
  evidence = JSON.parse(readFileSync(resolve(proof, 'agent-result.json'), 'utf8'));
  assert.equal(evidence.realSealedHttp, true); assert.equal(evidence.activeWindows, 0);
  assert.equal(evidence.cases.length, 8); assert.ok(evidence.cases.every(row => row.passed));
} catch (error) { failure = String(error); process.exitCode = 1; }
finally {
  for (const { kind, id, name } of resources.reverse()) {
    try {
      const inspect = JSON.parse(docker(kind === 'network' ? ['network', 'inspect', id] : ['inspect', id]).out)[0];
      assert.equal(inspect.Id, id); assert.equal((kind === 'network' ? inspect.Labels : inspect.Config.Labels)['ninedeploy.proof'], owner);
      docker(kind === 'network' ? ['network', 'rm', id] : ['rm', '-fv', id]);
      cleanup.push({ kind, name, id, removed: true });
    } catch (error) { failure ??= String(error); process.exitCode = 1; cleanup.push({ kind, name, id, removed: false }); }
  }
  const result = { image, imageId, source: process.env.GITHUB_SHA, realDocker: true, realTraefik: true, ...(evidence ?? {}), cleanup, accepted: !failure, ...(failure ? { failure } : {}) };
  writeFileSync(resolve(proof, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
