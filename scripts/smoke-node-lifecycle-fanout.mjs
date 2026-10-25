// Real multi-node lifecycle ordering through sealed HTTP, SQLite and two Traefik instances.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const image = process.argv.find(arg => arg.startsWith('--image='))?.slice(8);
assert.ok(image && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image), 'Pass --image=<built NineDeploy image>');
const proof = resolve(process.argv.find(arg => arg.startsWith('--proof='))?.slice(8) ?? '.temp_files/lifecycle-fanout-' + randomBytes(6).toString('hex'));
mkdirSync(proof, { recursive: true });
const owner = 'fanout-lifecycle-' + randomBytes(5).toString('hex');
const network = 'nd-' + owner, nodes = [4, 5].map(id => ({ id, daemon: 'nd-' + owner + '-node' + id, volume: 'nd-' + owner + '-home' + id }));
const home = '/var/lib/ninedeploy-agent', cases = [], runners = [];
const cli = args => spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 90_000, maxBuffer: 4 << 20 });
const checked = args => { const result = cli(args); assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout.trim(); };
const inner = (id, args) => checked(['exec', nodes.find(node => node.id === id).daemon, 'docker', ...args]);
const report = name => { const row = { name, passed: true }; cases.push(row); console.log(JSON.stringify(row)); writeFileSync(proof + '/runtime-cases.json', JSON.stringify({ image, cases }, null, 2)); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const program = String.raw`
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createDb, runMigrations, servers, services, serviceTargets, domains, nodeLifecycleIntents, eq, desc } from '/app/packages/db/dist/index.js';
import { buildAgentApp } from '/app/apps/server/dist/agentApp.js';
import { agentRoutes } from '/app/apps/server/dist/agent.js';
import { agentOp } from '/app/apps/server/dist/lib/agentClient.js';
import { encrypt, sha256 } from '/app/apps/server/dist/lib/crypto.js';
import { renderStaticConfig } from '/app/apps/server/dist/engine/proxy.js';
import { withRoutingAck } from '/app/apps/server/dist/lib/proxyRoutingAck.js';
import { acceptNodeLifecycleIntent } from '/app/apps/server/dist/lib/nodeLifecycleIntent.js';
import { executeNodeLifecycleIntent } from '/app/apps/server/dist/lib/nodeLifecycleController.js';
import { nodeLifecycleRuntime } from '/app/apps/server/dist/lib/nodeLifecycleRuntime.js';
const mode = process.env.PROOF_MODE, childHost = process.env.CHILD_HOST;
const app = await buildAgentApp(); await app.register(agentRoutes, { tokenHash: sha256('isolated-proof-only'), nonceFile: '/var/lib/ninedeploy-agent/nonces' });
await app.listen({ host: '0.0.0.0', port: mode === 'child-agent' ? 3000 : 0 });
if (mode !== 'child-agent') {
  const c = createDb({ url: 'file:/var/lib/ninedeploy-agent/panel.sqlite' }); await c.ready; await runMigrations(c.db);
  const svc = () => c.db.query.services.findFirst({ where: eq(services.id, 1) });
  const response = host => new Promise((resolve, reject) => {
    const q = request({ host, port: 80, path: '/', headers: { host: 'fanout-lifecycle.test' } }, r => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
    q.setTimeout(3000, () => q.destroy(Error('Routing deadline'))); q.on('error', reject); q.end();
  });
  try {
    for (const id of [4, 5]) await c.db.insert(servers).values({ id, name: 'Isolated node ' + id, host: id === 4 ? '127.0.0.1' : childHost,
      port: id === 4 ? app.server.address().port : 3000, tokenEncrypted: encrypt('isolated-proof-only') }).onConflictDoUpdate({ target: servers.id,
      set: { port: id === 4 ? app.server.address().port : mode === 'offline-stop' ? 1 : 3000 } });
    if (mode === 'setup') {
      await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', status: 'stopped', serverId: 4, runtimeId: 'web-9',
        runtimeReplicas: 2, replicas: 3, port: 8080, healthCheck: 'http-strict', healthPath: '/ready', healthTimeoutSeconds: 15 });
      await c.db.insert(serviceTargets).values({ id: 42, serviceId: 1, serverId: 5, runtimeId: 'web-t5-7', status: 'idle' });
      await c.db.insert(domains).values({ serviceId: 1, hostname: 'fanout-lifecycle.test', status: 'active', ssl: false });
      for (const id of [4, 5]) {
        await agentOp(c.db, id, 'proxy.writeConfig', { kind: 'static', content: renderStaticConfig(null) }, () => {});
        await agentOp(c.db, id, 'proxy.writeConfig', { kind: 'dynamic', content: withRoutingAck('http: {}\n') }, () => {});
      }
      console.log('RESULT ' + JSON.stringify({ setup: true }));
    } else {
      const row = mode === 'resume' ? (await c.db.select().from(nodeLifecycleIntents).orderBy(desc(nodeLifecycleIntents.id)).limit(1))[0]
        : await acceptNodeLifecycleIntent(c.db, await svc(), mode === 'stop' || mode === 'offline-stop' ? 'stop' : mode === 'restart' ? 'restart' : 'start');
      if (mode === 'resume') await c.db.update(nodeLifecycleIntents).set({ nextAttemptAt: new Date(0) }).where(eq(nodeLifecycleIntents.id, row.id));
      const deps = nodeLifecycleRuntime(c.db), invoke = deps.agent, route = deps.route, trace = []; let nextId = null;
      deps.agent = async (id, op, params, options) => {
        if (op === 'docker.lifecycle' && params.action === 'stop' && params.targets.length) {
          for (const host of ['127.0.0.1', childHost]) assert.equal(await response(host), 404, 'All routes must be withdrawn before any Stop effect');
        }
        const result = await invoke(id, op, params, options);
        if (['docker.lifecycle', 'docker.readiness', 'docker.identity'].includes(op)) trace.push({ node: id, op,
          ...(op === 'docker.lifecycle' ? { action: params.action, revision: params.revision, targets: params.targets } : {}) });
        if (id === 5 && op === 'docker.lifecycle' && params.action === 'start') {
          if (mode === 'lost-child') throw Error('Injected lost child receipt after real agent effect');
          if (mode === 'superseded-start') nextId = (await acceptNodeLifecycleIntent(c.db, await svc(), 'stop')).id;
        }
        return result;
      };
      deps.route = async (service, signal, id) => {
        await route(service, signal, id);
        assert.equal(await response(id === 4 ? '127.0.0.1' : childHost), service.status === 'stopped' ? 404 : 200);
        trace.push({ node: id, op: 'routing-ack', status: service.status });
        if (mode === 'lost-route' && id === 5) throw Error('Injected lost child routing response');
      };
      const result = await executeNodeLifecycleIntent(c.db, row.id, deps);
      const stored = await c.db.query.nodeLifecycleIntents.findFirst({ where: eq(nodeLifecycleIntents.id, row.id) });
      console.log('RESULT ' + JSON.stringify({ result, id: row.id, nextId, phase: stored.phase, reason: stored.reason, status: (await svc()).status, trace }));
    }
  } finally { await app.close(); c.client.close(); }
}
`;
writeFileSync(proof + '/program.mjs', program);
function run(mode) {
  const runner = 'nd-' + owner + '-' + mode + '-' + runners.length; runners.push(runner);
  const result = cli(['run', '--rm', '--name', runner, '--label', 'ninedeploy.proof=' + owner, '--network', 'container:' + nodes[0].daemon,
    '--user', '0', '--no-healthcheck', '-v', nodes[0].volume + ':' + home, '-v', resolve(proof, 'program.mjs') + ':/proof/program.mjs:ro', '-w', home,
    '-e', 'NODE_ENV=test', '-e', 'NINEDEPLOY_DATA_DIR=' + home + '/panel-data', '-e', 'DOCKER_HOST=tcp://127.0.0.1:2375', '-e', 'PROOF_MODE=' + mode,
    '-e', 'CHILD_HOST=' + nodes[1].ip, '--entrypoint', 'node', image, '/proof/program.mjs']);
  writeFileSync(proof + '/runtime-' + mode + '-' + Date.now() + '.log', (result.stdout ?? '') + '\n' + (result.stderr ?? ''));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const lines = result.stdout.split('\n').filter(line => line.startsWith('RESULT ')); assert.equal(lines.length, 1, result.stdout);
  return JSON.parse(lines[0].slice(7));
}
const states = () => ({ primary: ['web-9', 'web-9-r2', 'web-9-r3'].map(name => inner(4, ['inspect', name, '--format', '{{.State.Running}}'])),
  child: inner(5, ['inspect', 'web-t5-7', '--format', '{{.State.Running}}']) });
try {
  checked(['image', 'inspect', image]);
  for (const fixture of ['busybox:1.36', 'docker:28-dind', 'traefik:v3.1']) if (cli(['image', 'inspect', fixture]).status !== 0) checked(['pull', fixture]);
  checked(['network', 'create', '--internal', '--label', 'ninedeploy.proof=' + owner, network]);
  for (const node of nodes) {
    checked(['volume', 'create', '--label', 'ninedeploy.proof=' + owner, node.volume]);
    checked(['run', '-d', '--name', node.daemon, '--label', 'ninedeploy.proof=' + owner, '--privileged', '--network', network,
      '-v', node.volume + ':' + home, '-e', 'DOCKER_TLS_CERTDIR=', 'docker:28-dind', 'dockerd', '--host=unix:///var/run/docker.sock', '--host=tcp://127.0.0.1:2375', '--tls=false']);
    node.ip = checked(['inspect', node.daemon, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}']);
    const until = Date.now() + 40_000;
    while (cli(['exec', node.daemon, 'docker', 'info']).status !== 0) { assert.ok(Date.now() < until, 'Private daemon startup deadline'); await pause(250); }
    checked(['save', '-o', proof + '/fixtures-' + node.id + '.tar', 'busybox:1.36', 'traefik:v3.1']);
    checked(['cp', proof + '/fixtures-' + node.id + '.tar', node.daemon + ':/root/fixtures.tar']);
    inner(node.id, ['load', '-i', '/root/fixtures.tar']); inner(node.id, ['network', 'create', 'ninedeploy']);
  }
  const childAgent = 'nd-' + owner + '-child-agent'; runners.push(childAgent);
  checked(['run', '-d', '--name', childAgent, '--label', 'ninedeploy.proof=' + owner, '--network', 'container:' + nodes[1].daemon, '--user', '0', '--no-healthcheck',
    '-v', nodes[1].volume + ':' + home, '-v', resolve(proof, 'program.mjs') + ':/proof/program.mjs:ro', '-w', home, '-e', 'NODE_ENV=test',
    '-e', 'NINEDEPLOY_DATA_DIR=' + home + '/agent-data', '-e', 'DOCKER_HOST=tcp://127.0.0.1:2375', '-e', 'PROOF_MODE=child-agent', '--entrypoint', 'node', image, '/proof/program.mjs']);
  for (const name of ['web-9', 'web-9-r2', 'web-9-r3']) inner(4, ['create', '--name', name, '--network', 'ninedeploy', '--label', 'ninedeploy.managed=service',
    '--label', 'ninedeploy.service=1', '--label', 'ninedeploy.deployment=9', 'busybox:1.36', 'sh', '-c', 'mkdir -p /www; echo ready > /www/index.html; cp /www/index.html /www/ready; exec httpd -f -p 8080 -h /www']);
  inner(5, ['create', '--name', 'web-t5-7', '--network', 'ninedeploy', '--label', 'ninedeploy.managed=service', '--label', 'ninedeploy.service=1',
    '--label', 'ninedeploy.deployment=7', 'busybox:1.36', 'sh', '-c', 'mkdir -p /www; echo ready > /www/index.html; if [ ! -e /bad ]; then cp /www/index.html /www/ready; fi; exec httpd -f -p 8080 -h /www']);
  run('setup');
  for (const node of nodes) inner(node.id, ['run', '-d', '--name', 'ninedeploy-proxy', '--network', 'ninedeploy', '-p', '80:80', '-p', '443:443',
    '-v', home + '/.agent-proxy:/etc/traefik:ro', 'traefik:v3.1']);
  const start = run('start'); assert.equal(start.result.state, 'completed'); assert.equal(start.status, 'running');
  assert.deepEqual(states(), { primary: ['true', 'true', 'false'], child: 'true' });
  for (const id of [4, 5]) assert.equal(start.trace.filter(row => row.node === id && row.op === 'docker.readiness').length, 3);
  assert.deepEqual(start.trace.filter(row => row.op === 'routing-ack').map(row => row.node), [4, 5]);
  report('two-independent-daemons-start-only-after-both-readiness-and-routing-acknowledgements');
  const restart = run('restart'); assert.equal(restart.result.state, 'completed'); assert.deepEqual(states(), { primary: ['true', 'true', 'false'], child: 'true' });
  report('restart-withdraws-both-routes-before-stopping-and-republishes-both-generations');
  inner(5, ['exec', 'web-t5-7', 'sh', '-c', 'touch /bad; rm /www/ready']);
  run('stop');
  const unready = run('start'); assert.equal(unready.result.state, 'held'); assert.equal(unready.phase, 'readiness'); assert.equal(unready.status, 'stopped');
  assert.equal(unready.trace.some(row => row.op === 'routing-ack'), false);
  assert.equal(unready.trace.filter(row => row.node === 4 && row.op === 'docker.readiness').length, 3);
  inner(5, ['exec', 'web-t5-7', 'sh', '-c', 'rm /bad; cp /www/index.html /www/ready']);
  assert.equal(run('resume').result.state, 'completed');
  report('primary-ready-child-http-404-never-publishes-until-child-readiness-recovers');
  const offline = run('offline-stop'); assert.equal(offline.result.state, 'held'); assert.equal(offline.status, 'stopped');
  assert.deepEqual(states(), { primary: ['true', 'true', 'false'], child: 'true' });
  assert.equal(run('resume').result.state, 'completed'); assert.deepEqual(states(), { primary: ['false', 'false', 'false'], child: 'false' });
  report('offline-child-stop-remains-pending-and-recovers-the-original-command');
  const lost = run('lost-child'); assert.equal(lost.result.state, 'held'); assert.equal(lost.phase, 'applying');
  const replay = run('resume'); assert.equal(replay.result.state, 'completed'); assert.equal(replay.id, lost.id);
  assert.equal(replay.trace.some(row => row.op === 'docker.identity'), false);
  assert.deepEqual(replay.trace.filter(row => row.op === 'docker.lifecycle').map(row => [row.node, row.targets]), lost.trace.filter(row => row.op === 'docker.lifecycle').map(row => [row.node, row.targets]));
  report('lost-child-effect-replays-exact-immutable-identities-through-real-agent-journal');
  run('stop');
  const late = run('superseded-start'); assert.equal(late.result.state, 'superseded'); assert.ok(late.nextId > late.id);
  assert.equal(late.trace.some(row => row.op === 'routing-ack'), false); assert.equal(run('resume').result.state, 'completed');
  assert.deepEqual(states(), { primary: ['false', 'false', 'false'], child: 'false' });
  report('new-stop-supersedes-real-child-start-response-without-late-route-publication');
  const lostRoute = run('lost-route'); assert.equal(lostRoute.result.state, 'held'); assert.equal(lostRoute.phase, 'routing');
  const retryRoute = run('resume'); assert.equal(retryRoute.result.state, 'completed'); assert.equal(retryRoute.id, lostRoute.id);
  assert.equal(retryRoute.trace.some(row => row.op === 'docker.lifecycle'), false);
  for (const id of [4, 5]) assert.equal(retryRoute.trace.filter(row => row.node === id && row.op === 'docker.readiness').length, 3);
  report('lost-child-route-response-rechecks-both-nodes-without-replaying-start');
  run('stop');
  writeFileSync(proof + '/runtime-cases.json', JSON.stringify({ image, cases, realDocker: true, sealedHttp: true, realSqlite: true,
    independentDaemons: 2, realTraefikInstances: 2, publicLifecycleApi: false, retryBackoffElapsed: false }, null, 2));
} finally {
  for (const runner of runners) { const r = cli(['inspect', runner, '--format', '{{index .Config.Labels "ninedeploy.proof"}}']); if (r.status === 0) { assert.equal(r.stdout.trim(), owner); checked(['rm', '-fv', runner]); } }
  for (const node of nodes) {
    const d = cli(['inspect', node.daemon, '--format', '{{index .Config.Labels "ninedeploy.proof"}}']); if (d.status === 0) { assert.equal(d.stdout.trim(), owner); checked(['rm', '-fv', node.daemon]); }
    const v = cli(['volume', 'inspect', node.volume, '--format', '{{index .Labels "ninedeploy.proof"}}']); if (v.status === 0) { assert.equal(v.stdout.trim(), owner); checked(['volume', 'rm', node.volume]); }
  }
  const n = cli(['network', 'inspect', network, '--format', '{{index .Labels "ninedeploy.proof"}}']); if (n.status === 0) { assert.equal(n.stdout.trim(), owner); checked(['network', 'rm', network]); }
  writeFileSync(proof + '/runtime-cleanup.json', JSON.stringify({ owner, containers: checked(['ps', '-aq', '--filter', 'label=ninedeploy.proof=' + owner]),
    volumes: checked(['volume', 'ls', '-q', '--filter', 'label=ninedeploy.proof=' + owner]), networks: checked(['network', 'ls', '-q', '--filter', 'label=ninedeploy.proof=' + owner]) }, null, 2));
}
