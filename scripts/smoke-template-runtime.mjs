import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const registry = JSON.parse(await readFile(new URL('../apps/server/src/templates/registry.json', import.meta.url), 'utf8'));

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const has = (name) => args.includes(`--${name}`);
const requested = opt('ids', '').split(',').filter(Boolean);
const timeoutSeconds = Number(opt('timeout', 300));
const outPath = opt('out', null);
const all = has('all');
if (!all && requested.length === 0) {
  process.stderr.write('Usage: node scripts/smoke-template-runtime.mjs --all | --ids=n8n,gitea [--timeout=300] [--out=results.json]\n');
  process.exit(2);
}

const byId = new Map(registry.templates.map((template) => [template.id, template]));
const ids = all ? registry.templates.map((template) => template.id) : requested;
const unknown = ids.filter((id) => !byId.has(id));
if (unknown.length > 0) throw new Error(`Unknown template IDs: ${unknown.join(', ')}`);

// Profile per template — every catalog entry must be runnable by exactly one:
// plain   single image, env + volume, probe the template port
// socket  plain + read-only docker.sock mount (portainer/dozzle/dockge/…)
// db      attach a throwaway managed database (ENGINES contract: user/db per
//         engine, network alias `db`) and resolve template.databaseEnv exactly
//         like engine/pipeline.ts does at deploy time
// compose materialise composeContent + generated SERVICE_* env, `compose up`,
//         probe the routed service port, `down -v`
function profileOf(template) {
  if (template.composeContent) return 'compose';
  if (template.dbEngine) return 'db';
  if (template.dockerSocket) return 'socket';
  return 'plain';
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function randomString(length) {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += ALNUM[b % ALNUM.length];
  return out;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const network = `nd-template-smoke-${suffix}`;
const createdContainers = [];
const createdVolumes = [];
const composeProjects = [];
const results = [];

async function docker(dockerArgs, options = {}) {
  return exec('docker', dockerArgs, { timeout: options.timeout ?? 120_000, maxBuffer: 4 * 1024 * 1024 });
}

async function cleanup() {
  for (const project of composeProjects.splice(0).reverse()) {
    await docker(['compose', '-p', project, 'down', '-v', '--remove-orphans', '--timeout', '10']).catch(() => undefined);
  }
  for (const container of createdContainers.reverse()) {
    await docker(['rm', '-f', container]).catch(() => undefined);
  }
  for (const volume of createdVolumes.reverse()) {
    await docker(['volume', 'rm', volume]).catch(() => undefined);
  }
  await docker(['network', 'rm', network]).catch(() => undefined);
}

async function pullIfNeeded(image) {
  const cached = await docker(['image', 'inspect', image]).then(() => true).catch(() => false);
  if (cached) return 'cached';
  await docker(['pull', image], { timeout: 900_000 });
  return 'pulled';
}

async function probePort(probeNetwork, ip, port) {
  return docker(['run', '--rm', '--network', probeNetwork, 'busybox:1.36', 'nc', '-z', '-w', '3', ip, String(port)], { timeout: 15_000 })
    .then(() => true).catch(() => false);
}

/** Wait for `running` + listening on template.port; throws with tail logs. */
async function waitListening(template, container, probeNetwork) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const { stdout: state } = await docker(['inspect', container, '--format', '{{.State.Status}}']);
    if (state.trim() !== 'running') {
      const { stdout: logs } = await docker(['logs', '--tail', '100', container]).catch(() => ({ stdout: '' }));
      throw new Error(`exited before readiness (${state.trim()}):\n${logs}`);
    }
    const { stdout: ip } = await docker(
      ['inspect', container, '--format', `{{with index .NetworkSettings.Networks "${probeNetwork}"}}{{.IPAddress}}{{end}}`],
    );
    if (ip.trim() && await probePort(probeNetwork, ip.trim(), template.port)) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const { stdout: logs } = await docker(['logs', '--tail', '100', container]).catch(() => ({ stdout: '' }));
  throw new Error(`did not listen on port ${template.port} within ${timeoutSeconds}s:\n${logs}`);
}

function envArgs(template) {
  const out = [];
  for (const entry of template.env ?? []) {
    out.push('-e', `${entry.key}=${entry.secret ? randomBytes(24).toString('hex') : entry.value}`);
  }
  return out;
}

async function runPlainLike(template, container) {
  const runArgs = ['run', '-d', '--name', container, '--network', network, '--restart', 'no'];
  if (template.volumeMount) {
    const volume = `${container}-data`;
    await docker(['volume', 'create', volume]);
    createdVolumes.push(volume);
    runArgs.push('-v', `${volume}:${template.volumeMount}`);
  }
  runArgs.push(...envArgs(template));
  if (template.dockerSocket) runArgs.push('-v', '/var/run/docker.sock:/var/run/docker.sock:ro');
  runArgs.push(template.image, ...(template.cmd ?? []));
  await docker(runArgs, { timeout: 120_000 });
  await waitListening(template, container, network);
}

/** Mirror of ENGINES defaults (engine/database.ts) — same images, users, db names. */
async function startManagedDatabase(template, password) {
  const postgres = template.dbEngine === 'postgres';
  const image = postgres ? 'postgres:18' : 'mysql:9.7';
  await pullIfNeeded(image);
  const container = `nd-smoke-${template.id}-db-${suffix}`.replace(/[^a-z0-9_.-]/g, '-');
  createdContainers.push(container);
  const env = postgres
    ? ['POSTGRES_USER=nine', `POSTGRES_PASSWORD=${password}`, 'POSTGRES_DB=app']
    : [`MYSQL_ROOT_PASSWORD=${password}`, 'MYSQL_DATABASE=app'];
  await docker(['run', '-d', '--name', container, '--network', network, '--network-alias', 'db', '--restart', 'no',
    ...env.map((e) => ['-e', e]).flat(), image], { timeout: 120_000 });
  const ready = postgres ? ['exec', container, 'pg_isready', '-U', 'nine'] : ['exec', container, 'mysqladmin', 'ping', '-uroot', `-p${password}`];
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await docker(ready).then(() => true).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`managed ${template.dbEngine} database did not become ready in 180s`);
}

