// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Owned hosted acceptance, outside Turbo.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use an isolated GitHub Actions runner');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Use a GitHub-hosted runner');
assert.equal(process.env.DOCKER_HOST, 'unix:///var/run/docker.sock', 'Use only the hosted runner daemon');
const image = process.argv.find(arg => arg.startsWith('--image='))?.slice(8); assert.match(image ?? '', /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/);
const proof = resolve(process.argv.find(arg => arg.startsWith('--proof='))?.slice(8) ?? '.temp_files/wake-recovery');
const publicDir = resolve(proof, 'public'), privateDir = resolve(proof, 'private');
mkdirSync(publicDir, { recursive: true }); mkdirSync(resolve(privateDir, 'shim'), { recursive: true });
const owner = `wake-recovery-${randomBytes(8).toString('hex')}`, agentToken = randomBytes(32).toString('hex');
const jwtSecret = randomBytes(32).toString('hex');
const resources = [], cases = [], cleanup = [];
let failure, imageId, oldImage, evidence;
const docker = (args, allowed = false, extra = {}) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 2 << 20, windowsHide: true, ...extra });
  if (!allowed) assert.equal(result.status, 0, `${args.slice(0, 3)}: ${result.stderr || result.stdout}`);
  return { ...result, out: (result.stdout ?? '').trim() };
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function driver(candidate, delay) {
  writeFileSync(resolve(privateDir, 'creation-delay'), String(delay));
  const id = docker(['run', '-d', '--name', 'ninedeploy-agent', '--label', `ninedeploy.proof=${owner}`, '--network', 'ninedeploy', '--user', '0', '--no-healthcheck', '-w', '/fixture',
    '-e', 'GITHUB_ACTIONS=true', '-e', 'NINEDEPLOY_DATA_DIR=/fixture/data', '-e', 'NINEDEPLOY_DB_PATH=/fixture/panel.db', '-e', 'NINEDEPLOY_AGENT_REQUIRE_SEALED=1',
    '-e', `NINEDEPLOY_JWT_SECRET=${jwtSecret}`,
    '-e', 'NINEDEPLOY_AGENT_PROXY_TRAFFIC=on', '-e', 'NINEDEPLOY_AGENT_ORDERED_PROXY=on', '-e', 'NINEDEPLOY_AGENT_CONTAINER_MUTATIONS=on',
    '-e', `ND_PROOF_TOKEN=${agentToken}`,
    '-e', 'PATH=/fixture/shim:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', `${privateDir}:/fixture`, '-v', `${publicDir}:/proof`, '--entrypoint', 'node', candidate, '-e', 'setInterval(()=>{},1000)']).out;
  resources.push({ kind: 'container', id }); return id;
}
try {
  for (const name of ['ninedeploy-agent', 'ninedeploy-wake', 'ninedeploy-proxy']) assert.notEqual(docker(['inspect', name], true).status, 0, `Refuse existing ${name}`);
  assert.notEqual(docker(['network', 'inspect', 'ninedeploy'], true).status, 0, 'Refuse an existing proxy network');
  imageId = docker(['image', 'inspect', image, '--format', '{{.Id}}']).out;
  if (docker(['image', 'inspect', 'busybox:1.36'], true).status !== 0) docker(['pull', 'busybox:1.36']);
  docker(['build', '-t', `${owner}:old`, '-'], false, { input: `FROM ${image}\nLABEL ninedeploy.proof=${owner}\n` });
  oldImage = docker(['image', 'inspect', `${owner}:old`, '--format', '{{.Id}}']).out; assert.notEqual(oldImage, imageId);
  resources.push({ kind: 'image', id: oldImage });
  resources.push({ kind: 'network', id: docker(['network', 'create', '--label', `ninedeploy.proof=${owner}`, 'ninedeploy']).out });
  copyFileSync(new URL('./fixtures/wake-recovery.mjs', import.meta.url), resolve(privateDir, 'fixture.mjs'));
  // Delay the real Docker creation boundary; do not patch the application.
  // The same delay should leave the old backend serving during a safe handoff.
  writeFileSync(resolve(privateDir, 'shim/docker'), `#!/bin/sh\ncase " $* " in\n  *" ninedeploy.managed=wake "*)\n    if [ "$1" = run ]; then\n      shift\n      delay=$(cat /fixture/creation-delay)\n      if [ "$delay" -gt 0 ]; then touch /proof/creation-paused; sleep "$delay"; fi\n      exec /usr/bin/docker run --label "ninedeploy.proof=${owner}" "$@"\n    fi;;\nesac\nexec /usr/bin/docker "$@"\n`, { mode: 0o755 });
  const oldDriver = driver(`${owner}:old`, 0);
  docker(['exec', oldDriver, 'node', '/fixture/fixture.mjs', 'seed'], false, { timeout: 180_000 });
  const seed = JSON.parse(readFileSync(resolve(publicDir, 'seed.json'), 'utf8'));
  const native = JSON.parse(docker(['inspect', seed.catcherId]).out)[0];
  cases.push({ name: 'catcher-does-not-inherit-panel-healthcheck', passed: native.Config.Healthcheck?.Test?.[0] === 'NONE', healthTest: native.Config.Healthcheck?.Test });
  if (docker(['image', 'inspect', 'traefik:3'], true).status !== 0) docker(['pull', 'traefik:3']);
  const proxy = docker(['run', '-d', '--name', 'ninedeploy-proxy', '--label', `ninedeploy.proof=${owner}`, '--network', 'ninedeploy',
    '-v', `${privateDir}/.agent-proxy:/etc/traefik:ro`, 'traefik:3', '--configFile=/etc/traefik/traefik.yml']).out;
  resources.push({ kind: 'container', id: proxy });
  const request = "const h=require('node:http');const q=h.get({hostname:'ninedeploy-proxy',path:'/dashboard',headers:{host:'wake.invalid'}},r=>{r.resume();r.on('end',()=>{console.log(JSON.stringify({status:r.statusCode}));process.exit(r.statusCode===503?0:1)})});q.setTimeout(2000,()=>q.destroy());q.on('error',()=>process.exit(1))";
  for (const deadline = Date.now() + 30_000; ;) {
    const probe = docker(['exec', oldDriver, 'node', '-e', request], true);
    writeFileSync(resolve(publicDir, 'initial-route.json'), JSON.stringify({ exitCode: probe.status, response: probe.out, error: probe.stderr?.slice(0, 500) }));
    if (probe.status === 0) break;
    assert.ok(Date.now() < deadline, 'Initial waking route never became available'); await pause(200);
  }
  docker(['rm', '-fv', oldDriver]);
  const candidate = driver(image, 3);
  writeFileSync(resolve(privateDir, 'sample.mjs'), `import http from 'node:http';import{appendFileSync,existsSync,writeFileSync}from'node:fs';const rows=[];while(!existsSync('/proof/stop')){const row=await new Promise(resolve=>{const start=Date.now(),q=http.get({hostname:'ninedeploy-proxy',path:'/dashboard',headers:{host:'wake.invalid'}},r=>{r.resume();r.on('end',()=>resolve({at:start,status:r.statusCode}))});q.setTimeout(1000,()=>q.destroy(Error('timeout')));q.on('error',()=>resolve({at:start,status:0}))});rows.push(row);appendFileSync('/proof/traffic.jsonl',JSON.stringify(row)+'\\n');await new Promise(r=>setTimeout(r,20))}writeFileSync('/proof/samples.json',JSON.stringify(rows));`);
  docker(['exec', '-d', candidate, 'node', '/fixture/sample.mjs']); await pause(1000);
  docker(['exec', candidate, 'node', '/fixture/fixture.mjs', 'recover'], false, { timeout: 180_000 });
  await pause(1000); writeFileSync(resolve(publicDir, 'stop'), '');
  for (const deadline = Date.now() + 5000; !existsSync(resolve(publicDir, 'samples.json')); ) { assert.ok(Date.now() < deadline, 'Sampler did not stop'); await pause(50); }
  const samples = JSON.parse(readFileSync(resolve(publicDir, 'samples.json'), 'utf8'));
  evidence = JSON.parse(readFileSync(resolve(publicDir, 'maintenance.json'), 'utf8'));
  assert.ok(existsSync(resolve(publicDir, 'creation-paused')), 'Creation delay did not exercise the handoff');
  assert.ok(samples.length >= 50, 'Too few real proxy requests');
  const counts = {}; for (const row of samples) counts[row.status] = (counts[row.status] ?? 0) + 1;
  cases.push({ name: 'traffic-during-delayed-replacement', passed: samples.every(row => row.status === 503), requests: samples.length, counts });
  cases.push({ name: 'maintenance-completed-after-real-sealed-routing', passed: evidence.result.state === 'completed' && evidence.phase === 'completed' });
  assert.equal(docker(['inspect', 'ninedeploy-proxy', '--format', '{{.Id}}']).out, proxy, 'Proxy was recreated');
  assert.ok(cases.every(row => row.passed), 'Catcher replacement acceptance failed; see cases and traffic trace');
} catch (error) { failure = String(error); process.exitCode = 1; }
finally {
  // Only fixture-labelled resources are discovered; no installation-wide cleanup.
  try {
    const ids = docker(['ps', '-aq', '--filter', `label=ninedeploy.proof=${owner}`]).out.split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const row = JSON.parse(docker(['inspect', id]).out)[0]; assert.equal(row.Config.Labels['ninedeploy.proof'], owner);
      docker(['rm', '-fv', id]); cleanup.push({ kind: 'container', id, removed: true });
    }
    for (const resource of resources.reverse()) {
      if (resource.kind === 'container') continue;
      const row = JSON.parse(docker(resource.kind === 'network' ? ['network', 'inspect', resource.id] : ['image', 'inspect', resource.id]).out)[0];
      assert.equal((resource.kind === 'network' ? row.Labels : row.Config.Labels)['ninedeploy.proof'], owner);
      docker(resource.kind === 'network' ? ['network', 'rm', resource.id] : ['image', 'rm', '-f', resource.id]); cleanup.push({ ...resource, removed: true });
    }
  } catch (error) { failure ??= String(error); process.exitCode = 1; cleanup.push({ removed: false }); }
  const result = { image, imageId, oldImage, source: process.env.GITHUB_SHA, realDocker: true, realTraefik: true, seededDormantJournal: true,
    cases, maintenance: evidence, cleanup, accepted: !failure, ...(failure ? { failure } : {}) };
  writeFileSync(resolve(publicDir, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
}
