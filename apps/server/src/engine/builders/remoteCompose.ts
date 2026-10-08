import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Builder, BuildContext, DeployRuntime } from '../types.js';
import type { AgentCall } from './remoteDocker.js';
import { RemoteDeployUnsupportedError } from './remoteDocker.js';
import { composeScalar, parseComposePs } from './compose.js';
import { INLINE_COMPOSE_FILE } from '../../lib/composeWorkspace.js';
import { assertCloneTargetAllowed } from '../../lib/gitEgress.js';
import { assertAgentGuardsBuildPaths } from '../../lib/agentCapabilities.js';
import type { NodeGitCredentialSource } from '../../lib/nodeGitCredential.js';

/**
 * Remote Compose builder — brings a compose stack up on a registered node
 * through the typed agent protocol.
 *
 * Why this matters more than it looks: most of NineDeploy's one-click template
 * catalogue is compose-shaped, so without this the entire template library was
 * unavailable on a node — multi-node worked for hand-rolled docker services
 * and nothing else.
 *
 * Shape of a remote compose deploy, mirroring the local builder's ORDER, which
 * is the part that matters:
 *
 *   1. materialise the stack in the node's per-service workspace — the YAML for
 *      an inline stack, or a git checkout for a repository one;
 *   2. write `.env` (compose reads project variables from it) and, when the
 *      service has volume attachments, a compose override that adds them;
 *   3. PREFLIGHT: `compose config --quiet` then `compose pull`, both while the
 *      previous revision is still serving. A broken `${VAR}` reference or a bad
 *      tag therefore fails the deployment WITHOUT ever having torn the live
 *      stack down;
 *   4. `compose up -d --build --remove-orphans` — with NO `down` before it
 *      (r590): compose's `up --build` builds every image before it recreates
 *      a single container, so build time is not downtime and a failed build
 *      leaves the previous revision serving. (The local builder had a `down`
 *      ahead of `up --build`; it now builds first, then downs.);
 *   5. apply the platform restart policy, because a compose file with no
 *      `restart:` leaves every container dead after a host reboot and nobody
 *      is watching a remote node;
 *   6. delete `.env` and the override — they carry resolved secrets and the
 *      stack has already read them.
 *
 * Unlike the docker builder there is NO blue-green: compose replaces the
 * project in place, exactly as it does locally.
 */

const PROJECT_PREFIX = 'ndcmp';

/** Compose's default container name for a service: `<project>-<service>-1`. */
function mainContainer(project: string, composeService: string): string {
  return `${project}-${composeService}-1`;
}

/**
 * Render one `.env` VALUE for compose's dotenv parser.
 *
 * Byte-identical to the local builder's rule, and for the same reasons:
 * unquoted values are truncated at the first ` #`, so a secret containing one
 * would reach the container silently truncated; double-quoted values then
 * undergo `$VAR` expansion from the CLI's own environment, so `$` is escaped.
 */
function dotenvValue(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, () => '\\$')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

/**
 * The override file that adds the panel's volume attachments to the main
 * service. Compose merges `-f` left to right, so this WINS on duplicate keys —
 * the panel is the source of truth for attachments.
 */
function renderVolumeOverride(
  composeService: string,
  attachments: Array<{ volumeName: string; containerPath: string; readOnly?: boolean | null }>,
): string {
  // r471: mounts go through composeScalar — remotely compose runs with the
  // service's own .env in scope, and compose interpolates `$VAR` inside every
  // scalar; a `$` in containerPath must not read a secret into the mount path.
  const mounts = attachments
    .map((a) => `      - ${composeScalar(`${a.volumeName}:${a.containerPath}${a.readOnly ? ':ro' : ''}`)}`)
    .join('\n');
  const externals = attachments.map((a) => `  ${a.volumeName}:\n    external: true\n`).join('');
  return `services:\n  ${composeService}:\n    volumes:\n${mounts}\nvolumes:\n${externals}`;
}

/**
 * F208: the repository's own committed `.env`, read from the panel's checkout
 * of the SAME commit (`ctx.workDir`, which the node resets to `ctx.commitSha`).
 * Same rules as the local builder (r352/r423): null when the repo has none,
 * and a committed symlink is refused rather than followed — on the panel host
 * it would read an arbitrary file and ship it to the node.
 */
