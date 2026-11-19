// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Standalone Docker acceptance, outside cached Turbo tasks.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';
import { capacityChecks, limits, nearestRankP95, profile } from './lib/capacity-baseline.mjs';
import { faultChecks, faultProfiles, fullDiskProbe } from './lib/capacity-resilience.mjs';
import { removeOwnedSmokeResource } from './lib/owned-smoke-resources.mjs';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const image = option('image');
assert.match(image ?? '', /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, 'Pass --image=<local NineDeploy candidate>');
const scenario = option('scenario') ?? 'baseline';
assert.ok(scenario === 'baseline' || Object.hasOwn(faultProfiles, scenario), 'Use baseline, slow-node, full-disk, or log-outage');
const fault = faultProfiles[scenario];
const budgets = scenario === 'slow-node' ? { ...limits, deploymentWaitP95Ms: fault.deploymentWaitP95Ms } : limits;
const output = resolve(option('proof') ?? '.temp_files/n06-capacity');
mkdirSync(output, { recursive: true });
const proof = mkdtempSync(join(output, 'run-'));
const owner = randomBytes(16).toString('hex');
const prefix = `nd-n06-${owner.slice(0, 12)}`;
const label = `ninedeploy.proof=${owner}`;
const name = role => `${prefix}-${role}`;
const network = name('net');
const panel = name('panel');
const registry = name('registry');
const sink = name('sink');
const data = name('panel-data');
const workImage = 'nginx:1.27-alpine';
const privateImage = `${registry}:5000/n06/web:baseline`;
const fixtures = ['docker:28-dind', 'registry:2', workImage, 'traefik:3'];
const archive = join(proof, 'preload.tar');
const resources = [];
const receipt = { scenario, profile, limits: budgets, owner, image, cleanup: false,
  ...(fault ? { fault: { settings: fault } } : {}) };
const write = (file, value) => writeFileSync(join(proof, file), `${JSON.stringify(value, null, 2)}\n`);
const execAsync = promisify(execFile);
const options = timeout => ({ encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20, timeout });
const cli = (args, timeout = 90_000) => spawnSync('docker', args, options(timeout));
function docker(args, timeout) {
  const r = cli(args, timeout);
  if (r.status !== 0) throw new Error(`Docker ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.error?.message || '').trim().slice(-1500)}`);
  return r.stdout.trim();
}
const fixture = file => fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url));
const mount = (source, target) => ['--mount', `type=bind,src=${source},dst=${target},readonly`];
const bridge = ['--network', network];
function run(container, args, networkArgs = bridge) {
  resources.push(['container', container]);
  return docker(['run', '-d', '--name', container, '--label', label, ...networkArgs, ...args]);
}
function volume(value, options = []) {
  resources.push(['volume', value]);
  docker(['volume', 'create', '--label', label, ...options, value]);
}
async function exec(container, args) {
  const { stdout } = await execAsync('docker', ['exec', container, ...args], options(20_000));
  return stdout.trim();
}
const inner = (daemon, args) => exec(daemon, ['docker', ...args]);
const startDaemon = async (daemon, extra = []) => {
  const daemonId = run(daemon, ['--privileged', '-e', 'DOCKER_TLS_CERTDIR=', ...extra, fixtures[0], 'dockerd',
    '--host=unix:///var/run/docker.sock', '--host=tcp://0.0.0.0:2375', '--tls=false',
    '--insecure-registry', `${registry}:5000`]);
  await until(async () => cli(['exec', daemonId, 'docker', 'info'], 5_000).status === 0, `private daemon ${daemon}`, 40_000);
  const file = openSync(archive, 'r');
  try {
    const loaded = spawnSync('docker', ['exec', '-i', daemonId, 'docker', 'load'],
      { ...options(120_000), stdio: [file, 'pipe', 'pipe'] });
    assert.equal(loaded.status, 0, (loaded.stderr || loaded.error?.message || '').trim());
  } finally {
    closeSync(file);
  }
  return daemonId;
};
async function until(read, description, timeout, retryRequestErrors = false) {
  const deadline = performance.now() + timeout;
  let lastError;
  do {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      if (!retryRequestErrors) throw error;
      lastError = error;
    }
    await pause(250);
  } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

