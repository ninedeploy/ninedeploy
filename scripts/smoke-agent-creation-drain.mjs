// Real Docker and native SQLite ordering for already-admitted managed creation.
// Panel-issued generation bounds and public handoff cancellation remain separate gates.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
const image = process.argv.find(arg => arg.startsWith('--image='))?.slice(8);
assert.ok(image && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image), 'Pass --image=<built NineDeploy image>');
const proof = resolve(process.argv.find(arg => arg.startsWith('--proof='))?.slice(8) ?? '.temp_files/agent-creation-drain-' + randomBytes(6).toString('hex'));
mkdirSync(proof, { recursive: true });
const owner = 'creation-drain-' + randomBytes(5).toString('hex'), daemon = 'nd-' + owner, volume = daemon + '-journal';
const builderImage = 'ninedeploy-proof:' + owner, appImage = builderImage + '-app', home = '/var/lib/ninedeploy-agent';
const runners = [], jobs = [], cases = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const cli = args => spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 90_000, maxBuffer: 4 << 20 });
const checked = args => { const result = cli(args); assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout.trim(); };
const inner = args => checked(['exec', daemon, 'docker', ...args]);
const until = async (fn, description, budget = 30_000) => { const end = Date.now() + budget; while (!fn()) { assert.ok(Date.now() < end, description); await pause(100); } };
const report = row => { cases.push(row); writeFileSync(proof + '/runtime-cases.json', JSON.stringify({ image, realDocker: true, realSqlite: true, independentAgentProcesses: true,
  sealedHttp: false, publicPanelController: false, delayedRequestAdmission: 'Agent lifecycle generation fence only; panel bound not verified', cases }, null, 2)); console.log(JSON.stringify(row)); };
const baseArgs = name => ['run', '--rm', '--name', name, '--label', 'ninedeploy.proof=' + owner, '--network', 'container:' + daemon, '--user', '0', '--no-healthcheck',
  '-v', volume + ':' + home, '-w', home, '-e', 'NODE_ENV=test', '-e', 'DOCKER_HOST=tcp://127.0.0.1:2375'];
