import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Builder } from '../types.js';
import type { BuildConfig } from '@ninedeploy/db';
import type { NinedeployManifest } from '@ninedeploy/schemas';
import { generateNixpacksToml } from '../../lib/ninedeployToNixpacks.js';
import { buildEnv, capture, run, sleep } from '../../lib/exec.js';
import { composeScalar, dotenvValue } from './compose.js';
import { ensureDockerImage, pullDockerImage } from '../../lib/dockerPull.js';
import { NETWORK } from '../proxy.js';
import { MAX_REPLICAS, deploymentLabels, replicaNames } from '../dockerNames.js';
import { ensureServiceBridge } from '../../lib/serviceBridge.js';
import { buildWithBuildKit } from './buildkit.js';
import { buildStaticSite } from './staticSite.js';
import { buildProbeUrl, safeProbePath } from '../../lib/probeUrl.js';
import { writeSecretFile, type SecretFile } from '../../lib/secretFile.js';
import { pullableReleaseRef } from '../fanout.js';
import { repoRelative, resolveInRepo } from '../../lib/repoPath.js';
import { acquireRegistryLock, registryLockKey } from '../../lib/registryLock.js';

/**
 * Find a Dockerfile inside a repo when the user kept `baseDir: '/'` and
 * did not set an explicit `dockerfilePath` — the common monorepo shape
 * (`/Dockerfile` for infra, `/apps/api/Dockerfile` for the app). Search is
 * intentionally shallow (top 2 directory levels) so a giant checkout cannot
 * stall the build on a multi-second walk, and the closest Dockerfile to the
 * root wins so a stray tool's build artefact never hijacks the build.
 *
 * Returns the relative path to the Dockerfile (e.g. `apps/api/Dockerfile`)
 * and the relative baseDir (e.g. `apps/api`) it lives in. Both are returned
 * as repo-relative POSIX paths for direct use with `docker build -f`.
 */
