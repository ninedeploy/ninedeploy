// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Standalone hosted acceptance is not a cached Turbo task.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R2 node scale to zero step 2 (docs/NODE_SLEEP_WAKE.md): the wake catcher on the real image.
 * The run arguments come from the image's own `wakeCatcherRunArgs`; only the container name and
 * network are swapped for owned ones, so the shared runner's names are never touched.
 */
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use an isolated GitHub Actions runner');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Use a GitHub-hosted runner');
assert.equal(process.env.DOCKER_HOST, 'unix:///var/run/docker.sock', 'Use only the hosted runner daemon');
const image = process.argv.find(arg => arg.startsWith('--image='))?.slice(8);
assert.ok(image && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image), 'Pass --image=<candidate>');
const proof = resolve(process.argv.find(arg => arg.startsWith('--proof='))?.slice(8) ?? '.temp_files/wake-catcher');
mkdirSync(proof, { recursive: true });
const owner = `wake-${randomBytes(8).toString('hex')}`, network = `nd-${owner}`, catcher = `nd-${owner}-catcher`, resources = [], cases = [];
const docker = args => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 2 << 20, windowsHide: true });
  assert.equal(result.status, 0, `${args.slice(0, 3)}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};
const token = randomBytes(16).toString('hex'), key = randomBytes(32).toString('hex');
let failure;
try {
  const imageId = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  resources.push({ kind: 'network', id: docker(['network', 'create', '--label', `ninedeploy.proof=${owner}`, network]) });
  const args = JSON.parse(docker(['run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '--input-type=module', '-e',
    `const m=await import('/app/apps/server/dist/lib/nodeWakeCatcher.js');console.log(JSON.stringify(m.wakeCatcherRunArgs(${JSON.stringify(imageId)},${JSON.stringify(key)})))`]));
  const name = args.indexOf('--name'), net = args.indexOf('--network');
  assert.equal(args[name + 1], 'ninedeploy-wake'); assert.equal(args[net + 1], 'ninedeploy');
  args[name + 1] = catcher; args[net + 1] = network;
  args.splice(1, 0, '--label', `ninedeploy.proof=${owner}`);
  resources.push({ kind: 'container', id: docker(args) });
  const info = JSON.parse(docker(['inspect', catcher]))[0];
  assert.equal(info.Image, imageId); assert.equal(info.Config.User, '65534:65534'); assert.equal(info.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(info.HostConfig.CapDrop, ['ALL']); assert.equal(info.HostConfig.Privileged, false);
  // The image's VOLUME /data must be shadowed by the empty tmpfs: no volume or bind mount at all.
  assert.ok(info.Mounts.every(mount => mount.Type === 'tmpfs'), `unexpected mounts: ${JSON.stringify(info.Mounts)}`);
  assert.deepEqual((info.HostConfig.Mounts ?? []).map(mount => [mount.Type, mount.Target]), [['tmpfs', '/data']]);
  for (const path of ['/data/probe', '/probe', '/app/probe']) {
    const write = spawnSync('docker', ['exec', catcher, 'node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(path)},'x')`], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.notEqual(write.status, 0, `the catcher could write ${path}`);
  }
  assert.deepEqual(Object.keys(info.NetworkSettings.Networks), [network]); assert.equal(Object.keys(info.HostConfig.PortBindings ?? {}).length, 0);
  cases.push({ name: 'agent-image-unprivileged-read-only-no-mounts', passed: true });
  assert.ok(!info.Config.Labels['ninedeploy.wake.key'].includes(key), 'the label must not hold the key');
  const fetchScript = (path, keyed = true) => `fetch('http://${catcher}:8080${path}',{headers:${keyed ? JSON.stringify({ 'x-nd-wake-key': key }) : '{}'}}).then(async r=>console.log(JSON.stringify({status:r.status,retry:r.headers.get('retry-after'),body:await r.text()})))`;
  let reply;
  for (const deadline = Date.now() + 30_000; ;) {
    const run = spawnSync('docker', ['run', '--rm', '--network', network, '--label', `ninedeploy.proof=${owner}`, '--entrypoint', 'node', image, '-e', fetchScript(`/_nd/wake/${token}/dashboard`)],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    if (run.status === 0) { reply = JSON.parse(run.stdout.trim()); break; }
    assert.ok(Date.now() < deadline, `catcher did not answer: ${run.stderr}`);
  }
  assert.equal(reply.status, 503); assert.equal(reply.retry, '5'); assert.match(reply.body, /Waking up/); assert.match(reply.body, /http-equiv="refresh"/);
  cases.push({ name: 'waking-page-503-self-reload', passed: true });
  const other = JSON.parse(docker(['run', '--rm', '--network', network, '--label', `ninedeploy.proof=${owner}`, '--entrypoint', 'node', image, '-e', fetchScript('/')]));
  assert.equal(other.status, 404);
  cases.push({ name: 'untokened-request-wakes-nothing', passed: true });
  // A neighbouring container on the proxy network does not know the node's wake key.
  const spoofed = JSON.parse(docker(['run', '--rm', '--network', network, '--label', `ninedeploy.proof=${owner}`, '--entrypoint', 'node', image, '-e', fetchScript(`/_nd/wake/${randomBytes(16).toString('hex')}/`, false)]));
  assert.equal(spoofed.status, 404);
  cases.push({ name: 'unkeyed-neighbour-request-wakes-nothing', passed: true });
  const logs = docker(['logs', '--timestamps', catcher]).split('\n').filter(line => / ND-WAKE /.test(line));
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(`^\\S+ ND-WAKE \\{"token":"${token}"\\}$`));
  cases.push({ name: 'one-demand-line-for-the-token', passed: true, line: logs[0] });
} catch (error) { failure = String(error); process.exitCode = 1; }
finally {
  const cleanup = [];
  for (const { kind, id } of resources.reverse()) {
    try {
      const inspect = JSON.parse(docker(kind === 'network' ? ['network', 'inspect', id] : ['inspect', id]))[0];
      assert.equal((kind === 'network' ? inspect.Labels : inspect.Config.Labels)['ninedeploy.proof'], owner);
      docker(kind === 'network' ? ['network', 'rm', id] : ['rm', '-fv', id]);
      cleanup.push({ kind, id, removed: true });
    } catch (error) { failure ??= String(error); process.exitCode = 1; cleanup.push({ kind, id, removed: false }); }
  }
  const result = { image, source: process.env.GITHUB_SHA, realDocker: true, cases, cleanup, accepted: !failure, ...(failure ? { failure } : {}) };
  writeFileSync(resolve(proof, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
