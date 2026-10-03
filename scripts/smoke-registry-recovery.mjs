import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { recoverImageDirectlyFromRegistry } from '../apps/server/dist/lib/dockerPull.js';

if (process.platform !== 'linux') {
  throw new Error('registry recovery smoke must run on Linux, matching the supported NineDeploy host');
}

const registry = JSON.parse(await readFile(new URL('../apps/server/src/templates/registry.json', import.meta.url), 'utf8'));
const requested = process.argv.find((arg) => arg.startsWith('--ids='))?.slice('--ids='.length).split(',').filter(Boolean);
const timeoutSeconds = Number(process.argv.find((arg) => arg.startsWith('--timeout='))?.slice('--timeout='.length) ?? 600);
const certified = registry.templates.filter((template) => template.runtimeVerified === true);
const selected = requested?.length ? certified.filter((template) => requested.includes(template.id)) : certified;
const missing = requested?.filter((id) => !selected.some((template) => template.id === id)) ?? [];
if (missing.length) throw new Error(`IDs are missing or not runtime-certified: ${missing.join(', ')}`);

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const network = `nd-recovery-smoke-${suffix}`;
const helperImage = `ninedeploy-smoke/busybox:${suffix}`;
const resources = { containers: [], volumes: [], images: [] };

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: options.quiet ? 'pipe' : 'inherit',
    timeout: options.timeout ?? 10 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} exited ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  }
  return result.stdout?.trim() ?? '';
}

function removeTracked(kind, value) {
  const entries = resources[kind];
  const index = entries.indexOf(value);
  if (index >= 0) entries.splice(index, 1);
}

function cleanupContainer(name) {
  try { docker(['rm', '-f', '-v', name], { quiet: true }); } catch { /* best effort */ }
  removeTracked('containers', name);
}

function cleanupVolume(name) {
  try { docker(['volume', 'rm', name], { quiet: true }); } catch { /* best effort */ }
  removeTracked('volumes', name);
}

function cleanupImage(name) {
  try { docker(['image', 'rm', '-f', name], { quiet: true }); } catch { /* best effort */ }
  removeTracked('images', name);
}

function cleanup() {
  for (const name of [...resources.containers].reverse()) cleanupContainer(name);
  for (const name of [...resources.volumes].reverse()) cleanupVolume(name);
  for (const name of [...resources.images].reverse()) cleanupImage(name);
  try { docker(['network', 'rm', network], { quiet: true }); } catch { /* best effort */ }
}

async function recover(source, target) {
  resources.images.push(target);
  await recoverImageDirectlyFromRegistry(source, (line) => process.stdout.write(`${line}\n`), target);
}

function createVolume(name) {
  docker(['volume', 'create', name], { quiet: true });
  resources.volumes.push(name);
}

async function waitUntil(label, probe, failureDetails = () => '') {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`${label} did not become ready within ${timeoutSeconds}s${failureDetails()}`);
}

async function startDatabase(template) {
  const password = randomBytes(24).toString('hex');
  const container = `nd-recovery-db-${template.id}-${suffix}`;
  const volume = `${container}-data`;
  const target = `ninedeploy-smoke/${template.id}-db:${suffix}`;
  const profile = template.dbEngine === 'mysql'
    ? {
        source: 'mysql:8.4', port: 3306, mount: '/var/lib/mysql',
        env: { MYSQL_ROOT_PASSWORD: password, MYSQL_DATABASE: 'app' },
        user: 'root',
        probe: ['mysqladmin', 'ping', '-h', '127.0.0.1', '-uroot', `-p${password}`, '--silent'],
      }
    : {
        source: 'postgres:16', port: 5432, mount: '/var/lib/postgresql/data',
        env: { POSTGRES_USER: 'nine', POSTGRES_PASSWORD: password, POSTGRES_DB: 'app' },
        user: 'nine',
        probe: ['pg_isready', '-h', '127.0.0.1', '-U', 'nine', '-d', 'app'],
      };

  await recover(profile.source, target);
  createVolume(volume);
  const args = ['run', '-d', '--name', container, '--network', network, '-v', `${volume}:${profile.mount}`];
  for (const [key, value] of Object.entries(profile.env)) args.push('-e', `${key}=${value}`);
  args.push(target);
  docker(args);
  resources.containers.push(container);
  await waitUntil(
    `${template.id} database`,
    () => spawnSync('docker', ['exec', container, ...profile.probe], { stdio: 'ignore' }).status === 0,
    () => `:\n${docker(['logs', '--tail', '100', container], { quiet: true })}`,
  );
  return { container, volume, target, password, port: profile.port, user: profile.user, database: 'app' };
}

function databaseEnv(template, database) {
  if (!database) return {};
  const values = {
    host: database.container,
    hostPort: `${database.container}:${database.port}`,
    port: String(database.port),
    database: database.database,
    username: database.user,
    password: database.password,
  };
  return Object.fromEntries(Object.entries(template.databaseEnv ?? {}).map(([key, source]) => [key, values[source]]));
}

try {
  docker(['network', 'create', network], { quiet: true });
  await recover('busybox:1.36', helperImage);

  for (const template of selected) {
    process.stdout.write(`\n=== ${template.id}: ${template.image} ===\n`);
    const appImage = `ninedeploy-smoke/${template.id}:${suffix}`;
    const appContainer = `nd-recovery-app-${template.id}-${suffix}`;
    const appVolume = template.volumeMount ? `${appContainer}-data` : undefined;
    const database = template.dbEngine ? await startDatabase(template) : undefined;
    await recover(template.image, appImage);
    if (appVolume) createVolume(appVolume);

    const args = ['run', '-d', '--name', appContainer, '--network', network];
    if (appVolume) args.push('-v', `${appVolume}:${template.volumeMount}`);
    const environment = {
      ...Object.fromEntries((template.env ?? []).map((entry) => [
        entry.key,
        entry.secret ? randomBytes(24).toString('hex') : entry.value,
      ])),
      ...databaseEnv(template, database),
    };
    for (const [key, value] of Object.entries(environment)) args.push('-e', `${key}=${value}`);
    args.push(appImage, ...(template.cmd ?? []));
    docker(args);
    resources.containers.push(appContainer);

    await waitUntil(
      template.id,
      () => {
        if (docker(['inspect', appContainer, '--format', '{{.State.Status}}'], { quiet: true }) !== 'running') return false;
        const ip = docker([
          'inspect', appContainer, '--format',
          `{{with index .NetworkSettings.Networks "${network}"}}{{.IPAddress}}{{end}}`,
        ], { quiet: true });
        if (!ip) return false;
        return spawnSync(
          'docker',
          ['run', '--rm', '--network', network, helperImage, 'nc', '-z', '-w', '3', ip, String(template.port)],
          { stdio: 'ignore', timeout: 15_000 },
        ).status === 0;
      },
      () => `:\n${docker(['logs', '--tail', '100', appContainer], { quiet: true })}`,
    );
    process.stdout.write(`PASS ${template.id}: direct registry recovery, container start, and ${template.port}/tcp probe\n`);

    cleanupContainer(appContainer);
    if (appVolume) cleanupVolume(appVolume);
    cleanupImage(appImage);
    if (database) {
      cleanupContainer(database.container);
      cleanupVolume(database.volume);
      cleanupImage(database.target);
    }
  }
  process.stdout.write(`\nPASS: all ${selected.length} runtime-certified Hub templates survived snapshotter-independent recovery\n`);
} finally {
  cleanup();
}
