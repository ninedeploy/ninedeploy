// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Standalone Docker acceptance, outside cached Turbo tasks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { removeOwnedSmokeResource } from './lib/owned-smoke-resources.mjs';

const starters = [
  { name: 'nextjs', port: 3000, marker: 'NineDeploy Next.js starter' },
  { name: 'laravel', port: 80, marker: 'NineDeploy Laravel starter' },
  { name: 'fastapi', port: 8000, marker: 'NineDeploy FastAPI starter' },
];
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const image = option('image');
assert.match(image ?? '', /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, 'Pass --image=<NineDeploy image>');
const output = resolve(option('proof') ?? '.temp_files/framework-starters');
mkdirSync(output, { recursive: true });
const proof = mkdtempSync(join(output, 'run-'));
const owner = randomBytes(16).toString('hex');
const prefix = `nd-n09-${owner.slice(0, 12)}`;
const label = `ninedeploy.proof=${owner}`;
const network = `${prefix}-net`;
const volume = `${prefix}-data`;
const daemon = `${prefix}-docker`;
const panel = `${prefix}-panel`;
const daemonImage = 'docker:28-dind';
const resources = [];
const receipt = { image, owner, starters: [], cleanup: false };
let origin;
let token;
let phase = 'fixture setup';

function command(file, args, timeout = 20_000) {
  return spawnSync(file, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 4 << 20, timeout });
}

const cli = (args, timeout) => command('docker', args, timeout);
function docker(args, timeout) {
  const result = cli(args, timeout);
  assert.equal(result.status, 0, `Docker ${args.slice(0, 2).join(' ')}: ${(result.stderr || result.error?.message || '').trim().slice(-1200)}`);
  return result.stdout.trim();
}

function run(name, args) {
  resources.push(['container', name]);
  docker(['run', '-d', '--name', name, '--label', label, '--network', network, ...args], 120_000);
}

async function until(read, description, timeout) {
  const deadline = performance.now() + timeout;
  do {
    const result = await read();
    if (result) return result;
    await pause(1000);
  } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

async function request(path, body) {
  const binary = Buffer.isBuffer(body);
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': binary ? 'application/gzip' : 'application/json' }),
    },
    body: binary ? body : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(`${path} returned HTTP ${response.status}${detail?.error?.code ? ` (${detail.error.code})` : ''}`);
  }
  return response;
}

async function api(path, body) {
  return (await request(path, body)).json();
}

// Use the real proxy listener with the route's Host header from the isolated bridge.
const probe = `const [host, hostname, path] = process.argv.slice(1);
const request = require('node:http').get({ host, path, headers: { Host: hostname } }, response => {
  response.setEncoding('utf8');
  let body = '';
  response.on('data', chunk => { body += chunk; });
  response.on('end', () => console.log(JSON.stringify({ status: response.statusCode, body })));
});
request.setTimeout(3000, () => request.destroy(new Error('Proxy probe timed out')));
request.on('error', () => { process.exitCode = 1; });`;

async function verifyRoute(hostname, path, matches) {
  return until(() => {
    const result = cli(['exec', panel, 'node', '-e', probe, daemon, hostname, path], 6_000);
    if (result.status !== 0) return false;
    const response = JSON.parse(result.stdout);
    return response.status === 200 && matches(response.body) && response;
  }, `${hostname}${path} to serve the starter`, 45_000);
}