function findDockerfileInRepo(
  workDir: string,
  log: (line: string) => void,
): { dockerfilePath: string; baseDir: string } | null {
  const MAX_DEPTH = 2;
  const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo', '.cache', 'vendor', '.venv']);
  let best: { rel: string; depth: number; dirRel: string } | null = null;

  const walk = (absDir: string, relDir: string, depth: number): void => {
    if (best && best.depth <= depth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    // Check for Dockerfile at this level first — the shallowest hit wins.
    for (const e of entries) {
      if (e.isFile() && (e.name === 'Dockerfile' || e.name === 'dockerfile')) {
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        if (!best || depth < best.depth) {
          best = { rel, depth, dirRel: relDir };
        }
        return;
      }
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.')) continue;
      const childRel = relDir ? `${relDir}/${e.name}` : e.name;
      walk(path.join(absDir, e.name), childRel, depth + 1);
    }
  };

  walk(workDir, '', 0);
  if (!best) return null;
  // `best` is captured by the closure but TypeScript narrows it back to
  // `never` once `walk` returns because the inner reassignments live in a
  // separate function scope. Re-bind through a local for type-safe access.
  const found: { rel: string; depth: number; dirRel: string } = best;
  // The Dockerfile itself is always in its directory — baseDir is that dir.
  const baseDir = found.dirRel;
  log(`📁 Auto-detected Dockerfile at ${found.rel} (depth ${found.depth})`);
  return { dockerfilePath: found.rel, baseDir: baseDir || '.' };
}

/**
 * r666: the `docker build -f` operand for a Dockerfile build.
 *
 * The Settings field reads the Dockerfile path relative to the base
 * directory, and the existence check (`hasDockerfile`) always looked there —
 * but the build passed `-f` relative to the repository ROOT (docker resolves
 * `-f` against its cwd, the checkout). With `baseDir: apps/web` and the
 * default `Dockerfile` the check found `apps/web/Dockerfile` and the build
 * then failed on a repo without a root Dockerfile (or built the root one).
 *
 * Upgrade-safe resolution: a repo-root-relative file that exists keeps
 * winning, so every service that built before builds the SAME file now
 * (`baseDir` + a root Dockerfile, `baseDir` + a root-relative
 * `apps/web/Dockerfile`, and `baseDir` unset, where both readings agree);
 * only when it does not exist is the base-directory one used — the case that
 * could never build. Both candidates go through the symlink-refusing
 * `resolveInRepo`.
 */
export function resolveBuildDockerfile(
  workDir: string,
  baseDir: string | undefined,
  dockerfilePath: string,
  log: (line: string) => void = () => undefined,
): string {
  const rootRelative = repoRelative(workDir, dockerfilePath);
  const underBase = resolveInRepo(workDir, baseDir, dockerfilePath);
  const baseRelative = path.relative(path.resolve(workDir), underBase).split(path.sep).join('/') || '.';
  if (baseRelative === rootRelative) return rootRelative;
  if (existsSync(resolveInRepo(workDir, dockerfilePath))) {
    if (existsSync(underBase)) {
      log(
        `Both ${rootRelative} and ${baseRelative} exist — building ${rootRelative} (the path from the repository root), as earlier releases did. ` +
          `To build ${baseRelative} instead, set the build pack to "dockerfile" and the Dockerfile path to "${baseRelative}".`,
      );
    }
    return rootRelative;
  }
  return existsSync(underBase) ? baseRelative : rootRelative;
}

const swallow = () => {};
const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const PROBE_IMAGE = 'busybox:1.36';
const PROBE_CONTAINER = 'ninedeploy-prober';
const DEPLOY_HEARTBEAT_MS = 20_000;
const DEFAULT_NIXPACKS_PORT = 3000;

/** Valid docker --restart values: the fixed policies plus on-failure:N. */
const RE_RESTART = /^(no|always|unless-stopped|on-failure(?::\d{1,3})?)$/;
const safeRestartPolicy = (raw: string | undefined): string =>
  raw && RE_RESTART.test(raw) ? raw : 'unless-stopped';

const validPort = (raw: string | undefined): number | null => {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
};

let probeContainerReady = false;
let probeContainerInit: Promise<void> | null = null;

/** Keep one tiny network probe container instead of creating one per retry. */
async function ensureProbeContainer(log: (line: string) => void): Promise<void> {
  if (probeContainerReady) return;
  if (probeContainerInit) return probeContainerInit;
  probeContainerInit = (async () => {
    const state = await capture('docker', [
      'inspect', PROBE_CONTAINER,
      '--format', '{{.State.Running}}|{{json .NetworkSettings.Networks}}',
    ]).catch(() => '');
    if (!state) {
      await ensureDockerImage(PROBE_IMAGE, log);
      await run('docker', [
        'run', '-d', '--name', PROBE_CONTAINER, '--restart', 'unless-stopped',
        '--network', NETWORK, PROBE_IMAGE, 'sh', '-c', 'while :; do sleep 3600; done',
      ], {}, log);
    } else {
      if (!state.startsWith('true|')) await run('docker', ['start', PROBE_CONTAINER], {}, log);
      if (!state.includes(`"${NETWORK}"`)) {
        await run('docker', ['network', 'connect', NETWORK, PROBE_CONTAINER], {}, log).catch(() => undefined);
      }
    }
    probeContainerReady = true;
  })().finally(() => {
    probeContainerInit = null;
  });
  return probeContainerInit;
}

/** All user-defined networks a container is attached to (empty on inspect failure). */
async function containerNetworks(name: string): Promise<string[]> {
  try {
    const raw = await capture('docker', ['inspect', name, '--format', '{{json .NetworkSettings.Networks}}']);
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown> | null;
    return parsed ? Object.keys(parsed) : [];
  } catch {
    return [];
  }
}

/**
 * Model B puts every runtime on its own `nd-svc-<slug>` bridge, and Docker
 * drops traffic BETWEEN different bridges (DOCKER-ISOLATION chains). The probe
 * container lives on the shared `ninedeploy` mesh, so without joining the
 * runtime's bridge its `nc` times out against every container IP — and any app
 * that binds its port after the direct-probe grace period (first boot, DB
 * migrations) fails its healthcheck while perfectly healthy. Idempotent:
 * networks the prober already sits on are skipped; membership persists across
 * deploys, mirroring how Traefik is attached to every bridge.
 */
async function ensureProbeNetworks(runtimeId: string, log: (line: string) => void): Promise<void> {
  const runtimeNets = await containerNetworks(runtimeId);
  if (runtimeNets.length === 0) return;
  const joined = new Set(await containerNetworks(PROBE_CONTAINER));
  for (const network of runtimeNets) {
    if (joined.has(network)) continue;
    await run('docker', ['network', 'connect', network, PROBE_CONTAINER], {}, log).catch(
      (err: unknown) => log(
        `warning: could not attach ${PROBE_CONTAINER} to ${network}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
}

/**
 * Write runtime env vars to a private temp file (mode 0600, inside a 0700
 * mkdtemp directory) which docker then loads via its env-file option. Keeping
 * secrets in a file — rather than on the command line — keeps them out of
 * process listings and container inspection; the private directory keeps a
 * local user from pre-planting a symlink at the path (see lib/secretFile.ts).
 */
export function writeEnvFile(env: Record<string, string>): SecretFile | null {
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  // docker --env-file cannot contain physical newlines inside a value. Store
  // them as explicit escape sequences so subsequent lines cannot be parsed as
  // attacker-controlled keys and the convention matches the Compose builder.
  const body = entries.map(([k, v]) => `${k}=${v.replace(/\r\n?|\n/g, '\\n')}`).join('\n');
  return writeSecretFile('nd-env', 'service.env', `${body}\n`);
}

/**
 * r465: true when any resolved env value spans lines (PEM keys, JSON
 * documents). docker's `--env-file` parser cannot carry a physical newline —
 * such services used to receive a literal "\n" and choke on their own
 * credentials. Those services start through the compose bridge below instead,
 * whose dotenv parser decodes the escapes into REAL newlines (the same
 * byte-verified format the compose and remote-compose builders use).
 */
export function hasMultiLineEnv(env: Record<string, string>): boolean {
  return Object.values(env).some((v) => v.includes('\n'));
}

/** The compose-dotenv twin of the runtime env file: quoted, escape-decoded. */
export function writeComposeEnvFile(env: Record<string, string>): SecretFile | null {
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  const body = entries.map(([k, v]) => `${k}=${dotenvValue(v)}`).join('\n');
  return writeSecretFile('nd-env', 'service.compose.env', `${body}\n`);
}

interface RuntimeComposeInput {
  /** Container name — also the compose service key, so the network alias the
   * bridge provides equals the name `docker run` would have given. */
  name: string;
  image: string;
  restart: string;
  /** The service's own `nd-svc-<slug>` bridge, joined as an external network. */
  bridge: string;
  cpuShares: number;
  cpuLimitMilli: number;
  memLimitMb: number;
  dataVolume: string | null;
  dataMount: string | null;
  attachments: Array<{ volumeName: string; containerPath: string; readOnly?: boolean | null }>;
  publishedPort: number | null;
  containerPort: number | null;
  dockerSocket: boolean;
  cmd: string[] | null;
  envFile: string | null;
  /** r593: container labels (deployment / service ids) — see dockerNames.ts. */
  labels?: Array<[string, string]>;
}

/**
 * One-service compose file that reproduces the `docker run` invocation line
 * for line (r465). Everything downstream of "container exists" — blue-green
 * naming, health probes, Traefik routing, stop/rm — keys on the container
 * NAME, which this renders identically. Scalars are JSON-quoted: a JSON
 * string is a valid YAML double-quoted scalar, so template-controlled values
 * (image, command items, paths) can never break out of their field.
 */
export function renderRuntimeCompose(input: RuntimeComposeInput): string {
  const svc: string[] = [];
  svc.push(`  ${JSON.stringify(input.name)}:`);
  svc.push(`    image: ${composeScalar(input.image)}`);
  svc.push(`    container_name: ${JSON.stringify(input.name)}`);
  svc.push(`    restart: ${JSON.stringify(input.restart)}`);
  svc.push('    networks:', '      - default');
  const volumes: string[] = [];
  if (input.dataVolume && input.dataMount) volumes.push(`${input.dataVolume}:${input.dataMount}`);
  for (const a of input.attachments) volumes.push(`${a.volumeName}:${a.containerPath}${a.readOnly ? ':ro' : ''}`);
  if (input.dockerSocket) volumes.push('/var/run/docker.sock:/var/run/docker.sock');
  if (volumes.length > 0) {
    svc.push('    volumes:');
    for (const v of volumes) svc.push(`      - ${composeScalar(v)}`);
  }
  if (input.publishedPort && input.containerPort) {
    svc.push('    ports:', `      - ${JSON.stringify(`${input.publishedPort}:${input.containerPort}`)}`);
  }
  if (input.cpuShares > 0) svc.push(`    cpu_shares: ${input.cpuShares}`);
  if (input.cpuLimitMilli > 0) svc.push(`    cpus: ${input.cpuLimitMilli / 1000}`);
  if (input.memLimitMb > 0) {
    svc.push(`    mem_limit: ${JSON.stringify(`${input.memLimitMb}m`)}`);
    // Parity with the `docker run` line (--memory-swap = --memory): without
    // this the compose-run twin of a service could balloon into swap on the
    // same box where the docker-run original could not.
    svc.push(`    memswap_limit: ${JSON.stringify(`${input.memLimitMb}m`)}`);
  }
  if (input.cmd?.length) {
    svc.push('    command:');
    for (const c of input.cmd) svc.push(`      - ${composeScalar(c)}`);
  }
  if (input.envFile) svc.push(`    env_file: ${JSON.stringify(input.envFile)}`);
  if (input.labels?.length) {
    svc.push('    labels:');
    for (const [k, v] of input.labels) svc.push(`      ${JSON.stringify(k)}: ${composeScalar(v)}`);
  }

  const out: string[] = ['services:', ...svc];
  out.push('networks:', '  default:', `    name: ${JSON.stringify(input.bridge)}`, '    external: true');
  const namedVolumes = [
    ...(input.dataVolume && input.dataMount ? [input.dataVolume] : []),
    ...input.attachments.map((a) => a.volumeName),
  ];
  if (namedVolumes.length > 0) {
    out.push('volumes:');
    for (const v of new Set(namedVolumes)) out.push(`  ${JSON.stringify(v)}:`, '    external: true');
  }
  return `${out.join('\n')}\n`;
}

/**
 * Nixpacks' CLI has no env-file option: build-time variables travel as
 * repeatable `--env KEY=VALUE` argv. Nixpacks parses on the FIRST `=`, so
 * values may freely contain `=` (base64 secrets), and turns them into
 * `--build-arg`s consumed by an `ARG`/`ENV` pair it emits before the build
 * phases — which is what makes `NEXT_PUBLIC_*` inlining and NIXPACKS_*
 * version pins work during `next build`. Values reuse the runtime env-file's
 * literal `\n` escaping so a multi-line variable behaves identically at
 * build and run time. Note Nixpacks bakes these into the image config as
 * ENV; the runtime env-file overrides with the same values either way.
 */
export function nixpacksEnvArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v.replace(/\r\n?|\n/g, '\\n')}`]);
}

/** Shared no-op sinks (EPIPE guards / best-effort log drains). */
const swallowLine = (line: string): void => void line;
const swallowErr = (): void => undefined;

/**
 * Resolve a container's IP address on the shared Docker network, or null when
 * the container is not running. The host can route to bridge-network IPs
 * directly, which lets us healthcheck a container WITHOUT publishing any host
 * port — so blue-green never fights over `127.0.0.1:<port>` and rollback probes
 * always resolve the current address fresh from the runtime id.
 */
export async function containerIp(name: string): Promise<string | null> {
  try {
    const out = await capture('docker', [
      'inspect', name,
      '--format', '{{.State.Status}}|{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    ]);
    const [status, ip] = out.trim().split('|');
    return status === 'running' && ip ? ip : null;
  } catch {
    return null;
  }
}

type DockerContainerState = {
  Status?: string;
  ExitCode?: number;
  OOMKilled?: boolean;
  Error?: string;
};

/** Keep runtime diagnostics useful without echoing common credential shapes. */
export function sanitiseRuntimeLogs(raw: string): string {
  return raw
    .replace(/:\/\/([^:\s/@]+):([^@\s/]+)@/g, '://$1:[REDACTED]@')
    .replace(
      /((?:["']?)(?:password|passwd|token|secret|api[_-]?key)(?:["']?)\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi,
      '$1[REDACTED]',
    )
    .split('\n')
    .slice(-30)
    .join('\n')
    .slice(-8_000);
}

/** Inspect and log why a container is not reachable. Returns its state. */
async function logContainerDiagnostic(name: string, log: (line: string) => void): Promise<DockerContainerState | null> {
  try {
    const state = JSON.parse((await capture('docker', ['inspect', name, '--format', '{{json .State}}'])).trim()) as DockerContainerState;
    log(`container ${name} is ${state.Status ?? 'unavailable'} (exit ${state.ExitCode ?? 'unknown'}${state.OOMKilled ? ', OOM-killed' : ''})`);
    if (state.Error) log(`container runtime error: ${state.Error}`);
    try {
      // `capture` returns stdout only and `docker logs` exits 0, so anything the
      // app wrote to stderr used to vanish here — exactly the output a crashed
      // boot explains itself with. Stream both streams through run's sink.
      let tail = '';
      await run('docker', ['logs', '--tail', '30', name], {}, (line) => {
        tail += `${line}\n`;
      });
      const cleaned = sanitiseRuntimeLogs(tail);
      if (cleaned.trim()) log(`Recent container logs:\n${cleaned}`);
    } catch {
      /* the state line is still actionable when logs cannot be read */
    }
    return state;
  } catch {
    return null;
  }
}

/** TCP ports declared by the image/container metadata (for safe port recovery). */
export async function containerExposedTcpPorts(name: string): Promise<number[]> {
  try {
    const raw = await capture('docker', [
      'inspect', name,
      '--format', '{{json .Config.ExposedPorts}}',
    ]);
    const exposed = JSON.parse(raw.trim()) as Record<string, unknown> | null;
    if (!exposed) return [];
    return [...new Set(
      Object.keys(exposed)
        .map((key) => /^(\d+)\/tcp$/.exec(key)?.[1])
        .filter((port): port is string => !!port)
        .map(Number)
        .filter((port) => port >= 1 && port <= 65535),
    )].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * Build a source dir into a Docker image with Nixpacks — the buildpack path
 * for repos that ship no Dockerfile (e.g. a plain Next.js app). install/build/
 * start commands from the build config override Nixpacks' own detection, so
 * `npm ci` / `npm run build` / `npm start` style customizations work the same
 * way they do on Dokploy/Coolify. The service's resolved environment is
 * injected into the build too (`nixpacksEnvArgs`) — without it, `NEXT_PUBLIC_*`
 * and version pins like `NIXPACKS_NODE_VERSION` from the panel would only
 * exist at runtime and never reach `next build`.
 */
/**
 * r520: why the `railpack` build pack cannot run on THIS installation, or null.
 *
 * install.sh provisions the Railpack CLI on a bare-metal host, but the panel's
 * container image (Dockerfile) ships Nixpacks only — a container install
 * accepted `buildPack: railpack`, cloned the repository and then failed
 * mid-build on a missing binary. The container case is known without probing,
 * so it is also refused where the build pack is SAVED
 * ({@link railpackRefusedForInstall}); the probe covers a bare-metal host whose
 * install predates Railpack.
 *
 * r582: the image now ships the same pinned CLI as install.sh, so a container
 * is no longer a reason on its own (only an image WITHOUT the CLI is). What
 * neither install provided is the BuildKit daemon `railpack build` connects
 * to: it reads BUILDKIT_HOST and exits "BUILDKIT_HOST environment variable is
 * not set" without it — and buildEnv() never passed it on, so every railpack
 * build failed after the checkout on every install. The operator points
 * BUILDKIT_HOST at a BuildKit daemon in the panel's environment; until then
 * the pack is refused with that fix named, at save and at deploy time.
 */
export const RAILPACK_CONTAINER_REASON =
  'The railpack build pack is not available on this installation: this NineDeploy container image has no Railpack CLI (the official image bundles it since 0.10.38). ' +
  'Run the official image, or switch the build pack to auto, nixpacks or dockerfile (Service → Settings → Build) and redeploy.';
const RAILPACK_MISSING_REASON =
  'Railpack CLI is unavailable. Re-run the NineDeploy installer to provision it, or switch the build pack.';
export const RAILPACK_BUILDKIT_REASON =
  'The railpack build pack needs a BuildKit daemon, and BUILDKIT_HOST is not set for the panel. ' +
  'Start one (docker run -d --name buildkit --restart unless-stopped --privileged moby/buildkit), set BUILDKIT_HOST=docker-container://buildkit ' +
  "in the panel's environment (the install directory's .env on bare metal, the container's environment for a docker install) and restart the panel — " +
  'or switch the build pack to auto, nixpacks or dockerfile (Service → Settings → Build).';

const buildkitHostSet = (value: string | undefined) => !!value?.trim();

/** Save-time half of r520/r582: refuse railpack where it cannot build. */
export function railpackRefusedForInstall(buildkitHost: string | undefined = process.env['BUILDKIT_HOST']): string | null {
  return buildkitHostSet(buildkitHost) ? null : RAILPACK_BUILDKIT_REASON;
}

/** Deploy-time half of r520/r582: probe the CLI (and BuildKit address) before anything is cloned or built. */
export async function railpackUnavailableReason(
  inContainer = existsSync('/.dockerenv'),
  buildkitHost: string | undefined = process.env['BUILDKIT_HOST'],
): Promise<string | null> {
  try {
    await capture('railpack', ['--version']);
  } catch {
    return inContainer ? RAILPACK_CONTAINER_REASON : RAILPACK_MISSING_REASON;
  }
  return buildkitHostSet(buildkitHost) ? null : RAILPACK_BUILDKIT_REASON;
}

/**
 * Railpack source build (buildPack: 'railpack'). Railpack auto-detects the
 * stack and builds via its own BuildKit connection — NineDeploy passes the
 * image name and the runtime env; custom install/build commands are NOT
 * forwarded (railpack's plan handles them itself, and NineDeploy does not
 * translate nixpacks conventions onto railpack's config format).
 */
async function buildWithRailpack(
  target: string,
  baseDir: string,
  workDir: string,
  env: Record<string, string>,
  log: (line: string) => void,
): Promise<void> {
  const unavailable = await railpackUnavailableReason();
  if (unavailable) throw new Error(unavailable);

  const envArgs: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    envArgs.push('--env', `${key}=${value}`);
  }

  log(`⚡ railpack CLI build: ${baseDir} …`);
  await run(
    'railpack',
    ['build', baseDir, '--name', target, ...envArgs],
    { cwd: workDir, heartbeatMs: DEPLOY_HEARTBEAT_MS, heartbeatLabel: `Building ${target} with Railpack` },
    log,
  );
}

/**
 * r274: first line of every nixpacks.toml the builder generates. The file is
 * written into the REUSED working dir and nothing removed it, so the next
 * deploy read it as "repo already ships a nixpacks.toml — keeping it" and
 * every later manifest runtime/phases change was ignored. The marker tells
 * our own file (regenerated each deploy) from one the repository commits
 * (which still wins).
 */
export const GENERATED_NIXPACKS_MARKER =
  '# Generated by NineDeploy from .ninedeploy runtime/phases on every deploy — commit your own nixpacks.toml to take over.';

async function isGeneratedNixpacksToml(workDir: string, tomlPath: string): Promise<boolean> {
  try {
    if (readFileSync(tomlPath, 'utf8').startsWith(GENERATED_NIXPACKS_MARKER)) return true;
  } catch {
    return false;
  }
  // r274: files generated before the marker existed carry no marker. The
  // checkout itself is the arbiter: a nixpacks.toml the repository does not
  // TRACK can only be one an earlier deploy wrote. `git ls-files` prints the
  // path for a tracked file and nothing for an untracked one; a non-git
  // working dir (it throws) keeps the file, as before.
  try {
    const rel = path.relative(path.resolve(workDir), tomlPath).split(path.sep).join('/');
    return (await capture('git', ['ls-files', '--', rel], { cwd: workDir, timeoutMs: 15_000 })).trim() === '';
  } catch {
    return false;
  }
}

async function buildWithNixpacks(
  target: string,
  baseDir: string,
  buildConfig: BuildConfig | undefined,
  workDir: string,
  log: (line: string) => void,
  manifest?: NinedeployManifest,
  env: Record<string, string> = {},
): Promise<void> {
  // `runtime` and `phases` cannot be expressed as CLI flags — they become a
  // `nixpacks.toml` written next to the source. docs/NINEDEPLOY_MANIFEST.md
  // §6.1 has described this since the manifest shipped, but the generator was
  // never called: every `runtime`/`phases` block was validated and then
  // silently dropped.
  const generated = manifest ? generateNixpacksToml(manifest) : undefined;
  for (const w of generated?.warnings ?? []) log(`⚠ .ninedeploy nixpacks: ${w}`);
  const toml = generated?.toml;
  if (toml) {
    // `baseDir` here is REPO-RELATIVE (it is the operand handed to the
    // nixpacks CLI, which runs with cwd=workDir). Writing to it directly
    // would land the file next to the server process, not in the checkout —
    // re-anchor through `resolveInRepo`, which also refuses a path that
    // escapes the repository.
    const tomlPath = resolveInRepo(workDir, baseDir, 'nixpacks.toml');
    if (existsSync(tomlPath) && !(await isGeneratedNixpacksToml(workDir, tomlPath))) {
      // A hand-written nixpacks.toml in the repo is a deliberate, more
      // specific choice than the manifest — leave it alone and say so, rather
      // than overwriting a file the author committed.
      log('📋 .ninedeploy: repo already ships a nixpacks.toml — keeping it, manifest runtime/phases ignored');
    } else {
      writeFileSync(tomlPath, `${GENERATED_NIXPACKS_MARKER}\n${toml}`, 'utf8');
      const lineCount = toml.split('\n').length;
      log(`📋 .ninedeploy: generated nixpacks.toml from runtime/phases (${lineCount} lines)`);
    }
  } else {
    // r274: the working dir is reused across deploys, and an untracked file
    // survives the checkout. A manifest that no longer carries runtime/phases
    // (or no manifest at all) must not keep building with the stale file we
    // generated last time. Best-effort: a baseDir resolveInRepo refuses has
    // nothing of ours to remove.
    try {
      const tomlPath = resolveInRepo(workDir, baseDir, 'nixpacks.toml');
      if (existsSync(tomlPath) && (await isGeneratedNixpacksToml(workDir, tomlPath))) {
        rmSync(tomlPath, { force: true });
        log('📋 .ninedeploy: removed the nixpacks.toml generated by an earlier deploy');
      }
    } catch {
      /* nothing of ours to clean up */
    }
  }

  let hasCli = false;
  try {
    await capture('nixpacks', ['--version']);
    hasCli = true;
  } catch {
    hasCli = false;
  }

  const customArgs: string[] = [];
  if (buildConfig?.installCmd) customArgs.push('--install-cmd', buildConfig.installCmd);
  if (buildConfig?.buildCmd) customArgs.push('--build-cmd', buildConfig.buildCmd);
  if (buildConfig?.startCmd) customArgs.push('--start-cmd', buildConfig.startCmd);

  if (hasCli) {
    const envArgs = nixpacksEnvArgs(env);
    if (envArgs.length > 0) {
      log(`Injecting ${envArgs.length / 2} environment variable(s) into the Nixpacks build (values are never logged)`);
    }
    const args = ['build', baseDir, '--name', target, ...customArgs, ...envArgs];
    log(`⚡ nixpacks CLI build: ${baseDir} …`);
    await run(
      'nixpacks',
      args,
      { cwd: workDir, heartbeatMs: DEPLOY_HEARTBEAT_MS, heartbeatLabel: `Building ${target} with Nixpacks` },
      log,
    );
  } else {
    throw new Error(
      'Nixpacks CLI is unavailable. Re-run the NineDeploy installer to provision the checksum-verified source build tool.',
    );
  }
}

/** Docker builder: BuildKit image build + container run/stop via the docker CLI. */
export const dockerBuilder: Builder = {
  async buildAndRun(ctx, previous) {
    const { service, buildConfig, workDir, deploymentId, commitSha, env, imageDigest, registryAuth, log } = ctx;
    const name = `${service.slug}-${deploymentId}`;
    void previous;

    // Private registry: docker login (password via stdin, never argv) before
    // pulling, logout afterwards so the credential never lingers.
    const server = registryAuth?.server ?? '';
    let loggedIn = false;
    // r230: hold this registry's credential store for the whole login →
    // pull/build → logout window (see lib/registryLock.ts).
    const releaseRegistry = registryAuth ? await acquireRegistryLock(registryLockKey(null, server)) : null;
    try {
    if (registryAuth) {
      const loginArgs = ['login', '--username', registryAuth.username, '--password-stdin'];
      if (server) loginArgs.push(server);
      log(`Authenticating to registry ${server || '(default)'} …`);
      const { spawn } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        // Isolated env (same allowlist as every other exec) so host secrets
        // like the master key never leak into the login child.
        const child = spawn('docker', loginArgs, { env: buildEnv() });
        const swallow = swallowErr; // child gone / EPIPE on stdin
        child.stdin.on('error', swallow);
        child.stdin.write(`${registryAuth.password}\n`);
        child.stdin.end();
        // A registry that accepts TCP then stalls must not hang the pipeline
        // (and with it this registry's lock — every later deploy queues
        // behind it). Every other subprocess here is bounded by lib/exec's
        // 30-minute timeout; this hand-rolled spawn had none.
        const LOGIN_TIMEOUT_MS = 120_000;
        let settled = false;
        const finish = (err: Error | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) {
            child.kill('SIGKILL');
            reject(err);
          } else {
            resolve();
          }
        };
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          finish(new Error(`docker login timed out after ${LOGIN_TIMEOUT_MS / 1000}s (registry ${server || '(default)'} unreachable or stalling)`));
        }, LOGIN_TIMEOUT_MS);
        child.on('exit', (code) => (code === 0 ? finish(null) : finish(new Error(`docker login failed with exit code ${code}`))));
        child.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));
      });
      loggedIn = true;
    }
    } catch (err) {
      releaseRegistry?.();
      throw err;
    }

    // Determine the image to run: a pre-built image (template/one-click) or build from source.
    let target: string;
    let builtWithNixpacks = false;
    let builtStatic = false;
    // r520: set by every build pack that produces the image ITSELF (static,
    // railpack). The Dockerfile / Nixpacks dispatch below runs only when no
    // pack did — railpack used to fall through to a plain `docker build` that
    // failed on the Dockerfile-less repo railpack exists for, or silently
    // replaced the railpack image when the repo happened to ship one.
    let builtByPack = false;
    let resolvedPort: number | null = service.port ?? validPort(env.PORT);
    try {
    if (service.image) {
      // On rollback, pin the exact image by digest instead of the mutable
      // tag. r397: a stored imageDigest on OLD rows is the LOCAL image id —
      // `docker pull sha256:<id>` resolves to docker.io/library/sha256 and
      // always fails, after which rollback fell back to the local copy that
      // autoPrune may have removed after a week. Resolve the id to its
      // pullable repo digest while the local image still exists; rows written
      // since r397 already store the repo digest directly.
      target = await pullableReleaseRef(service.image, imageDigest ?? '');
      if (imageDigest) log(`Rollback pin ${imageDigest.slice(0, 24)}… → ${target}`);
      log(`Pulling image ${target} …`);
      try {
        await pullDockerImage(target, log);
      } catch (pullErr) {
        // A failed pull is only tolerable when the image exists locally
        // (local-only images). Otherwise a stale tag must NOT silently deploy
        // old code — and a missing image can never start anyway.
        let local = false;
        try {
          await capture('docker', ['image', 'inspect', target, '--format', '{{.Id}}']);
          local = true;
        } catch {
          local = false;
        }
        if (!local) throw pullErr;
        log(`pull failed, using local image ${target} (${pullErr instanceof Error ? pullErr.message : String(pullErr)})`);
      }
    } else {
      target = `ninedeploy/${service.slug}:${commitSha.slice(0, 7) || 'latest'}`;
      // Both fields are user-supplied and use a leading slash to mean "repo
      // root". `path.resolve` would read that as the FILESYSTEM root, so
      // `baseDir: "/etc"` used to make the host's /etc the build context —
      // re-anchor and containment-check them instead (lib/repoPath.ts).
      const pack = buildConfig?.buildPack ?? 'auto';
      // 'auto' resolves per-repo: an existing Dockerfile wins, otherwise fall
      // through to Nixpacks so Dockerfile-less repos (plain Next.js etc.) build
      // without any repo-side changes.
      //
      // Monorepo handling: when the user kept the defaults (`baseDir: '/'`,
      // no `dockerfilePath`), the previous logic only checked the repo root
      // and silently dropped to Nixpacks for repos whose Dockerfile lives in
      // a subdir. Auto-discover a Dockerfile up to 2 levels deep so private
      // monorepos "just work" without forcing the user to learn the fields.
      let baseDir = repoRelative(workDir, buildConfig?.baseDir);
      let dockerfile = resolveBuildDockerfile(workDir, buildConfig?.baseDir, buildConfig?.dockerfilePath || 'Dockerfile', log); // r666
      const explicitDockerfilePath = !!buildConfig?.dockerfilePath?.trim();
      const hasDockerfile = existsSync(resolveInRepo(workDir, buildConfig?.baseDir, buildConfig?.dockerfilePath || 'Dockerfile'));
      let useNixpacks = pack === 'nixpacks' || (pack === 'auto' && !hasDockerfile);
      if (pack === 'static') {
        // Static build pack: host-executed build commands, then the output
        // dir ships inside nginx:alpine. The runtime/health/routing phases
        // below run unchanged — only the build differs.
        await buildStaticSite(
          { workDir, baseDir: path.join(workDir, baseDir), buildConfig, env, log },
          target,
        );
        builtStatic = true;
        builtByPack = true;
      } else if (pack === 'railpack') {
        // Railpack auto-detects the stack and builds via its own BuildKit
        // connection — no host install/build commands run for it, so the
        // dispatch order places it before the nixpacks/Dockerfile checks.
        await buildWithRailpack(target, baseDir, workDir, env, log);
        builtByPack = true;
      } else if (pack === 'auto' && !hasDockerfile && !explicitDockerfilePath) {
        // Only auto-discover when the user did not already pin a path. A
        // pinned `dockerfilePath` is a deliberate choice and overrides.
        const discovered = findDockerfileInRepo(workDir, log);
        if (discovered) {
          baseDir = discovered.baseDir;
          dockerfile = discovered.dockerfilePath;
          useNixpacks = false;
        }
      }
      // The static and railpack packs already built their own image above —
      // the Dockerfile / Nixpacks strategies below apply to everything else.
      if (!builtByPack) {
        log(`Building image ${target} …`);
        if (useNixpacks) {
          builtWithNixpacks = true;
          await buildWithNixpacks(target, baseDir, buildConfig, workDir, log, ctx.manifest, env);
        } else {
          // Sprint 4 G-01 PR-B: when the `engine.use_buildkit` config flag
          // is on (default off), route the Dockerfile build through the
          // BuildKit driver so the build can consult / populate the
          // `IBuildCache` registered on the kernel. The legacy
          // `docker build` path stays the default until an operator
          // opts in, because the BuildKit invocation is incompatible
          // with hosts that ship the legacy builder only.
          if (ctx.useBuildKit) {
            const result = await buildWithBuildKit({
              workDir,
              dockerfilePath: dockerfile,
              baseDir,
              target,
              commitSha,
              lastBuildDigest: imageDigest,
              serviceId: service.id,
              cache: ctx.buildCache,
              onCacheEvent: ctx.onBuildCacheEvent,
              log,
            });
            log(`BuildKit finished: ${result.imageDigest}${result.cacheHit ? ' (cache hit)' : ''}`);
          } else {
            await run(
              'docker',
              ['build', '-t', target, '-f', dockerfile, baseDir],
              {
                cwd: workDir,
                env: { DOCKER_BUILDKIT: '1' },
                heartbeatMs: DEPLOY_HEARTBEAT_MS,
                heartbeatLabel: `Building Docker image ${target}`,
              },
              log,
            );
          }
        }
      }
    }

    // One canonical internal port drives the process, healthcheck and Traefik.
    // Explicit service configuration wins, followed by an existing PORT env.
    // Nixpacks apps follow the buildpack $PORT convention, so Dockerfile-less
    // source deploys get a deterministic 3000 default instead of completing
    // with a null port and therefore no Traefik route.
    if (!resolvedPort && builtWithNixpacks) {
      resolvedPort = DEFAULT_NIXPACKS_PORT;
      log(`No container port configured; using Nixpacks default ${resolvedPort}/tcp for runtime, healthcheck and Traefik`);
    }
    if (builtWithNixpacks && env.PORT === undefined) env.PORT = String(resolvedPort);
    // Static images listen on nginx's port 80 — no build-time PORT convention
    // applies, so the default is fixed rather than adopted from the env.
    if (builtStatic && !resolvedPort) {
      resolvedPort = 80;
      log(`Static image: using container port 80/tcp for runtime, healthcheck and Traefik`);
    }

    // Dockerfile/image deploys often declare exactly one EXPOSE port. Adopt it
    // automatically while leaving ambiguous multi-port images for the user to
    // select explicitly in Service → Network.
    if (!resolvedPort) {
      const exposedPorts = await containerExposedTcpPorts(target);
      if (exposedPorts.length === 1) {
        resolvedPort = exposedPorts[0]!;
        log(`Detected container port ${resolvedPort}/tcp from image metadata`);
      }
    }
    // Backward compatibility for direct-port-only services created before the
    // internal-port field was exposed in the UI.
    resolvedPort ??= service.publishedPort ?? null;
    } finally {
      if (loggedIn) {
        const logoutArgs = ['logout', ...(server ? [server] : [])];
        try {
          await run('docker', logoutArgs, {}, swallowLine);
        } catch {
          /* best-effort logout */
        }
      }
      releaseRegistry?.();
    }

    // BLUE-GREEN: the previous container is intentionally NOT stopped here. It
    // keeps serving traffic (Traefik still routes to it by name) until the new
    // container passes its healthcheck. The pipeline stops the previous one
    // (finalize) only after success; on failure it stops the NEW container,
    // leaving the old one running — a zero-downtime rollback.

    // EXCEPTION — host-published ports cannot run blue-green: Docker refuses to
    // bind the same host port twice, so EVERY redeploy after the first would
    // die on "port is already allocated" and the service would be stuck on its
    // first version forever. Retire the previous runtime FIRST and deploy
    // sequentially — a short, deliberate gap beats a permanently failing
    // redeploy.
    if (service.publishedPort && previous?.runtimeId && previous.runtimeId !== name) {
      log(
        `Host port ${service.publishedPort} is published — retiring previous runtime ${previous.runtimeId} before start (sequential deploy, no blue-green)`,
      );
      await run('docker', ['rm', '-f', previous.runtimeId], {}, swallowLine);
    }

    // A worker/host crash can leave this deployment's candidate container
    // behind before DB finalization. The deployment ID makes the name exact;
    // remove only that retry candidate, never the previous live runtime.
    // The batch also sweeps the candidate's -r2..-rN replicas, which would
    // otherwise linger forever: the next deploy gets a new deployment ID and
    // would never touch them again.
    if (previous?.runtimeId !== name) {
      try {
        await run('docker', ['rm', '-f', ...replicaNames(name, MAX_REPLICAS)], {}, swallowLine);
        log(`Removed interrupted deployment candidate ${name}`);
      } catch {
        // Missing container is the normal first-deploy path.
      }
    }

    // Model B: each service runs on its own `nd-svc-<slug>` bridge. Traefik is
    // attached to it (see `ensureServiceBridge`) so the proxy can still reach
    // the service by name; other services cannot, because they are not on
    // this bridge. The shared `ninedeploy` mesh is no longer a fan-in point
    // for app traffic — only Traefik + the probe container still live there.
    const bridge = await ensureServiceBridge(service.slug, log);
    // r465: multi-line env values cannot ride docker's --env-file (they would
    // arrive as a literal "\n"). Such services start through a one-service
    // compose file whose dotenv parser decodes the escapes into REAL
    // newlines — container name, bridge, volumes, limits and lifecycle stay
    // byte-identical to the docker run path.
    const multiLine = hasMultiLineEnv(env);
    const args = ['run', '-d', '--name', name, '--restart', safeRestartPolicy(buildConfig?.restartPolicy), '--network', bridge];
    // r593: label the generation with its deployment (and service) id so a
    // panel restart mid-deploy can find and remove exactly this candidate at
    // boot. Replicas clone `args`, so they carry the same labels.
    const labels = deploymentLabels(deploymentId, service.id);
    for (const [k, v] of labels) args.push('--label', `${k}=${v}`);
    // NOTE: no `-p` host port is published at all. Public traffic enters
    // exclusively through Traefik, which reaches the container by name over the
    // shared network; healthchecks probe the container's network IP directly
    // (see isHealthy). This keeps blue-green conflict-free — two versions can
    // run side by side without fighting over a host port — and removes the
    // loopback exposure entirely.
    if (service.cpuShares > 0) args.push('--cpu-shares', String(service.cpuShares));
    // Hard CPU cap — unlike --cpu-shares this throttles even without contention.
    if (service.cpuLimitMilli > 0) args.push('--cpus', String(service.cpuLimitMilli / 1000));
    // memory-swap pinned to memory: without it Docker allows swap = 2× the
    // limit, so a "512 MiB" service could really take 512 MiB RAM + 512 MiB
    // swap. A limit means a limit.
    if (service.memLimitMb > 0) args.push('--memory', `${service.memLimitMb}m`, '--memory-swap', `${service.memLimitMb}m`);
    if (service.volumeMount) args.push('-v', `nd-svc-${service.slug}-data:${service.volumeMount}`);
    // r321: the Volumes tab's attachments. The pipeline loads them into
    // ctx.volumeAttachments and the attach route queues a redeploy for them,
    // but only the compose builder ever read the list — on a docker service
    // an attach "succeeded", redeployed, and mounted nothing. Names and paths
    // are validated by the attachment schema; argv, never a shell. Replicas
    // clone these args, so every replica mounts them too.
    for (const a of ctx.volumeAttachments ?? []) {
      args.push('-v', `${a.volumeName}:${a.containerPath}${a.readOnly ? ':ro' : ''}`);
    }
    // Direct host port mapping (e.g. 8080:3000) for domain-less external access.
    if (service.publishedPort) {
      const containerPort = resolvedPort ?? service.publishedPort;
      args.push('-p', `${service.publishedPort}:${containerPort}`);
    }
    // Template-only flag (registry is admin-controlled): expose Docker control.
    if (service.dockerSocket) args.push('-v', '/var/run/docker.sock:/var/run/docker.sock');

    const composeEnvFile = multiLine ? writeComposeEnvFile(env) : null;
    const composeSpec = multiLine && composeEnvFile
      ? writeSecretFile(
          'nd-env',
          'runtime-compose.yml',
          renderRuntimeCompose({
            name,
            image: target,
            restart: safeRestartPolicy(buildConfig?.restartPolicy),
            bridge,
            cpuShares: service.cpuShares ?? 0,
            cpuLimitMilli: service.cpuLimitMilli ?? 0,
            memLimitMb: service.memLimitMb ?? 0,
            dataVolume: service.volumeMount ? `nd-svc-${service.slug}-data` : null,
            dataMount: service.volumeMount ?? null,
            attachments: ctx.volumeAttachments ?? [],
            publishedPort: service.publishedPort ?? null,
            containerPort: service.publishedPort ? (resolvedPort ?? service.publishedPort) : null,
            dockerSocket: service.dockerSocket === true,
            cmd: service.cmd?.length ? service.cmd : null,
            envFile: composeEnvFile.path,
            labels,
          }),
        )
      : null;
    // Compose declares named volumes as external and refuses to start when one
    // is missing; `docker run -v` auto-creates. Match the run semantics with
    // an idempotent create before up.
    if (composeSpec) {
      const ensureVolumes = new Set<string>([
        ...(service.volumeMount ? [`nd-svc-${service.slug}-data`] : []),
        ...(ctx.volumeAttachments ?? []).map((a) => a.volumeName),
      ]);
      for (const vol of ensureVolumes) {
        await run('docker', ['volume', 'create', vol], {}, swallowLine).catch(() => undefined);
      }
    }

    const envFile = composeSpec ? null : writeEnvFile(env);
    if (envFile) args.push('--env-file', envFile.path);
    if (!composeSpec) {
      args.push(target);
      // Template-defined command (argv after the image) — e.g. minio needs
      // `server /data` because its bare entrypoint just prints help and exits.
      if (service.cmd?.length) args.push(...service.cmd);
    }

    log(`Starting container ${name} …`);
    try {
      if (composeSpec) {
        await run(
          'docker',
          ['compose', '-p', `ndrt-${name}`, '-f', composeSpec.path, 'up', '-d', '--no-build'],
          { heartbeatMs: DEPLOY_HEARTBEAT_MS, heartbeatLabel: `Starting application container ${name} (compose bridge: real newlines in env)` },
          log,
        );
      } else {
        await run(
          'docker',
          args,
          { heartbeatMs: DEPLOY_HEARTBEAT_MS, heartbeatLabel: `Starting application container ${name}` },
          log,
        );
      }
    } finally {
      envFile?.cleanup();
      composeEnvFile?.cleanup();
      composeSpec?.cleanup();
    }

    // Horizontal replicas: N-1 extra containers of the SAME image/env on the
    // same bridge, started best-effort AFTER the primary (a primary failure
    // must not leave orphans behind). Traefik load-balances across them via
    // the multi-server render + healthCheck in renderDynamicConfig. Replicas
    // are clones of a container that already passed `docker run`; per-replica
    // health gates would 10x the boot time for no real safety.
    const replicaCount = Math.max(1, Math.min(service.replicas ?? 1, MAX_REPLICAS));
    // Achieved count starts at 1 (the primary is up) and grows per replica
    // that actually started — the proxy renders THIS, so a replica that
    // failed to start never becomes a dead round-robin backend.
    let achievedReplicas = 1;
    if (replicaCount > 1) {
      // The primary's env files were cleaned up above — replicas need their
      // own. One env file serves every replica; the values are identical.
      const replicaEnvFile = composeSpec ? writeComposeEnvFile(env) : writeEnvFile(env);
      // docker-run path: `args` still carries everything except the primary's
      // name, env-file path and host port publishing; swap the first two per
      // replica and strip the third — only the primary may own the published
      // host port (Docker refuses a second `-p` bind on the same port, so
      // clones inheriting it fail to start and scaling silently collapses to
      // 1). Public traffic reaches replicas over the shared bridge via
      // Traefik. Compose path (r465): render per replica, ports omitted for
      // the same reason, each in its own project so `up` cannot treat the
      // previous replica as an orphan.
      const cloneArgs = (replicaName: string): string[] => {
        const out: string[] = [];
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '-p' && i + 1 < args.length) {
            i++; // skip the host:container port pair
            continue;
          }
          if (i === 3) out.push(replicaName);
          else if (args[i] === envFile?.path && replicaEnvFile) out.push(replicaEnvFile.path);
          else out.push(args[i]!);
        }
        return out;
      };
      let replicaComposeSpec: SecretFile | null = null;
      for (let i = 2; i <= replicaCount; i++) {
          const replicaName = `${name}-r${i}`;
          try {
            if (composeSpec && replicaEnvFile) {
              replicaComposeSpec = writeSecretFile(
                'nd-env',
                'runtime-compose.yml',
                renderRuntimeCompose({
                  name: replicaName,
                  image: target,
                  restart: safeRestartPolicy(buildConfig?.restartPolicy),
                  bridge,
                  cpuShares: service.cpuShares ?? 0,
                  cpuLimitMilli: service.cpuLimitMilli ?? 0,
                  memLimitMb: service.memLimitMb ?? 0,
                  dataVolume: service.volumeMount ? `nd-svc-${service.slug}-data` : null,
                  dataMount: service.volumeMount ?? null,
                  attachments: ctx.volumeAttachments ?? [],
                  publishedPort: null,
                  containerPort: null,
                  dockerSocket: service.dockerSocket === true,
                  cmd: service.cmd?.length ? service.cmd : null,
                  envFile: replicaEnvFile.path,
                  labels,
                }),
              );
              await run(
                'docker',
                ['compose', '-p', `ndrt-${replicaName}`, '-f', replicaComposeSpec.path, 'up', '-d', '--no-build'],
                { heartbeatMs: DEPLOY_HEARTBEAT_MS, heartbeatLabel: `Starting replica ${replicaName}` },
                log,
              );
            } else {
              await run(
                'docker',
                cloneArgs(replicaName),
                { heartbeatMs: DEPLOY_HEARTBEAT_MS, heartbeatLabel: `Starting replica ${replicaName}` },
                log,
              );
            }
            achievedReplicas++;
            log(`Replica ${replicaName} started (${i}/${replicaCount})`);
          } catch (err) {
            log(`warning: replica ${replicaName} failed to start — continuing with fewer replicas (${msg(err)})`);
          } finally {
            replicaComposeSpec?.cleanup();
            replicaComposeSpec = null;
          }
        }
        replicaEnvFile?.cleanup();
      }

    // Capture the resolved image reference so rollback can later pin this
    // exact image. r397: prefer the REPO digest (`repo@sha256:…`, pullable
    // from any host forever) — `{{.Image}}` is the local config digest,
    // which no registry can pull and autoPrune deletes with the local copy.
    // Locally built images (nixpacks/static, never pushed) have no
    // RepoDigests and keep the local id, whose rollback stays local-only.
    let digest: string | undefined;
    try {
      const imageId = (await capture('docker', ['inspect', name, '--format', '{{.Image}}'])).trim() || undefined;
      if (imageId && service.image) {
        const pullable = await pullableReleaseRef(service.image, imageId);
        digest = pullable && pullable !== service.image ? pullable : imageId;
      } else {
        digest = imageId;
      }
    } catch {
      /* non-fatal — digest is best-effort */
    }

    return { runtimeId: name, port: resolvedPort, healthPath: service.healthPath ?? '/', imageDigest: digest, replicas: achievedReplicas };
  },

  // 5-minute deadline: first boots (model downloads, DB migrations) are slow.
  async isHealthy(runtime, timeoutMs = 300_000, directGraceMs = 10_000, log: (line: string) => void = () => undefined) {
    // Sanitised, then assembled structurally — a stored healthPath must not
    // be able to redirect the probe at another host (see lib/probeUrl.ts).
    const healthPath = safeProbePath(runtime.healthPath);
    const deadline = Date.now() + timeoutMs;
    // Direct host→container-IP probing works on Linux bridges but NOT on
    // Docker Desktop (macOS/Windows), where container IPs are unreachable
    // from the host. After a grace period of failed direct probes, fall back
    // to probing from a throwaway sibling container on the shared network —
    // name-based DNS works everywhere the app itself will be reached.
    const start = Date.now();
    let fallbackPorts: number[] | null = null;
    let restartDiagnosticWritten = false;
    let siblingTopologyLogged = false;
    while (Date.now() < deadline) {
      // Resolve the container's network address fresh on every attempt: null
      // when it is not running (a process that exits right after `docker run -d`
      // must not pass), and always the CURRENT address — which is exactly what
      // makes blue-green and rollback probes correct without persisting ports.
      const ip = await containerIp(runtime.runtimeId);
      if (!ip) {
        const elapsed = Date.now() - start;
        // A process that has exited cannot recover. A restart loop gets a
        // short grace period for transient dependency startup, then fails with
        // its real logs instead of printing five minutes of TCP probe noise.
        try {
          const raw = await capture('docker', ['inspect', runtime.runtimeId, '--format', '{{json .State}}']);
          const state = JSON.parse(raw.trim()) as DockerContainerState;
          const terminal = state.Status === 'exited' || state.Status === 'dead';
          const restartLoop = state.Status === 'restarting' && elapsed >= 30_000;
          if (terminal || restartLoop) {
            await logContainerDiagnostic(runtime.runtimeId, log);
            return false;
          }
          if (state.Status === 'restarting' && !restartDiagnosticWritten) {
            log(`container ${runtime.runtimeId} is restarting; waiting briefly before declaring startup failure`);
            restartDiagnosticWritten = true;
          }
        } catch {
          /* container can still be transitioning into the running state */
        }
        await sleep(1000);
        continue;
      }
      if (runtime.port) {
        if (Date.now() - start < directGraceMs) {
          // Probe the HTTP endpoint with a short per-attempt timeout so a server
          // that accepts TCP but never responds can't stall the whole deadline.
          try {
            const res = await fetch(buildProbeUrl(ip, runtime.port, healthPath), {
              signal: AbortSignal.timeout(3000),
            });
            // Always drain/cancel the body so the undici connection is released
            // instead of leaking one socket per probe iteration.
            try {
              await res.body?.cancel();
            } catch {
              /* body already consumed */
            }
            if (res.status < 500) return true;
          } catch {
            /* not up yet — retry until the grace period ends */
          }
          await sleep(1000);
          continue;
        }
        // Sibling probe: a raw TCP connect from the shared network. We probe
        // by the INSPECTED IP (container names can wildcard-resolve through
        // Docker Desktop's upstream DNS) and at the TCP level rather than
        // HTTP: busybox wget FOLLOWS redirects, and relative redirects from
        // apps like Jellyfin (Location: web/) then resolve as hostnames.
        // "Is the port accepting connections inside the network" is exactly
        // the signal this fallback needs.
        try {
          await ensureProbeContainer(log);
          // Without this the prober cannot route into the runtime's per-slug
          // bridge at all (inter-bridge traffic is dropped by default), which
          // turned every post-grace healthcheck into 5 minutes of blind nc
          // timeouts against a perfectly healthy container.
          await ensureProbeNetworks(runtime.runtimeId, log);
          await run('docker', [
            'exec', PROBE_CONTAINER, 'nc', '-w', '3', ip, String(runtime.port),
          ], {}, log);
          return true;
        } catch (probeErr) {
          probeContainerReady = false;
          // First failure: show where prober and container actually sit — a
          // prober stranded on the wrong bridge fails as a bare nc exit code.
          if (!siblingTopologyLogged) {
            siblingTopologyLogged = true;
            const runtimeNets = await containerNetworks(runtime.runtimeId);
            const proberNets = await containerNetworks(PROBE_CONTAINER);
            log(`sibling probe: container ${runtime.runtimeId} is on [${runtimeNets.join(', ')}], ${PROBE_CONTAINER} is on [${proberNets.join(', ')}]`);
          }
          // Surface WHY the sibling probe failed — healthcheck debugging
          // otherwise degrades to a bare "did not become ready".
          log(`sibling probe failed: ${probeErr instanceof Error ? probeErr.message : String(probeErr)}`);
        }
        // Image deploys commonly advertise their real internal port (for
        // example n8n exposes 5678/tcp). If the stored port is wrong, probe
        // those declared alternatives from the same Docker network. A
        // successful alternative becomes the runtime port and is persisted by
        // the pipeline, so Traefik and future deploys use the repaired value.
        fallbackPorts ??= (await containerExposedTcpPorts(runtime.runtimeId))
          .filter((port) => port !== runtime.port);
        for (const candidate of fallbackPorts) {
          try {
            await run('docker', [
              'exec', PROBE_CONTAINER, 'nc', '-w', '3', ip, String(candidate),
            ], {}, () => undefined);
            log(`detected healthy image port ${candidate}/tcp; replacing incorrect configured port ${runtime.port}`);
            runtime.port = candidate;
            return true;
          } catch {
            /* candidate is not accepting connections yet — retry next loop */
          }
        }
        await sleep(3000);
      } else {
        // No HTTP port to probe — a live container is the strongest signal available.
        return true;
      }
    }
    await logContainerDiagnostic(runtime.runtimeId, log);
    return false;
  },

  async stop(runtimeId, opts) {
    const grace = opts?.graceSeconds && opts.graceSeconds >= 0 ? Math.min(Math.floor(opts.graceSeconds), 300) : 5;
    // One batched rm covers the generation: the primary plus its `-r2..-rN`
    // replicas (deterministic names — see replicaNames). docker rm -f on a
    // missing name is an error per name but the batch still removes the rest,
    // and single-container services simply have no siblings to remove.
    const targets = replicaNames(runtimeId, MAX_REPLICAS);
    try {
      await run('docker', ['stop', '-t', String(grace), ...targets], {}, swallow);
    } catch {
      /* already gone */
    }
    try {
      await run('docker', ['rm', '-f', ...targets], {}, swallow);
    } catch {
      /* already gone */
    }
  },
};
