import { appendFileSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join as joinPath, relative as relativePath, resolve as resolvePath, sep as pathSep } from 'node:path';
import { agentStreamRoute, agentWebsocketOptions, buildAgentApp } from './agentApp.js';
import { advertisedCapabilities, AGENT_OPS, registeredCapabilities, runRegisteredOp } from './agentOps/index.js';
import { gitCredentialEnv } from './agentOps/gitCredential.js';
import {
  GIT_EGRESS_FLAGS,
  isRepoUrl,
  NODE_PROXY_IMAGE,
  type Params,
  RE_IMAGE,
  RE_NAME,
  RE_PATH,
  RE_SHA,
  RE_REF,
  str,
  switchedOff,
  validated,
} from './agentOps/operands.js';
import { closeAllStreamChannels, startTransferSweep } from './agentOps/stream.js';
import { agentChildTimeoutMs, tokenMatches } from './lib/agentClient.js';
import { MAX_SKEW_MS, open as openSealed, seal as sealResponse } from './lib/agentSeal.js';
import { spawnValidated } from './lib/spawnValidated.js';

/**
 * Agent mode (NINEDEPLOY_AGENT=1): a minimal HTTP surface for the core to run
 * DEPLOY OPERATIONS on this host. The request never carries a program name or
 * a raw argv — it names a typed operation from the fixed table below, and the
 * argv is constructed from literal flags plus strictly-validated operands
 * (identifier-like strings, image refs, paths without traversal). Actual
 * process spawning happens exclusively through lib/spawnValidated.ts (one
 * auditable choke point over the two fixed executables).
 *
 * Multi-node (0.15.x series, design §1): the operand validators live in
 * agentOps/operands.ts and the per-job Git credential in
 * agentOps/gitCredential.ts (both moved unchanged). Ops added after 0.15 are
 * NOT added here: they live in agentOps/*.ts behind the registry in
 * agentOps/index.ts, each gated on a capability the sealed `agent.ping`
 * advertises after the 0.15 list.
 */

/** 0.13 (T5): moved to agentOps/gitCredential.ts; re-exported for its callers. */
export { gitCredentialEnv, type GitCredentialEnv } from './agentOps/gitCredential.js';

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

/**
 * r660: what this agent can do beyond the original op table, reported inside
 * the SEALED `agent.ping` answer (authenticated, unlike `GET /agent/ping`).
 * An older agent answers `agent.ping` with no lines at all, so the panel reads
 * a missing capability as "too old" and refuses what depends on it with a
 * message naming the node — see lib/agentClient.ts `agentCapabilities`.
 */
export const AGENT_CAPABILITIES_015 = ['build-path-guard', 'workspace.remove', 'git.credential', 'terminal'] as const;

/**
 * Every capability this agent can advertise (kill switches aside): the 0.15
 * list unchanged and in order, then the multi-node capabilities whose ops are
 * registered in agentOps/index.ts, in `MULTI_NODE_CAPABILITIES` order. A
 * capability is never advertised before its op exists, so a newer panel never
 * trusts an op this agent would answer `unknown_op`.
 */
export const AGENT_CAPABILITIES: readonly string[] = [...AGENT_CAPABILITIES_015, ...registeredCapabilities()];

/**
 * 0.15 (T2b): advertised next to {@link AGENT_CAPABILITIES} only while this
 * node allows host shells — the node owner's kill switch
 * (`NINEDEPLOY_AGENT_HOST_TERMINAL=off`, or `NINEDEPLOY_HOST_TERMINAL=off`
 * like the panel's) removes it, and `terminal.open` refuses `host` anyway.
 */
export const AGENT_CAP_TERMINAL_HOST = 'terminal.host';

/** 0.15 (T2b): the node owner's switch. Either variable set to off/false/0/no/disabled forbids host shells. */
export function nodeHostTerminalForbidden(env: NodeJS.ProcessEnv = process.env): boolean {
  return switchedOff(env['NINEDEPLOY_AGENT_HOST_TERMINAL']) || switchedOff(env['NINEDEPLOY_HOST_TERMINAL']);
}

/**
 * What `agent.ping` advertises right now: exactly the 0.15 answer first
 * (the four 0.15 capabilities, then `terminal.host` unless the node forbids
 * host shells), so a 0.15 panel reads the same list it always did; then the
 * multi-node capabilities, minus any the node's owner switched off.
 */
export function agentCapabilities(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ...AGENT_CAPABILITIES_015,
    ...(nodeHostTerminalForbidden(env) ? [] : [AGENT_CAP_TERMINAL_HOST]),
    ...advertisedCapabilities(env),
  ];
}

/**
 * r660: the agent-side twin of the panel's `resolveInRepo` (lib/repoPath.ts).
 *
 * `dockerfile`, `context`, a compose `file`/`override` and a clone `dir` are
 * repository paths, and the repository is whatever the service's owner pushed:
 * `ln -s / ctx` (or `ln -s ../other-service ctx`) plus `baseDir: ctx` made
 * `docker build` — run as root, in a work root every tenant on the node
 * shares — send the node's filesystem or another service's checkout (its
 * `.env` included) to the builder, and a symlinked Dockerfile turned
 * `/etc/shadow` into a parse error echoed into the deploy log. RE_PATH only
 * ever checked the TEXT. Every component from `base` down is lstat-checked,
 * the last one included; a symlink — dangling or not — is refused, as is an
 * absolute path (the panel always sends repo-relative ones). A missing
 * component has nothing to follow; the docker command then fails on it.
 */
export function assertPathInWorkspace(base: string, value: string, what: string): string {
  if (value.startsWith('/') || value.includes('\\')) throw new Error(`Invalid ${what}: must be a path inside the service workspace`);
  const root = resolvePath(base);
  const resolved = resolvePath(root, value);
  if (resolved !== root && !resolved.startsWith(root + pathSep)) {
    throw new Error(`Invalid ${what}: must be a path inside the service workspace`);
  }
  let current = root;
  for (const part of relativePath(root, resolved).split(pathSep).filter((p) => p !== '')) {
    current = joinPath(current, part);
    let isLink: boolean;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') break;
      throw err;
    }
    if (isLink) throw new Error(`Refusing ${what} "${value}": the path goes through a symlink in the repository`);
  }
  return value;
}

/**
 * r660/r666: the Dockerfile a node builds. The panel sends `dockerfile`
 * repo-relative and the context separately, while its Settings field reads
 * the path relative to the base directory — so `baseDir: apps/web` with the
 * default `Dockerfile` built the ROOT Dockerfile, or failed when the repo had
 * none. A repo-relative file that exists keeps winning (every build that
 * worked keeps building the same file); otherwise one under the context is
 * used. Both candidates pass the symlink walk.
 */
function nodeDockerfile(base: string, dockerfile: string, context: string): string {
  assertPathInWorkspace(base, dockerfile, 'dockerfile');
  assertPathInWorkspace(base, context, 'context');
  if (context === '.' || existsSync(joinPath(base, dockerfile))) return dockerfile;
  const underContext = `${context.replace(/\/+$/, '')}/${dockerfile}`;
  if (!RE_PATH(underContext)) return dockerfile;
  assertPathInWorkspace(base, underContext, 'dockerfile');
  return existsSync(joinPath(base, underContext)) ? underContext : dockerfile;
}