let base, token, panelId, daemonId, sinkId, relayId;
let phase = 'fixture setup';
const activatePort = () => {
  const binding = docker(['port', panelId, '3000/tcp']);
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  base = `http://${binding}`;
};
async function fetchApi(path, method = 'GET', body) {
  return fetch(base + path, {
    method, signal: AbortSignal.timeout(8_000), redirect: 'error',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body && JSON.stringify(body),
  });
}
async function api(path, method, body) {
  const response = await fetchApi(path, method, body);
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(`${method ?? 'GET'} ${path} returned HTTP ${response.status}${detail?.error?.code ? ` (${detail.error.code})` : ''}`);
  }
  return response.json();
}
const health = () => until(() => api('/health'), 'panel health', 40_000, true);
const inventory = () => api('/v1/services');
async function control(container, port, endpoint, method = 'GET') {
  const url = `http://127.0.0.1:${port}/${endpoint}`;
  const command = "fetch(process.argv[1],{method:process.argv[2],signal:AbortSignal.timeout(3000)}).then(async r=>{if(!r.ok)throw Error(r.status);console.log(await r.text())})";
  const raw = await exec(container, ['node', '-e', command, url, method]);
  return raw ? JSON.parse(raw) : null;
}
const fetchSink = () => control(sinkId, 8081, 'receipt');
const storage = async () => JSON.parse(await exec(panelId, ['node', '-e',
  "const fs=require('node:fs');const child=require('node:child_process');console.log(JSON.stringify({dbBytes:fs.statSync('/data/ninedeploy.db').size, volumeBytes:Number(child.execFileSync('du',['-sk','/data']).toString().trim().split(/\\s+/)[0])*1024}))"]));

function logBurst(runtime, start, count) {
  const code = 'i="$1"; end="$2"; while [ "$i" -lt "$end" ]; do printf "n06-load-%s\\n" "$i"; i=$((i+1)); done > /proc/1/fd/1';
  return inner(daemonId, ['exec', runtime, 'sh', '-ec', code, 'n06', String(start), String(start + count)]);
}
const enqueue = async serviceId => {
  const { deploymentId } = await api(`/v1/services/${serviceId}/deploys`, 'POST', {});
  assert.ok(Number.isSafeInteger(deploymentId));
  return { serviceId, deploymentId };
};
async function deployResults(pending, timeout) {
  const services = [...new Set(pending.map(item => item.serviceId))];
  const log = async ({ serviceId, deploymentId }) => {
    const response = await fetchApi(`/v1/services/${serviceId}/deploys/${deploymentId}/logs/download`);
    assert.equal(response.status, 200, `Could not read the proof for deployment ${deploymentId}`);
    return response.text();
  };
  return until(async () => {
    const lists = new Map(await Promise.all(services.map(async id => [id, await api(`/v1/services/${id}/deploys`)])));
    const rows = pending.map(({ serviceId, deploymentId }) => lists.get(serviceId).find(item => item.id === deploymentId));
    const failed = rows.find(row => row && ['failed', 'cancelled'].includes(row.status));
    if (failed) {
      writeFileSync(join(proof, `failed-deploy-${failed.id}.log`), await log(pending.find(item => item.deploymentId === failed.id)));
      throw new Error(`Fixture deployment ${failed.id} reached ${failed.status}`);
    }
    if (!rows.every(row => row?.finishedAt && ['running', 'superseded'].includes(row.status))) return false;
    // A later successful deployment supersedes the previous running row. A
    // terminal status alone does not prove the older row ever started serving.
    const logs = await Promise.all(pending.map(log));
    if (logs.some(text => !text.includes('##[stage:COMPLETE:success]'))) return false;
    return rows.map(row => ({ ...row, completionVerified: true }));
  }, 'fixture deployments', timeout);
}
function summarizeRoutes(samples) {
  return Object.fromEntries(profile.routes.map(route => {
    const matches = samples.filter(sample => sample.route === route);
    return [route, { count: matches.length, p95Ms: nearestRankP95(matches.map(sample => sample.durationMs)),
      failures: matches.filter(sample => sample.status !== 200).length }];
  }));
}
async function sample(route, scheduled) {
  const started = performance.now();
  let status;
  try {
    const response = await fetchApi(route);
    await response.arrayBuffer();
    status = response.status;
  } catch (error) {
    status = error.name;
  }
  return { route, status, durationMs: performance.now() - started, launchMs: Math.max(0, started - scheduled) };
}

