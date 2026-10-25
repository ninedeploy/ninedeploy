// Agent-side mixed-generation Stop against real Docker and a persistent SQLite journal.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const image = process.argv.find(arg => arg.startsWith('--image='))?.slice(8);
assert.ok(image && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image), 'Pass --image=<built NineDeploy image>');
const proof = resolve(process.argv.find(arg => arg.startsWith('--proof='))?.slice(8) ?? '.temp_files/generation-stop-' + randomBytes(6).toString('hex'));
mkdirSync(proof, { recursive: true });
const owner = 'generation-stop-' + randomBytes(5).toString('hex'), daemon = 'nd-' + owner, volume = daemon + '-journal';
const cases = [], runners = [], home = '/var/lib/ninedeploy-agent';
const cli = args => spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 4 << 20 });
const checked = args => { const result = cli(args); assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout.trim(); };
const inner = args => checked(['exec', daemon, 'docker', ...args]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = name => { cases.push({ name, passed: true }); console.log(JSON.stringify(cases.at(-1))); writeFileSync(proof + '/cases.json', JSON.stringify({ image, cases }, null, 2)); };
const input = (revision, targets, action = 'stop') => ({ requestId: String(revision).padStart(32, '0'), revision, action, serviceId: 7, deploymentId: 9, targets, timeoutMs: 30_000 });
function run(params, options = {}) {
  const runner = daemon + '-runner-' + runners.length; runners.push(runner);
  const code = options.legacy ? "import{runOp}from'/app/apps/server/dist/agent.js';try{process.exitCode=await runOp('docker.stop'," + JSON.stringify({ name: options.legacy.id }) + ",console.log,{sealed:true});}catch(e){console.error(e.message);process.exitCode=1;}"
    : "import{runRegisteredOp}from'/app/apps/server/dist/agentOps/index.js';try{await runRegisteredOp('docker.lifecycle'," + JSON.stringify(params) + ",console.log,{sealed:true}," + JSON.stringify(options.env ?? {}) + ");}catch(e){console.error(e.message);process.exitCode=1;}";
  const result = cli(['run', '--rm', '--name', runner, '--label', 'ninedeploy.proof=' + owner, '--network', 'container:' + daemon, '--user', '0', '--no-healthcheck',
    '-v', volume + ':' + home, '-w', home, '-e', 'NODE_ENV=test', '-e', 'DOCKER_HOST=tcp://127.0.0.1:2375', '--entrypoint', 'node', image, '--input-type=module', '-e', code]);
  writeFileSync(proof + '/request-' + runners.length + '.log', (result.stdout ?? '') + '\n' + (result.stderr ?? ''));
  return result;
}
function reply(result, params) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const frames = result.stdout.split('\n').filter(line => line.startsWith('ND-LIFECYCLE ')); assert.equal(frames.length, 1);
  const receipt = JSON.parse(frames[0].slice(13));
  assert.deepEqual(receipt, { requestId: params.requestId, serviceId: 7, deploymentId: 9, revision: params.revision, action: params.action, complete: true,
    items: params.targets.map(target => ({ ...target, running: false })) });
  return receipt;
}
const refused = (result, pattern) => { assert.equal(result.status, 1, result.stdout); assert.match(result.stderr, pattern); assert.ok(!result.stdout.includes('ND-LIFECYCLE ')); };
const running = target => inner(['inspect', target.id, '--format', '{{.State.Running}}']) === 'true';
function create(name, serviceId, deploymentId) {
  inner(['run', '-d', '--name', name, '--label', 'ninedeploy.managed=service', '--label', 'ninedeploy.service=' + serviceId,
    '--label', 'ninedeploy.deployment=' + deploymentId, 'busybox:1.36', 'sh', '-c', 'trap "exit 0" TERM; while :; do sleep 1; done']);
  return { id: inner(['inspect', name, '--format', '{{.Id}}']), name, deploymentId };
}
try {
  checked(['image', 'inspect', image]);
  for (const fixture of ['busybox:1.36', 'docker:28-dind']) if (cli(['image', 'inspect', fixture]).status !== 0) checked(['pull', fixture]);
  checked(['volume', 'create', '--label', 'ninedeploy.proof=' + owner, volume]);
  checked(['run', '-d', '--name', daemon, '--label', 'ninedeploy.proof=' + owner, '--privileged', '--network', 'none', '-e', 'DOCKER_TLS_CERTDIR=',
    'docker:28-dind', 'dockerd', '--host=unix:///var/run/docker.sock', '--host=tcp://127.0.0.1:2375', '--tls=false']);
  const deadline = Date.now() + 40_000;
  while (cli(['exec', daemon, 'docker', 'info']).status !== 0) { assert.ok(Date.now() < deadline, 'Private daemon readiness'); await pause(200); }
  checked(['save', '-o', proof + '/busybox.tar', 'busybox:1.36']); checked(['cp', proof + '/busybox.tar', daemon + ':/root/busybox.tar']); inner(['load', '-i', '/root/busybox.tar']);
  const previous = create('old-9', 7, 9), candidate = create('candidate-10', 7, 10), decoy = create('foreign-10', 8, 10);
  assert.equal(running(previous), true); assert.equal(running(candidate), true); assert.equal(running(decoy), true);
  writeFileSync(proof + '/before.json', JSON.stringify({ previous, candidate, decoy, allRunning: true }, null, 2));
  const stop = input(3, [previous, candidate]);
  // This is the original behavior reproduction: both generations must stop under one durable revision.
  reply(run(stop), stop); assert.equal(running(previous), false); assert.equal(running(candidate), false); assert.equal(running(decoy), true);
  record('one-revision-stops-both-real-generations-and-preserves-foreign-service');
  const cached = reply(run(stop), stop); inner(['rm', candidate.id]);
  assert.deepEqual(reply(run(stop), stop), cached);
  record('fresh-agent-process-replays-durable-receipt-after-an-obsolete-target-is-removed');
  const replacement = create(candidate.name, 7, 10);
  refused(run(input(4, [previous, candidate])), /identity|inspection/); assert.equal(running(replacement), true);
  record('missing-old-id-cannot-stop-same-name-generation-replacement');
  refused(run(input(5, [previous, { ...replacement, deploymentId: 11 }])), /identity|generation/);
  assert.equal(running(replacement), true); assert.equal(running(previous), false);
  record('wrong-generation-label-refuses-the-complete-batch-before-effects');
  refused(run(input(6, [previous, decoy])), /identity|generation/); assert.equal(running(decoy), true); assert.equal(running(replacement), true);
  record('foreign-service-label-refuses-the-complete-batch-before-effects');
  const adopt = input(7, [previous, replacement]); reply(run(adopt), adopt);
  refused(run(input(2, [{ id: previous.id, name: previous.name }], 'start')), /stale|superseded/);
  refused(run(input(8, [previous], 'start')), /Stop only|implicit generation/);
  assert.deepEqual(reply(run(adopt), adopt).items, cached.items.map((item, index) => index === 0 ? item : { ...replacement, running: false }));
  record('older-start-and-explicit-mixed-start-cannot-resurrect-or-advance-the-stop-journal');
  for (const target of [previous, replacement]) refused(run(adopt, { legacy: target }), /[Ll]egacy.*fenced/);
  record('legacy-stop-is-fenced-for-both-root-and-explicit-target-generations');
  refused(run({ ...input(1, [decoy]), serviceId: 8 }, { env: { NINEDEPLOY_AGENT_CONTAINER_LIFECYCLE: 'off' } }), /disabled.*owner/);
  assert.equal(running(decoy), true);
  const absentJournal = cli(['run', '--rm', '--user', '0', '--entrypoint', 'sh', '-v', volume + ':' + home, image, '-c', 'test ! -e ' + home + '/.agent-work/.lifecycle/service-8.sqlite']);
  assert.equal(absentJournal.status, 0);
  record('owner-disabled-generation-stop-refuses-before-journal-or-docker-effects');
  writeFileSync(proof + '/cases.json', JSON.stringify({ image, imageId: checked(['image', 'inspect', image, '--format', '{{.Id}}']), cases,
    realDocker: true, persistentSqlite: true, independentAgentProcesses: true, isolatedDaemon: true, publicPanelController: false, sealedHttp: false }, null, 2));
} finally {
  for (const runner of runners) { const found = cli(['inspect', runner, '--format', '{{index .Config.Labels "ninedeploy.proof"}}']); if (found.status === 0) { assert.equal(found.stdout.trim(), owner); checked(['rm', '-fv', runner]); } }
  const d = cli(['inspect', daemon, '--format', '{{index .Config.Labels "ninedeploy.proof"}}']); if (d.status === 0) { assert.equal(d.stdout.trim(), owner); checked(['rm', '-fv', daemon]); }
  const v = cli(['volume', 'inspect', volume, '--format', '{{index .Labels "ninedeploy.proof"}}']); if (v.status === 0) { assert.equal(v.stdout.trim(), owner); checked(['volume', 'rm', volume]); }
  rmSync(proof + '/busybox.tar', { force: true });
  writeFileSync(proof + '/cleanup.json', JSON.stringify({ owner, containers: checked(['ps', '-aq', '--filter', 'label=ninedeploy.proof=' + owner]),
    volumes: checked(['volume', 'ls', '-q', '--filter', 'label=ninedeploy.proof=' + owner]) }, null, 2));
}
