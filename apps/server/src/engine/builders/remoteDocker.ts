import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NinedeployManifest } from '@ninedeploy/schemas';
import type { Builder, BuildContext, DeployRuntime } from '../types.js';
import { assertCloneTargetAllowed } from '../../lib/gitEgress.js';
import { acquireRegistryLock, registryLockKey } from '../../lib/registryLock.js';
import { AGENT_CAPABILITY_VERSION, assertAgentGuardsBuildPaths, capabilityRefusalFor, parseAgentCapabilities } from '../../lib/agentCapabilities.js';
import { deployAborted } from '../../lib/deployAbort.js';
import type { NodeGitCredentialSource } from '../../lib/nodeGitCredential.js';
import { generateNixpacksToml } from '../../lib/ninedeployToNixpacks.js';
import { repoRelative, resolveInRepo } from '../../lib/repoPath.js';
import { runRemoteContainer } from './remoteRun.js';
import { verifyNodeReadiness } from '../../lib/nodeReadiness.js';
import { confirmedNodeProbe } from '../../lib/nodeProbeReceipt.js';
import { discoverRemoteReplicas, retireRemoteReplicas } from './remoteReplicas.js';
import { BUILDPACKS_NODE_REASON, isBuildpackPack } from '../../lib/buildPacks.js';

// r267: moved to remoteRun.ts with the run phase (multi-node T1); re-exported
// so every importer keeps its path.
export { envForAgent } from './remoteRun.js';

/**
 * Remote Docker builder — deploys a service onto a registered node through the
 * typed agent protocol.
 *
 * Why this exists
 * ---------------
 * `server_id` has been on the services table, on the Servers page and in the
 * BuildContext since the fleet feature shipped, and no builder ever read it:
 * docker, pm2 and compose all shell out locally through `lib/exec.ts`. A
 * service pinned to a node would therefore have been built and started on the
 * PANEL host while the panel, the Servers page and the deploy log all reported
 * the node. `lib/remoteDeploy.ts` refused the deploy outright rather than put
 * the container on the wrong machine; this builder is what finally makes the
 * refusal unnecessary for the shape it covers.
 *
 * Ingress model
 * -------------
 * Each node runs its OWN Traefik (`proxy.ensure` on the agent) and terminates
 * TLS for the services that live on it — the operator points the domain at the
 * node, not at the panel. Production traffic therefore never hairpins through
 * the panel host, which is what makes multi-node worth having. The container
 * joins the node's `ninedeploy` network and the node's Traefik reaches it by
 * container name, exactly as the panel's own Traefik does locally, so no host
 * port has to be published for a domain to work.
 *
 * What this covers, and what it refuses
 * -------------------------------------
 * Covered: `docker` services that run a pre-built IMAGE, and those that build
 * from a git repository — a Dockerfile, or (multi-node, design §2) Nixpacks
 * and Railpack through the agent's `build.nixpacks` / `build.railpack` ops.
 * The PANEL resolves the build pack on its own checkout (PREPARE already holds
 * it at the pinned commit) with the local builder's rules, so a node never
 * decides; {@link resolveNodeBuildPlan}.
 *
 * Refused, loudly, rather than silently mishandled:
 *   - Nixpacks on an agent without `build.nixpacks` (an older agent): the
 *     deploy fails with "update the node agent" before anything is cloned.
 *     Railpack on such an agent keeps r520's Dockerfile substitution, so a
 *     service that builds today keeps building identically until its agent
 *     is updated (owner decision O10: then it really builds with Railpack).
 *   - PM2 and Compose services. The agent has no PM2 op at all, and a Compose
 *     stack needs its file materialised on the node first.
 * Each refusal throws with a message naming the reason, so the deployment fails
 * recoverably with an explanation instead of landing somewhere unexpected.
 *
 * Health
 * ------
 * Remote health is CONTAINER STATE, not an HTTP probe: the panel sits outside
 * the node's Docker network and cannot reach the container, and publishing a
 * host port purely to be probed would expose every remote service on the node's
 * public interface. `isHealthy` polls `docker.inspect` until the container
 * reports `running` and stays there over several samples without restarting
 * (r265). This is a weaker signal than the local builder's HTTP probe and the
 * deploy log says so.
 */

