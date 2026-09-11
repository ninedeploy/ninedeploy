import { buildAgentApp } from './agentApp.js';
import { tokenMatches } from './lib/agentClient.js';
import { open as openSealed, seal as sealResponse } from './lib/agentSeal.js';
import { spawnValidated } from './lib/spawnValidated.js';
import { pullDockerImage } from './lib/dockerPull.js';

/**
 * Agent mode (NINEDEPLOY_AGENT=1): a minimal HTTP surface for the core to run
 * DEPLOY OPERATIONS on this host. The request never carries a program name or
 * a raw argv — it names a typed operation from the fixed table below, and the
 * argv is constructed from literal flags plus strictly-validated operands
 * (identifier-like strings, image refs, paths without traversal). Actual
 * process spawning happens exclusively through lib/spawnValidated.ts (one
 * auditable choke point over the two fixed executables).
 */

// ── operand validators ────────────────────────────────────────────────────
const RE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/; // container/volume/project names, slugs
const RE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9@:/._-]*$/; // image refs incl. digests, registries
const RE_PATH_RAW = /^[A-Za-z0-9@._][A-Za-z0-9@._/-]*$|^\/[A-Za-z0-9@._/-]*$/; // relative or absolute
/** Path validator: rejects any `..` segment so operands can never traverse up. */
const RE_PATH = (value: string): boolean => RE_PATH_RAW.test(value) && !value.split('/').includes('..');
const RE_SHA = /^(HEAD|[0-9a-f]{6,64})$/;
const RE_REF = /^[A-Za-z0-9@:/._][A-Za-z0-9@:/._-]*$/; // branches, tags, URLs — first char must not be `-` (git reads a dash-leading argv element as an option)
/**
 * Repository URL for a clone: RE_REF's charset AND a network scheme (r099).
 * RE_REF alone accepted `file:///etc` or a bare local path — the agent must not
 * rely on the panel's schema to keep a clone off the node's own filesystem.
 */
const isRepoUrl = (value: string): boolean =>
  RE_REF.test(value) && /^(?:https?:\/\/|ssh:\/\/|git:\/\/|git@[A-Za-z0-9.-]+:)/.test(value);
/**
 * `-c` flags for every network git op on the node (r099): no HTTP redirects
 * (a public host bouncing to the node's metadata service / LAN), no `file://`
 * or `ext::` transports.
 */