/**
 * r660: run the symlink walk over every repository path an op names, and
 * resolve the Dockerfile a build uses. Returns the params the argv is built
 * from. Ops without such operands pass through untouched.
 */
function guardWorkspacePaths(op: string, params: Params, base: string): Params {
  if (op === 'docker.build') {
    const dockerfile = validated(str(params, 'dockerfile'), RE_PATH, 'dockerfile');
    const context = validated(str(params, 'context'), RE_PATH, 'context');
    return { ...params, dockerfile: nodeDockerfile(base, dockerfile, context) };
  }
  if (op === 'git.clone' && str(params, 'dir') !== undefined) {
    assertPathInWorkspace(base, validated(str(params, 'dir'), RE_PATH, 'target dir'), 'target dir');
  }
  if (op.startsWith('docker.compose') && op !== 'docker.composeDown') {
    if (str(params, 'file') !== undefined) assertPathInWorkspace(base, validated(str(params, 'file'), RE_PATH, 'compose file'), 'compose file');
    if (str(params, 'override') !== undefined) {
      assertPathInWorkspace(base, validated(str(params, 'override'), RE_PATH, 'compose override file'), 'compose override file');
    }
  }
  return params;
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
 * Resource limit flags for `docker.run`/`docker.runEnv`. Values arrive as
 * panel-supplied strings and are re-validated here — an off-format value
 * degrades to "no flag" (cpu shares) or "0" (uncapped), never to argv
 * injection. memory-swap is pinned equal to memory: Docker's default allows
 * swap = 2× the limit, which would quietly double the configured ceiling.
 */
function resourceArgs(p: Params): string[] {
  const argv: string[] = [];
  const shares = str(p, 'cpuShares');
  if (shares !== undefined && /^\d{1,6}$/.test(shares)) argv.push('--cpu-shares', shares);
  const cpus = str(p, 'cpuLimitMilli');
  if (cpus !== undefined && /^\d{1,6}$/.test(cpus) && Number(cpus) > 0) argv.push('--cpus', String(Number(cpus) / 1000));
  const mem = str(p, 'memLimitMb');
  if (mem !== undefined && /^\d{1,6}$/.test(mem) && Number(mem) > 0) argv.push('--memory', `${mem}m`, '--memory-swap', `${mem}m`);
  return argv;
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
      argv.push(...resourceArgs(p));
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
      argv.push(...resourceArgs(p));
      const vol = str(p, 'volume');
      if (vol !== undefined) argv.push('-v', `${validated(vol, RE_NAME, 'volume name')}:${validated(str(p, 'mount') ?? '/', RE_PATH, 'mount path')}`);
      argv.push('--env-file', validated(str(p, 'envFile'), RE_PATH, 'env file path'));
      argv.push(...publishArgs(p));
      argv.push(validated(str(p, 'image'), RE_IMAGE, 'image'));
      return argv;
    },
  },
  // r526: the panel passes the service's stop grace (0-300 s, the schema's
  // range); anything else — or a panel that predates it — keeps the 5 s default.
  'docker.stop': {
    exe: 'docker',
    build: (p) => {
      const grace = str(p, 'graceSeconds');
      const t = grace !== undefined && /^\d{1,3}$/.test(grace) && Number(grace) <= 300 ? String(Number(grace)) : '5';
      return ['stop', '-t', t, validated(str(p, 'name'), RE_NAME, 'name')];
    },
  },
  'docker.start': { exe: 'docker', build: (p) => ['start', validated(str(p, 'name'), RE_NAME, 'name')] },
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
  // r466: node-side volume lifecycle. A remote service's data volume lives on
  // the NODE — the panel's local `docker volume ls` never saw it, so a freed
  // slug could re-mount a deleted service's node data and the Volumes page
  // could never clean it. `inspect` doubles as the existence probe (exit 0 =
  // exists); callers interpret the exit code.
  'docker.volumeInspect': {
    exe: 'docker',
    build: (p) => ['volume', 'inspect', validated(str(p, 'name'), RE_NAME, 'volume name')],
  },
  'docker.volumeRm': {
    exe: 'docker',
    build: (p) => ['volume', 'rm', validated(str(p, 'name'), RE_NAME, 'volume name')],
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
  // r464: resolves the ACTUAL main container of a stack the node just brought
  // up. A compose file that pins `container_name:` (or a scale change)
  // produces a different name than the deterministic `<project>-<service>-1`,
  // and health/routing/stop would all target a container that does not exist —
  // the local builder has always resolved this, the remote one now can too.
  'docker.composePs': {
    exe: 'docker',
    build: (p) => {
      const argv = [...composeStackArgs(p), 'ps', '--format', 'json'];
      const service = str(p, 'service');
      if (service !== undefined) argv.push(validated(service, RE_NAME, 'compose service'));
      return argv;
    },
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
const PROXY_IMAGE = NODE_PROXY_IMAGE;
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
  // r416: PULL THE IMAGE BEFORE touching the live proxy. The old order
  // (`rm -f` → `run`) destroyed the node's only proxy FIRST — a failed pull
  // or a transient daemon error then left every domain on the node dark while
  // the panel logged "the node keeps serving its previous routing". With the
  // image local, the only remaining run-failure window is tiny; on failure
  // the proxy is GONE and the caller must be told so (see nodeProxy.ts).
  await spawnValidated('docker', ['pull', image], () => {});
  // 0.15 D5 (O7): probed before the live proxy is removed, so the probe never
  // lengthens the ingress gap. Only part of the argv: this op recreates the
  // proxy only when the panel asks (a static-config change), so the rotation
  // lands at the next natural recreate and never forces one.
  const logOpts = nodeProxyLogOptArgs(await nodeDockerLoggingDriver());
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
      ...logOpts,
      image,
    ],
    onLine,
  );
}

/** 0.15 D5: Docker log drivers that accept `max-size` / `max-file`. */
const ROTATING_LOG_DRIVERS = new Set(['json-file', 'local']);

/**
 * 0.15 D5 (node side of engine/proxy.ts `traefikLogOptArgs`): Traefik's access
 * log goes to the container log, which the json-file driver never rotates. A
 * driver that does not accept these options would make `docker run` fail and
 * take the node's ingress down, so anything else (or an unknown driver) keeps
 * today's argv.
 */
export function nodeProxyLogOptArgs(driver: string | null): string[] {
  return driver && ROTATING_LOG_DRIVERS.has(driver) ? ['--log-opt', 'max-size=20m', '--log-opt', 'max-file=3'] : [];
}

let nodeLoggingDriver: string | null = null;

/**
 * 0.15 D5: the node daemon's default logging driver (`docker info`), cached
 * for the process once known. Null when Docker did not answer (nothing is
 * cached, so the next recreate asks again).
 */
export async function nodeDockerLoggingDriver(): Promise<string | null> {
  if (nodeLoggingDriver) return nodeLoggingDriver;
  const lines: string[] = [];
  try {
    const code = await spawnValidated('docker', ['info', '--format', '{{.LoggingDriver}}'], (l) => lines.push(l));
    const out = lines.join('').trim();
    if (code !== 0 || !/^[A-Za-z0-9._-]{1,64}$/.test(out)) return null;
    nodeLoggingDriver = out;
    return out;
  } catch {
    return null;
  }
}

