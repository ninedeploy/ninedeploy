import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const image = process.argv.find(arg => arg.startsWith('--image='))?.slice(8);
assert.ok(image && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image), 'Pass --image=<built NineDeploy image>');
const owner = `lifecycle-${randomBytes(6).toString('hex')}`, daemon = `nd-${owner}-daemon`, volume = `nd-${owner}-journal`;
const name = `nd-${owner}-web`, containers = [], cases = [], jobs = [];
const temp = mkdtempSync(join(tmpdir(), 'ninedeploy-lifecycle-'));
const archive = join(temp, 'busybox.tar'), wrapper = join(temp, 'docker');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const cli = args => spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
const checked = args => { const r = cli(args); assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim(); };
const node = args => checked(['exec', daemon, 'docker', ...args]);
const params = (revision, action, target) => ({ requestId: String(revision).padStart(32, '0'), revision, action, serviceId: 7, deploymentId: 9, targets: [target], timeoutMs: 30_000 });
function argumentsFor(input, hold, env, legacyAction) {
  const runner = `nd-${owner}-r${input.revision}-${jobs.length}`;
  const program = legacyAction
    ? `import{runOp}from'/app/apps/server/dist/agent.js';try{process.exitCode=await runOp('docker.${legacyAction}',${JSON.stringify({ name: input.targets[0].name })},console.log,{sealed:true});}catch(error){console.error(error.message);process.exitCode=1;}`
    : `import{runRegisteredOp}from'/app/apps/server/dist/agentOps/index.js';import{writeFileSync}from'node:fs';${hold === 'observe-stop' || hold === 'observe-legacy-fence' ? `writeFileSync('/var/lib/ninedeploy-agent/${hold === 'observe-stop' ? 'stop' : 'legacy-fence'}-entered','1');` : ''}try{await runRegisteredOp('docker.lifecycle',${JSON.stringify(input)},console.log,{sealed:true},${JSON.stringify(env ?? {})});}catch(error){console.error(error.message);process.exitCode=1;}`;
  const args = ['run', '--rm', '--name', runner, '--label', `ninedeploy.proof=${owner}`, '--network', `container:${daemon}`, '--user', '0', '--no-healthcheck',
    '-v', `${volume}:/var/lib/ninedeploy-agent`, '-w', '/var/lib/ninedeploy-agent', '-e', 'NODE_ENV=test', '-e', 'DOCKER_HOST=tcp://127.0.0.1:2375'];
  if (hold === 'before' || hold === 'after') args.push('--mount', `type=bind,source=${wrapper},target=/proof/bin/docker,readonly`,
    '-e', 'PATH=/proof/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', '-e', `ND_LIFECYCLE_HOLD=${hold}`);
  if (legacyAction) args.push('-e', 'ND_LIFECYCLE_PREFIX=legacy-');
  args.push('--entrypoint', 'node', image, '--input-type=module', '-e', program);
  return { args, runner };
}
function launch(input, hold, legacyAction) {
  const { args, runner } = argumentsFor(input, hold, undefined, legacyAction);
  const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const job = { runner, child, done: false, stdout: '', stderr: '', result: undefined };
  const timer = setTimeout(() => child.kill(), 60_000);
  child.stdout.on('data', bytes => { job.stdout = (job.stdout + bytes.toString()).slice(-65536); });
  child.stderr.on('data', bytes => { job.stderr = (job.stderr + bytes.toString()).slice(-65536); });
  job.result = new Promise((resolve, reject) => {
    child.once('error', error => { clearTimeout(timer); job.done = true; reject(error); });
    child.once('close', code => { clearTimeout(timer); job.done = true; resolve({ status: code, stdout: job.stdout, stderr: job.stderr }); });
  });
  jobs.push(job); return job;
}
function receipt(result, input) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const frames = result.stdout.split('\n').filter(line => line.startsWith('ND-LIFECYCLE ')); assert.equal(frames.length, 1);
  const r = JSON.parse(frames[0].slice(13));
  assert.equal(r.complete, true); assert.equal(r.requestId, input.requestId); assert.equal(r.revision, input.revision);
  assert.equal(r.serviceId, input.serviceId); assert.equal(r.deploymentId, input.deploymentId); assert.equal(r.action, input.action);
  assert.deepEqual(r.items, input.targets.map(t => ({ ...t, running: input.action === 'start' })));
  return r;
}
function run(input, env) { return cli(argumentsFor(input, undefined, env).args); }
function refused(result, pattern) { assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, pattern); assert.ok(!result.stdout.includes('ND-LIFECYCLE ')); }
async function marker(runner, file) {
  const until = Date.now() + 15_000;
  while (cli(['exec', runner, 'test', '-f', `/var/lib/ninedeploy-agent/${file}`]).status !== 0) {
    assert.ok(Date.now() < until, `Missing real-process barrier ${file}`); await pause(100);
  }
}
try {
  checked(['image', 'inspect', image]);
  for (const img of ['busybox:1.36', 'docker:28-dind']) if (cli(['image', 'inspect', img]).status !== 0) checked(['pull', img]);
  writeFileSync(wrapper, '#!/bin/sh\nset -eu\nif [ "$1" = start ] && [ "$ND_LIFECYCLE_HOLD" = before ]; then touch /var/lib/ninedeploy-agent/${ND_LIFECYCLE_PREFIX:-}before-entered; until [ -f /var/lib/ninedeploy-agent/${ND_LIFECYCLE_PREFIX:-}before-release ]; do sleep 0.05; done; fi\nif [ "$1" = inspect ] && [ "$ND_LIFECYCLE_HOLD" = after ] && [ -f /var/lib/ninedeploy-agent/effect-observed ]; then touch /var/lib/ninedeploy-agent/after-entered; until [ -f /var/lib/ninedeploy-agent/after-release ]; do sleep 0.05; done; fi\n/usr/bin/docker "$@"\nif [ "$1" = start ] && [ "$ND_LIFECYCLE_HOLD" = after ]; then touch /var/lib/ninedeploy-agent/effect-observed; fi\n', { mode: 0o755 });
  checked(['volume', 'create', '--label', `ninedeploy.proof=${owner}`, volume]);
  checked(['run', '-d', '--name', daemon, '--label', `ninedeploy.proof=${owner}`, '--privileged', '--network', 'none', '-e', 'DOCKER_TLS_CERTDIR=',
    'docker:28-dind', 'dockerd', '--host=unix:///var/run/docker.sock', '--host=tcp://127.0.0.1:2375', '--tls=false']);
  containers.push(daemon);
  const readyBy = Date.now() + 30_000;
  while (cli(['exec', daemon, 'docker', 'info']).status !== 0) { assert.ok(Date.now() < readyBy, 'Isolated daemon readiness deadline'); await pause(200); }
  checked(['save', '-o', archive, 'busybox:1.36']); checked(['cp', archive, `${daemon}:/root/busybox.tar`]); node(['load', '-i', '/root/busybox.tar']);
  node(['create', '--name', name, '--label', 'ninedeploy.managed=service', '--label', 'ninedeploy.service=7', '--label', 'ninedeploy.deployment=9',
    'busybox:1.36', 'sh', '-c', 'trap "exit 0" TERM; while :; do sleep 1; done']);
  const target = { id: node(['inspect', name, '--format', '{{.Id}}']), name };
  const start = params(1, 'start', target); receipt(run(start), start);
  const fence = { ...params(2, 'stop', target), targets: [] }; receipt(run(fence), fence);
  assert.equal(node(['inspect', name, '--format', '{{.State.Status}}']), 'running');
  refused(run(start), /stale|superseded/);
  cases.push({ name: 'fence-only-stop-persists-before-routing-and-does-not-stop-the-container', passed: true });
  const stop = params(3, 'stop', target); receipt(run(stop), stop);
  refused(run(params(2, 'start', target)), /stale|superseded/);
  assert.equal(node(['inspect', name, '--format', '{{.State.Status}}']), 'exited');
  cases.push({ name: 'fresh-agent-process-rejects-delayed-start-after-stop', passed: true });
  receipt(run(stop), stop); cases.push({ name: 'durable-exact-retry', passed: true });
  const pendingStart = params(4, 'start', target), first = launch(pendingStart, 'before'); await marker(first.runner, 'before-entered');
  const pendingStop = params(5, 'stop', target), second = launch(pendingStop, 'observe-stop'); await marker(second.runner, 'stop-entered');
  await pause(200);
  assert.equal(second.done, false, 'Stop overtook an undrained start in a different process');
  checked(['exec', first.runner, 'touch', '/var/lib/ninedeploy-agent/before-release']);
  receipt(await first.result, pendingStart); receipt(await second.result, pendingStop);
  assert.equal(node(['inspect', name, '--format', '{{.State.Status}}']), 'exited');
  cases.push({ name: 'sqlite-serializes-actual-cross-process-start-stop', passed: true });
  const crashedStart = params(6, 'start', target), crash = launch(crashedStart, 'after'); await marker(crash.runner, 'after-entered');
  assert.equal(node(['inspect', name, '--format', '{{.State.Status}}']), 'running');
  checked(['kill', '--signal', 'KILL', crash.runner]); assert.notEqual((await crash.result).status, 0);
  const recoveredStop = params(7, 'stop', target); receipt(run(recoveredStop), recoveredStop);
  refused(run(crashedStart), /stale|superseded/);
  assert.equal(node(['inspect', name, '--format', '{{.State.Status}}']), 'exited');
  cases.push({ name: 'hard-crash-after-effect-preserves-fence-and-allows-newer-stop', passed: true });
  node(['rm', name]);
  node(['run', '-d', '--name', name, '--label', 'ninedeploy.managed=service', '--label', 'ninedeploy.service=7', '--label', 'ninedeploy.deployment=9',
    'busybox:1.36', 'sleep', '120']);
  const replacement = { name, id: node(['inspect', name, '--format', '{{.Id}}']) }; assert.notEqual(replacement.id, target.id);
  refused(run(params(8, 'stop', target)), /identity|inspection/);
  assert.equal(node(['inspect', name, '--format', '{{.State.Status}}']), 'running');
  cases.push({ name: 'old-identity-never-stops-a-same-name-replacement', passed: true });
  refused(run(params(9, 'stop', replacement), { NINEDEPLOY_AGENT_CONTAINER_LIFECYCLE: 'off' }), /disabled.*owner/);
  assert.equal(node(['inspect', name, '--format', '{{.State.Status}}']), 'running');
  cases.push({ name: 'owner-disabled-refusal', passed: true });
  const final = params(10, 'stop', replacement); receipt(run(final), final);
  assert.equal(node(['inspect', name, '--format', '{{.State.Status}}']), 'exited');
  cases.push({ name: 'new-immutable-identity-converges-with-a-newer-revision', passed: true });
  refused(cli(argumentsFor(params(20, 'start', replacement), undefined, undefined, 'start').args), /[Ll]egacy.*fenced/);
  assert.equal(node(['inspect', name, '--format', '{{.State.Status}}']), 'exited');
  cases.push({ name: 'delayed-legacy-start-cannot-resurrect-an-ordered-stop', passed: true });
  const orderedStart = params(11, 'start', replacement); receipt(run(orderedStart), orderedStart);
  refused(cli(argumentsFor(params(21, 'stop', replacement), undefined, undefined, 'stop').args), /[Ll]egacy.*fenced/);
  assert.equal(node(['inspect', name, '--format', '{{.State.Status}}']), 'running');
  const orderedStop = params(12, 'stop', replacement); receipt(run(orderedStop), orderedStop);
  cases.push({ name: 'delayed-legacy-stop-cannot-undo-an-ordered-start', passed: true });
  const legacyName = `${name}-legacy`;
  node(['create', '--name', legacyName, '--label', 'ninedeploy.managed=service', '--label', 'ninedeploy.service=11', '--label', 'ninedeploy.deployment=9', 'busybox:1.36', 'sleep', '120']);
  const legacyTarget = { name: legacyName, id: node(['inspect', legacyName, '--format', '{{.Id}}']) };
  const legacy = launch({ ...params(30, 'start', legacyTarget), serviceId: 11 }, 'before', 'start'); await marker(legacy.runner, 'legacy-before-entered');
  const adoptedFence = { ...params(1, 'stop', legacyTarget), serviceId: 11, targets: [] };
  const adoption = launch(adoptedFence, 'observe-legacy-fence'); await marker(adoption.runner, 'legacy-fence-entered');
  await pause(200); assert.equal(adoption.done, false, 'First ordered fence overtook an undrained legacy process');
  checked(['exec', legacy.runner, 'touch', '/var/lib/ninedeploy-agent/legacy-before-release']);
  assert.equal((await legacy.result).status, 0); receipt(await adoption.result, adoptedFence);
  const adoptedStop = { ...params(2, 'stop', legacyTarget), serviceId: 11 }; receipt(run(adoptedStop), adoptedStop);
  refused(cli(argumentsFor({ ...params(31, 'start', legacyTarget), serviceId: 11 }, undefined, undefined, 'start').args), /[Ll]egacy.*fenced/);
  assert.equal(node(['inspect', legacyName, '--format', '{{.State.Status}}']), 'exited');
  cases.push({ name: 'first-adoption-fence-waits-for-an-actual-legacy-process-and-rejects-its-replay', passed: true });
  console.log(JSON.stringify({ image, cases, realDocker: true, independentAgentProcesses: true, isolatedNodeDaemon: true }));
} finally {
  for (const job of jobs) {
    const label = cli(['inspect', job.runner, '--format', '{{index .Config.Labels "ninedeploy.proof"}}']);
    if (label.status === 0) { assert.equal(label.stdout.trim(), owner); checked(['rm', '-fv', job.runner]); }
    await job.result.catch(() => undefined);
    const late = cli(['inspect', job.runner, '--format', '{{index .Config.Labels "ninedeploy.proof"}}']);
    if (late.status === 0) { assert.equal(late.stdout.trim(), owner); checked(['rm', '-fv', job.runner]); }
  }
  for (const container of containers.reverse()) { assert.equal(checked(['inspect', container, '--format', '{{index .Config.Labels "ninedeploy.proof"}}']), owner); checked(['rm', '-fv', container]); }
  const label = cli(['volume', 'inspect', volume, '--format', '{{index .Labels "ninedeploy.proof"}}']);
  if (label.status === 0) { assert.equal(label.stdout.trim(), owner); checked(['volume', 'rm', volume]); }
  rmSync(archive, { force: true }); rmSync(wrapper, { force: true }); rmdirSync(temp);
}