const GIT_EGRESS_FLAGS = ['-c', 'http.followRedirects=false', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never'];

type Params = Record<string, unknown>;

const str = (p: Params, k: string): string | undefined => (typeof p[k] === 'string' ? (p[k] as string) : undefined);

function validated(value: string | undefined, check: RegExp | ((v: string) => boolean), what: string): string {
  if (value === undefined || !(typeof check === 'function' ? check(value) : check.test(value))) throw new Error(`Invalid ${what}`);
  return value;
}

/**
 * Root every remote service checkout and build context lives under, relative
 * to the agent's working directory.
 *
 * Git has no per-invocation repository operand — `fetch`, `checkout`, `reset`
 * and `rev-parse` all act on the process's cwd. Before this existed the agent
 * ran every git op in its OWN cwd, so a host could hold exactly one checkout
 * and two remote services would overwrite each other's source tree. Each
 * service now gets `<WORK_DIR>/<name>/`.
 */
const WORK_DIR = '.agent-work';

/**
 * Resolve (and create) one service's workspace, refusing anything that would
 * land outside `WORK_DIR`.
 *
 * `RE_NAME` already forbids `/` and any leading dot, so a traversal cannot be
 * spelled — the containment assertion is defence in depth on the one path that
 * becomes a child process's cwd.
 */
export async function resolveWorkspace(name: string): Promise<string> {
  const { mkdirSync } = await import('node:fs');
  const pathmod = await import('node:path');
  const safe = validated(name, RE_NAME, 'workspace name');
  const root = pathmod.resolve(process.cwd(), WORK_DIR);
  const dir = pathmod.resolve(root, safe);
  if (dir !== root && !dir.startsWith(root + pathmod.sep)) {
    throw new Error('Invalid workspace name');
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** `host:container` publish operand, numeric on both sides. */
function publishArgs(p: Params): string[] {
  const spec = str(p, 'publish');
  if (spec === undefined) return [];
  const m = /^(\d{1,5}):(\d{1,5})$/.exec(spec);
  if (!m) throw new Error('Invalid publish spec');
  const [host, container] = [Number(m[1]), Number(m[2])];
  if (host < 1 || host > 65535 || container < 1 || container > 65535) throw new Error('Invalid publish spec');
  return ['-p', `${host}:${container}`];
}

/**
 * `compose -p <project> -f <file> [-f <override>]` — the shared prefix of every
 * compose operation. The optional override file carries the panel's volume
 * attachments; compose merges `-f` left to right, so it wins on duplicate keys.
 */
function composeStackArgs(p: Params): string[] {
  const argv = [
    'compose',
    '-p', validated(str(p, 'project'), RE_NAME, 'project'),
    '-f', validated(str(p, 'file'), RE_PATH, 'compose file'),
  ];
  const override = str(p, 'override');
  if (override !== undefined) argv.push('-f', validated(override, RE_PATH, 'compose override file'));
  return argv;
}

/** Typed operation table: op name → executable + argv template builder. */
type Op = (p: Params) => string[];

const OPS: Record<string, { exe: 'docker' | 'git'; build: Op }> = {
  'docker.pull': { exe: 'docker', build: (p) => ['pull', validated(str(p, 'image'), RE_IMAGE, 'image')] },
  'docker.build': {
    exe: 'docker',
    build: (p) => [
      'build', '-t', validated(str(p, 'tag'), RE_IMAGE, 'tag'),
      '-f', validated(str(p, 'dockerfile'), RE_PATH, 'dockerfile'),
      validated(str(p, 'context'), RE_PATH, 'context'),
    ],
  },
  'docker.run': {
    exe: 'docker',
    build: (p) => {
      const argv = ['run', '-d', '--name', validated(str(p, 'name'), RE_NAME, 'name'), '--restart', 'unless-stopped', '--network', 'ninedeploy'];
      const cpu = str(p, 'cpuShares');
      if (cpu !== undefined) argv.push('--cpu-shares', /^\d{1,6}$/.test(cpu) ? cpu : '0');
      const mem = str(p, 'memLimitMb');
      if (mem !== undefined) argv.push('--memory', `${/^\d{1,6}$/.test(mem) ? mem : '0'}m`);
      const vol = str(p, 'volume');
      if (vol !== undefined) argv.push('-v', `${validated(vol, RE_NAME, 'volume name')}:${validated(str(p, 'mount') ?? '/', RE_PATH, 'mount path')}`);
      argv.push(...publishArgs(p));
      argv.push(validated(str(p, 'image'), RE_IMAGE, 'image'));
      return argv;
    },
  },
  'docker.runEnv': {
    // Like docker.run but with environment variables: the agent writes them to
    // a 0600 temp env-file locally (values never touch argv) and mounts it via
    // --env-file, deleting the file afterwards.
    exe: 'docker',
    build: (p) => {
      const argv = ['run', '-d', '--name', validated(str(p, 'name'), RE_NAME, 'name'), '--restart', 'unless-stopped', '--network', 'ninedeploy'];
      const cpu = str(p, 'cpuShares');
      if (cpu !== undefined) argv.push('--cpu-shares', /^\d{1,6}$/.test(cpu) ? cpu : '0');
      const mem = str(p, 'memLimitMb');
      if (mem !== undefined) argv.push('--memory', `${/^\d{1,6}$/.test(mem) ? mem : '0'}m`);
      const vol = str(p, 'volume');
      if (vol !== undefined) argv.push('-v', `${validated(vol, RE_NAME, 'volume name')}:${validated(str(p, 'mount') ?? '/', RE_PATH, 'mount path')}`);
      argv.push('--env-file', validated(str(p, 'envFile'), RE_PATH, 'env file path'));
      argv.push(...publishArgs(p));
      argv.push(validated(str(p, 'image'), RE_IMAGE, 'image'));
      return argv;
    },
  },
  'docker.stop': { exe: 'docker', build: (p) => ['stop', '-t', '5', validated(str(p, 'name'), RE_NAME, 'name')] },
  'docker.rm': { exe: 'docker', build: (p) => ['rm', '-f', validated(str(p, 'name'), RE_NAME, 'name')] },
  'docker.inspect': {
    exe: 'docker',
    build: (p) => {
      // A fixed set of literal format strings — never a caller-supplied one,
      // which would be a template-injection surface into the docker CLI.
      const format = str(p, 'format');
      const safe =
        format === 'state'
          ? '{{.State.Status}}|{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
          : format === 'health'
            // Compose stacks author their own healthchecks: an app that boots,
            // stays `running` and fails its healthcheck forever must not deploy
            // green. FailingStreak + RestartCount ride along so a crash-looping
            // stack fails EARLY instead of burning the whole window.
            ? '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}|{{.State.Health.FailingStreak}}{{else}}none|0{{end}}|{{.RestartCount}}'
            : '{{.Image}}';
      return ['inspect', validated(str(p, 'name'), RE_NAME, 'name'), '--format', safe];
    },
  },
  'docker.logs': { exe: 'docker', build: (p) => ['logs', '--tail', '300', '--timestamps', validated(str(p, 'name'), RE_NAME, 'name')] },
  'docker.login': {
    exe: 'docker',
    build: (p) => {
      const argv = ['login', '--username', validated(str(p, 'username'), RE_NAME, 'username'), '--password-stdin'];
      const server = str(p, 'server');
      if (server) argv.push(validated(server, RE_IMAGE, 'registry server'));
      return argv;
    },
  },
  'docker.logout': {
    exe: 'docker',
    build: (p) => {
      const argv = ['logout'];
      const server = str(p, 'server');
      if (server) argv.push(validated(server, RE_IMAGE, 'registry server'));
      return argv;
    },
  },
  // ── user-defined network management (typed, same validation model) ──────
  'docker.networkCreate': {
    exe: 'docker',
    build: (p) => {
      const argv = ['network', 'create'];
      const driver = str(p, 'driver');
      if (driver !== undefined) argv.push('--driver', driver === 'bridge' || driver === 'overlay' ? driver : 'bridge');
      argv.push(validated(str(p, 'name'), RE_NAME, 'network name'));
      return argv;
    },
  },
  'docker.networkRm': {
    exe: 'docker',
    build: (p) => ['network', 'rm', validated(str(p, 'name'), RE_NAME, 'network name')],
  },
  'docker.networkConnect': {
    exe: 'docker',
    build: (p) => [
      'network', 'connect',
      validated(str(p, 'network'), RE_NAME, 'network name'),
      validated(str(p, 'container'), RE_NAME, 'container name'),
    ],
  },
  'docker.networkDisconnect': {
    exe: 'docker',
    build: (p) => [
      'network', 'disconnect',
      validated(str(p, 'network'), RE_NAME, 'network name'),
      validated(str(p, 'container'), RE_NAME, 'container name'),
    ],
  },
  'docker.composeUp': {
    exe: 'docker',
    build: (p) => [...composeStackArgs(p), 'up', '-d', '--build', '--remove-orphans'],
  },
  // Preflight gates. Both run while the PREVIOUS revision is still serving, so
  // a bad tag or a broken `${VAR}` reference fails the deployment without ever
  // having torn the live stack down — the same ordering the local builder uses.
  'docker.composeConfig': {
    exe: 'docker',
    build: (p) => [...composeStackArgs(p), 'config', '--quiet'],
  },
  'docker.composePull': {
    exe: 'docker',
    build: (p) => [...composeStackArgs(p), 'pull', '--ignore-buildable', '--quiet'],
  },
  'docker.composeDown': {
    exe: 'docker',
    build: (p) => ['compose', '-p', validated(str(p, 'project'), RE_NAME, 'project'), 'down', '--remove-orphans'],
  },
  'git.clone': {
    exe: 'git',
    build: (p) => {
      const argv = [...GIT_EGRESS_FLAGS, 'clone'];
      const depth = str(p, 'depth');
      if (depth !== undefined) argv.push('--depth', /^\d{1,3}$/.test(depth) ? depth : '1');
      argv.push(validated(str(p, 'url'), isRepoUrl, 'repo url'), validated(str(p, 'dir') ?? '.', RE_PATH, 'target dir'));
      return argv;
    },
  },
  'git.fetch': { exe: 'git', build: () => [...GIT_EGRESS_FLAGS, 'fetch', '--all'] },
  'git.checkout': { exe: 'git', build: (p) => ['checkout', validated(str(p, 'ref') ?? 'HEAD', RE_REF, 'ref')] },
  'git.rev-parse': { exe: 'git', build: () => ['rev-parse', 'HEAD'] },
  'git.reset': { exe: 'git', build: (p) => ['reset', '--hard', validated(str(p, 'sha') ?? 'HEAD', RE_SHA, 'commit sha')] },
};

/**
 * Node-local reverse proxy — Sprint 7, remote deploys.
 *
 * Each remote node terminates TLS for the services that run on it, exactly as
 * the panel host does for its own. That is the model Coolify and Dokploy use,
 * and it is the only one where production traffic does NOT hairpin through the
 * panel: the operator points the domain at the NODE, and the node answers.
 *
 * The panel renders both Traefik configs (it owns the domain and certificate
 * model) and ships the rendered text here; the agent only writes it to a fixed
 * location and runs the container. Nothing about the path is caller-supplied.
 */
const PROXY_DIR = '.agent-proxy';
const PROXY_CONTAINER = 'ninedeploy-proxy';
const PROXY_IMAGE = 'traefik:v3.1';
/** Refuse a config larger than this — the panel renders kilobytes, not megabytes. */
const MAX_PROXY_CONFIG_BYTES = 1024 * 1024;

/** Absolute path of the node's proxy directory, creating it on first use. */
async function proxyDir(): Promise<string> {
  const { mkdirSync } = await import('node:fs');
  const pathmod = await import('node:path');
  const base = pathmod.resolve(process.cwd(), PROXY_DIR);
  mkdirSync(pathmod.join(base, 'dynamic'), { recursive: true, mode: 0o700 });
  return base;
}

/**
 * Write one of the two Traefik config files. `kind` is an enum, not a path, so
 * there is no filename operand a caller could steer.
 */
async function writeProxyConfigOp(params: Params): Promise<{ path: string; changed: boolean }> {
  const { existsSync, readFileSync, writeFileSync, renameSync } = await import('node:fs');
  const pathmod = await import('node:path');
  const kind = str(params, 'kind');
  if (kind !== 'static' && kind !== 'dynamic') throw new Error('Invalid config kind');
  const content = str(params, 'content');
  if (content === undefined || content.includes('\u0000')) throw new Error('Invalid config content');
  if (Buffer.byteLength(content, 'utf8') > MAX_PROXY_CONFIG_BYTES) throw new Error('Config too large');

  const base = await proxyDir();
  const target = kind === 'static'
    ? pathmod.join(base, 'traefik.yml')
    : pathmod.join(base, 'dynamic', 'ninedeploy.yml');
  // Atomic replace: Traefik watches the dynamic directory, and a half-written
  // file is a config error that takes routing down until the next write.
  // Whether the content CHANGED decides, on the caller's side, if the proxy
  // has to be recreated. Traefik hot-reloads the dynamic file, but reads the
  // static one only at start-up — and recreating on every routing change would
  // turn each domain edit into a brief ingress outage.
  const previous = existsSync(target) ? readFileSync(target, 'utf8') : null;
  const changed = previous !== content;
  if (changed) {
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, target);
  }
  return { path: pathmod.relative(process.cwd(), target), changed };
}

/**
 * Start (or restart) the node's Traefik. The argv is entirely literal apart
 * from the image tag, which is validated as an image reference.
 */
async function proxyEnsureOp(params: Params, onLine: (l: string) => void): Promise<number> {
  const { existsSync, writeFileSync, chmodSync } = await import('node:fs');
  const pathmod = await import('node:path');
  const image = str(params, 'image') === undefined
    ? PROXY_IMAGE
    : validated(str(params, 'image'), RE_IMAGE, 'proxy image');
  const base = await proxyDir();

  // Seed acme.json so the bind mount is a FILE; Docker would otherwise create
  // a directory in its place and Traefik would fail to store certificates.
  const acme = pathmod.join(base, 'acme.json');
  if (!existsSync(acme)) writeFileSync(acme, '{}', { mode: 0o600 });
  try {
    chmodSync(acme, 0o600);
  } catch {
    /* best effort — some filesystems refuse chmod */
  }

  // The shared network has to exist before the proxy can join it; on a fresh
  // node nothing has created it yet. An "already exists" failure is expected
  // and ignored.
  await spawnValidated('docker', ['network', 'create', 'ninedeploy'], () => {});
  await spawnValidated('docker', ['rm', '-f', PROXY_CONTAINER], () => {});
  return spawnValidated(
    'docker',
    [
      'run', '-d', '--name', PROXY_CONTAINER, '--restart', 'unless-stopped',
      '--network', 'ninedeploy',
      '--add-host', 'host.docker.internal:host-gateway',
      '-p', '80:80', '-p', '443:443',
      '-v', `${base}:/etc/traefik:ro`,
      '-v', `${acme}:/etc/traefik/acme.json`,
      image,
    ],
    onLine,
  );
}

/**
 * Files a remote compose deploy needs inside its service workspace.
 *
 * `kind` is an ENUM, never a filename, so no caller can steer the write — the
 * same property `proxy.writeConfig` has. The three names are fixed:
 *
 *   compose          → docker-compose.yml    (an inline stack's YAML)
 *   dotenv           → .env                  (compose reads project vars here)
 *   compose-override → .ninedeploy.compose.override.yml (volume attachments)
 *
 * `.env` and the override carry resolved secrets, so both are written 0600 and
 * `file.deleteWorkspaceFile` removes them once compose has read them.
 */
const WORKSPACE_FILES: Record<string, string> = {
  compose: 'docker-compose.yml',
  dotenv: '.env',
  'compose-override': '.ninedeploy.compose.override.yml',
};

/** Refuse a file larger than this — a compose stack is kilobytes, not megabytes. */
const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024;

async function writeWorkspaceFileOp(params: Params): Promise<{ path: string }> {
  const { writeFileSync, renameSync } = await import('node:fs');
  const pathmod = await import('node:path');
  const kind = str(params, 'kind');
  const name = kind === undefined ? undefined : WORKSPACE_FILES[kind];
  if (name === undefined) throw new Error('Invalid workspace file kind');
  const content = str(params, 'content');
  if (content === undefined || content.includes('\u0000')) throw new Error('Invalid file content');
  if (Buffer.byteLength(content, 'utf8') > MAX_WORKSPACE_FILE_BYTES) throw new Error('File too large');

  const dir = await resolveWorkspace(validated(str(params, 'workspace'), RE_NAME, 'workspace name'));
  const target = pathmod.join(dir, name);
  // Atomic replace: compose may be reading the previous revision's file while
  // the next deploy writes this one.
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, target);
  return { path: pathmod.relative(process.cwd(), target) };
}

async function deleteWorkspaceFileOp(params: Params): Promise<void> {
  const { rmSync } = await import('node:fs');
  const pathmod = await import('node:path');
  const kind = str(params, 'kind');
  const name = kind === undefined ? undefined : WORKSPACE_FILES[kind];
  if (name === undefined) throw new Error('Invalid workspace file kind');
  const dir = await resolveWorkspace(validated(str(params, 'workspace'), RE_NAME, 'workspace name'));
  rmSync(pathmod.join(dir, name), { force: true });
}

/**
 * Apply the platform's default restart policy to a compose project.
 *
 * Compose files without an explicit `restart:` leave every container
 * unrestartable — they stay dead across a daemon restart and a host reboot —
 * and `compose up` offers no policy override. On the panel host that is
 * annoying; on a remote node nobody is watching, so the stack would simply be
 * gone after a reboot. `compose ps -q` names the containers this project owns,
 * then `docker update` persists the policy on each.
 *
 * Best effort: a project whose containers cannot be listed or updated is
 * reported and left alone rather than failing a deployment that already
 * succeeded.
 */
async function composeRestartPolicyOp(params: Params, onLine: (l: string) => void): Promise<number> {
  const dir = await resolveWorkspace(validated(str(params, 'workspace'), RE_NAME, 'workspace name'));
  const ids: string[] = [];
  const psCode = await spawnValidated(
    'docker',
    [...composeStackArgs(params), 'ps', '-q'],
    (line) => {
      const id = line.trim();
      // Container ids are hex; anything else on this stream is progress noise.
      if (/^[0-9a-f]{12,64}$/i.test(id)) ids.push(id);
    },
    { cwd: dir },
  );
  if (psCode !== 0 || ids.length === 0) {
    onLine('compose ps returned no containers — restart policy not applied');
    return 0;
  }
  const code = await spawnValidated(
    'docker',
    ['update', '--restart', 'unless-stopped', ...ids],
    onLine,
    { cwd: dir },
  );
  if (code !== 0) onLine('docker update failed — containers keep the policy their compose file gave them');
  onLine(`restart policy applied to ${ids.length} container(s)`);
  return 0;
}

/** Env files the agent writes for docker.runEnv live under this fixed dir. */
const ENV_DIR = '.agent-env';

/** Write an env file (KEY=VALUE lines) for a subsequent docker.runEnv call. */
async function writeEnvFileOp(params: Params): Promise<{ path: string }> {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const pathmod = await import('node:path');
  const base = pathmod.join(process.cwd(), ENV_DIR);
  const name = validated(str(params, 'name'), RE_NAME, 'env file name');
  const entries = params['env'];
  if (typeof entries !== 'object' || entries === null) throw new Error('Invalid env');
  const lines: string[] = [];
  for (const [k, v] of Object.entries(entries as Record<string, unknown>)) {
    if (!RE_NAME.test(k) || typeof v !== 'string' || v.includes('\n') || v.includes('\0') || v.length > 32768) {
      throw new Error(`Invalid env value for ${k}`);
    }
    lines.push(`${k}=${v}`);
  }
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const file = pathmod.join(base, `${name}.env`);
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return { path: `${ENV_DIR}/${name}.env` };
}

/** Remove an env file written earlier (best-effort). */
async function deleteEnvFileOp(params: Params): Promise<void> {
  const { rmSync } = await import('node:fs');
  const pathmod = await import('node:path');
  const name = validated(str(params, 'name'), RE_NAME, 'env file name');
  rmSync(pathmod.join(process.cwd(), ENV_DIR, `${name}.env`), { force: true });
}

/**
 * Operations handled by `runOp` directly rather than through the argv table.
 * The route consults this alongside `OPS` so a new handler cannot be reachable
 * without being listed here (or unreachable after being added).
 */
const HANDLED_OPS = new Set([
  'file.writeEnv',
  'file.deleteEnv',
  'file.writeWorkspace',
  'file.deleteWorkspace',
  'docker.pull',
  'docker.composeRestartPolicy',
  'git.ensure',
  'proxy.writeConfig',
  'proxy.ensure',
]);

/** Run one typed operation (exported for tests). */
export async function runOp(op: string, params: Params, onLine: (l: string) => void): Promise<number> {
  if (op === 'file.writeEnv') {
    const { path } = await writeEnvFileOp(params);
    onLine(`wrote ${path}`);
    return 0;
  }
  if (op === 'file.deleteEnv') {
    await deleteEnvFileOp(params);
    return 0;
  }
  if (op === 'file.writeWorkspace') {
    const { path } = await writeWorkspaceFileOp(params);
    onLine(`workspace-file ${path}`);
    return 0;
  }
  if (op === 'file.deleteWorkspace') {
    await deleteWorkspaceFileOp(params);
    return 0;
  }
  if (op === 'docker.composeRestartPolicy') {
    return composeRestartPolicyOp(params, onLine);
  }
  if (op === 'git.ensure') {
    // Idempotent checkout: clone when the workspace holds no repository yet,
    // otherwise fetch. Doing this as ONE op keeps the caller free of
    // exception-driven control flow ("try fetch, fall back to clone" would
    // swallow a genuine clone failure and report it as a fetch failure).
    const { existsSync } = await import('node:fs');
    const pathmod = await import('node:path');
    const dir = await resolveWorkspace(validated(str(params, 'workspace'), RE_NAME, 'workspace name'));
    const url = validated(str(params, 'url'), isRepoUrl, 'repo url');
    if (existsSync(pathmod.join(dir, '.git'))) {
      return spawnValidated('git', [...GIT_EGRESS_FLAGS, 'fetch', '--all', '--prune'], onLine, { cwd: dir });
    }
    const depth = str(params, 'depth');
    const argv = [...GIT_EGRESS_FLAGS, 'clone'];
    if (depth !== undefined) argv.push('--depth', /^\d{1,3}$/.test(depth) ? depth : '1');
    argv.push(url, '.');
    return spawnValidated('git', argv, onLine, { cwd: dir });
  }
  if (op === 'proxy.writeConfig') {
    const { path, changed } = await writeProxyConfigOp(params);
    // A distinct marker: the exec route scrapes lines beginning `wrote ` to
    // surface `file.writeEnv`'s path, and a proxy write is not an env file.
    onLine(`proxy-config ${path} ${changed ? 'changed' : 'unchanged'}`);
    return 0;
  }
  if (op === 'proxy.ensure') {
    return proxyEnsureOp(params, onLine);
  }
  if (op === 'docker.pull') {
    const image = validated(str(params, 'image'), RE_IMAGE, 'image');
    await pullDockerImage(image, onLine);
    return 0;
  }
  const def = OPS[op];
  if (!def) return -1;
  const argv = def.build(params);

  // `docker login` is built with `--password-stdin` so the credential never
  // appears in argv (and therefore never in `ps` or the process table). The
  // password has to actually REACH stdin, though: without this the child sat
  // waiting on a pipe that was never written or closed, and every remote
  // private-registry deploy hung until the agent's 600 s request timeout.
  if (op === 'docker.login') {
    const password = str(params, 'password');
    if (password === undefined) throw new Error('Invalid registry password');
    return spawnValidated(def.exe, argv, onLine, { stdin: `${password}
` });
  }
  // A `workspace` operand runs the op inside that service's own directory.
  // Git needs it (fetch/checkout/reset act on the cwd, so without it one host
  // could hold a single checkout); `docker build` uses it so two services'
  // build contexts cannot collide. Absent = the agent's own cwd, which is what
  // every host-level op (networks, prune, inspect) wants.
  const workspace = str(params, 'workspace');
  const cwd = workspace === undefined ? undefined : await resolveWorkspace(workspace);
  return spawnValidated(def.exe, argv, onLine, cwd === undefined ? {} : { cwd });
}

export async function announceToMaster(
  masterUrl: string,
  payload: { name: string; host?: string; port: number; token: string },
  enrolmentToken = process.env['NINEDEPLOY_ENROLMENT_TOKEN'] ?? '',
): Promise<void> {
  try {
    const endpoint = `${masterUrl.replace(/\/+$/, '')}/v1/servers/announce`;
    const res = await fetch(endpoint, {
      method: 'POST',
      // M-6: the master refuses an announce without the admin-issued enrolment
      // secret. Generate it in Settings -> Nodes and set
      // NINEDEPLOY_ENROLMENT_TOKEN in this agent's environment.
      headers: { 'content-type': 'application/json', 'x-ninedeploy-enrolment': enrolmentToken },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { status?: string; message?: string };
      // eslint-disable-next-line no-console
      console.log(`[NineDeploy Agent] Announced to master at ${masterUrl} (${data.status}). Waiting for admin approval in NineDeploy panel.`);
    } else {
      const errText = await res.text();
      // eslint-disable-next-line no-console
      console.warn(`[NineDeploy Agent] Master announce warning (${res.status}): ${errText.slice(0, 200)}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[NineDeploy Agent] Could not reach master at ${masterUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const masterUrl = process.env['NINEDEPLOY_MASTER_URL'] ?? '';
  let tokenHash = process.env['NINEDEPLOY_AGENT_TOKEN'] ?? '';
  let rawToken = process.env['NINEDEPLOY_AGENT_RAW_TOKEN'] ?? '';

  if (!tokenHash && masterUrl) {
    // Auto-discovery mode: generate a local token pair and announce to master
    const { randomBytes, createHash } = await import('node:crypto');
    rawToken = rawToken || randomBytes(32).toString('hex');
    tokenHash = createHash('sha256').update(rawToken).digest('hex');
  }

  if (!tokenHash) {
    // eslint-disable-next-line no-console
    console.error('NINEDEPLOY_AGENT_TOKEN (sha256 hash) or NINEDEPLOY_MASTER_URL is required in agent mode');
    process.exit(1);
  }
  const port = Number(process.env['NINEDEPLOY_AGENT_PORT'] ?? 4600);

  const app = await buildAgentApp();
  await app.register(agentRoutes, { tokenHash });

  await app.listen({ host: '0.0.0.0', port });
  // eslint-disable-next-line no-console
  console.log(`NineDeploy agent listening on :${port} (${Object.keys(OPS).length} typed deploy operations)`);

  if (masterUrl) {
    const { hostname } = await import('node:os');
    const nodeName = process.env['NINEDEPLOY_NODE_NAME'] || hostname();
    const advertiseHost = process.env['NINEDEPLOY_ADVERTISE_HOST'] || undefined;
    void announceToMaster(masterUrl, {
      name: nodeName,
      host: advertiseHost,
      port,
      token: rawToken,
    });
  }

  const shutdown = async () => {
    // Hard-exit backstop: a close() that never settles (open sockets) must
    // not keep a SIGTERM'd agent alive indefinitely.
    const force = setTimeout(process.exit, 10_000);
    force.unref();
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * The agent's HTTP surface, as a registerable plugin (used by main() and by
 * route tests). `tokenHash` is the sha256 of the shared agent token.
 */
export const agentRoutes = async (app: import('fastify').FastifyInstance, opts: { tokenHash?: string }) => {
  const tokenHash = opts.tokenHash ?? process.env['NINEDEPLOY_AGENT_TOKEN'] ?? '';

  app.post('/agent/exec', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const raw = (req.body ?? {}) as { sealed?: unknown; op?: unknown; params?: unknown };

    // Sealed transport (preferred). The envelope is authenticated with a key
    // derived from the shared secret, so opening it IS the authentication —
    // the token never crosses the network, and neither do the service secrets
    // that `file.writeEnv` carries. See lib/agentSeal.ts.
    let input: { op?: unknown; params?: unknown; nonce?: unknown };
    let sealedRequest = false;
    if (raw.sealed !== undefined) {
      try {
        input = openSealed<{ op?: unknown; params?: unknown; nonce?: unknown }>(tokenHash, raw.sealed);
        sealedRequest = true;
      } catch {
        // Same answer as a bad token: a caller who cannot produce a valid
        // envelope has not authenticated, and saying more would turn this into
        // a decryption oracle.
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'Bad agent token' } });
      }
    } else {
      // Legacy plaintext path, kept so an upgraded agent still answers a core
      // that has not been upgraded yet. Deprecated — see /agent/ping, which
      // advertises `sealed: true` so a current core never takes this branch.
      const token = req.headers['x-agent-token'];
      if (typeof token !== 'string' || !tokenMatches(token, tokenHash)) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'Bad agent token' } });
      }
      input = raw;
    }
    const op = typeof input.op === 'string' ? input.op : '';
    const params: Params = typeof input.params === 'object' && input.params ? (input.params as Params) : {};
    if (!OPS[op] && !HANDLED_OPS.has(op)) {
      return reply.code(400).send({ error: { code: 'unknown_op', message: `Unknown operation: ${op}` } });
    }
    const lines: string[] = [];
    let exitCode: number;
    // For file.writeEnv, surface the remote env-file path for docker.runEnv.
    let envFile: string | null = null;
    try {
      exitCode = await runOp(op, params, (l) => lines.push(l));
      envFile = lines.find((l) => l.startsWith('wrote '))?.slice('wrote '.length) ?? null;
    } catch (err) {
      return reply.code(400).send({ error: { code: 'bad_params', message: err instanceof Error ? err.message : 'Invalid params' } });
    }
    const result: {
      lines: string[];
      exitCode: number;
      envFile: string | null;
      nonce?: string;
    } = { lines, exitCode, envFile };
    // Echo the caller's nonce back inside the sealed reply so the core can
    // bind this response to ITS request — a captured envelope replayed within
    // the seal window carries a stale nonce and is refused. Legacy plaintext
    // callers do not send one, so there is nothing to echo.
    const reqNonce = typeof input.nonce === 'string' ? input.nonce : undefined;
    if (sealedRequest && reqNonce !== undefined) result.nonce = reqNonce;
    // Seal the reply too: command output routinely echoes configuration, and a
    // plaintext response would undo half the point.
    return sealedRequest ? { sealed: sealResponse(tokenHash, result) } : result;
  });

  // Unauthenticated capability probe. `sealed: true` is how a current core
  // learns it may use the sealed transport; a missing or forged answer no
  // longer downgrades anything — the core fails the operation closed unless
  // the operator explicitly enabled the plaintext fallback.
  app.get('/agent/ping', async () => ({
    ok: true,
    agent: true,
    sealed: true,
    version: (await import('./version.js')).VERSION,
  }));
};

// Boot when the agent flag is set. Tests set NINEDEPLOY_AGENT=1 explicitly
// (via test/agentBoot.test.ts) so the boot path stays covered.
if (process.env['NINEDEPLOY_AGENT'] === '1') {
  void main();
}

export const agentMode = { main, OPS };
