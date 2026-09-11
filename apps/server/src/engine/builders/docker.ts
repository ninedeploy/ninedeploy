import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Builder } from '../types.js';
import type { BuildConfig } from '@ninedeploy/db';
import type { NinedeployManifest } from '@ninedeploy/schemas';
import { generateNixpacksToml } from '../../lib/ninedeployToNixpacks.js';
import { buildEnv, capture, run, sleep } from '../../lib/exec.js';
import { ensureDockerImage, pullDockerImage } from '../../lib/dockerPull.js';
import { NETWORK } from '../proxy.js';
import { ensureServiceBridge } from '../../lib/serviceBridge.js';
import { buildWithBuildKit } from './buildkit.js';
import { buildStaticSite } from './staticSite.js';
import { buildProbeUrl, safeProbePath } from '../../lib/probeUrl.js';
import { writeSecretFile, type SecretFile } from '../../lib/secretFile.js';
import { repoRelative, resolveInRepo } from '../../lib/repoPath.js';

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

const swallow = () => {};
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
  if (manifest) {
    const { toml, warnings } = generateNixpacksToml(manifest);
    for (const w of warnings) log(`⚠ .ninedeploy nixpacks: ${w}`);
    if (toml) {
      // `baseDir` here is REPO-RELATIVE (it is the operand handed to the
      // nixpacks CLI, which runs with cwd=workDir). Writing to it directly
      // would land the file next to the server process, not in the checkout —
      // re-anchor through `resolveInRepo`, which also refuses a path that
      // escapes the repository.
      const tomlPath = resolveInRepo(workDir, baseDir, 'nixpacks.toml');
      if (existsSync(tomlPath)) {
        // A hand-written nixpacks.toml in the repo is a deliberate, more
        // specific choice than the manifest — leave it alone and say so, rather
        // than overwriting a file the author committed.
        log('📋 .ninedeploy: repo already ships a nixpacks.toml — keeping it, manifest runtime/phases ignored');
      } else {
        writeFileSync(tomlPath, toml, 'utf8');
        const lineCount = toml.split('\n').length;
        log(`📋 .ninedeploy: generated nixpacks.toml from runtime/phases (${lineCount} lines)`);
      }
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
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`docker login failed with exit code ${code}`))));
        child.on('error', reject);
      });
      loggedIn = true;
    }

    // Determine the image to run: a pre-built image (template/one-click) or build from source.
    let target: string;
    let builtWithNixpacks = false;
    let builtStatic = false;
    let resolvedPort: number | null = service.port ?? validPort(env.PORT);
    try {
    if (service.image) {
      // On rollback, pin the exact image by digest instead of the mutable tag.
      target = imageDigest ?? service.image;
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
      let dockerfile = repoRelative(workDir, buildConfig?.dockerfilePath || 'Dockerfile');
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
      // The static pack already built its own image above — the Dockerfile /
      // Nixpacks strategies below apply to everything else.
      if (!builtStatic) {
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
    if (previous?.runtimeId !== name) {
      try {
        await run('docker', ['rm', '-f', name], {}, swallowLine);
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
    const args = ['run', '-d', '--name', name, '--restart', safeRestartPolicy(buildConfig?.restartPolicy), '--network', bridge];
    // NOTE: no `-p` host port is published at all. Public traffic enters
    // exclusively through Traefik, which reaches the container by name over the
    // shared network; healthchecks probe the container's network IP directly
    // (see isHealthy). This keeps blue-green conflict-free — two versions can
    // run side by side without fighting over a host port — and removes the
    // loopback exposure entirely.
    if (service.cpuShares > 0) args.push('--cpu-shares', String(service.cpuShares));
    if (service.memLimitMb > 0) args.push('--memory', `${service.memLimitMb}m`);
    if (service.volumeMount) args.push('-v', `nd-svc-${service.slug}-data:${service.volumeMount}`);
    // Direct host port mapping (e.g. 8080:3000) for domain-less external access.
    if (service.publishedPort) {
      const containerPort = resolvedPort ?? service.publishedPort;
      args.push('-p', `${service.publishedPort}:${containerPort}`);
    }
    // Template-only flag (registry is admin-controlled): expose Docker control.
    if (service.dockerSocket) args.push('-v', '/var/run/docker.sock:/var/run/docker.sock');

    const envFile = writeEnvFile(env);
    if (envFile) args.push('--env-file', envFile.path);
    args.push(target);
    // Template-defined command (argv after the image) — e.g. minio needs
    // `server /data` because its bare entrypoint just prints help and exits.
    if (service.cmd?.length) args.push(...service.cmd);

    log(`Starting container ${name} …`);
    try {
      await run(
        'docker',
        args,
        { heartbeatMs: DEPLOY_HEARTBEAT_MS, heartbeatLabel: `Starting application container ${name}` },
        log,
      );
    } finally {
      envFile?.cleanup();
    }

    // Capture the resolved image digest so rollback can later pin this exact image.
    let digest: string | undefined;
    try {
      digest = (await capture('docker', ['inspect', name, '--format', '{{.Image}}'])).trim() || undefined;
    } catch {
      /* non-fatal — digest is best-effort */
    }

    return { runtimeId: name, port: resolvedPort, healthPath: service.healthPath ?? '/', imageDigest: digest };
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
    try {
      await run('docker', ['stop', '-t', String(grace), runtimeId], {}, swallow);
    } catch {
      /* already gone */
    }
    try {
      await run('docker', ['rm', '-f', runtimeId], {}, swallow);
    } catch {
      /* already gone */
    }
  },
};
