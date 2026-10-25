import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const image = process.argv.find(arg => arg.startsWith('--image='))?.slice(8);
assert.ok(image && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image), 'Pass --image=<built NineDeploy image>');
const owner = `readiness-${randomBytes(6).toString('hex')}`, names = [], cases = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const docker = args => spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
const checked = args => { const result = docker(args); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
try {
  if (docker(['image', 'inspect', 'busybox:1.36']).status !== 0) checked(['pull', 'busybox:1.36']);
  for (const [nativeHealth, responseDelayMs] of [[true, 0], [false, 0], [true, 50], [false, 50]]) {
    const name = `nd-${owner}-${nativeHealth ? 'native' : 'none'}-${responseDelayMs}`; names.push(name);
    checked(['run', '-d', '--name', name, '--label', `ninedeploy.proof=${owner}`,
      ...(nativeHealth ? ['--health-cmd', 'exit 0', '--health-interval', '1s', '--health-timeout', '1s', '--health-start-period', '0s'] : ['--no-healthcheck']),
      '--entrypoint', 'node', image, '-e', `require('node:http').createServer((q,s)=>${responseDelayMs ? `setTimeout(()=>s.end('ready'),${responseDelayMs})` : "s.end('ready')"}).listen(8080,'0.0.0.0')`]);
    const id = checked(['inspect', name, '--format', '{{.Id}}']);
    const deadline = Date.now() + 20_000;
    let running = false;
    while (Date.now() < deadline) {
      const code = docker(['exec', name, 'node', '-e', "fetch('http://127.0.0.1:8080/ready?db=1',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]).status;
      const health = checked(['inspect', name, '--format', '{{if index .State "Health"}}{{.State.Health.Status}}{{else}}none{{end}}']);
      if (code === 0 && (!nativeHealth || health === 'healthy')) { running = true; break; }
      await pause(100);
    }
    assert.ok(running, 'Owned workload did not become ready');
    const request = { requestId: randomBytes(16).toString('hex'), targets: [{ id, name }], mode: 'http-strict', port: 8080, path: '/ready?db=1', timeoutMs: 10_000 };
    const program = `import{containerReadinessOps}from'/app/apps/server/dist/agentOps/containerReadiness.js';await containerReadinessOps.ops['docker.readiness'].run(${JSON.stringify(request)},console.log,{sealed:true});`;
    const sample = docker(['run', '--rm', '--label', `ninedeploy.proof=${owner}`, '--user', '0', '--no-healthcheck',
      '-v', '/var/run/docker.sock:/var/run/docker.sock', '-e', 'NODE_ENV=test', '--entrypoint', 'node', image, '--input-type=module', '-e', program]);
    const frames = (sample.stdout ?? '').split('\n').filter(line => line.startsWith('ND-READINESS '));
    let reply;
    try { if (frames.length === 1) reply = JSON.parse(frames[0].slice(13)); } catch { /* a malformed frame is a failed smoke */ }
    const passed = sample.status === 0 && reply?.requestId === request.requestId && reply.complete === true && reply.items?.length === 1 &&
      reply.items[0].id === id && reply.items[0].name === name && reply.items[0].ready === true;
    cases.push({ nativeHealth, responseDelayMs, passed, ...(passed ? {} : { code: sample.status, detail: (sample.stderr || sample.stdout || '').slice(-2000) }) });
  }
  console.log(JSON.stringify({ image, cases, realDocker: true }));
  assert.ok(cases.every(result => result.passed), 'Container readiness smoke failed');
} finally {
  for (const name of names.reverse()) {
    const label = docker(['inspect', name, '--format', '{{index .Config.Labels "ninedeploy.proof"}}']);
    if (label.status === 0) { assert.equal(label.stdout.trim(), owner); checked(['rm', '-fv', name]); }
  }
}
