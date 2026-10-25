import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const image = process.argv.find(arg => arg.startsWith('--image='))?.slice(8);
assert.ok(image && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image), 'Pass --image=<built NineDeploy image>');
const owner = `metrics-${randomBytes(6).toString('hex')}`;
const daemon = `nd-${owner}-daemon`, workload = `nd-${owner}-web`, replica = `${workload}-r1`;
const hostContainers = [], cases = [];
const temp = mkdtempSync(join(tmpdir(), 'ninedeploy-metrics-'));
const archive = join(temp, 'workload.tar');
const docker = args => spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });
const checked = args => { const result = docker(args); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
const node = args => checked(['exec', daemon, 'docker', ...args]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function request(targets, overrides = {}) {
  return { requestId: randomBytes(16).toString('hex'), serviceId: 7, deploymentId: 9, targets, timeoutMs: 10_000, ...overrides };
}
function sample(params, env = {}) {
  const program = `import{runRegisteredOp}from'/app/apps/server/dist/agentOps/index.js';try{process.exitCode=await runRegisteredOp('docker.metrics',${JSON.stringify(params)},console.log,{sealed:true},${JSON.stringify(env)});}catch(error){console.error(error.message);process.exitCode=1;}`;
  return docker(['run', '--rm', '--label', `ninedeploy.proof=${owner}`, '--network', `container:${daemon}`, '--user', '0', '--no-healthcheck',
    '-e', 'NODE_ENV=test', '-e', 'DOCKER_HOST=tcp://127.0.0.1:2375', '--entrypoint', 'node', image, '--input-type=module', '-e', program]);
}
function receipt(params) {
  const result = sample(params);
  assert.equal(result.status, 0, result.stderr);
  const frames = result.stdout.split('\n').filter(line => line.startsWith('ND-METRICS '));
  assert.equal(frames.length, 1);
  const reply = JSON.parse(frames[0].slice(11));
  assert.equal(reply.complete, true); assert.equal(reply.requestId, params.requestId);
  assert.equal(reply.serviceId, params.serviceId); assert.equal(reply.deploymentId, params.deploymentId);
  assert.deepEqual(reply.items.map(item => ({ id: item.id, name: item.name })), params.targets);
  return reply;
}
function refuses(label, params, pattern, env) {
  const result = sample(params, env);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, pattern);
  assert.ok(!result.stdout.includes('ND-METRICS '));
  cases.push({ name: label, passed: true });
}
try {
  checked(['image', 'inspect', image]);
  if (docker(['image', 'inspect', 'busybox:1.36']).status !== 0) checked(['pull', 'busybox:1.36']);
  if (docker(['image', 'inspect', 'docker:28-dind']).status !== 0) checked(['pull', 'docker:28-dind']);
  checked(['run', '-d', '--privileged', '--name', daemon, '--label', `ninedeploy.proof=${owner}`, '--network', 'none',
    '-e', 'DOCKER_TLS_CERTDIR=', 'docker:28-dind', 'dockerd', '--host=unix:///var/run/docker.sock', '--host=tcp://127.0.0.1:2375', '--tls=false']);
  hostContainers.push(daemon);
  const readyBy = Date.now() + 30_000;
  while (docker(['exec', daemon, 'docker', 'info']).status !== 0) {
    assert.ok(Date.now() < readyBy, 'Isolated Docker daemon did not become ready');
    await pause(200);
  }
  checked(['save', '-o', archive, 'busybox:1.36']);
  // dind mounts /tmp inside its own namespace; docker cp writes below that mount.
  checked(['cp', archive, `${daemon}:/root/workload.tar`]); node(['load', '-i', '/root/workload.tar']);
  for (const [name, memory, cpus] of [[workload, '64m', '0.5'], [replica, '32m', '0.25']]) {
    node(['run', '-d', '--name', name, '--label', 'ninedeploy.managed=service', '--label', 'ninedeploy.service=7', '--label', 'ninedeploy.deployment=9',
      '--memory', memory, '--cpus', cpus, 'busybox:1.36', 'sh', '-c', 'while :; do :; done']);
  }
  const targets = [workload, replica].map(name => ({ name, id: node(['inspect', name, '--format', '{{.Id}}']) }));
  // A same-name panel container has different limits: the node sample must never read it.
  checked(['run', '-d', '--name', workload, '--label', `ninedeploy.proof=${owner}`, '--memory', '16m', '--cpus', '0.125', 'busybox:1.36', 'sleep', '120']);
  hostContainers.push(workload);
  const result = receipt(request(targets));
  assert.deepEqual(result.items.map(item => [item.cpuLimitMilli, item.memLimitBytes]), [[500, 64 * 1024 ** 2], [250, 32 * 1024 ** 2]]);
  assert.ok(result.items.every(item => Number.isFinite(item.cpuPct) && item.cpuPct >= 0 && Number.isSafeInteger(item.memBytes) && item.memBytes >= 0 && item.restarts === 0));
  cases.push({ name: 'immutable-node-limits-with-same-name-panel-decoy', passed: true, items: result.items });
  refuses('foreign-deployment', request(targets, { deploymentId: 10 }), /generation/);
  refuses('owner-disabled', request(targets), /disabled.*owner/, { NINEDEPLOY_AGENT_CONTAINER_METRICS: 'off' });
  node(['stop', replica]);
  refuses('stopped-target', request(targets), /running state/);
  node(['rm', replica]);
  node(['run', '-d', '--name', replica, '--label', 'ninedeploy.managed=service', '--label', 'ninedeploy.service=7', '--label', 'ninedeploy.deployment=9',
    '--memory', '32m', '--cpus', '0.25', 'busybox:1.36', 'sleep', '120']);
  const replacementId = node(['inspect', replica, '--format', '{{.Id}}']);
  assert.notEqual(replacementId, targets[1].id);
  refuses('same-name-replacement-does-not-satisfy-old-identity', request(targets), /sample/);
  const fresh = receipt(request([{ id: replacementId, name: replica }]));
  assert.equal(fresh.items[0].memLimitBytes, 32 * 1024 ** 2);
  cases.push({ name: 'replacement-requires-its-new-immutable-id', passed: true });
  console.log(JSON.stringify({ image, cases, realDocker: true, isolatedNodeDaemon: true }));
} finally {
  for (const name of hostContainers.reverse()) {
    const label = docker(['inspect', name, '--format', '{{index .Config.Labels "ninedeploy.proof"}}']);
    if (label.status === 0) { assert.equal(label.stdout.trim(), owner); checked(['rm', '-fv', name]); }
  }
  rmSync(archive, { force: true });
  rmdirSync(temp);
}