function start(name, source, program, env = []) {
  runners.push(name); const job = { name, settled: false, code: null, stdout: '', stderr: '' };
  const child = spawn('docker', [...baseArgs(name), ...env, '--entrypoint', 'node', source, '--input-type=module', '-e', program], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => { job.stdout = (job.stdout + bytes).slice(-(1 << 20)); }); child.stderr.on('data', bytes => { job.stderr = (job.stderr + bytes).slice(-(1 << 20)); });
  job.finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Owned agent fixture deadline')); }, 60_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); job.settled = true; job.code = code; writeFileSync(proof + '/' + name + '.log', job.stdout + '\n' + job.stderr); resolve(code); });
  }); jobs.push(job.finished); return job;
}
const execute = (op, params) => "import{writeFileSync}from'node:fs';import{runOp}from'/app/apps/server/dist/agent.js';try{writeFileSync(" + JSON.stringify(home + '/lifecycle-' + params.revision + '-entered') + ",'1');process.exitCode=await runOp(" + JSON.stringify(op) + ',' + JSON.stringify(params) + ",console.log,{sealed:true});}catch(e){console.error(e.message);process.exitCode=1;}";
const prepare = (mode, deploymentId) => {
  const params = { name: 'drain-web-' + deploymentId, image: appImage, serviceId: 7, deploymentId, envFile: '.agent-env/drain-' + deploymentId + '.env',
    ...(mode === 'multi-network-spec' ? { extraNetworks: ['nd-extra'] } : {}) };
  const op = mode === 'run-env' ? 'docker.runEnv' : 'docker.runSpec';
  return "import{runOp}from'/app/apps/server/dist/agent.js';try{await runOp('file.writeEnv'," + JSON.stringify({ name: 'drain-' + deploymentId, env: { DRAIN_FIXTURE: '1' } }) + ",()=>{},{sealed:true});process.exitCode=await runOp(" + JSON.stringify(op) + ',' + JSON.stringify(params) + ",console.log,{sealed:true});}catch(e){console.error(e.message);process.exitCode=1;}";
};
const inspect = name => JSON.parse(inner(['inspect', name, '--format', '{"id":{{json .Id}},"name":{{json .Name}},"running":{{json .State.Running}},"status":{{json .State.Status}},"serviceId":{{json (index .Config.Labels "ninedeploy.service")}},"deploymentId":{{json (index .Config.Labels "ninedeploy.deployment")}}}']));
function receipt(job, targets) {
  assert.equal(job.code, 0, job.stderr); const frames = job.stdout.split('\n').filter(line => line.startsWith('ND-LIFECYCLE ')); assert.equal(frames.length, 1);
  const row = JSON.parse(frames[0].slice(13)); assert.equal(row.complete, true); assert.deepEqual(row.items, targets.map(target => ({ ...target, running: false }))); return row;
}
try {
  checked(['image', 'inspect', image]);
  const wrapper = proof + '/wrapper'; mkdirSync(wrapper);
  writeFileSync(wrapper + '/Dockerfile', 'FROM ' + image + '\nUSER root\nCOPY docker /proof/bin/docker\nRUN chmod 755 /proof/bin/docker\n');
  writeFileSync(wrapper + '/docker', '#!/bin/sh\nset -eu\nif [ "$1" = "$NINEDEPLOY_PROOF_VERB" ]; then\n  touch "$NINEDEPLOY_PROOF_BARRIER-entered"\n  while [ ! -f "$NINEDEPLOY_PROOF_BARRIER-release" ]; do sleep 0.05; done\nfi\nexec /usr/bin/docker "$@"\n');
  checked(['build', '-t', builderImage, wrapper]);
  const fixture = proof + '/fixture'; mkdirSync(fixture);
  writeFileSync(fixture + '/Dockerfile', 'FROM busybox:1.36\nCMD ["sh","-c","trap \'exit 0\' TERM; while :; do sleep 1; done"]\n');
  checked(['build', '-t', appImage, fixture]);
  checked(['volume', 'create', '--label', 'ninedeploy.proof=' + owner, volume]);
  checked(['run', '-d', '--name', daemon, '--label', 'ninedeploy.proof=' + owner, '--network', 'none', '--privileged', '-e', 'DOCKER_TLS_CERTDIR=', 'docker:28-dind',
    'dockerd', '--host=unix:///var/run/docker.sock', '--host=tcp://127.0.0.1:2375', '--tls=false']);
  await until(() => cli(['exec', daemon, 'docker', 'info']).status === 0, 'Private Docker daemon');
  checked(['save', '-o', proof + '/app.tar', appImage]); checked(['cp', proof + '/app.tar', daemon + ':/root/app.tar']); inner(['load', '-i', '/root/app.tar']);
  inner(['network', 'create', 'ninedeploy']); inner(['network', 'create', 'nd-extra']);
  for (const [index, mode] of ['multi-network-spec', 'single-network-spec', 'run-env'].entries()) {
    const revision = 8 + index * 16, barrier = home + '/' + mode, generation = 10 + index * 2;
    const builder = start(daemon + '-builder-' + index, builderImage, prepare(mode, generation), ['-e', 'PATH=/proof/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      '-e', 'NINEDEPLOY_PROOF_VERB=' + (mode === 'multi-network-spec' ? 'start' : 'run'), '-e', 'NINEDEPLOY_PROOF_BARRIER=' + barrier]);
    await until(() => { assert.ok(!builder.settled, builder.stderr || 'Builder exited before its barrier'); return cli(['exec', builder.name, 'test', '-f', barrier + '-entered']).status === 0; }, 'Builder reached its real Docker barrier');
    const request = { requestId: String(revision).padStart(32, '0'), serviceId: 7, deploymentId: generation - 1, revision, action: 'stop', targets: [], timeoutMs: 30_000 };
    const fence = start(daemon + '-fence-' + index, image, execute('docker.lifecycle', request));
    await until(() => cli(['exec', builder.name, 'test', '-f', home + '/lifecycle-' + revision + '-entered']).status === 0, 'Independent fence process opened the shared journal');
    await pause(750);
    assert.equal(fence.settled, false, 'A fence must drain the already-admitted creator before discovery');
    checked(['exec', builder.name, 'touch', barrier + '-release']); assert.equal(await builder.finished, 0, builder.stderr); await fence.finished; receipt(fence, []);
    const before = inspect('drain-web-' + generation); assert.equal(before.running, true); assert.equal(before.serviceId, '7'); assert.equal(before.deploymentId, String(generation));
    const target = { id: before.id, name: 'drain-web-' + generation, deploymentId: generation };
    const stopping = start(daemon + '-stop-' + index, image, execute('docker.lifecycle', { ...request, requestId: String(revision + 1).padStart(32, '0'), revision: revision + 1, targets: [target] }));
    await stopping.finished; receipt(stopping, [target]); assert.equal(inspect(target.id).running, false);
    inner(['rm', '-f', target.id]);
    const delayed = start(daemon + '-delayed-' + index, image, prepare(mode, generation));
    assert.notEqual(await delayed.finished, 0, 'A delayed stopped generation must be refused');
    assert.match(delayed.stderr, /stale|fenced|superseded/i);
    assert.notEqual(cli(['exec', daemon, 'docker', 'inspect', target.name]).status, 0, 'A refused create must not leave a candidate');
    const newer = start(daemon + '-newer-' + index, image, prepare(mode, generation + 1)); assert.equal(await newer.finished, 0, newer.stderr);
    const fresh = inspect('drain-web-' + (generation + 1)); assert.equal(fresh.running, true); assert.equal(fresh.deploymentId, String(generation + 1));
    report({ name: mode, passed: true, fenceDrainedAdmittedCreator: true, completeStop: true, delayedStoppedGenerationRefused: true, newerDeploymentStillWorks: true, target });
    inner(['rm', '-f', fresh.id]);
  }
  const timeoutFixture = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/agent-timeout-drain.mjs').split(sep).join('/');
  const timeout = cli(['run', '--rm', '--network', 'none', '--entrypoint', 'node', '--mount', 'type=bind,source=' + timeoutFixture + ',target=/proof.mjs,readonly', image, '/proof.mjs']);
  writeFileSync(proof + '/timeout-child.log', (timeout.stdout ?? '') + '\n' + (timeout.stderr ?? '')); assert.equal(timeout.status, 0, timeout.stderr);
  report({ name: 'sigterm-resistant-real-child-drains-before-successor', passed: true, realNodeChild: true, executableSubstitution: true });
} finally {
  for (const runner of runners) {
    const found = cli(['inspect', runner, '--format', '{{index .Config.Labels "ninedeploy.proof"}}']);
    if (found.status === 0) { assert.equal(found.stdout.trim(), owner); checked(['rm', '-fv', runner]); }
  }
  await Promise.allSettled(jobs);
  const found = cli(['inspect', daemon, '--format', '{{index .Config.Labels "ninedeploy.proof"}}']);
  if (found.status === 0) { assert.equal(found.stdout.trim(), owner); checked(['rm', '-fv', daemon]); }
  const journal = cli(['volume', 'inspect', volume, '--format', '{{index .Labels "ninedeploy.proof"}}']);
  if (journal.status === 0) { assert.equal(journal.stdout.trim(), owner); checked(['volume', 'rm', volume]); }
  rmSync(proof + '/app.tar', { force: true });
  writeFileSync(proof + '/cleanup.json', JSON.stringify({ owner, containers: checked(['ps', '-aq', '--filter', 'label=ninedeploy.proof=' + owner]), volumes: checked(['volume', 'ls', '-q', '--filter', 'label=ninedeploy.proof=' + owner]) }, null, 2));
}