async function deployStarter({ name, port, marker }) {
  const receiptRow = { framework: name };
  receipt.starters.push(receiptRow);
  const source = fileURLToPath(new URL(`../examples/${name}`, import.meta.url));
  const archive = join(proof, `${name}.tar.gz`);
  const excludes = ['.git', '.env', '.env.*', '.next', 'node_modules', 'vendor', '.venv', '__pycache__'];
  const packed = command('tar', ['-czf', archive, ...excludes.map(value => `--exclude=${value}`), '-C', source, '.']);
  assert.equal(packed.status, 0, (packed.stderr || packed.error?.message || '').trim());
  const service = await api('/v1/services', { name: `Starter ${name}`, type: 'docker' });
  const path = `/v1/services/${service.id}`;
  const started = performance.now();
  const upload = await api(`${path}/source`, readFileSync(archive));
  rmSync(archive);
  assert.ok(Number.isInteger(upload.deploymentId), 'Source upload must start a deployment');
  Object.assign(receiptRow, { serviceId: service.id, deploymentId: upload.deploymentId });
  console.log(`${name}: source accepted, deployment ${upload.deploymentId}`);

  let deploymentLog;
  try {
    await until(async () => {
      const deployments = await api(`${path}/deploys`);
      const deployment = deployments.find(row => row.id === upload.deploymentId);
      assert.ok(!['failed', 'cancelled'].includes(deployment?.status), `Deployment ${upload.deploymentId} ${deployment?.status}`);
      return deployment?.status === 'running' && deployment.finishedAt;
    }, `${name} deployment to finish`, 15 * 60_000);
    receiptRow.deployMs = Math.round(performance.now() - started);
  } finally {
    // Fixture sources and build settings are public. API credentials are never put in the build environment.
    deploymentLog = await request(`${path}/deploys/${upload.deploymentId}/logs/download`)
      .then(response => response.text()).catch(() => '');
    if (deploymentLog) writeFileSync(join(proof, `${name}.log`), deploymentLog);
  }

  const configured = await api(path);
  assert.equal(configured.port, port);
  // The manifest health path is effective for the deployment. Service settings keep their own value.
  assert.ok(deploymentLog.includes(`.ninedeploy runtime config: port=${port}, healthPath=/healthz`), 'Manifest runtime settings missing from deploy log');
  assert.ok(deploymentLog.includes('##[stage:HEALTHCHECK:success]'), 'No successful readiness probe in deploy log');
  const hostname = `${name}.starters.test`;
  await api(`${path}/domains`, { hostname, ssl: false });
  const home = await verifyRoute(hostname, '/', body => body.includes(marker));
  const health = await verifyRoute(hostname, '/healthz', body => JSON.parse(body).status === 'ok');
  Object.assign(receiptRow, { port, healthPath: '/healthz', hostname, homeStatus: home.status,
    healthStatus: health.status, marker, routedMs: Math.round(performance.now() - started) });
  console.log(`PASS ${name}: deployed in ${receiptRow.deployMs} ms, routed in ${receiptRow.routedMs} ms`);
}

try {
  const endpoint = process.env.DOCKER_CONTEXT || !process.env.DOCKER_HOST
    ? docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
    : process.env.DOCKER_HOST;
  assert.match(endpoint, /^(npipe|unix):\/\//, 'Use a local Docker Engine');
  assert.equal(docker(['info', '--format', '{{.OSType}}']), 'linux', 'The isolated fixture requires Linux containers');
  if (cli(['image', 'inspect', image]).status !== 0) docker(['pull', image], 180_000);
  const candidate = JSON.parse(docker(['image', 'inspect', image]))[0];
  receipt.imageId = candidate.Id;
  receipt.panelRevision = candidate.Config.Labels?.['org.opencontainers.image.revision'] ?? null;
  receipt.startedAt = new Date().toISOString();
  resources.push(['network', network]);
  docker(['network', 'create', '--label', label, network]);
  resources.push(['volume', volume]);
  docker(['volume', 'create', '--label', label, volume]);
  run(daemon, ['--privileged', '-v', `${volume}:/data`, daemonImage,
    'dockerd', '--host=tcp://0.0.0.0:2375', '--tls=false']);
  await until(() => cli(['exec', daemon, 'docker', '-H', 'tcp://127.0.0.1:2375', 'info'], 5_000).status === 0,
    'private Docker Engine', 60_000);
  const setupToken = randomBytes(24).toString('hex');
  run(panel, ['-p', '127.0.0.1::3000', '-v', `${volume}:/data`,
    '-e', `DOCKER_HOST=tcp://${daemon}:2375`,
    '-e', `NINEDEPLOY_JWT_SECRET=${randomBytes(32).toString('hex')}`,
    '-e', `NINEDEPLOY_MASTER_KEY=${randomBytes(32).toString('hex')}`,
    '-e', `NINEDEPLOY_SETUP_TOKEN=${setupToken}`, image]);
  const binding = docker(['port', panel, '3000/tcp']);
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  origin = `http://${binding}`;
  const health = await until(() => api('/health').then(result => result.status === 'ok' && result).catch(() => false),
    'panel health', 90_000);
  receipt.version = health.version;
  console.log(`Panel ${receipt.version} ready`);
  token = (await api('/v1/auth/register', { setupToken, name: 'Starter smoke operator',
    email: 'starters@example.test', password: randomBytes(24).toString('hex') })).tokens.accessToken;
  for (const starter of starters) {
    phase = starter.name;
    await deployStarter(starter);
  }
} catch (error) {
  receipt.failure = { phase, message: error.message };
  console.error(`${phase}: ${error.message}`);
  process.exitCode = 1;
} finally {
  for (const [kind, resource] of resources.reverse()) {
    removeOwnedSmokeResource(cli, kind, resource, owner, { removeAnonymousVolumes: true });
  }
  receipt.cleanup = [['ps', '-aq'], ['volume', 'ls', '-q'], ['network', 'ls', '-q']].every(args => {
    const result = cli([...args, '--filter', `label=${label}`]);
    return result.status === 0 && !result.stdout.trim();
  });
  if (!receipt.cleanup) {
    console.error(`Fixture cleanup failed for owner ${owner}`);
    process.exitCode = 1;
  }
  writeFileSync(join(proof, 'result.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`Receipt: ${proof}`);
}