/** Test hook: forget the cached logging driver. */
export function resetNodeDockerLoggingDriverCache(): void {
  nodeLoggingDriver = null;
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
  const { writeFileSync, renameSync, rmSync } = await import('node:fs');
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
  // r660: the workspace is also the repository checkout, so `<name>.tmp` can
  // be a symlink the repo committed — and a plain write FOLLOWED it, putting
  // the service's resolved secrets into any file on the node, as root. The
  // link itself is removed first, and `wx` (O_CREAT|O_EXCL) never follows one.
  const tmp = `${target}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
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
 *
 * F812 (the node twin of F561): only services WITHOUT their own policy get
 * the default — a `restart: "no"` one-shot job, `on-failure:N` or
 * `deploy.restart_policy` keeps what the file declares. An unreadable config
 * falls back to every container (the previous behaviour). The config output
 * carries resolved env values, so it is parsed here and never echoed.
 */
async function composeRestartPolicyOp(params: Params, onLine: (l: string) => void): Promise<number> {
  const dir = await resolveWorkspace(validated(str(params, 'workspace'), RE_NAME, 'workspace name'));
  guardWorkspacePaths('docker.composePs', params, dir); // r660
  let services: string[] = [];
  const cfgLines: string[] = [];
  const cfgCode = await spawnValidated(
    'docker',
    [...composeStackArgs(params), 'config', '--format', 'json'],
    (line) => cfgLines.push(line),
    { cwd: dir },
  );
  const declared = cfgCode === 0 ? composeServicePolicies(cfgLines) : null;
  if (declared !== null) {
    const defaultable = [...declared].filter(([, own]) => !own).map(([name]) => name);
    const usable = defaultable.filter((name) => RE_NAME.test(name));
    if (usable.length === 0) {
      onLine('every compose service declares its own restart policy — none changed');
      return 0;
    }
    if (usable.length < declared.size) services = usable;
  }
  const ids: string[] = [];
  const psCode = await spawnValidated(
    'docker',
    [...composeStackArgs(params), 'ps', '-q', ...services],
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

/**
 * F812: service name → "declares its own restart policy", from the lines of
 * `compose config --format json` (stderr warnings are merged into the same
 * stream, so the JSON is cut from its first `{` line to its last `}` line).
 * Null when the output is not a readable config.
 */
function composeServicePolicies(lines: string[]): Map<string, boolean> | null {
  const start = lines.findIndex((l) => l.trimStart().startsWith('{'));
  const end = lines.findLastIndex((l) => l.trimEnd().endsWith('}'));
  if (start === -1 || end < start) return null;
  try {
    const cfg = JSON.parse(lines.slice(start, end + 1).join('\n')) as {
      services?: Record<string, { restart?: unknown; deploy?: { restart_policy?: unknown } | null } | null>;
    };
    if (!cfg?.services || typeof cfg.services !== 'object' || Array.isArray(cfg.services)) return null;
    return new Map(Object.entries(cfg.services).map(([name, def]) => [name, Boolean(def?.restart || def?.deploy?.restart_policy)]));
  } catch {
    return null;
  }
}

/** Env files the agent writes for docker.runEnv live under this fixed dir. */
const ENV_DIR = '.agent-env';

/**
 * r267: env-file keys. RE_NAME (the container-name rule) refused a leading
 * `_`, which the panel's env key rule (`^[A-Za-z_][A-Za-z0-9_]*$`) accepts —
 * a service with `_JAVA_OPTIONS` deployed locally and failed on every node.
 * A strict superset of the old rule, so nothing that worked stops working;
 * still no `=`, whitespace or newline, so a key cannot split an env-file line.
 */
const RE_ENV_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

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
    if (!RE_ENV_KEY.test(k) || typeof v !== 'string' || v.includes('\n') || v.includes('\0') || v.length > 32768) {
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
 * r467: node telemetry for the Monitoring page. One composite read — host
 * os-level stats as a single JSON line (`ND-HOST {...}`), then raw
 * `docker stats --no-stream` lines (`name|cpu%|mem`) and one `df` line for
 * the node's disk, all through the line-based op transport. The PANEL joins
 * container names to service rows; the agent only reports what it can see.
 * os.cpus()/totalmem()/loadavg() read /proc — the HOST's values even from
 * inside the agent container (no lxcfs virtualization on a standard node).
 */
async function agentStatsOp(onLine: (l: string) => void): Promise<number> {
  const os = await import('node:os');
  const total = os.totalmem();
  onLine(
    `ND-HOST ${JSON.stringify({
      cpuCores: os.cpus().length,
      load1: os.loadavg()[0] ?? 0,
      memTotalBytes: total,
      memUsedBytes: total - os.freemem(),
    })}`,
  );
  const dockerStats = await spawnValidated(
    'docker',
    ['stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}'],
    onLine,
  );
  // Node disk: df of the agent's own root — the workspaces and images live
  // on the same filesystem on a standard node. -P is the POSIX format (one
  // line per filesystem, no wrapped long device names); the header is skipped
  // BY POSITION because scrubbedEnv passes LANG through and coreutils
  // translates it — matching the English text used to leak a translated
  // header through as a bogus ND-DF row.
  let firstDfLine = true;
  const df = await spawnValidated('df', ['-kP', '.'], (l) => {
    if (firstDfLine) {
      firstDfLine = false;
      return;
    }
    if (l.trim() !== '') onLine(`ND-DF ${l}`);
  });
  return dockerStats !== 0 ? dockerStats : df;
}

// ── 0.15 T2b: node terminals ────────────────────────────────────────────────
//
// `terminal.open` (sealed only) starts the exec or the host-shell helper and
// parks it under a single-use channel for 30 s; the panel then connects
// `GET /agent/terminal` with that channel and every frame is encrypted and
// authenticated per channel (lib/agentFrameCipher.ts). The process is killed
// (HUP then KILL, or the helper removed) whenever the panel connection drops.
// No byte of terminal input or output is ever logged or stored (O2).

/** WebSocket route of the terminal channel. */
export const AGENT_TERMINAL_PATH = '/agent/terminal';
/** Subprotocol carrying the channel id (`ninedeploy.agent-terminal.<channelId>`). */
export const AGENT_TERMINAL_PROTOCOL_PREFIX = 'ninedeploy.agent-terminal.';
/** A channel nobody attached within this window is closed and its process killed. */
export const TERMINAL_CHANNEL_TTL_MS = 30_000;
/** Channels (pending + attached) one agent holds at a time. */
export const TERMINAL_MAX_CHANNELS = 8;
/** Hard cap on one channel's life, whatever the panel's settings say. */
export const TERMINAL_HARD_CAP_MS = 24 * 3600 * 1000;
/** The panel's first frame (it authenticates the channel) must arrive within this window. */
export const TERMINAL_AUTH_TIMEOUT_MS = 10_000;
/** Backpressure: stop reading the process while the panel socket holds more than this. */
const TERMINAL_BACKPRESSURE_HIGH = 4 * 1024 * 1024;
const TERMINAL_HELPER_SWEEP_MS = 60_000;

/** The node's own containers a terminal must never enter (the agent holds the token hash, the proxy the certificates). */
const AGENT_CONTAINER = 'ninedeploy-agent';

interface TerminalChannel {
  id: string;
  salt: Buffer;
  tty: import('./lib/dockerTty.js').TtyProcess;
  kind: 'container' | 'host';
  sessionId: number;
  /** The host-shell helper's container id (host channels). */
  helperId: string | null;
  state: 'pending' | 'attached' | 'closed';
  timers: NodeJS.Timeout[];
}

const terminalChannels = new Map<string, TerminalChannel>();
/** Host-shell helpers this process started and has not yet seen removed. */
const ownTerminalHelpers = new Set<string>();
let helperSweep: NodeJS.Timeout | undefined;

/** Live terminal channels (pending + attached), for tests and the shutdown hook. */
export const terminalChannelCount = (): number => terminalChannels.size;

/** Close a channel: stop its timers, forget it, kill the process. Idempotent, never throws. */
async function closeTerminalChannel(ch: TerminalChannel): Promise<void> {
  if (ch.state === 'closed') return;
  ch.state = 'closed';
  for (const t of ch.timers) clearTimeout(t);
  terminalChannels.delete(ch.id);
  try {
    await ch.tty.kill();
  } catch {
    /* gone already: the sweep is the backstop */
  }
}

/** Close every channel (agent shutdown, tests). */
export async function closeAllTerminalChannels(): Promise<void> {
  await Promise.all([...terminalChannels.values()].map((ch) => closeTerminalChannel(ch)));
  if (helperSweep) clearInterval(helperSweep);
  helperSweep = undefined;
}

/**
 * Backstop for helpers whose kill did not land (a Docker hiccup): every 60 s,
 * remove the host-shell helpers this process started whose channel is gone,
 * and any terminal helper past its expiry label. Started with the first host
 * channel, so an agent that never opens one never lists containers.
 */
function ensureHelperSweep(): void {
  if (helperSweep) return;
  helperSweep = setInterval(() => {
    void (async () => {
      const { dockerTransport, isEngineTransport, listContainersWithLabel, forceRemoveContainer, TERMINAL_SESSION_LABEL, TERMINAL_EXPIRES_LABEL } =
        await import('./lib/dockerTty.js');
      const t = dockerTransport();
      if (!isEngineTransport(t)) return;
      const live = new Set([...terminalChannels.values()].map((c) => c.helperId).filter((id): id is string => id !== null));
      const nowSec = Math.floor(Date.now() / 1000);
      for (const h of await listContainersWithLabel(t, TERMINAL_SESSION_LABEL)) {
        const expires = Number(h.labels[TERMINAL_EXPIRES_LABEL]);
        const expired = Number.isFinite(expires) && expires > 0 && expires < nowSec;
        if (expired || (ownTerminalHelpers.has(h.id) && !live.has(h.id))) {
          await forceRemoveContainer(t, h.id).catch(() => undefined);
          ownTerminalHelpers.delete(h.id);
        }
      }
    })().catch(() => undefined);
  }, TERMINAL_HELPER_SWEEP_MS);
  helperSweep.unref?.();
}

function intParam(p: Params, k: string, min: number, max: number): number {
  const v = p[k];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`Invalid ${k}`);
  return v;
}

/**
 * True for a container a node terminal must not enter: the agent's own (it
 * holds the token hash every sealed request is keyed with), the node proxy
 * (certificates), and terminal helpers. Every service container on a node is
 * named `<slug>-<deployment>` with no label, so there is no positive marker to
 * require — the panel names only containers it resolved from its own rows,
 * inside a sealed request.
 */
async function refusedTerminalContainer(name: string, summary: { id: string; hostname: string | null; labels: Record<string, string> }) {
  const { hostname } = await import('node:os');
  const { TERMINAL_SESSION_LABEL } = await import('./lib/dockerTty.js');
  if (name === AGENT_CONTAINER || name === PROXY_CONTAINER) return true;
  if (summary.labels[TERMINAL_SESSION_LABEL] !== undefined) return true;
  const own = hostname();
  if (/^[0-9a-f]{12,64}$/.test(own) && summary.id.startsWith(own)) return true;
  return existsSync('/.dockerenv') && summary.hostname === own;
}

/** The host-shell helper image on a node: `NINEDEPLOY_HOST_SHELL_IMAGE`, else the node proxy's image (already present). */
export function nodeHostShellImage(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env['NINEDEPLOY_HOST_SHELL_IMAGE'] ?? '').trim();
  return configured && configured.length <= 255 && RE_IMAGE.test(configured) ? configured : PROXY_IMAGE;
}

/**
 * `terminal.open {kind, container?, cols, rows, sessionId}` → one line,
 * `ND-TERMINAL {"channel","salt"}`, inside the sealed reply. Refused unless
 * the request arrived sealed (the reply carries the channel key's salt).
 */
async function terminalOpenOp(params: Params, onLine: (l: string) => void, sealed: boolean): Promise<number> {
  if (!sealed) {
    throw new Error('Refusing to open a terminal over the unencrypted transport: terminal.open is accepted only inside a sealed request');
  }
  const kind = str(params, 'kind');
  if (kind !== 'container' && kind !== 'host') throw new Error('Invalid terminal kind');
  const cols = intParam(params, 'cols', 10, 500);
  const rows = intParam(params, 'rows', 5, 200);
  const sessionId = intParam(params, 'sessionId', 1, 2 ** 31 - 1);
  if (kind === 'host' && nodeHostTerminalForbidden()) {
    throw new Error('Host shells are disabled on this node (NINEDEPLOY_AGENT_HOST_TERMINAL=off)');
  }
  const container = kind === 'container' ? validated(str(params, 'container'), RE_NAME, 'container name') : null;
  if (container !== null && container.length > 128) throw new Error('Invalid container name');
  if (terminalChannels.size >= TERMINAL_MAX_CHANNELS) {
    throw new Error(`Too many open terminals on this node (at most ${TERMINAL_MAX_CHANNELS})`);
  }
  const tty = await import('./lib/dockerTty.js');
  const t = tty.dockerTransport();
  if (!tty.isEngineTransport(t)) throw new Error(`Terminals need the Docker Engine API on this node (${t.reason})`);

  let proc: import('./lib/dockerTty.js').TtyProcess;
  let helperId: string | null = null;
  if (kind === 'host') {
    const image = nodeHostShellImage();
    const probe = await tty.probeHostShellImage(t, image);
    if (!probe.ok) throw new Error(`Cannot start a host shell on this node: ${probe.reason}. Set NINEDEPLOY_HOST_SHELL_IMAGE on the agent to an image with nsenter.`);
    const helper = await tty.openHostShellTty(t, {
      image,
      sessionId,
      expiresAt: Math.ceil((Date.now() + TERMINAL_HARD_CAP_MS) / 1000) + 60,
      cols,
      rows,
    });
    helperId = helper.containerId;
    ownTerminalHelpers.add(helperId);
    ensureHelperSweep();
    proc = helper;
  } else {
    const name = container as string;
    const summary = await tty.inspectContainer(t, name);
    if (!summary) throw new Error(`Container ${name} does not exist on this node`);
    if (!summary.running) throw new Error(`Container ${name} is not running`);
    if (await refusedTerminalContainer(name, summary)) throw new Error(`A shell inside ${name} is refused`);
    proc = await tty.openExecTty(t, { container: name, cmd: tty.SHELL_CMD, cols, rows });
  }

  const { randomBytes } = await import('node:crypto');
  const { FRAME_SALT_BYTES } = await import('./lib/agentFrameCipher.js');
  const ch: TerminalChannel = {
    id: randomBytes(16).toString('hex'),
    salt: randomBytes(FRAME_SALT_BYTES),
    tty: proc,
    kind,
    sessionId,
    helperId,
    state: 'pending',
    timers: [],
  };
  const unref = (timer: NodeJS.Timeout) => {
    timer.unref?.();
    return timer;
  };
  ch.timers.push(
    unref(setTimeout(() => {
      if (ch.state === 'pending') void closeTerminalChannel(ch);
    }, TERMINAL_CHANNEL_TTL_MS)),
    unref(setTimeout(() => void closeTerminalChannel(ch), TERMINAL_HARD_CAP_MS)),
  );
  // A process that ends before anyone attached frees its slot at once.
  proc.onEnd(() => {
    if (ch.state === 'pending') void closeTerminalChannel(ch);
  });
  terminalChannels.set(ch.id, ch);
  onLine(`ND-TERMINAL ${JSON.stringify({ channel: ch.id, salt: ch.salt.toString('base64') })}`);
  return 0;
}

/** The parts of a `ws` socket the channel bridge uses. */
interface AgentTerminalSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', cb: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close' | 'error', cb: () => void): unknown;
}

/** The channel id a handshake offers, or null. */
export function agentTerminalChannelId(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  const entry = raw
    .split(',')
    .map((p) => p.trim())
    .find((p) => p.startsWith(AGENT_TERMINAL_PROTOCOL_PREFIX));
  const id = entry?.slice(AGENT_TERMINAL_PROTOCOL_PREFIX.length) ?? '';
  return /^[0-9a-f]{32}$/.test(id) ? id : null;
}

/**
 * Bridge one attached channel: decrypt the panel's frames into the process,
 * encrypt its output back. The process's output is withheld until the
 * panel's first frame has authenticated (anyone can race a WebSocket to the
 * channel id; only the panel can derive the key). Any bad frame, the socket
 * closing, or the process ending closes the channel and kills the process.
 */
async function bridgeTerminalChannel(socket: AgentTerminalSocket, ch: TerminalChannel, tokenHash: string): Promise<void> {
  const { deriveFrameKey, FrameOpener, FrameSealer, FRAME_TYPE, decodeResize, encodeExit } = await import('./lib/agentFrameCipher.js');
  const key = deriveFrameKey(tokenHash, ch.salt);
  const rx = new FrameOpener(key, 'panel');
  const tx = new FrameSealer(key, 'agent');
  const OPEN = 1;
  let authed = false;
  let panelPaused = false;
  let pressurePaused = false;
  let drain: NodeJS.Timeout | undefined;
  const shut = (code: number, reason: string) => {
    clearInterval(drain);
    try {
      if (socket.readyState === OPEN) socket.close(code, reason);
    } catch {
      /* already closed */
    }
    void closeTerminalChannel(ch);
  };
  const send = (frame: Buffer) => {
    if (socket.readyState !== OPEN) return;
    try {
      socket.send(frame);
    } catch {
      /* closed: the close handler ends the channel */
    }
  };
  const authTimer = setTimeout(() => {
    if (!authed) shut(1008, 'channel not authenticated');
  }, TERMINAL_AUTH_TIMEOUT_MS);
  authTimer.unref?.();
  ch.timers.push(authTimer);

  const applyPause = () => {
    if (panelPaused || pressurePaused) ch.tty.pause();
    else ch.tty.resume();
  };
  const startOutput = () => {
    ch.tty.onData((chunk) => {
      if (ch.state === 'closed') return;
      for (const frame of tx.sealData(chunk)) send(frame);
      if (!pressurePaused && socket.bufferedAmount > TERMINAL_BACKPRESSURE_HIGH) {
        pressurePaused = true;
        applyPause();
        drain = setInterval(() => {
          if (socket.readyState !== OPEN || socket.bufferedAmount <= TERMINAL_BACKPRESSURE_HIGH / 4) {
            clearInterval(drain);
            pressurePaused = false;
            applyPause();
          }
        }, 50);
        drain.unref?.();
      }
    });
    ch.tty.onEnd((code) => {
      send(tx.seal(FRAME_TYPE.exit, encodeExit(code)));
      shut(1000, 'shell exited');
    });
  };

  socket.on('message', (data, isBinary) => {
    if (ch.state === 'closed') return;
    if (!isBinary) return shut(1008, 'text frames are not part of this protocol');
    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data as Buffer[]) : Buffer.from(data as ArrayBuffer);
    let frame: { type: number; payload: Buffer };
    try {
      frame = rx.open(bytes);
    } catch {
      return shut(1008, 'bad frame');
    }
    if (!authed) {
      authed = true;
      clearTimeout(authTimer);
      startOutput();
    }
    switch (frame.type) {
      case FRAME_TYPE.data:
        ch.tty.write(frame.payload);
        return;
      case FRAME_TYPE.resize: {
        const size = decodeResize(frame.payload);
        if (size) ch.tty.resize(size.cols, size.rows);
        return;
      }
      case FRAME_TYPE.pause:
        panelPaused = true;
        applyPause();
        return;
      case FRAME_TYPE.resume:
        panelPaused = false;
        applyPause();
        return;
      case FRAME_TYPE.close:
        return shut(1000, 'closed by the panel');
      default:
        // `exit` is the agent's to send.
        return shut(1008, 'unexpected frame');
    }
  });
  socket.on('close', () => shut(1000, ''));
  socket.on('error', () => shut(1011, ''));
}

/** Test hook: forget every channel without touching processes. */
export function _resetAgentTerminals(): void {
  for (const ch of terminalChannels.values()) for (const t of ch.timers) clearTimeout(t);
  terminalChannels.clear();
  ownTerminalHelpers.clear();
  if (helperSweep) clearInterval(helperSweep);
  helperSweep = undefined;
}

/**
 * Operations handled by `runOp` directly rather than through the argv table.
 * The route consults this alongside `OPS` so a new handler cannot be reachable
 * without being listed here (or unreachable after being added).
 */
/** 0.16: git's refusal of `--depth` by a server without shallow support (dumb HTTP, some self-hosted servers). */
const SHALLOW_UNSUPPORTED = /does not support shallow|dumb http transport/i;

const HANDLED_OPS = new Set([
  'agent.ping',
  'workspace.remove',
  'agent.stats',
  'file.writeEnv',
  'file.deleteEnv',
  'file.writeWorkspace',
  'file.deleteWorkspace',
  'docker.pull',
  'docker.composeRestartPolicy',
  'git.ensure',
  'proxy.writeConfig',
  'proxy.ensure',
  // 0.15 (T2b): sealed only; advertised as the `terminal` capability.
  'terminal.open',
  // Multi-node (design §1, M8): every op registered in agentOps/index.ts,
  // each gated on its capability. Listed here so the exec route's reachability
  // check and the op-table snapshot see them like any other handled op.
  ...AGENT_OPS.keys(),
]);

/**
 * Run one typed operation (exported for tests). `ctx.sealed` says the request
 * arrived inside a sealed envelope; only then is a Git credential accepted.
 */
export async function runOp(
  op: string,
  params: Params,
  rawOnLine: (l: string) => void,
  ctx: { sealed?: boolean } = {},
): Promise<number> {
  // 0.13 (T5): validated before anything touches the node; its output
  // redactor wraps every line the op produces.
  const credential = gitCredentialEnv(op, params, ctx.sealed === true);
  const onLine = credential ? (l: string) => rawOnLine(credential.redact(l)) : rawOnLine;
  const credentialOpts = credential ? { env: credential.env } : {};
  if (op === 'agent.ping') {
    // r660: version + capabilities ride inside the sealed answer, so the panel
    // can refuse what an older agent would do unsafely (see AGENT_CAPABILITIES).
    const { VERSION } = await import('./version.js');
    onLine(`ND-AGENT ${JSON.stringify({ version: VERSION, caps: agentCapabilities() })}`);
    return 0;
  }
  if (op === 'workspace.remove') {
    // r662: a deleted (or moved-away) service's checkout used to stay on the
    // node forever, source and build context included. The name is validated
    // like every workspace operand; `rm -r` removes a symlink inside the tree
    // as a link, never what it points at.
    const { rmSync } = await import('node:fs');
    const pathmod = await import('node:path');
    const safe = validated(str(params, 'workspace'), RE_NAME, 'workspace name');
    const root = pathmod.resolve(process.cwd(), WORK_DIR);
    const dir = pathmod.resolve(root, safe);
    if (!dir.startsWith(root + pathmod.sep)) throw new Error('Invalid workspace name');
    rmSync(dir, { recursive: true, force: true });
    onLine(`workspace ${safe} removed`);
    return 0;
  }
  if (op === 'agent.stats') return agentStatsOp(onLine);
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
      // r227: widen a checkout made by an older agent (a shallow clone is
      // single-branch, and `fetch --all` follows only its refspec) so every
      // branch's tip is fetched.
      await spawnValidated('git', ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], () => undefined, { cwd: dir });
      // r268: `url` used to be ignored once a checkout existed, so a service
      // whose repository URL changed (or a new service reusing a slug) kept
      // fetching the OLD origin forever and deployed its code. Point origin
      // at the requested URL — already validated by `isRepoUrl` above, so it
      // cannot be a local path or read as an option. `set-url` to the same
      // value is a no-op, so this runs unconditionally.
      const setUrl = await spawnValidated('git', ['remote', 'set-url', 'origin', url], onLine, { cwd: dir });
      if (setUrl !== 0) return setUrl;
      return spawnValidated('git', [...GIT_EGRESS_FLAGS, 'fetch', '--all', '--prune'], onLine, { cwd: dir, ...credentialOpts });
    }
    // F813: `git clone <url> .` refuses a non-empty directory before any
    // transport, and the workspace is shared with the service's other source
    // kinds — an inline compose deploy leaves its docker-compose.yml here, as
    // does a stale workspace a reused slug inherits. Without a `.git` nothing
    // in it is a checkout; clear it (links are removed as links) and clone.
    const { readdirSync, rmSync } = await import('node:fs');
    const leftovers = readdirSync(dir);
    if (leftovers.length > 0) {
      for (const entry of leftovers) rmSync(pathmod.join(dir, entry), { recursive: true, force: true });
      onLine(`workspace held ${leftovers.length} non-repository file(s) — cleared before cloning`);
    }
    const depth = str(params, 'depth');
    const argv = [...GIT_EGRESS_FLAGS, 'clone'];
    // r227: `--depth` implies `--single-branch`: a service on any branch but
    // the default then failed `git checkout <branch>` on the node.
    if (depth !== undefined) argv.push('--depth', /^\d{1,3}$/.test(depth) ? depth : '1', '--no-single-branch');
    argv.push(url, '.');
    if (depth === undefined) return spawnValidated('git', argv, onLine, { cwd: dir, ...credentialOpts });
    // 0.16: a server without shallow support (git's dumb HTTP transport, some
    // self-hosted servers) refuses `--depth` outright, while a full clone of
    // the same repository works. Retry ONCE without it on that refusal only;
    // the retry keeps the egress flags, the credential env and the redacting
    // `onLine`. Any other failure is returned as is.
    let shallowUnsupported = false;
    const watch = (line: string) => {
      if (SHALLOW_UNSUPPORTED.test(line)) shallowUnsupported = true;
      onLine(line);
    };
    const shallow = await spawnValidated('git', argv, watch, { cwd: dir, ...credentialOpts });
    if (shallow === 0 || !shallowUnsupported) return shallow;
    onLine('the git server does not support shallow clones (dumb HTTP transport) — retrying with a full clone');
    // A failed `clone .` may leave a partial checkout behind; `clone .` needs an empty directory.
    for (const entry of readdirSync(dir)) rmSync(pathmod.join(dir, entry), { recursive: true, force: true });
    return spawnValidated('git', [...GIT_EGRESS_FLAGS, 'clone', url, '.'], onLine, { cwd: dir, ...credentialOpts });
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
  if (op === 'terminal.open') {
    return terminalOpenOp(params, onLine, ctx.sealed === true);
  }
  if (op === 'git.reset') {
    // r227: a pinned commit older than the shallow tip (a rollback, or a
    // deploy of a commit the branch has since moved past) is absent from a
    // depth-1 checkout — fetch exactly that commit before resetting to it.
    const sha = validated(str(params, 'sha') ?? 'HEAD', RE_SHA, 'commit sha');
    const workspace = str(params, 'workspace');
    const opts = workspace === undefined ? {} : { cwd: await resolveWorkspace(workspace) };
    if (sha !== 'HEAD') {
      const present = await spawnValidated('git', ['cat-file', '-e', `${sha}^{commit}`], () => undefined, opts);
      if (present !== 0) {
        // 0.16: as in git.ensure, a server without shallow support refuses
        // `--depth`; fetch the commit once more without it on that refusal only.
        let shallowUnsupported = false;
        const watch = (line: string) => {
          if (SHALLOW_UNSUPPORTED.test(line)) shallowUnsupported = true;
          onLine(line);
        };
        const fetched = await spawnValidated('git', [...GIT_EGRESS_FLAGS, 'fetch', '--depth', '1', 'origin', sha], watch, { ...opts, ...credentialOpts });
        if (fetched !== 0 && shallowUnsupported) {
          onLine('the git server does not support shallow fetches (dumb HTTP transport) — retrying with a full fetch');
          await spawnValidated('git', [...GIT_EGRESS_FLAGS, 'fetch', 'origin', sha], onLine, { ...opts, ...credentialOpts });
        }
      }
    }
    return spawnValidated('git', ['reset', '--hard', sha], onLine, opts);
  }
  if (op === 'docker.pull') {
    const image = validated(str(params, 'image'), RE_IMAGE, 'image');
    // r417: a plain validated pull. This used to call the PANEL-side
    // pullDockerImage recovery machine (3 retries, ctr/tar crane downloads
    // from GitHub, 30-60 MINUTE step timeouts) — bypassing the agent's
    // spawnValidated invariant, outliving the panel's 600 s request budget
    // while the deploy had already failed, and relying on binaries the agent
    // container does not ship. A failed pull on a node now fails fast and
    // honestly; the panel surfaces the error and the deploy can be retried.
    return spawnValidated('docker', ['pull', image], onLine);
  }
  // Multi-node ops (agentOps/*.ts): the registry checks the capability's
  // kill switch and the sealed-only rule before the op's own validation.
  const registered = await runRegisteredOp(op, params, onLine, { sealed: ctx.sealed === true });
  if (registered !== null) return registered;
  const def = OPS[op];
  if (!def) return -1;
  // A `workspace` operand runs the op inside that service's own directory.
  // Git needs it (fetch/checkout/reset act on the cwd, so without it one host
  // could hold a single checkout); `docker build` uses it so two services'
  // build contexts cannot collide. Absent = the agent's own cwd, which is what
  // every host-level op (networks, prune, inspect) wants.
  const workspace = str(params, 'workspace');
  const cwd = workspace === undefined ? undefined : await resolveWorkspace(workspace);
  // r660: repository paths are symlink-walked under the directory the op
  // runs in before any argv exists.
  const argv = def.build(guardWorkspacePaths(op, params, cwd ?? process.cwd()));

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
  // r526: build/bring-up ops get the panel host's build budget instead of the
  // 595 s default (the panel waits as long for them — see LONG_AGENT_OPS).
  const timeoutMs = agentChildTimeoutMs(op);
  return spawnValidated(def.exe, argv, onLine, {
    ...(cwd === undefined ? {} : { cwd }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    // 0.13 (T5): only git.fetch can carry one on this path (gitCredentialEnv).
    ...credentialOpts,
  });
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

/** File (relative to the agent's working directory) holding an auto-join token. */
export const AGENT_TOKEN_FILE = '.agent-token';

/** The persisted auto-join token, created (owner-only) on first use. */
export function loadOrCreateAgentToken(generate: () => string, dir = process.cwd()): string {
  const file = joinPath(dir, AGENT_TOKEN_FILE);
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32,128}$/.test(stored)) return stored;
  }
  const token = generate();
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

async function main(): Promise<void> {
  const masterUrl = process.env['NINEDEPLOY_MASTER_URL'] ?? '';
  let tokenHash = process.env['NINEDEPLOY_AGENT_TOKEN'] ?? '';
  let rawToken = process.env['NINEDEPLOY_AGENT_RAW_TOKEN'] ?? '';

  if (!tokenHash && masterUrl) {
    // Auto-discovery mode: generate a local token pair and announce to master.
    // r176: persist it. A fresh random token on every start made the master
    // refuse the next announce ("token mismatch") while still holding the old
    // token, so every agentOp got 401 until the node was deleted and
    // re-approved by hand — after any reboot or container update.
    const { randomBytes, createHash } = await import('node:crypto');
    rawToken = rawToken || loadOrCreateAgentToken(() => randomBytes(32).toString('hex'));
    tokenHash = createHash('sha256').update(rawToken).digest('hex');
  }

  if (!tokenHash) {
    // eslint-disable-next-line no-console
    console.error('NINEDEPLOY_AGENT_TOKEN (sha256 hash) or NINEDEPLOY_MASTER_URL is required in agent mode');
    process.exit(1);
  }
  const port = Number(process.env['NINEDEPLOY_AGENT_PORT'] ?? 4600);

  const app = await buildAgentApp();
  await app.register(agentRoutes, { tokenHash, nonceFile: joinPath(process.cwd(), AGENT_NONCE_FILE) });

  await app.listen({ host: '0.0.0.0', port });
  // eslint-disable-next-line no-console
  console.log(`NineDeploy agent listening on :${port} (${Object.keys(OPS).length} typed deploy operations)`);
  // Multi-node (design §1.5): sweep stream transfer files an earlier process
  // left behind (an agent that died mid-transfer), now and every 10 minutes.
  startTransferSweep();

  if (masterUrl) {
    const { hostname } = await import('node:os');
    const nodeName = process.env['NINEDEPLOY_NODE_NAME'] || hostname();
    const advertiseHost = process.env['NINEDEPLOY_ADVERTISE_HOST'] || undefined;
    const announce = () =>
      announceToMaster(masterUrl, {
        name: nodeName,
        host: advertiseHost,
        port,
        token: rawToken,
      }).catch(() => undefined);
    void announce();
    // r421 heartbeat: `online` used to mean "last BOOT" — the panel reported
    // a dead node green forever (nothing else advanced lastSeenAt). A 60 s
    // re-announce makes lastSeenAt real and the panel's staleness display
    // honest. Announce is idempotent for a matched token (name/lastSeenAt
    // refresh only).
    const heartbeat = setInterval(announce, 60_000);
    heartbeat.unref();
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

/** r667: output characters one op answer carries (see the exec route). */
const MAX_OP_OUTPUT_CHARS = 16 * 1024 * 1024;

/** r668: the panel's nonce is 32 hex chars; anything bounded and token-shaped is accepted. */
const RE_NONCE = /^[A-Za-z0-9_-]{1,128}$/;
/** r668: hard ceiling on remembered nonces (the rate limit keeps it far below). */
const MAX_SEEN_NONCES = 20_000;

/** File (relative to the agent's working directory) persisting seen nonces across restarts. */
export const AGENT_NONCE_FILE = '.agent-nonces';

/**
 * r668: reload the unexpired nonces persisted by {@link recordSeenNonce} and
 * rewrite the file with just those. A missing or unreadable file starts empty
 * — the in-memory protection still applies from the first request on.
 */
export function loadSeenNonces(file: string, into: Map<string, number>): void {
  const now = Date.now();
  try {
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const [nonce, exp] = line.trim().split(' ');
        const expiry = Number(exp);
        if (nonce && RE_NONCE.test(nonce) && Number.isFinite(expiry) && expiry > now && into.size < MAX_SEEN_NONCES) {
          into.set(nonce, expiry);
        }
      }
    }
    persistSeenNonces(file, into);
  } catch (err) {
    console.warn(`[NineDeploy Agent] Could not restore the replay cache from ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** r668: rewrite the file with exactly the live entries (compaction). */
function persistSeenNonces(file: string, seen: Map<string, number>): void {
  writeFileSync(file, [...seen].map(([n, e]) => `${n} ${e}\n`).join(''), { mode: 0o600 });
}

/** r668: appends between two compactions, so the file stays near the live set's size. */
const NONCE_COMPACT_EVERY = 5_000;

/** r668: append one seen nonce (best effort — the in-memory map is authoritative while running). */
function recordSeenNonce(file: string, nonce: string, expiry: number): void {
  try {
    appendFileSync(file, `${nonce} ${expiry}\n`, { mode: 0o600 });
  } catch {
    /* disk full / read-only — protection holds until the next restart */
  }
}

/**
 * The agent's HTTP surface, as a registerable plugin (used by main() and by
 * route tests). `tokenHash` is the sha256 of the shared agent token.
 */
export const agentRoutes = async (app: import('fastify').FastifyInstance, opts: { tokenHash?: string; nonceFile?: string }) => {
  /** Sealed-request nonces seen within the replay window → expiry (r174). */
  const seenNonces = new Map<string, number>();
  const tokenHash = opts.tokenHash ?? process.env['NINEDEPLOY_AGENT_TOKEN'] ?? '';
  // r668: the cache used to live only in memory, so restarting the agent (a
  // crash, an update, a reboot) reopened the replay window for every envelope
  // captured in the five minutes before. Seen nonces are appended to a file
  // and reloaded at start; the file is compacted to the live entries then.
  const nonceFile = opts.nonceFile;
  if (nonceFile !== undefined) loadSeenNonces(nonceFile, seenNonces);
  let appendedSinceCompact = 0;

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
    // r174: refuse a replayed request. The nonce used to bind only the
    // RESPONSE: a captured sealed `docker.rm` / `git.reset` envelope could be
    // re-posted for the whole ±5-minute seal window and it ran again. Every
    // nonce is remembered for twice that window (covering clock skew in both
    // directions).
    // r668: a sealed request WITHOUT a nonce is refused. Every panel since
    // 0.7.3 seals a fresh nonce into each request (agentOp and the sealed
    // ping), so the "pre-nonce core" this used to wave through cannot drive a
    // supported agent — while a nonce-less envelope was replayable for the
    // whole window, which is all an attacker needed to strip.
    if (sealedRequest) {
      if (typeof input.nonce !== 'string' || !RE_NONCE.test(input.nonce)) {
        return reply.code(401).send({
          error: { code: 'nonce_required', message: 'Sealed agent requests must carry a nonce — upgrade the NineDeploy panel' },
        });
      }
      const now = Date.now();
      for (const [n, exp] of seenNonces) if (exp <= now) seenNonces.delete(n);
      if (seenNonces.has(input.nonce)) {
        return reply.code(401).send({ error: { code: 'replayed', message: 'Replayed agent request' } });
      }
      // A bounded table: the route's rate limit already caps it near 1200.
      if (seenNonces.size >= MAX_SEEN_NONCES) {
        return reply.code(429).send({ error: { code: 'busy', message: 'Too many agent requests in the replay window' } });
      }
      const expiry = now + 2 * MAX_SKEW_MS;
      seenNonces.set(input.nonce, expiry);
      if (nonceFile !== undefined) {
        if (++appendedSinceCompact >= NONCE_COMPACT_EVERY) {
          appendedSinceCompact = 0;
          try {
            persistSeenNonces(nonceFile, seenNonces);
          } catch {
            /* best effort, like the append */
          }
        } else {
          recordSeenNonce(nonceFile, input.nonce, expiry);
        }
      }
    }
    const op = typeof input.op === 'string' ? input.op : '';
    const params: Params = typeof input.params === 'object' && input.params ? (input.params as Params) : {};
    if (!OPS[op] && !HANDLED_OPS.has(op)) {
      return reply.code(400).send({ error: { code: 'unknown_op', message: `Unknown operation: ${op}` } });
    }
    const lines: string[] = [];
    // r667: the answer carries every output line, and 300 log LINES (or a
    // chatty build) is no byte bound. Past MAX_OP_OUTPUT_CHARS the oldest
    // lines are dropped — the end of an output is where its error is.
    let keptChars = 0;
    let dropped = 0; // lines[0..dropped) are discarded (compacted in batches, never shifted one by one)
    let droppedEarlier = 0;
    const collect = (l: string) => {
      lines.push(l);
      keptChars += l.length;
      while (keptChars > MAX_OP_OUTPUT_CHARS && lines.length - dropped > 1) {
        keptChars -= (lines[dropped] as string).length;
        lines[dropped] = '';
        dropped += 1;
      }
      if (dropped >= 65_536) {
        lines.splice(0, dropped);
        droppedEarlier += dropped;
        dropped = 0;
      }
    };
    let exitCode: number;
    // For file.writeEnv, surface the remote env-file path for docker.runEnv.
    let envFile: string | null = null;
    try {
      // 0.13 (T5): a Git credential is accepted only from a sealed request.
      exitCode = await runOp(op, params, collect, { sealed: sealedRequest });
      if (dropped + droppedEarlier > 0) {
        lines.splice(0, dropped, `… ${dropped + droppedEarlier} earlier output line(s) omitted by the agent`);
      }
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

  // 0.15 (T2b): the node terminal channel. No token check here: the channel
  // id comes only from a SEALED `terminal.open` reply, is single use and
  // expires in 30 s, and every frame is encrypted and authenticated under a
  // key derived from the shared secret — a peer without it can neither feed
  // the shell nor read it. Anything but a pending channel closes 1008.
  if (!app.hasDecorator('websocketServer')) {
    // agentApp registers it; a bare instance (tests) gets the same options here.
    const { default: websocket } = await import('@fastify/websocket');
    await app.register(websocket, agentWebsocketOptions);
  }
  app.addHook('onClose', async () => {
    await closeAllTerminalChannels();
    await closeAllStreamChannels();
  });
  app.get(AGENT_TERMINAL_PATH, { websocket: true, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, (socket, req) => {
    const id = agentTerminalChannelId(req.headers['sec-websocket-protocol']);
    const ch = id === null ? undefined : terminalChannels.get(id);
    if (!ch || ch.state !== 'pending') {
      try {
        socket.close(1008, 'unknown terminal channel');
      } catch {
        /* already closed */
      }
      return;
    }
    // Consumed: a second connection with the same id finds nothing.
    ch.state = 'attached';
    void bridgeTerminalChannel(socket as unknown as AgentTerminalSocket, ch, tokenHash).catch(() => {
      try {
        socket.close(1011, 'terminal error');
      } catch {
        /* already closed */
      }
      void closeTerminalChannel(ch);
    });
  });

  // Multi-node (design §1.4): the sealed stream channel `GET /agent/stream`,
  // handed out only by a SEALED `stream.open` (agentOps/stream.ts). Same
  // model as the terminal channel above: single use, 30 s to attach, every
  // frame encrypted under a per-channel key (stream-domain HKDF info).
  await agentStreamRoute(app, { tokenHash });
};

// Boot when the agent flag is set. Tests set NINEDEPLOY_AGENT=1 explicitly
// (via test/agentBoot.test.ts) so the boot path stays covered.
if (process.env['NINEDEPLOY_AGENT'] === '1') {
  // Parity with the panel's r168 guard: a stray rejected promise in a
  // fire-and-forget path must be logged, not kill the agent mid-deploy.
  process.on('unhandledRejection', (reason) => {
    console.error(`[NineDeploy Agent] Unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });
  // A failed BOOT, by contrast, should exit nonzero so systemd's
  // Restart=on-failure sees a clean failure instead of a half-booted agent
  // idling against the panel forever.
  void main().catch((err: unknown) => {
    console.error(`[NineDeploy Agent] Boot failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

export const agentMode = { main, OPS, HANDLED_OPS, AGENT_OPS };
