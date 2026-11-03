// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Owned hosted acceptance outside Turbo.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use an isolated GitHub Actions runner');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Use a GitHub-hosted runner');
assert.equal(process.env.DOCKER_HOST, 'unix:///var/run/docker.sock', 'Use only the hosted daemon');
const image = process.argv.find(arg => arg.startsWith('--image='))?.slice(8); assert.match(image ?? '', /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/);
const proof = resolve(process.argv.find(arg => arg.startsWith('--proof='))?.slice(8) ?? '.temp_files/node-sleep-wake');
const publicDir = resolve(proof, 'public'), privateDir = resolve(proof, 'private');
mkdirSync(publicDir, { recursive: true }); mkdirSync(resolve(privateDir, 'app-state'), { recursive: true }); mkdirSync(resolve(privateDir, 'shim'), { recursive: true });
const owner = `sleep-wake-${randomBytes(8).toString('hex')}`, token = randomBytes(32).toString('hex'), jwt = randomBytes(32).toString('hex');
const basicAuth = randomBytes(24).toString('hex');
const resources = [], cleanup = [], cases = [];
let failure, imageId, evidence;
// Async execution keeps the driver observable while the real five-minute clock runs.
async function docker(args, allowed = false, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', error = '', timedOut = false, oversized = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    const collect = (current, chunk) => { const next = current + chunk; if (next.length > 2 << 20) { oversized = true; child.kill('SIGKILL'); } return next.slice(0, 2 << 20); };
    child.stdout.on('data', chunk => { out = collect(out, chunk); }); child.stderr.on('data', chunk => { error = collect(error, chunk); });
    child.on('error', reason => { clearTimeout(timer); reject(reason); });
    child.on('close', status => {
      clearTimeout(timer);
      if (timedOut || oversized || (!allowed && status !== 0)) reject(new Error(`${args.slice(0, 3).join(' ')} failed: ${timedOut ? 'deadline' : oversized ? 'output limit' : error || out}`));
      else resolve({ status, out: out.trim() });
    });
  });
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function container(name, args) {
  const id = (await docker(['run', '-d', '--name', name, '--label', `ninedeploy.proof=${owner}`, ...args])).out;
  resources.push({ kind: 'container', id }); return id;
}
try {
  for (const name of ['ninedeploy-agent', 'ninedeploy-proxy', 'web-9', 'secure-10']) assert.notEqual((await docker(['inspect', name], true)).status, 0, `Refuse existing ${name}`);
  assert.notEqual((await docker(['network', 'inspect', 'ninedeploy'], true)).status, 0, 'Refuse existing network');
  imageId = (await docker(['image', 'inspect', image, '--format', '{{.Id}}'])).out;
  for (const dependency of ['busybox:1.36', 'traefik:3']) if ((await docker(['image', 'inspect', dependency], true)).status !== 0) await docker(['pull', dependency]);
  resources.push({ kind: 'network', id: (await docker(['network', 'create', '--label', `ninedeploy.proof=${owner}`, 'ninedeploy'])).out });
  copyFileSync(new URL('./fixtures/node-sleep-wake.mjs', import.meta.url), resolve(privateDir, 'fixture.mjs'));
  copyFileSync(new URL('./fixtures/node-sleep-wake-sampler.mjs', import.meta.url), resolve(privateDir, 'sample.mjs'));
  // Add only the fixture ownership label at the real catcher creation boundary.
  writeFileSync(resolve(privateDir, 'shim/docker'), `#!/bin/sh\ncase " $* " in\n *" ninedeploy.managed=wake "*)\n if [ "$1" = run ]; then shift; exec /usr/bin/docker run --label "ninedeploy.proof=${owner}" "$@"; fi;;\nesac\nexec /usr/bin/docker "$@"\n`, { mode: 0o755 });
  const appId = await container('web-9', ['--network', 'ninedeploy', '--user', '0', '--no-healthcheck', '--label', 'ninedeploy.managed=service',
    '--label', 'ninedeploy.service=1', '--label', 'ninedeploy.deployment=9', '-v', `${privateDir}/app-state:/state`, '--entrypoint', 'node', image, '-e',
    "const fs=require('node:fs');fs.appendFileSync('/state/boots','boot\\n');require('node:http').createServer((q,r)=>{if(q.url==='/ready'){r.statusCode=fs.existsSync('/state/block-ready')?503:200;r.end('readiness');}else r.end('owned-sleep-application');}).listen(3000,'0.0.0.0')"]);
  mkdirSync(resolve(privateDir, 'secure-state'), { recursive: true });
  const secureId = await container('secure-10', ['--network', 'ninedeploy', '--user', '0', '--no-healthcheck', '--label', 'ninedeploy.managed=service',
    '--label', 'ninedeploy.service=2', '--label', 'ninedeploy.deployment=10', '-v', `${privateDir}/secure-state:/state`, '--entrypoint', 'node', image, '-e',
    "const fs=require('node:fs');fs.appendFileSync('/state/boots','boot\\n');require('node:http').createServer((q,r)=>{if(q.url==='/ready'){fs.writeFileSync('/state/ready-probed','');r.statusCode=fs.existsSync('/state/block-ready')?503:200;r.end('readiness');}else r.end('owned-sleep-application');}).listen(3000,'0.0.0.0')"]);
  const driver = await container('ninedeploy-agent', ['--network', 'ninedeploy', '--user', '0', '--no-healthcheck', '-w', '/fixture',
    '-e', 'GITHUB_ACTIONS=true', '-e', 'NINEDEPLOY_DATA_DIR=/fixture/data', '-e', 'NINEDEPLOY_DB_PATH=/fixture/panel.db', '-e', 'NINEDEPLOY_AGENT_REQUIRE_SEALED=1',
    '-e', `NINEDEPLOY_JWT_SECRET=${jwt}`, '-e', `ND_PROOF_TOKEN=${token}`, '-e', `ND_PROOF_BASIC_AUTH=${basicAuth}`, '-e', 'NINEDEPLOY_AGENT_PROXY_TRAFFIC=on',
    '-e', 'NINEDEPLOY_AGENT_ORDERED_PROXY=on', '-e', 'NINEDEPLOY_AGENT_CONTAINER_MUTATIONS=on',
    '-e', 'PATH=/fixture/shim:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${privateDir}:/fixture`, '-v', `${publicDir}:/proof`, '--entrypoint', 'node', image, '-e', 'setInterval(()=>{},1000)']);
  await docker(['exec', driver, 'node', '/fixture/fixture.mjs', 'setup']);
  const proxy = await container('ninedeploy-proxy', ['--network', 'ninedeploy', '-v', `${privateDir}/.agent-proxy:/etc/traefik:ro`, 'traefik:3', '--configFile=/etc/traefik/traefik.yml']);
  // Observer has neither Docker socket nor panel data/secrets, and survives coordinator exit.
  const observer = await container(`nd-${owner}-observer`, ['--network', 'ninedeploy', '--user', '0', '--no-healthcheck',
    '-v', `${privateDir}/sample.mjs:/sample.mjs:ro`, '-v', `${publicDir}:/proof`, '--entrypoint', 'node', image, '/sample.mjs', 'sample']);
  for (const deadline = Date.now() + 30_000; ;) {
    if ((await docker(['exec', driver, 'node', '/fixture/sample.mjs', 'probe'], true)).status === 0) break;
    assert.ok(Date.now() < deadline, 'Initial application route unavailable'); await pause(250);
  }
  await docker(['exec', driver, 'node', '/fixture/fixture.mjs', 'journey'], false, 540_000);
  await docker(['exec', driver, 'node', '/fixture/fixture.mjs', 'resume'], false, 60_000);
  evidence = JSON.parse(readFileSync(resolve(publicDir, 'journey.json'), 'utf8'));
  assert.ok(evidence.complete && evidence.realSealedHttp && evidence.seededDormantJournal === false);
  writeFileSync(resolve(publicDir, 'stop'), '');
  for (const deadline = Date.now() + 5000; !existsSync(resolve(publicDir, 'samples.json')); ) { assert.ok(Date.now() < deadline, 'Observer did not settle'); await pause(50); }
  assert.equal((await docker(['wait', observer])).out, '0');
  const rows = JSON.parse(readFileSync(resolve(publicDir, 'samples.json'), 'utf8'));
  const held = evidence.cases.find(row => row.name === 'http-readiness-failure-retains-waking-page-after-real-start');
  const heldRows = rows.filter(row => row.at >= held.from && row.at <= held.to);
  cases.push(...evidence.cases);
  cases.push({ name: 'continuous-traffic-through-real-stop-and-wake', passed: rows.length >= 100 && rows.every(row => !row.error && (row.application || row.waking)), requests: rows.length,
    application: rows.filter(row => row.application).length, waking: rows.filter(row => row.waking).length });
  cases.push({ name: 'failed-http-readiness-never-publishes-application', passed: heldRows.length >= 50 && heldRows.every(row => row.waking), requests: heldRows.length });
  cases.push({ name: 'traffic-after-completed-wake', passed: rows.some(row => row.at >= evidence.completedAt && row.application) });
  cases.push({ name: 'immutable-app-and-proxy-kept', passed: (await docker(['inspect', '--format', '{{.Id}}', 'web-9'])).out === appId &&
    (await docker(['inspect', '--format', '{{.Id}}', 'ninedeploy-proxy'])).out === proxy });
  cases.push({ name: 'superseding-stop-keeps-secure-application-off', passed: (await docker(['inspect', '--format', '{{.Id}}', 'secure-10'])).out === secureId &&
    (await docker(['inspect', '--format', '{{.State.Running}}', secureId])).out === 'false' });
  assert.ok(cases.every(row => row.passed), 'Real sleep/wake acceptance failed');
} catch (error) { failure = String(error); process.exitCode = 1; }
finally {
  try {
    const ids = (await docker(['ps', '-aq', '--filter', `label=ninedeploy.proof=${owner}`])).out.split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const row = JSON.parse((await docker(['inspect', id])).out)[0]; assert.equal(row.Config.Labels['ninedeploy.proof'], owner);
      await docker(['rm', '-fv', id]); cleanup.push({ kind: 'container', id, removed: true });
    }
    for (const resource of resources.reverse()) if (resource.kind === 'network') {
      const row = JSON.parse((await docker(['network', 'inspect', resource.id])).out)[0]; assert.equal(row.Labels['ninedeploy.proof'], owner);
      await docker(['network', 'rm', resource.id]); cleanup.push({ ...resource, removed: true });
    }
  } catch (error) { failure ??= String(error); process.exitCode = 1; cleanup.push({ removed: false }); }
  const result = { source: process.env.GITHUB_SHA, imageId, realDocker: true, realTraefik: true, seededDormantJournal: false,
    cases, evidence, cleanup, accepted: !failure, ...(failure ? { failure } : {}) };
  writeFileSync(resolve(publicDir, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
}