/** Same mapping engine/pipeline.ts bakes at deploy time for databaseEnv rows. */
function resolveDatabaseEnv(template, password) {
  const postgres = template.dbEngine === 'postgres';
  const port = postgres ? 5432 : 3306;
  const values = {
    url: postgres ? `postgres://nine:${password}@db:${port}/app` : `mysql://root:${password}@db:${port}/app`,
    host: 'db',
    hostPort: `db:${port}`,
    port: String(port),
    username: postgres ? 'nine' : 'root',
    password,
    database: 'app',
  };
  return Object.entries(template.databaseEnv ?? {}).flatMap(([key, source]) => ['-e', `${key}=${values[source] ?? ''}`]);
}

async function runDbTemplate(template, container) {
  const password = randomString(24);
  await pullIfNeeded(template.image);
  await startManagedDatabase(template, password);
  const runArgs = ['run', '-d', '--name', container, '--network', network, '--restart', 'no'];
  if (template.volumeMount) {
    const volume = `${container}-data`;
    await docker(['volume', 'create', volume]);
    createdVolumes.push(volume);
    runArgs.push('-v', `${volume}:${template.volumeMount}`);
  }
  runArgs.push(...envArgs(template), ...resolveDatabaseEnv(template, password), template.image, ...(template.cmd ?? []));
  await docker(runArgs, { timeout: 120_000 });
  await waitListening(template, container, network);
}

/** Same interpolation semantics as engine/magicVars.ts: SERVICE_* tokens get
 *  generated values, everything else is left to compose (defaults apply). */