function readRepoDotEnv(workDir: string): string | null {
  const file = path.join(workDir, '.env');
  try {
    if (lstatSync(file).isSymbolicLink()) {
      throw new Error(
        'the repository commits .env as a symlink — refusing to write resolved secrets through it. Replace the symlink with a regular file.',
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return readFileSync(file, 'utf8');
}

export function createRemoteComposeBuilder(
  agent: AgentCall,
  opts: {
    nodeLabel?: string;
    /** 0.13 (T5): the service's per-job Git credential (a GitHub App token); absent = anonymous clone. */
    gitCredential?: NodeGitCredentialSource;
  } = {},
): Builder {
  // Recorded at buildAndRun time: the project this builder MINTED for the
  // runtimeId it MINTED. The Builder interface only hands `stop()` the
  // runtimeId, so a string-surgery recovery from `<project>-<service>-1`
  // was the only way to reach the project — and that breaks the moment the
  // compose service key (user-controlled YAML) contains a hyphen of its
  // own, leaving partial residue in the "project". A live map keyed by the
  // builder's own minted runtimeId closes the gap with zero string surgery.
  // Map, not array: a redeploy of the same service reuses the runtimeId
  // shape and we want the LATEST project for it.
  const projectByRuntimeId = new Map<string, string>();
  return {
    async buildAndRun(ctx: BuildContext): Promise<DeployRuntime> {
      const { service, buildConfig, env, log } = ctx;
      const workspace = service.slug;
      const project = `${PROJECT_PREFIX}-${service.slug}`;
      const composeService = service.composeService ?? service.slug;
      const sink = (line: string) => log(line);

      // r415: the shared mesh must exist before anything connects to it —
      // on a fresh node nothing else creates it until the first successful
      // deploy's proxy sync (see remoteDocker's identical guard).
      await agent('docker.networkCreate', { name: 'ninedeploy', driver: 'bridge' }, sink).catch(() => undefined);

      // An inline stack is shipped from the panel; a repository stack is
      // checked out on the node. A service with neither has nothing to bring up.
      let composeFile: string;
      if (service.composeContent) {
        log(`Shipping the inline compose stack to the node workspace "${workspace}" …`);
        await agent(
          'file.writeWorkspace',
          { workspace, kind: 'compose', content: service.composeContent },
          sink,
        );
        // The build config's path is deliberately NOT honoured for an inline
        // stack: the panel writes a fixed filename, and following a
        // (Dockerfile-shaped) Settings field would point `-f` at a file nothing
        // writes. Same rule as the local builder.
        composeFile = INLINE_COMPOSE_FILE;
      } else if (service.repoUrl) {
        // Egress gate before the node clones (r099) — see remoteDocker.ts.
        await assertCloneTargetAllowed(service.repoUrl);
        // r660: a repository compose file (and the build contexts it names)
        // is a repo path like a Dockerfile — same agent requirement.
        const label = opts.nodeLabel ?? `#${service.serverId ?? '?'}`;
        await assertAgentGuardsBuildPaths(agent, label);
        // 0.13 (T5): per-job GitHub App token, revoked once the checkout is
        // done — see remoteDocker.ts.
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
          if (ctx.commitSha) await git.git('git.reset', { workspace, sha: ctx.commitSha }, sink);
        } finally {
          await git.release();
        }
        // Re-anchored: a leading slash means "repo root" in the panel's field,
        // but on the node it would be the filesystem root.
        composeFile =
          (buildConfig?.dockerfilePath || INLINE_COMPOSE_FILE).replace(/^\/+/, '') || INLINE_COMPOSE_FILE;
      } else {
        throw new RemoteDeployUnsupportedError(
          `"${service.name}" is a compose service with neither inline YAML nor a repository URL, so there is nothing to bring up on the node.`,
        );
      }

      const attachments = ctx.volumeAttachments ?? [];
      const stack: Record<string, unknown> = { workspace, project, file: composeFile };
      const hasEnv = Object.keys(env).length > 0;
      // F208 (r352 on the node): a repository stack may commit its own `.env`
      // (interpolation defaults). Panel values are appended AFTER the repo's
      // lines (compose's dotenv parser is last-wins per key) and the repo's
      // file is restored afterwards instead of deleted. An inline stack has
      // no repository file to keep.
      const repoDotEnv = hasEnv && !service.composeContent ? readRepoDotEnv(ctx.workDir) : null;

      // Declared before the try: the r464 resolution inside it may replace
      // the deterministic name with the one the stack actually runs.
      let runtimeId = mainContainer(project, composeService);

      try {
        // F209: both writes happen INSIDE the try — a write the node performed
        // but whose answer the panel never got ("the node may still be
        // running it") must still reach the cleanup below.
        if (attachments.length > 0) {
          stack['override'] = '.ninedeploy.compose.override.yml';
          await agent(
            'file.writeWorkspace',
            {
              workspace,
              kind: 'compose-override',
              content: renderVolumeOverride(composeService, attachments),
            },
            sink,
          );
          log(`Wrote ${attachments.length} volume attachment(s) into the compose override`);
        }

        if (hasEnv) {
          const panelLines = `${Object.entries(env)
            .map(([k, v]) => `${k}=${dotenvValue(v)}`)
            .join('\n')}\n`;
          const repoText = repoDotEnv ?? '';
          await agent(
            'file.writeWorkspace',
            {
              workspace,
              kind: 'dotenv',
              content:
                repoText === '' || repoText.endsWith('\n') ? repoText + panelLines : `${repoText}\n${panelLines}`,
            },
            sink,
          );
        }

        // Preflight, in this order, BEFORE anything touches the running stack.
        log(`Validating compose project ${project} on the node …`);
        await agent('docker.composeConfig', stack, sink);
        log('Pre-pulling images (can take minutes on slow links) …');
        await agent('docker.composePull', stack, sink).catch((err: unknown) => {
          // `--ignore-buildable` is not in older compose CLIs, and a stack that
          // only BUILDS has nothing to pull. Neither is a reason to fail before
          // `up` has had its chance — `up --build` reports the real error.
          log(
            `pre-pull skipped: ${err instanceof Error ? err.message : String(err)} (continuing to up --build)`,
          );
        });

        log(`Bringing up compose project ${project} …`);
        await agent('docker.composeUp', stack, sink);

        // The node's Traefik lives on the shared `ninedeploy` network, but a
        // compose project creates its OWN default network — so without this
        // the proxy cannot resolve the stack's containers and every domain on
        // it answers 502. The local builder solves the same problem with
        // `connectTraefikToComposeNetwork`; this is its remote twin.
        await agent(
          'docker.networkConnect',
          { network: `${project}_default`, container: 'ninedeploy-proxy' },
          sink,
        ).catch((err: unknown) => {
          // Already attached is the common case after a redeploy, and docker
          // reports it as an error. A genuinely failed attach shows up as a
          // 502 the operator can act on, which is better than failing a
          // deployment whose containers are up and healthy.
          log(
            `node proxy not attached to ${project}_default: ${err instanceof Error ? err.message : String(err)} (already attached is normal on a redeploy)`,
          );
        });

        // Compose offers no restart-policy override, and a file without
        // `restart:` leaves every container dead after a host reboot.
        await agent('docker.composeRestartPolicy', stack, sink).catch((err: unknown) => {
          log(
            `restart policy not applied: ${err instanceof Error ? err.message : String(err)} — containers keep whatever their compose file declared`,
          );
        });

        // r464: resolve the ACTUAL main container, same as the local builder —
        // a stack that pins `container_name:` (or a scale change) produces a
        // different name than the deterministic `<project>-<service>-1`, and
        // health, routing and stop would all target a container that does not
        // exist. Runs INSIDE the try so the override file still exists (ps
        // takes the same -f set `up` did); tolerant — anything unparseable
        // keeps the deterministic name.
        try {
          const res = await agent('docker.composePs', { ...stack, service: composeService }, sink);
          const parsed = parseComposePs(res.lines.join('\n'));
          // F210: a `restarting` main container (an app that restarts until
          // its database is up) is still THE container — only its name was
          // being asked for; the health check judges its state.
          if (parsed?.Name && (parsed.State === 'running' || parsed.State === 'restarting')) {
            const resolved = parsed.Name.replace(/^\//, '');
            if (resolved !== runtimeId) {
              log(`main container resolved as ${resolved}`);
              runtimeId = resolved;
            }
          }
        } catch (err) {
          log(
            `warning: could not resolve main container name, using ${runtimeId}: ${err instanceof Error ? err.message : err}`,
          );
        }
      } finally {
        // Both files carry resolved secrets and compose has already read them.
        // F208: the repository's own `.env` is put back, not deleted; if
        // that write fails the secret-bearing file is deleted all the same.
        if (hasEnv) {
          const removeDotEnv = () =>
            agent('file.deleteWorkspace', { workspace, kind: 'dotenv' }, sink).catch(() => undefined);
          if (repoDotEnv !== null) {
            await agent('file.writeWorkspace', { workspace, kind: 'dotenv', content: repoDotEnv }, sink).catch(
              removeDotEnv,
            );
          } else {
            await removeDotEnv();
          }
        }
        if (attachments.length > 0) {
          await agent('file.deleteWorkspace', { workspace, kind: 'compose-override' }, sink).catch(
            () => undefined,
          );
        }
      }

      // Record the project this builder MINTED for the runtimeId it MINTED
      // (possibly the r464-resolved one), so `stop()` can tear down the
      // right project without string surgery.
      projectByRuntimeId.set(runtimeId, project);
      return {
        runtimeId,
        port: service.port ?? null,
        healthPath: service.healthPath || '/',
        // Multi-container: digest pinning is per service, so there is no single
        // digest to record for a rollback.
        imageDigest: undefined,
      };
    },

    async isHealthy(
      runtime: DeployRuntime,
      timeoutMs = 60_000,
      _directGraceMs?: number,
      log: (line: string) => void = () => undefined,
    ): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      let baselineRestarts: number | undefined;
      while (Date.now() < deadline) {
        try {
          const res = await agent(
            'docker.inspect',
            { name: runtime.runtimeId, format: 'health' },
            () => undefined,
          );
          const raw = res.lines.filter((l) => l.trim() !== '').at(-1) ?? '';
          const [status, health, failingStreak, restartCount] = raw.trim().split('|');

          // A stack that authors its own healthcheck must pass it: an app that
          // boots, stays `running` and never goes healthy is not a green deploy.
          if (status === 'running' && (health === 'none' || health === 'healthy')) return true;
          if (status === 'exited' || status === 'dead') {
            log(`${runtime.runtimeId} exited before becoming healthy`);
            await agent('docker.logs', { name: runtime.runtimeId }, log).catch(() => undefined);
            return false;
          }
          // Fail fast instead of burning the whole window on a stack that is
          // crash-looping or on a healthcheck that will never pass.
          const restarts = Number(restartCount);
          if (Number.isFinite(restarts)) {
            baselineRestarts ??= restarts;
            if (restarts - baselineRestarts >= 3) {
              log(`${runtime.runtimeId} is crash-looping (restart count ${restarts}) — failing fast`);
              return false;
            }
          }
          if (Number(failingStreak) >= 15) {
            log(`${runtime.runtimeId} healthcheck keeps failing (streak ${failingStreak}) — failing fast`);
            return false;
          }
        } catch {
          /* the container is not up yet, or the node blinked — retry */
        }
        log(`waiting for ${runtime.runtimeId} on the node …`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      log(`${runtime.runtimeId} did not become healthy on the node within ${Math.round(timeoutMs / 1000)}s`);
      return false;
    },

    async stop(runtimeId: string): Promise<void> {
      // Look up the project this builder minted for this runtimeId. A
      // string-surgery recovery from `<project>-<service>-1` was the previous
      // fallback and broke when the compose service key itself contained a
      // hyphen — `runtimeId.replace(/-[^-]+-\d+$/, '')` strips only the LAST
      // `-[^-]+-\d+` block, so `ndcmp-web-frontend-api-1` extracted the wrong
      // project `ndcmp-web-frontend` instead of `ndcmp-web`. A runtimeId this
      // builder never recorded is one it cannot authoritatively tear down —
      // refuse it rather than guess.
      const project = projectByRuntimeId.get(runtimeId);
      if (project === undefined || !project.startsWith(`${PROJECT_PREFIX}-`)) return;
      await agent('docker.composeDown', { project }, () => undefined).catch(() => undefined);
    },
  };
}