/** The typed-op caller the pipeline binds for a service pinned to a node. */
export type AgentCall = (
  op: string,
  params: Record<string, unknown>,
  sink: (line: string) => void,
  options?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<{ exitCode: number; lines: string[] }>;

/**
 * r415: make sure the node has the shared `ninedeploy` network every container
 * joins. `docker network create` on an existing network exits 1 with "Error
 * response from daemon: network with name ninedeploy already exists" — the
 * normal case on every deploy but a node's first — so that answer is silent.
 * Any other failure goes to the deploy log and the deploy carries on as before
 * (the container start then names the missing network).
 */
export async function ensureNodeNetwork(agent: AgentCall, log: (line: string) => void): Promise<void> {
  const lines: string[] = [];
  let failure: string | null = null;
  try {
    const res = await agent('docker.networkCreate', { name: 'ninedeploy', driver: 'bridge' }, (line) => lines.push(line));
    if (res.exitCode !== 0) failure = `exit ${res.exitCode}`;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  if (failure !== null && [...lines, failure].some((line) => /already exists/i.test(line))) return;
  for (const line of lines) log(line);
  if (failure !== null) log(`Could not create the "ninedeploy" network on the node: ${failure}`);
}

/** Thrown for a service shape this builder deliberately does not handle. */
export class RemoteDeployUnsupportedError extends Error {
  readonly code = 'remote_deploy_unsupported';
  constructor(message: string) {
    super(message);
    this.name = 'RemoteDeployUnsupportedError';
  }
}

/**
 * Container-state values `docker inspect --format '{{.State.Status}}'` can
 * report. Anything not in the "settled and healthy" set keeps the poll going.
 */
const TERMINAL_BAD = new Set(['exited', 'dead', 'removing']);

/**
 * r265: consecutive good `docker.inspect` samples (one poll apart) a new
 * container must hold before it counts as healthy, and the restart-count rise
 * that marks it as crash-looping. Mirrors remoteCompose.isHealthy.
 */
const STABLE_SAMPLES = 3;
const CRASH_LOOP_RESTARTS = 3;

/**
 * Multi-node (M6): an image built elsewhere (the panel host or a build
 * server) and already loaded on this node under `tag`, with its content
 * address `imageId`. The deploy then neither pulls nor clones nor builds.
 */
export interface PrebuiltImage {
  tag: string;
  imageId: string;
  builtWithNixpacks?: boolean;
  builtStatic?: boolean;
}

// ── 0.16 T3 node builds (design §2.2) ──

/** What the node builds: the panel's decision, sent as operands. */
export type NodeBuildPlan =
  | { pack: 'dockerfile'; dockerfile: string; context: string }
  | { pack: 'nixpacks'; baseDir: string }
  | { pack: 'railpack'; baseDir: string };

type PackConfig = { buildPack?: string | null; dockerfilePath?: string | null; baseDir?: string | null } | undefined;

/** The `docker.build` operands every release before this one sent (the agent resolves them, r660/r666). */
function legacyDockerfilePlan(buildConfig: PackConfig): { pack: 'dockerfile'; dockerfile: string; context: string } {
  const dockerfile = (buildConfig?.dockerfilePath || 'Dockerfile').replace(/^\/+/, '') || 'Dockerfile';
  const context = (buildConfig?.baseDir || '.').replace(/^\/+/, '') || '.';
  return { pack: 'dockerfile', dockerfile, context };
}

/** True when the agent's own r666 resolution of `plan` finds a file in the panel's checkout. */
function legacyDockerfileExists(workDir: string, plan: { dockerfile: string; context: string }): boolean {
  try {
    return existsSync(resolveInRepo(workDir, plan.dockerfile)) || existsSync(resolveInRepo(workDir, plan.context, plan.dockerfile));
  } catch {
    // A symlinked path: the agent's own walk refuses it with the message the operator needs.
    return true;
  }
}

/**
 * Design §2.2: the build pack a node uses, resolved on the PANEL's checkout
 * of the pinned commit with the local builder's rules (engine/builders/
 * docker.ts) — Dockerfile at the configured path, else a discovered one
 * (`findDockerfileInRepo`, two levels deep), else Nixpacks.
 *
 * Upgrade-safe: whenever today's node build would find its Dockerfile (or
 * the path is pinned, or there is no panel checkout to look at), the operands
 * are exactly the ones every earlier release sent. Only the case that could
 * never build on a node before — `auto` with no Dockerfile where the agent
 * looks — changes: it builds the discovered Dockerfile, or with Nixpacks.
 */
export async function resolveNodeBuildPlan(workDir: string, buildConfig: PackConfig, log: (line: string) => void): Promise<NodeBuildPlan> {
  const pack = buildConfig?.buildPack ?? 'auto';
  const legacy = legacyDockerfilePlan(buildConfig);
  const checkout = existsSync(path.join(workDir, '.git'));
  const baseDir = checkout ? repoRelative(workDir, buildConfig?.baseDir ?? undefined) : legacy.context;
  if (pack === 'nixpacks') return { pack: 'nixpacks', baseDir };
  if (pack === 'railpack') return { pack: 'railpack', baseDir };
  // G4.4: never the legacy Dockerfile plan below — that would quietly build
  // something other than the buildpacks image the service asked for.
  if (isBuildpackPack(pack)) throw new Error(BUILDPACKS_NODE_REASON);
  if (pack !== 'auto' || !checkout || buildConfig?.dockerfilePath?.trim() || legacyDockerfileExists(workDir, legacy)) return legacy;
  // docker.ts is loaded lazily: it imports fan-out, which imports this module.
  const { findDockerfileInRepo } = await import('./docker.js');
  const discovered = findDockerfileInRepo(workDir, log);
  if (discovered) return { pack: 'dockerfile', dockerfile: discovered.dockerfilePath, context: discovered.baseDir };
  log('No Dockerfile in the repository — building with Nixpacks on the node, as the panel host would.');
  return { pack: 'nixpacks', baseDir };
}

/** The agent's build-env name rule (agentOps/builds.ts). */
const RE_BUILD_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;
const MAX_BUILD_ENV_VALUE = 32 * 1024;
const MAX_BUILD_ENV_KEYS = 512;

/** The runtime env as a node build takes it; a variable the agent would refuse is left out of the BUILD (never the run) and named. */
export function nodeBuildEnv(env: Record<string, string>, log: (line: string) => void): Record<string, string> {
  const kept: Record<string, string> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (RE_BUILD_ENV_KEY.test(key) && value.length <= MAX_BUILD_ENV_VALUE && !value.includes('\0') && Object.keys(kept).length < MAX_BUILD_ENV_KEYS) {
      kept[key] = value;
    } else {
      skipped.push(key.slice(0, 64));
    }
  }
  if (skipped.length > 0) {
    log(`⚠ ${skipped.length} environment variable(s) not passed to the node build (name, size or count a build cannot take): ${skipped.slice(0, 10).join(', ')}`);
  }
  return kept;
}

/** The panel-generated nixpacks.toml (with its marker line), or undefined; warnings go to the log. */
async function nodeNixpacksToml(manifest: NinedeployManifest | undefined, log: (line: string) => void): Promise<string | undefined> {
  if (!manifest) return undefined;
  const generated = generateNixpacksToml(manifest);
  for (const w of generated.warnings) log(`⚠ .ninedeploy nixpacks: ${w}`);
  if (!generated.toml) return undefined;
  const { GENERATED_NIXPACKS_MARKER } = await import('./docker.js');
  return `${GENERATED_NIXPACKS_MARKER}\n${generated.toml}`;
}

/** Nixpacks apps follow the buildpack $PORT convention (docker.ts `DEFAULT_NIXPACKS_PORT`). */
const DEFAULT_NIXPACKS_PORT = 3000;
// ── end 0.16 T3 ──

// ── 0.16 T4 build placement: the build half ──
/**
 * The source-build half of the remote builder's `buildAndRun`, moved out
 * unchanged (multi-node T4) so build placement can build on a BUILD SERVER
 * and ship the image to the hosts that run the service (design §6.3): the
 * egress gate, the r660 path guard, the T3 pack resolution and capability
 * checks, the per-job Git credential, the clone at the pinned commit and the
 * build. `opts.tag` names the image (default `ninedeploy/<slug>:<sha7>`).
 */
export async function buildSourceOnNode(
  agent: AgentCall,
  ctx: BuildContext,
  opts: { nodeLabel?: string; gitCredential?: NodeGitCredentialSource; tag?: string } = {},
): Promise<{ target: string; builtWithNixpacks: boolean }> {
  const { service, buildConfig, commitSha, env, log } = ctx;
  const workspace = service.slug;
  const sink = (line: string) => log(line);
  let target: string;
  let plan: NodeBuildPlan = legacyDockerfilePlan(buildConfig);
  let builtWithNixpacks = false;
  if (!service.repoUrl) {
    throw new RemoteDeployUnsupportedError(
      `"${service.name}" has neither an image nor a repository URL, so there is nothing to deploy on the node.`,
    );
  }

  // Same egress gate as a panel-side checkout (r099): the clone runs from
  // the NODE's network position — a cloud VM with its own metadata
  // service, or a LAN — and used to skip the check entirely.
  await assertCloneTargetAllowed(service.repoUrl);
  // r660: only an agent that symlink-walks the build paths may build
  // the repository — asked before anything is cloned onto the node.
  const label = opts.nodeLabel ?? `#${service.serverId ?? '?'}`;
  await assertAgentGuardsBuildPaths(agent, label);
  // ── 0.16 T3 node builds (design §2.2) ──
  // The pack is resolved on the panel's checkout and checked against
  // the agent's capabilities BEFORE anything is cloned onto the node.
  plan = await resolveNodeBuildPlan(ctx.workDir, buildConfig, log);
  if (plan.pack !== 'dockerfile') {
    const { lines } = await agent('agent.ping', {}, () => undefined);
    const info = parseAgentCapabilities(lines);
    if (plan.pack === 'nixpacks') {
      const refusal = capabilityRefusalFor(info, label, { cap: 'build.nixpacks', feature: 'build with Nixpacks' });
      if (refusal) {
        throw new RemoteDeployUnsupportedError(
          `${refusal.message} Until then, add a Dockerfile to the repository, or clear the target server to build on the panel host.`,
        );
      }
    } else if (!info.caps.has('build.railpack')) {
      // r520, kept for agents without `build.railpack` only: say so
      // instead of pretending, and build the repository's Dockerfile.
      log(
        'Railpack is not available on a remote node — building the repository Dockerfile instead. ' +
          `(Update the node agent to v${AGENT_CAPABILITY_VERSION['build.railpack']} or newer to build with Railpack on the node.)`,
      );
      plan = legacyDockerfilePlan(buildConfig);
    }
  }
  // 0.16.2: the legacy `docker.build` takes no stage and no build arguments.
  // An agent with `docker.buildOptions` takes both (`docker.buildWith`);
  // without it, building the last stage instead would ship a different image
  // (often the dev or test one), so that is refused before anything is cloned.
  const wantsOptions = plan.pack === 'dockerfile' && (!!buildConfig?.buildTarget || (buildConfig?.buildArgs ?? []).length > 0);
  let buildOptions = false;
  if (wantsOptions) {
    const { lines } = await agent('agent.ping', {}, () => undefined);
    const refusal = capabilityRefusalFor(parseAgentCapabilities(lines), label, {
      cap: 'docker.buildOptions',
      feature: 'build a Dockerfile stage or with build arguments',
    });
    buildOptions = refusal === null;
    if (refusal && buildConfig?.buildTarget) {
      throw new RemoteDeployUnsupportedError(
        `${refusal.message} Until then, build on the panel host (Service → Settings → Build on: panel), or clear the build stage ("${buildConfig.buildTarget}").`,
      );
    }
  }
  // ── end 0.16 T3 ──
  // 0.13 (T5): a GitHub App repository gets a repository-scoped token for
  // this checkout only — refused for an agent that cannot take it, and
  // revoked below whatever happens. Anything else clones as before.
  const git = opts.gitCredential
    ? await opts.gitCredential(agent, { label, serverId: service.serverId ?? null })
    : { git: agent, release: async () => undefined };
  try {
    log(`Fetching ${service.repoUrl} into the node workspace "${workspace}" …`);
    await git.git('git.ensure', { workspace, url: service.repoUrl, depth: '1' }, sink);
    if (service.branch) {
      await git.git('git.fetch', { workspace }, sink);
      await git.git('git.checkout', { workspace, ref: service.branch }, sink);
    }
    if (commitSha) {
      await git.git('git.reset', { workspace, sha: commitSha }, sink);
    }
  } finally {
    await git.release();
  }

  target = opts.tag ?? `ninedeploy/${service.slug}:${commitSha.slice(0, 7) || 'latest'}`;
  if (plan.pack === 'nixpacks') {
    const buildEnv = nodeBuildEnv(env, log);
    const toml = await nodeNixpacksToml(ctx.manifest, log);
    const params: Record<string, unknown> = { workspace, baseDir: plan.baseDir, tag: target };
    if (buildConfig?.installCmd) params['installCmd'] = buildConfig.installCmd;
    if (buildConfig?.buildCmd) params['buildCmd'] = buildConfig.buildCmd;
    if (buildConfig?.startCmd) params['startCmd'] = buildConfig.startCmd;
    if (Object.keys(buildEnv).length > 0) params['env'] = buildEnv;
    if (toml !== undefined) params['nixpacksToml'] = toml;
    log(`Building ${target} with Nixpacks on the node …`);
    await agent('build.nixpacks', params, sink);
    builtWithNixpacks = true;
  } else if (plan.pack === 'railpack') {
    const buildEnv = nodeBuildEnv(env, log);
    const params: Record<string, unknown> = { workspace, baseDir: plan.baseDir, tag: target };
    if (Object.keys(buildEnv).length > 0) params['env'] = buildEnv;
    log(`Building ${target} with Railpack on the node …`);
    await agent('build.railpack', params, sink);
  } else if (buildOptions) {
    const { dockerBuildArgValues } = await import('./docker.js');
    const buildArgs = dockerBuildArgValues(buildConfig?.buildArgs, env, log, ctx.buildSecretKeys);
    const params: Record<string, unknown> = { workspace, tag: target, dockerfile: plan.dockerfile, context: plan.context };
    if (buildConfig?.buildTarget) params['target'] = buildConfig.buildTarget;
    if (Object.keys(buildArgs).length > 0) params['buildArgs'] = buildArgs;
    log(`Building ${target} from ${plan.dockerfile} on the node …`);
    await agent('docker.buildWith', params, sink);
  } else {
    // 0.16.1: an agent without `docker.buildOptions` takes no build
    // arguments — say so instead of building as if they had been passed.
    if ((buildConfig?.buildArgs ?? []).length > 0) {
      log(
        `⚠ Build arguments (${(buildConfig?.buildArgs ?? []).join(', ')}) are not passed: this node's agent cannot take them ` +
          `(update it to v${AGENT_CAPABILITY_VERSION['docker.buildOptions']} or newer, or build on the panel host).`,
      );
    }
    log(`Building ${target} from ${plan.dockerfile} on the node …`);
    await agent('docker.build', { workspace, tag: target, dockerfile: plan.dockerfile, context: plan.context }, sink);
  }
  return { target, builtWithNixpacks };
}
// ── end 0.16 T4 ──

export function createRemoteDockerBuilder(
  agent: AgentCall,
  opts: {
    pollMs?: number;
    nodeLabel?: string;
    /** 0.13 (T5): the service's per-job Git credential (a GitHub App token); absent = anonymous clone. */
    gitCredential?: NodeGitCredentialSource;
    /**
     * Multi-node (M6, set by build placement): the image was built elsewhere
     * and shipped here. Absent = today's behaviour (pull, or clone and build
     * on the node). No caller sets it yet.
     */
    prebuiltImage?: PrebuiltImage;
  } = {},
): Builder {
  const pollMs = opts.pollMs ?? 2000;
  const replicaSets = new Map<string, Array<{ id: string; name: string }>>();
  const previousReplicaOwners = new Map<string, number>();
  /** Parse the `health` inspect format: `<status>|<health>|<failingStreak>|<restartCount>`. */
  const parseHealth = (
    lines: string[],
  ): { status: string; health: string; failingStreak: number; restarts: number } => {
    const raw = lines.filter((l) => l.trim() !== '').at(-1) ?? '';
    const [status = '', health = '', failingStreak = '', restarts = ''] = raw.trim().split('|');
    return {
      status,
      health,
      failingStreak: Number(failingStreak),
      restarts: restarts === '' ? Number.NaN : Number(restarts),
    };
  };

  return {
    async buildAndRun(ctx: BuildContext, previous?: DeployRuntime): Promise<DeployRuntime> {
      const { service, deploymentId, env, imageDigest, registryAuth, log } = ctx;
      if (previous && (service.runtimeReplicas ?? 1) > 1) previousReplicaOwners.set(previous.runtimeId, service.id);
      const probeProtocol = service.healthCheck === 'http-strict' ? 'http' : service.healthCheck === 'tcp' ? 'tcp' : undefined;
      if (probeProtocol) {
        const info = parseAgentCapabilities((await agent('agent.ping', {}, () => undefined)).lines);
        const refusal = capabilityRefusalFor(info, opts.nodeLabel ?? `#${service.serverId ?? '?'}`, { cap: 'docker.probe', feature: 'probe application readiness' });
        if (refusal) throw new RemoteDeployUnsupportedError(refusal.message);
        if (!service.port && service.image) throw new RemoteDeployUnsupportedError('HTTP/TCP readiness needs a container port.');
      }

      if (service.type !== 'docker') {
        throw new RemoteDeployUnsupportedError(
          `Remote deployments support docker services only; "${service.name}" is a ${service.type} service. ` +
            'Clear the target server to deploy it on the panel host.',
        );
      }

      // (The node workspace is the service slug: see buildSourceOnNode.)
      const name = `${service.slug}-${deploymentId}`;
      const sink = (line: string) => log(line);

      // r415: every container below starts with `--network ninedeploy`, but
      // nothing created that network on the node until the FIRST SUCCESSFUL
      // deploy's proxy sync — a chicken-and-egg that made a fresh node's
      // every deploy fail with "network ninedeploy not found" (and the
      // failure path never syncs the proxy, so it never self-healed).
      // An existing network is a silent no-op (ensureNodeNetwork).
      await ensureNodeNetwork(agent, log);

      let target: string;
      let builtWithNixpacks = false;
      // ── 0.16 T4 prebuilt image (M6) ──
      // Built on the panel or a build server and shipped to this node before
      // the run phase (design §6.3 step 5). Unset by every caller until build
      // placement lands, so every deploy takes the branches below as before.
      if (opts.prebuiltImage) {
        target = (service.replicas ?? 1) > 1 ? opts.prebuiltImage.imageId : opts.prebuiltImage.tag;
        builtWithNixpacks = opts.prebuiltImage.builtWithNixpacks ?? false;
        log(`Running ${target} (${opts.prebuiltImage.imageId.slice(0, 19)}), built elsewhere and shipped to the node …`);
      } else
      // ── end 0.16 T4 ──
      if (service.image) {
        // Pre-built image (template / one-click). On rollback the deployment
        // row pins the exact digest, same as the local builder.
        target = imageDigest ?? service.image;
        // r230: the node's credential store is shared by every deploy to it.
        const releaseRegistry = registryAuth
          ? await acquireRegistryLock(registryLockKey(service.serverId ?? -1, registryAuth.server))
          : null;
        try {
        if (registryAuth) {
          log(`Logging in to ${registryAuth.server || 'docker.io'} on the node …`);
          await agent(
            'docker.login',
            {
              username: registryAuth.username,
              password: registryAuth.password,
              ...(registryAuth.server ? { server: registryAuth.server } : {}),
            },
            sink,
          );
        }
        try {
          log(`Pulling ${target} on the node …`);
          await agent('docker.pull', { image: target }, sink);
        } finally {
          if (registryAuth) {
            await agent(
              'docker.logout',
              registryAuth.server ? { server: registryAuth.server } : {},
              sink,
            ).catch(() => undefined);
          }
        }
        } finally {
          releaseRegistry?.();
        }
      } else {
        // 0.16 T4: the build itself is buildSourceOnNode (a pure move), shared
        // with build placement's build-server builds.
        ({ target, builtWithNixpacks } = await buildSourceOnNode(agent, ctx, opts));
      }

      // Nixpacks apps follow the buildpack $PORT convention: the same 3000
      // default and PORT the panel host gives them (docker.ts), so a
      // Dockerfile-less source deploy gets a port and therefore a route.
      let runService = service;
      let runEnv = env;
      if (builtWithNixpacks || opts.prebuiltImage?.builtStatic) {
        const port = service.port ?? (opts.prebuiltImage?.builtStatic ? 80 : DEFAULT_NIXPACKS_PORT);
        if (service.port == null) {
          log(`No container port configured; using ${opts.prebuiltImage?.builtStatic ? 'static image' : 'Nixpacks'} default ${port}/tcp for runtime and Traefik`);
          runService = { ...service, port };
        }
        if (builtWithNixpacks && env['PORT'] === undefined) runEnv = { ...env, PORT: String(port) };
      }

      // 0.16.6: container options travel on docker.runSpec when the agent
      // can apply them; otherwise runRemoteContainer warns, as 0.16.1 did.

      // The run phase (env-file, `docker.runEnv`, cleanup) lives in
      // remoteRun.ts, unchanged.
      const { port: resolvedPort, replicas, targets } = await runRemoteContainer(agent, {
        service: runService,
        deploymentId,
        env: runEnv,
        name,
        image: target,
        previous,
        log,
        // 0.16 T5 integration (node volumes): the attachments `docker.runSpec` mounts.
        volumeAttachments: ctx.volumeAttachments ?? [],
        nodeLabel: opts.nodeLabel ?? `#${service.serverId ?? '?'}`,
        // 0.16.5: file mounts, written on the node and mounted through docker.runSpec.
        files: ctx.nodeFiles ?? [],
      });

      if (targets) replicaSets.set(name, targets);
      if (opts.prebuiltImage && target === opts.prebuiltImage.imageId) {
        try {
          const actual = (await agent('docker.inspect', { name: targets?.[0]?.id ?? name, format: 'image' }, () => undefined)).lines.filter(line => line.trim()).at(-1)?.trim();
          if (actual !== opts.prebuiltImage.imageId) throw new Error('Runtime image identity does not match the recorded artifact');
        } catch (err) {
          if (targets) await retireRemoteReplicas(agent, targets).catch(() => undefined);
          else await agent('docker.rm', { name }, () => undefined).catch(() => undefined);
          throw err;
        }
      }

      let sourceImageId: string | undefined;
      if (ctx.recordDockerArtifact && !service.image) {
        try {
          const actual = (await agent('docker.inspect', { name: targets?.[0]?.id ?? name, format: 'image' }, () => undefined)).lines.filter(line => line.trim()).at(-1)?.trim();
          if (!actual || !/^sha256:[a-f0-9]{64}$/.test(actual)) throw new Error('unreadable image ID');
          if (opts.prebuiltImage && actual !== opts.prebuiltImage.imageId) throw new Error('placed build image changed');
          sourceImageId = actual;
        } catch {
          log('Node artifact image could not be observed; this deployment continues without an artifact record');
        }
      }

      return {
        ...(sourceImageId ? { artifactBuild: { builtWithNixpacks, builtStatic: opts.prebuiltImage?.builtStatic ?? false } } : {}),
        runtimeId: name,
        ...(targets ? { nodeTargets: targets, replicas } : {}),
        port: resolvedPort,
        healthPath: service.healthPath ?? '/',
        ...(probeProtocol ? { healthCheck: service.healthCheck as 'http-strict' | 'tcp' } : {}),
        ...(service.healthCheck === 'running' ? { healthCheck: 'running' as const } : {}),
        // r270: only a real digest is a digest. Recording the mutable tag (or
        // the node-local build tag) here made the deployment row claim digest
        // pinning while a rollback re-pulled whatever the tag points at today.
        // The node offers no repo-digest lookup, so an unpinned release
        // records none and rollback honestly means "this tag".
        imageDigest: sourceImageId ?? (opts.prebuiltImage && target === opts.prebuiltImage.imageId ? opts.prebuiltImage.imageId : (service.image && /@sha256:[0-9a-f]{64}$/i.test(target) ? target : undefined)),
        // 0.16.4: the command runs as the container's Docker healthcheck; the state poll waits for "healthy".
        ...(runService.healthCheck === 'command' && runService.healthCommand?.trim()
          ? { healthCheck: 'command' as const, healthCommand: runService.healthCommand.trim() }
          : {}),
      };
    },

    async isHealthy(
      runtime: DeployRuntime,
      timeoutMs = 300_000,
      directGraceMs = 10_000,
      log: (line: string) => void = () => undefined,
      options: { checkpoint?: () => Promise<void> } = {},
    ): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      // A running container is not ready to receive proxied traffic until its
      // configured port listens. Explicit modes and rollback checks keep their policy.
      const readinessMode = runtime.healthCheck ?? (runtime.port && directGraceMs > 0 ? 'tcp' : undefined);
      let interruption: { reason: unknown } | undefined;
      const checkpoint = async () => {
        try { await options.checkpoint?.(); }
        catch (reason) { interruption = { reason }; throw reason; }
      };
      const healthCall = async (op: string, params: Record<string, unknown>, sink: (line: string) => void = () => undefined) => {
        await checkpoint();
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Node readiness deadline exceeded');
        const result = await agent(op, params, sink, { timeoutMs: options.checkpoint ? Math.min(15_000, remaining) : remaining });
        await checkpoint();
        if (Date.now() >= deadline) throw new Error('Node readiness deadline exceeded');
        return result;
      };
      const wait = async () => {
        await checkpoint();
        const remaining = deadline - Date.now();
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remaining)));
      };
      if (runtime.nodeTargets?.length) {
        return verifyNodeReadiness((op, params, sink) => healthCall(op, params, sink), {
          targets: runtime.nodeTargets, port: runtime.port, mode: readinessMode ?? 'auto', path: runtime.healthPath,
        }, Math.max(0, deadline - Date.now()), checkpoint, log);
      }
      // r265: the first `running` sample used to be the verdict and
      // `restarting` just kept the poll going — under `--restart
      // unless-stopped` a crash-looping container is `running` between
      // crashes, so it deployed green. A new container must now hold `running`
      // (and pass its image HEALTHCHECK, if it has one) over several
      // consecutive samples with no restart in between, and a rising restart
      // count fails fast: remoteCompose.isHealthy's signals, over the same
      // `health` inspect format (shipped with the remote builders, so every
      // agent that can run this builder answers it). The rollback probe
      // (grace 0) only asks whether the previous runtime is still up, so one
      // good sample answers it.
      const needed = directGraceMs > 0 ? STABLE_SAMPLES : 1;
      const failWithLogs = async (why: string): Promise<false> => {
        log(why);
        // Pull the container's own output so the failure is diagnosable
        // from the deploy log rather than only from the node.
        await healthCall('docker.logs', { name: runtime.runtimeId }, log).catch(() => { if (interruption) throw interruption.reason; });
        return false;
      };
      let stable = 0;
      let baselineRestarts: number | undefined;
      let lastRestarts: number | undefined;
      while (Date.now() < deadline && !deployAborted()) {
        try {
          const res = await healthCall(
            'docker.inspect',
            { name: runtime.runtimeId, format: 'health' },
          );
          const { status, health, failingStreak, restarts } = parseHealth(res.lines);
          if (TERMINAL_BAD.has(status)) {
            return failWithLogs(`${runtime.runtimeId} reached state "${status}" on the node`);
          }
          if (Number.isFinite(restarts)) {
            baselineRestarts ??= restarts;
            // A restart between two samples means the "stable" run so far
            // belonged to a process that has since died — count again.
            if (lastRestarts !== undefined && restarts !== lastRestarts) stable = 0;
            lastRestarts = restarts;
            if (restarts - baselineRestarts >= CRASH_LOOP_RESTARTS) {
              return failWithLogs(
                `${runtime.runtimeId} is crash-looping on the node (restart count ${restarts}) — failing fast`,
              );
            }
          }
          if (status === 'running' && (health === 'none' || health === 'healthy')) {
            if (readinessMode === 'http-strict' || readinessMode === 'tcp') {
              if (!runtime.port) return failWithLogs('HTTP/TCP readiness needs a container port.');
              const result = await healthCall('docker.probe', {
                name: runtime.runtimeId, port: runtime.port,
                protocol: readinessMode === 'tcp' ? 'tcp' : 'http', path: runtime.healthPath,
              });
              const ready = confirmedNodeProbe(result.lines, result.exitCode, readinessMode === 'tcp' ? 'tcp' : 'http');
              if (!ready) {
                stable = 0;
                await wait();
                continue;
              }
            }
            stable += 1;
            if (stable >= needed) {
              log(
                readinessMode === 'http-strict' || readinessMode === 'tcp'
                  ? `${runtime.runtimeId} passed its ${readinessMode === 'tcp' ? 'TCP' : 'HTTP'} readiness probe on the node.`
                  : readinessMode === 'command'
                  ? `${runtime.runtimeId} is running on the node and its healthcheck command passes.`
                  : `${runtime.runtimeId} is running on the node. Remote health is container state, not an ` +
                      'HTTP probe: the panel is outside the node network.',
              );
              return true;
            }
          } else {
            // `restarting`, `created`, or an image HEALTHCHECK still
            // `starting` / `unhealthy`: not a stable run.
            stable = 0;
            if (failingStreak >= 15) {
              return failWithLogs(
                `${runtime.runtimeId} healthcheck keeps failing (streak ${failingStreak}) — failing fast`,
              );
            }
          }
        } catch (err) {
          if (interruption) throw interruption.reason;
          // Inspect fails while the container is still being created, and also
          // when the node is briefly unreachable. Both are worth retrying
          // inside the deadline; the last failure is reported on timeout.
          stable = 0;
          log(`waiting for ${runtime.runtimeId}: ${err instanceof Error ? err.message : String(err)}`);
        }
        await wait();
      }
      await checkpoint();
      log(`${runtime.runtimeId} did not reach a running state on the node within ${Math.round(timeoutMs / 1000)}s`);
      return false;
    },

    async stop(runtimeId: string, opts?: { graceSeconds?: number }): Promise<void> {
      const known = replicaSets.get(runtimeId);
      const owner = previousReplicaOwners.get(runtimeId);
      if (known || owner != null) {
        const targets = known ?? await discoverRemoteReplicas(agent, runtimeId, owner!);
        await retireRemoteReplicas(agent, targets, opts?.graceSeconds ?? 5);
        return;
      }
      // r526: the service's stop grace reaches the node too (it used to be
      // dropped and the agent pinned `-t 5`). An agent that predates the
      // operand ignores it and keeps 5 s. Both calls are best-effort: a
      // container that is already gone must not fail the teardown.
      const params: Record<string, unknown> = { name: runtimeId };
      if (opts?.graceSeconds !== undefined) params['graceSeconds'] = String(opts.graceSeconds);
      await agent('docker.stop', params, () => undefined).catch(() => undefined);
      await agent('docker.rm', { name: runtimeId }, () => undefined).catch(() => undefined);
    },
  };
}