function scheduledRequests(start, seconds) {
  return Array.from({ length: seconds * profile.requestsPerSecond }, (_, index) => {
    const deadline = start + index * 1000 / profile.requestsPerSecond;
    return pause(Math.max(0, deadline - performance.now()))
      .then(() => sample(profile.routes[index % profile.routes.length], deadline));
  });
}

try {
  console.log(`N06 evidence: ${proof}`);
  const contextEndpoint = () => docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  const endpoint = process.env.DOCKER_CONTEXT ? contextEndpoint() : process.env.DOCKER_HOST || contextEndpoint();
  assert.match(endpoint, /^(?:npipe:\/\/\/\/\.\/pipe\/[^/]+|unix:\/\/\/[^\r\n]+)$/, 'Use a local Docker Unix socket or named pipe');
  const engine = JSON.parse(docker(['info', '--format', '{{json .}}']));
  assert.equal(engine.OSType, 'linux');
  const inspect = ref => JSON.parse(docker(['image', 'inspect', ref]))[0];
  const images = Object.fromEntries([image, ...fixtures].map(ref => {
    const detail = inspect(ref);
    return [ref, { id: detail.Id, repoDigests: detail.RepoDigests, revision: detail.Config.Labels?.['org.opencontainers.image.revision'] }];
  }));
  receipt.environment = { node: process.version, driverPlatform: process.platform, driverCpu: cpus()[0]?.model,
    driverMemoryBytes: totalmem(), dockerVersion: engine.ServerVersion, dockerCpus: engine.NCPU, dockerMemoryBytes: engine.MemTotal, images };
  write('configuration.json', receipt);
  docker(['save', '-o', archive, workImage, 'traefik:3'], 120_000);
  resources.push(['network', network]);
  docker(['network', 'create', '--label', label, network]);
  volume(data, scenario === 'full-disk' ? ['--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs',
    '--opt', 'o=size=32m,mode=0700'] : []);
  run(registry, ['--no-healthcheck', fixtures[1]]);
  sinkId = run(sink, ['--no-healthcheck', ...mount(fixture('capacity-log-sink.mjs'), '/tmp/n06-sink.mjs'),
    '--entrypoint', 'node', image, '/tmp/n06-sink.mjs']);
  const panelDaemon = name('panel-docker');
  daemonId = await startDaemon(panelDaemon, ['-v', `${data}:/data`]);
  await until(async () => {
    const result = cli(['exec', daemonId, 'wget', '-qO-', '-T', '2', `http://${registry}:5000/v2/`], 5_000);
    return result.status === 0;
  }, 'private registry', 15_000);
  await inner(daemonId, ['tag', workImage, privateImage]);
  await inner(daemonId, ['push', privateImage]);
  const setupToken = randomBytes(24).toString('hex');
  panelId = run(panel, ['--user', '0', '-p', '127.0.0.1::3000', '-v', `${data}:/data`,
    '-e', `DOCKER_HOST=tcp://${panelDaemon}:2375`, '-e', 'NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1',
    '-e', 'NINEDEPLOY_DEPLOY_CONCURRENCY=1', '-e', 'NINEDEPLOY_NODE_SLEEP_AUTOMATION=off',
    '-e', `NINEDEPLOY_SETUP_TOKEN=${setupToken}`, '-e', `NINEDEPLOY_JWT_SECRET=${randomBytes(32).toString('hex')}`,
    ...mount(fixture('capacity-event-loop.mjs'), '/tmp/n06-probe.mjs'),
    ...(scenario === 'full-disk' ? mount(fixture('capacity-disk-pressure.mjs'), '/tmp/n06-disk.mjs') : []), image,
    'node', '--import', '/tmp/n06-probe.mjs', 'apps/server/dist/server.js']);
  activatePort();
  await health();
  token = (await api('/v1/auth/register', 'POST', { setupToken, name: 'Capacity operator',
    email: 'capacity@example.test', password: randomBytes(24).toString('hex') })).tokens.accessToken;

  phase = 'node enrollment';
  const placements = [null];
  for (let index = 0; index < profile.nodes; index++) {
    const agent = name(`agent-${index}`);
    const nodeDaemon = name(`node-${index}-docker`);
    const agentData = name(`agent-${index}-data`);
    const agentHome = '/var/lib/ninedeploy-agent';
    volume(agentData);
    const nodeId = await startDaemon(nodeDaemon, ['-v', `${agentData}:${agentHome}`]);
    const host = docker(['inspect', nodeId, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}']);
    const delayedNode = scenario === 'slow-node' && index === 0;
    if (delayedNode) {
      relayId = run(name('relay'), ['--no-healthcheck', ...mount(fixture('capacity-agent-relay.mjs'), '/tmp/n06-relay.mjs'),
        '--entrypoint', 'node', image, '/tmp/n06-relay.mjs', String(fault.delayMs)],
      ['--network', `container:${nodeId}`]);
    }
    const registered = await api('/v1/servers', 'POST', { name: `Capacity node ${index + 1}`, host, port: delayedNode ? 4601 : 4600 });
    assert.match(registered.tokenSha256, /^[a-f0-9]{64}$/);
    run(agent, ['--user', '0', '-w', agentHome, '-v', `${agentData}:${agentHome}`,
      '-e', 'DOCKER_HOST=tcp://127.0.0.1:2375', '-e', 'NINEDEPLOY_AGENT=1',
      '-e', `NINEDEPLOY_AGENT_TOKEN=${registered.tokenSha256}`, image, 'node', '/app/apps/server/dist/agent.js'],
    ['--network', `container:${nodeId}`]);
    await until(async () => (await api(`/v1/servers/${registered.id}/test`, 'POST')).ok, 'sealed agent handshake', 30_000, true);
    placements.push(registered.id);
  }
  const nodes = await api('/v1/servers');
  assert.equal(nodes.length, profile.nodes);
  assert.ok(nodes.every(node => node.status === 'online' && node.agent?.capabilities.includes('docker.readiness')));

  phase = 'service and drain setup';
  const ids = [];
  for (let index = 0; index < profile.services; index++) {
    const placement = placements[index === 0 ? 0 : (index - 1) % placements.length];
    const service = await api('/v1/services', 'POST', { name: `Capacity service ${index + 1}`, type: 'docker',
      image: privateImage, port: 80, ...(placement == null ? {} : { serverId: placement }) });
    assert.ok(Number.isSafeInteger(service.id));
    ids.push(service.id);
  }
  await deployResults(await Promise.all(ids.slice(0, 4).map(enqueue)), 150_000);
  const logService = await api(`/v1/services/${ids[0]}`);
  assert.match(logService.runtimeId, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
  const drain = await api('/v1/log-drains', 'POST', { name: 'Capacity log sink', type: 'http',
    url: `http://${sink}:8080/logs`, serviceId: ids[0] });
  const queue = () => api(`/v1/log-drains/${drain.id}/queue`);
  await pause(11_000);
  await inner(daemonId, ['exec', logService.runtimeId, 'sh', '-ec', 'echo n06-warm > /proc/1/fd/1']);
  await until(async () => (await fetchSink()).warm >= 1, 'first delivered container log', 30_000);
  const warmup = await Promise.all(scheduledRequests(performance.now(), profile.warmupSeconds));
  assert.ok(warmup.every(item => item.status === 200), 'Warmup HTTP requests must succeed');
  assert.equal((await queue()).pendingEntries, 0);
  const before = await storage();

  phase = 'steady workload';
  const nodeProbe = async () => {
    const started = performance.now();
    assert.ok((await api(`/v1/servers/${placements[1]}/test`, 'POST')).ok);
    return performance.now() - started;
  };
  if (scenario === 'slow-node') {
    receipt.fault.cleanProbeMs = await nodeProbe();
    assert.ok((await control(relayId, 4602, 'slow', 'POST')).slow);
  }
  if (scenario === 'log-outage') {
    await control(sinkId, 8081, 'offline', 'POST');
    const target = `http://${sink}:8080/logs`;
    const independent = "fetch(process.argv[1],{signal:AbortSignal.timeout(3000)}).then(()=>console.log('reachable'),e=>console.log(e.cause?.code||e.name))";
    receipt.fault.offlineConnectionRefused = (await exec(panelId, ['node', '-e', independent, target])) === 'ECONNREFUSED';
  }
  console.log(`Fixture ready. Running ${profile.steadySeconds} seconds of scheduled load (${scenario}).`);
  const startedAt = Date.now();
  const start = performance.now();
  const backlog = [];
  const timed = (offset, operation) => pause(Math.max(0, start + offset - performance.now())).then(operation);
  const requests = scheduledRequests(start, profile.steadySeconds);
  const queued = profile.deploymentBursts.map(second => timed(second * 1000, () => Promise.all(ids.slice(1, 4).map(enqueue))));
  const logs = profile.logBursts.map((second, index) =>
    timed(second * 1000, () => logBurst(logService.runtimeId, index * profile.linesPerBurst, profile.linesPerBurst)));
  const observations = Array.from({ length: profile.steadySeconds / 2 }, (_, index) => timed(index * 2000, async () => {
    backlog.push({ at: Date.now(), ...await queue() });
  }));
  const injection = [];
  if (scenario === 'slow-node') injection.push(timed(12_000, async () => { receipt.fault.slowProbeMs = await nodeProbe(); }));
  if (scenario === 'full-disk') injection.push(timed(fault.startSecond * 1000, () => fullDiskProbe({
    disk: async action => JSON.parse(await exec(panelId, ['node', '/tmp/n06-disk.mjs', action])),
    inventory,
    call: async (action, value) => {
      const response = action === 'create'
        ? await fetchApi('/v1/services', 'POST', { name: value, type: 'docker', image: privateImage, port: 80 })
        : await fetchApi(`/v1/services/${value}`, 'DELETE');
      return { status: response.status, body: await response.json().catch(() => null) };
    },
  }, receipt.fault)));
  const outcomes = await Promise.allSettled([Promise.all(requests), Promise.all(queued), Promise.all(logs),
    Promise.all(observations), pause(profile.steadySeconds * 1000), ...injection]);
  const rejected = outcomes.find(outcome => outcome.status === 'rejected');
  if (rejected) throw rejected.reason;
  const [requestOutcome, queueOutcome] = outcomes;
  const samples = requestOutcome.value;
  const deploymentIds = queueOutcome.value.flat();
  const endedAt = startedAt + profile.steadySeconds * 1000;
  write('http.json', samples);
  write('backlog.json', backlog);
  if (scenario === 'slow-node') {
    const relay = await control(relayId, 4602, 'normal', 'POST');
    assert.equal(relay.slow, false);
    receipt.fault.delayedChunks = relay.delayedChunks;
    receipt.fault.forwardedBytes = relay.forwardedBytes;
    receipt.fault.recoveryMs = await nodeProbe();
  }
  let logRestoredAt;
  if (scenario === 'log-outage') {
    receipt.fault.pendingBeforeRestore = (await queue()).pendingEntries;
    receipt.fault.deliveredBeforeRestore = Object.keys(await fetchSink()).filter(key => key.startsWith('load-')).length;
    await control(sinkId, 8081, 'online', 'POST');
    logRestoredAt = performance.now();
  }
  const loop = (await exec(panelId, ['cat', '/tmp/n06-event-loop.ndjson'])).split(/\r?\n/).map(line => JSON.parse(line))
    .filter(window => window.at >= startedAt + 1000 && window.at <= endedAt && window.count > 0);
  write('event-loop.json', loop);
  const expectedLogs = profile.logBursts.length * profile.linesPerBurst;
  const delivery = until(async () => {
    const status = await queue();
    const counts = await fetchSink();
    if (status.pendingEntries !== 0 || Object.keys(counts).filter(key => key.startsWith('load-')).length < expectedLogs) return false;
    if (logRestoredAt !== undefined) receipt.fault.recoveryMs = performance.now() - logRestoredAt;
    return { status, counts };
  }, 'log delivery and empty queue', scenario === 'log-outage' ? fault.recoveryMs : profile.settleMs)
    .catch(async () => ({ status: await queue(), counts: await fetchSink() }));
  const [drained, deployed] = await Promise.allSettled([delivery, deployResults(deploymentIds, profile.settleMs)]);
  if (drained.status === 'rejected') throw drained.reason;
  const deliveryDone = drained.value;
  write('delivery.json', deliveryDone);
  if (deployed.status === 'rejected') throw deployed.reason;
  const deploys = deployed.value;
  write('deployments.json', deploys);
  const after = await storage();

  phase = 'controlled restart';
  console.log('Measuring controlled restart after the load settles.');
  const restartAt = performance.now();
  await execAsync('docker', ['restart', '--time', '8', panelId], options(30_000));
  activatePort();
  await health();
  const restoredServices = await inventory();
  const serviceRows = Array.isArray(restoredServices) ? restoredServices : restoredServices.services;
  assert.deepEqual(serviceRows.map(row => row.id).toSorted((a, b) => a - b), ids);
  const restoredNodes = await api('/v1/servers');
  assert.deepEqual(restoredNodes.map(row => row.id).toSorted((a, b) => a - b), placements.slice(1));
  assert.equal((await queue()).pendingEntries, deliveryDone.status.pendingEntries);
  const panelRestartMs = performance.now() - restartAt;
  const panelLogs = await execAsync('docker', ['logs', '--since', new Date(startedAt).toISOString(), panelId], options(30_000));
  const logLines = (panelLogs.stdout + panelLogs.stderr).split(/\r?\n/);
  const sqliteBusyLines = logLines
    .filter(line => /SQLITE_BUSY|database (?:table )?is locked|database is busy/i.test(line)).length;
  if (scenario === 'full-disk') receipt.fault.sqliteFullLines = logLines.filter(line => /SQLITE_FULL|database or disk is full/i.test(line)).length;
  const expectedIds = Array.from({ length: expectedLogs }, (_, index) => deliveryDone.counts[`load-${index}`] ?? 0);
  receipt.storage = { before, after };
  receipt.metrics = {
    routes: summarizeRoutes(samples),
    requestFailures: samples.filter(item => item.status !== 200).length,
    launchP95Ms: nearestRankP95(samples.map(item => item.launchMs)),
    panelLoopWindows: loop.length,
    panelLoopWindowP95Ms: loop.length ? Math.max(...loop.map(item => item.p95Ms)) : null,
    sqliteBusyLines,
    storageGrowthBytes: Math.max(0, after.volumeBytes - before.volumeBytes),
    deploymentsCompleted: deploys.length,
    deploymentWaitP95Ms: nearestRankP95(deploys.map(row => Date.parse(row.startedAt) - Date.parse(row.createdAt))),
    logPendingEntries: Math.max(...backlog.map(item => item.pendingEntries)),
    logFinalPendingEntries: deliveryDone.status.pendingEntries,
    logMissingLines: expectedIds.filter(count => count === 0).length,
    logDuplicateLines: expectedIds.reduce((sum, count) => sum + Math.max(0, count - 1), 0),
    panelRestartMs,
  };
  receipt.checks = [...capacityChecks(receipt.metrics, budgets), ...faultChecks(scenario, receipt.fault)];
  for (const check of receipt.checks) console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}: ${check.value} (threshold ${check.limit})`);
  if (!receipt.checks.every(check => check.passed)) process.exitCode = 1;
} catch (error) {
  receipt.failure = { phase, message: error.message };
  console.error(`${phase}: ${error.message}`);
  process.exitCode = 1;
} finally {
  for (const [kind, resource] of resources.reverse()) {
    removeOwnedSmokeResource(cli, kind, resource, owner, { removeAnonymousVolumes: true });
  }
  receipt.cleanup = [['ps', '-aq'], ['volume', 'ls', '-q'], ['network', 'ls', '-q']].every(args => {
    const r = cli([...args, '--filter', `label=${label}`]);
    return r.status === 0 && !r.stdout.trim();
  });
  if (!receipt.cleanup) process.exitCode = 1;
  rmSync(archive, { force: true });
  write('result.json', receipt);
}
