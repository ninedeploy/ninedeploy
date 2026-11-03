// Real builder acceptance against an owned nested daemon; never a local/live Docker host.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.env.DOCKER_HOST, 'unix:///var/run/docker.sock');
assert.equal(process.env.DOCKER_CONTEXT, 'default');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const proof = resolve(root, '.temp_files/host-port-preparation');
mkdirSync(proof, { recursive: true });
const socket = join(proof, 'engine.sock'), name = `nd-prep-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
const realDocker = execFileSync('which', ['docker'], { encoding: 'utf8' }).trim();
const outer = (...args) => execFileSync(realDocker, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 8 << 20 }).trim();
const inner = (...args) => outer('exec', name, 'docker', ...args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const deadline = Date.now() + 30000; let last; do { try { return await check(); } catch (error) { last = error; await sleep(200); } } while (Date.now() < deadline); throw last; }
const image = 'node:26.12.1-alpine', cases = [];
let created = false;
try {
  outer('run', '-d', '--privileged', '--name', name, '-e', 'DOCKER_TLS_CERTDIR=', '-v', `${root}:${root}:ro`, '-v', `${proof}:${proof}`, 'docker:29-dind', `--host=unix://${socket}`);
  created = true;
  await until(() => inner('info'));
  await until(() => outer('exec', name, 'chmod', '0666', socket)); // Only the owned nested socket.
  inner('pull', image); inner('pull', 'traefik:3'); inner('network', 'create', 'ninedeploy');
  writeFileSync(join(proof, 'dynamic.yml'), 'http:\n  routers:\n    app:\n      rule: Host(`prep.test`)\n      service: app\n  services:\n    app:\n      loadBalancer:\n        servers:\n          - url: http://initial:3000\n');
  inner('run', '-d', '--name', 'ninedeploy-traefik', '--network', 'ninedeploy', '-v', `${proof}:/config:ro`, 'traefik:3', '--entrypoints.web.address=:80', '--providers.file.filename=/config/dynamic.yml', '--providers.file.watch=true');
  const clientScript = `const http=require('node:http');let done=false;const records=[];async function tick(){if(done)return;try{records.push(await new Promise((resolve,reject)=>{const q=http.get({hostname:'ninedeploy-traefik',headers:{host:'prep.test'}},r=>{let body='';r.on('data',c=>body+=c);r.on('end',()=>resolve({status:r.statusCode,body}))});q.setTimeout(3000,()=>q.destroy(Error('timeout')));q.on('error',reject)}))}catch(e){records.push({error:e.name})}setTimeout(tick,50)}http.createServer((q,r)=>{if(q.url==='/begin'){records.length=0;done=false;tick()}if(q.url==='/finish')done=true;r.end(JSON.stringify(records))}).listen(8091,'127.0.0.1');`;
  inner('run', '-d', '--name', 'client', '--network', 'ninedeploy', image, 'node', '-e', clientScript);
  const records = endpoint => JSON.parse(inner('exec', 'client', 'node', '-e', `fetch('http://127.0.0.1:8091/${endpoint}').then(r=>r.text()).then(console.log)`));
  const request = () => inner('exec', 'client', 'node', '-e', "require('node:http').get({hostname:'ninedeploy-traefik',headers:{host:'prep.test'}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{if(r.statusCode!==200)process.exit(1);console.log(b)})}).on('error',()=>process.exit(1))");
  const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
  const tsx = require.resolve('tsx/cli');
  for (const [index, multiline] of [false, true].entries()) {
    const slug = `prep-${multiline ? 'multiline' : 'plain'}`, old = `${slug}-4`, candidate = `${slug}-5`;
    const directory = join(proof, slug), bin = join(directory, 'bin'); mkdirSync(bin, { recursive: true });
    const port = 33000 + index, udp = 35060 + index * 100;
    inner('network', 'create', `nd-svc-${slug}`); inner('network', 'connect', `nd-svc-${slug}`, 'ninedeploy-traefik');
    inner('run', '-d', '--name', old, '--network', `nd-svc-${slug}`, '-p', `${port}:3000`, '-p', `${udp}:5060/udp`, '-p', `${udp + 10}-${udp + 12}:10000-10002/udp`, '-v', `nd-svc-${slug}-data:/data`, '-v', `${root}/scripts/fixtures/persistent-port-runtime.mjs:/fixture.mjs:ro`, image, 'node', '/fixture.mjs', 'server', 'old');
    inner('exec', old, 'node', '-e', "require('node:fs').writeFileSync('/data/preparation-marker','preserve')");
    const route = runtime => writeFileSync(join(proof, 'dynamic.yml'), `http:\n  routers:\n    app:\n      rule: Host(\`prep.test\`)\n      service: app\n  services:\n    app:\n      loadBalancer:\n        servers:\n          - url: http://${runtime}:3000\n`);
    route(old); await until(() => assert.equal(request(), 'old'));
    const config = { root, directory, socket, slug, old, image, port, udp, multiline, failCreate: true };
    const configPath = join(directory, 'input.json');
    function configure(failCreate) {
      config.failCreate = failCreate; writeFileSync(configPath, JSON.stringify(config));
      const wrapper = `#!/usr/bin/env node\nconst cp=require('node:child_process'),fs=require('node:fs');const args=process.argv.slice(2),env={...process.env};delete env.DOCKER_CONTEXT;delete env.DOCKER_HOST;fs.appendFileSync(${JSON.stringify(join(directory, 'commands.jsonl'))},JSON.stringify(args)+'\\n');const result=cp.spawnSync(${JSON.stringify(realDocker)},['--host',${JSON.stringify('unix://' + socket)},...args],{env,encoding:'utf8',input:args.includes('--password-stdin')?fs.readFileSync(0):undefined,maxBuffer:8<<20});if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);const prepared=(args[0]==='create'&&args.includes(${JSON.stringify(candidate)}))||(args[0]==='compose'&&args.includes('create')&&args.includes(${JSON.stringify('ndrt-' + candidate)}));if(prepared&&result.status===0){const inspect=n=>JSON.parse(cp.execFileSync(${JSON.stringify(realDocker)},['--host',${JSON.stringify('unix://' + socket)},'inspect',n,'--format','{{json .State}}'],{env,encoding:'utf8'}));fs.writeFileSync(${JSON.stringify(join(directory, 'candidate.json'))},JSON.stringify({old:inspect(${JSON.stringify(old)}),candidate:inspect(${JSON.stringify(candidate)})}));if(${JSON.stringify(failCreate)}){console.error('Injected candidate create acknowledgement failure');process.exit(125)}}process.exit(result.status??1);\n`;
      writeFileSync(join(bin, 'docker'), wrapper); chmodSync(join(bin, 'docker'), 0o755);
    }
    const worker = () => new Promise((resolveWorker, reject) => {
      const env = { ...process.env, PATH: bin + ':' + process.env.PATH, DOCKER_HOST: 'unix://' + socket }; delete env.DOCKER_CONTEXT;
      const child = spawn(process.execPath, [tsx, join(root, 'scripts/fixtures/host-port-preparation-worker.mjs'), configPath], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
      let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; }); child.once('error', reject);
      child.once('close', status => { writeFileSync(join(directory, 'worker.log'), output); status === 0 ? resolveWorker() : reject(new Error('Builder worker failed; see owned worker.log')); });
    });
    configure(true); records('begin'); await worker(); await sleep(1000);
    const traffic = records('finish'); writeFileSync(join(directory, 'traffic.json'), JSON.stringify(traffic));
    assert.ok(traffic.length >= 10); assert.ok(traffic.every(row => row.status === 200 && row.body === 'old'));
    const preparation = JSON.parse(readFileSync(join(directory, 'candidate.json'), 'utf8'));
    assert.equal(preparation.old.Running, true); assert.equal(preparation.candidate.Status, 'created'); assert.equal(preparation.candidate.Running, false);
    assert.equal(inner('inspect', old, '--format', '{{.State.Running}}'), 'true');
    assert.equal(inner('exec', old, 'cat', '/data/preparation-marker'), 'preserve');
    const commands = readFileSync(join(directory, 'commands.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(!commands.some(args => args[0] === 'stop' && args.includes(old)));
    for (const file of ['candidate.json', 'worker-result.json', 'worker.log', 'build.log']) copyFileSync(join(directory, file), join(directory, 'failure-' + file));
    configure(false); await worker(); route(candidate); await until(() => assert.equal(request(), 'new'));
    assert.equal(inner('exec', candidate, 'cat', '/data/preparation-marker'), 'preserve');
    if (multiline) assert.equal(inner('exec', candidate, 'node', '-e', 'console.log(process.env.CERT === "line1\\nline2")'), 'true');
    cases.push({ multiline, failedPreparationRequests: traffic.length, unexpected502: traffic.filter(row => row.status === 502).length, oldPreservedOnFailure: true, candidateStayedStoppedUntilHandoff: true, preparedStartHealthy: true, volumeMarkerPreserved: true });
    inner('rm', '-f', old, candidate);
  }
  writeFileSync(join(proof, 'result.json'), JSON.stringify({ passed: true, cases, startupDowntimeEliminated: false }, null, 2));
} finally {
  if (created) {
    outer('rm', '-f', '-v', name);
    assert.equal(outer('ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'), '');
    writeFileSync(join(proof, 'cleanup.json'), JSON.stringify({ ownedDaemonRemoved: name }));
  }
}