async function runComposeTemplate(template, project, workDir) {
  const composeFile = join(workDir, 'docker-compose.yml');
  await writeFile(composeFile, template.composeContent, { mode: 0o600 });
  const tokens = [...new Set([...template.composeContent.matchAll(/\bSERVICE_[A-Z0-9_]+\b/g)].map((m) => m[0]))].sort();
  await writeFile(join(workDir, '.env'), tokens.map((t) => `${t}=${randomString(32)}`).join('\n'), { mode: 0o600 });
  await docker(['compose', '-p', project, '-f', composeFile, 'up', '-d', '--quiet-pull'], { timeout: 600_000 });
  const { stdout: net } = await docker(['network', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}']);
  const probeNetwork = net.trim().split('\n')[0];
  if (!probeNetwork) throw new Error('compose project network not found after up');
  const { stdout: cid } = await docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`, '--filter', `label=com.docker.compose.service=${template.composeService}`]);
  const container = cid.trim().split('\n')[0];
  if (!container) throw new Error(`routed service '${template.composeService}' is not running after up`);
  await waitListening(template, container, probeNetwork);
}

await docker(['pull', 'busybox:1.36'], { timeout: 300_000 }).catch(async () => {
  const cached = await docker(['image', 'inspect', 'busybox:1.36']).then(() => true).catch(() => false);
  if (!cached) throw new Error('busybox:1.36 unavailable — needed for port probes');
});

let done = 0;
try {
  await docker(['network', 'create', network]);
  const workDir = await mkdtemp(join(tmpdir(), 'nd-smoke-'));
  for (const id of ids) {
    const template = byId.get(id);
    const profile = profileOf(template);
    const started = Date.now();
    done += 1;
    const prefix = `[${String(done).padStart(3, '0')}/${ids.length}] ${id} (${profile})`;
    try {
      if (profile === 'compose') {
        const project = `ndsmoke${suffix}${done}`;
        composeProjects.push(project);
        await pullIfNeeded(template.image);
        await runComposeTemplate(template, project, workDir);
        composeProjects.splice(composeProjects.indexOf(project), 1);
        await docker(['compose', '-p', project, 'down', '-v', '--remove-orphans', '--timeout', '10']).catch(() => undefined);
      } else if (profile === 'db') {
        const container = `nd-smoke-${id.replace(/[^a-z0-9_.-]/g, '-')}-${suffix}`;
        createdContainers.push(container);
        await runDbTemplate(template, container);
        createdContainers.splice(createdContainers.indexOf(container), 1);
        await docker(['rm', '-f', container]).catch(() => undefined);
        const dbContainer = createdContainers.pop();
        if (dbContainer) await docker(['rm', '-f', dbContainer]).catch(() => undefined);
      } else {
        const container = `nd-smoke-${id.replace(/[^a-z0-9_.-]/g, '-')}-${suffix}`;
        createdContainers.push(container);
        await pullIfNeeded(template.image);
        await runPlainLike(template, container);
        createdContainers.splice(createdContainers.indexOf(container), 1);
        await docker(['rm', '-f', container]).catch(() => undefined);
      }
      const seconds = Math.round((Date.now() - started) / 1000);
      results.push({ id, profile, ok: true, seconds });
      process.stdout.write(`PASS ${prefix} ${seconds}s\n`);
    } catch (error) {
      const seconds = Math.round((Date.now() - started) / 1000);
      const message = String(error instanceof Error ? error.message : error).split('\n').slice(0, 25).join('\n');
      results.push({ id, profile, ok: false, seconds, error: message });
      process.stdout.write(`FAIL ${prefix} ${seconds}s\n  ${message.split('\n')[0]}\n`);
    }
  }
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n== ${results.length - failed.length}/${results.length} passed (${failed.length} failed) ==\n`);
for (const failure of failed) process.stdout.write(`FAIL ${failure.id} (${failure.profile}): ${failure.error.split('\n')[0]}\n`);
if (outPath) {
  await writeFile(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), registryVersion: registry.version, results }, null, 2));
  process.stdout.write(`results written to ${outPath}\n`);
}
if (failed.length > 0) process.exit(1);
