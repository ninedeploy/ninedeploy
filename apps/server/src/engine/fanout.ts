import { and, eq } from 'drizzle-orm';
import { serviceTargets, servers, type DB } from '@ninedeploy/db';
import { agentOp } from '../lib/agentClient.js';
import { assertAgentGuardsBuildPaths, capabilityRefusal, nodeLabel } from '../lib/agentCapabilities.js';
import { agentTransportSealed } from '../lib/agentClient.js';
import { ensureNodeVolumes, NODE_RUN_SPEC_FEATURE, type NodeVolumeAttachment, nodeRunCapabilities, nodeRunNeeds, nodeVolumeLabels } from '../lib/remoteVolumes.js';
import { acquireRegistryLock, registryLockKey } from '../lib/registryLock.js';
import { assertCloneTargetAllowed } from '../lib/gitEgress.js';
import type { NodeGitCredentialSource } from '../lib/nodeGitCredential.js';
import { createRemoteDockerBuilder, envForAgent } from './builders/remoteDocker.js';
import { runSpecParams } from './builders/remoteRun.js';

/**
 * Multi-server fan-out: push a docker release to additional nodes after the
 * primary deployment succeeds.
 *
 * How a target obtains the release (D8: this header used to say "image
 * services only" while source builds fanned out too):
 *   - an IMAGE release is pulled on the target;
 *   - a SOURCE build whose primary built a Dockerfile is rebuilt on the target
 *     from the same pinned commit (`git.*` + `docker.build`), as since phase 2;
 *   - every other source build — built on the panel or a build server (design
 *     §6), or a primary pack a Dockerfile cannot reproduce (Nixpacks,
 *     Railpack, static: D2) — is SHIPPED: the primary's very image travels
 *     to the target (`ctx.prebuilt`), never a different build. A target that
 *     cannot receive it is refused with the reason.
 *
 * Per target, before anything is sent (D1): the caller's `targetRefusal`
 * (deploy hooks, the database host rule, volume attachments across hosts and
 * the agent's capabilities), and here the `docker.runSpec` capability for a
 * container command, the Docker socket or volume attachments — which a target
 * then runs with, instead of silently dropping them.
 *
 * Scope, stated honestly:
 *   - Additive, never blocking: a node that fails to pull or start keeps the
 *     primary release serving everywhere; the per-target row records the
 *     error for the panel.
 *   - Routing is node-local: every node runs its own Traefik and reaches its
 *     own container by name (`renderDynamicConfig` renders the service into
 *     every node that holds a target). Pointing a domain at several nodes is
 *     the operator's DNS decision — exactly Coolify's model.
 *   - Reconcile does not patrol targets yet: the phase-2 note lives in
 *     runtimeState.ts. A dead extra node serves stale traffic until its next
 *     deploy; the per-node Traefik healthCheck bounds the damage.
 */

const HEALTH_POLL_MS = 2_000;
const HEALTH_TIMEOUT_MS = 60_000;
/** F973: `docker image inspect` in pullableReleaseRef (local metadata read). */
const RELEASE_REF_INSPECT_TIMEOUT_MS = 10_000;

export type AgentCaller = (
  op: string,
  params: Record<string, unknown>,
  sink: (line: string) => void,
) => Promise<{ exitCode: number; lines: string[] }>;

export interface FanoutTarget {
  serverId: number;
  runtimeId: string | null;
}

/** The extra nodes (beyond the primary placement) a release is pushed to. */
export async function targetsForService(db: DB, serviceId: number): Promise<FanoutTarget[]> {
  const rows = await db
    .select({ serverId: serviceTargets.serverId, runtimeId: serviceTargets.runtimeId })
    .from(serviceTargets)
    .where(eq(serviceTargets.serviceId, serviceId));
  return rows;
}

/**
 * F117: the primary's r265 verdict, with a shorter deadline. The first
 * `running` sample used to be accepted — under `--restart unless-stopped` a
 * crash-looping container reads `running` between crashes, so the proven
 * generation was retired for it. The new container must now hold `running`
 * (and pass its image HEALTHCHECK) over consecutive samples with no restart
 * in between, and a rising restart count fails fast.
 */
async function waitRunning(
  agent: AgentCaller,
  name: string,
  log: (line: string) => void,
): Promise<boolean> {
  return createRemoteDockerBuilder(agent, { pollMs: HEALTH_POLL_MS }).isHealthy(
    { runtimeId: name, port: null, healthPath: '/' },
    HEALTH_TIMEOUT_MS,
    undefined,
    log,
  );
}

export interface FanoutContext {
  service: {
    id: number;
    slug: string;
    type: string;
    image: string | null;
    port: number | null;
    healthPath?: string | null;
    cpuShares: number;
    cpuLimitMilli: number;
    memLimitMb: number;
    volumeMount: string | null;
    publishedPort: number | null;
    // ── 0.16 T4 (D1): what a target runs with, instead of dropping it ──
    cmd?: string[] | null;
    dockerSocket?: boolean | null;
    ownerUserId?: number | null;
  };
  /** 0.16 T4 (D1): the service's volume attachments; a target mounts them through `docker.runSpec`. */
  volumeAttachments?: readonly NodeVolumeAttachment[];
  /**
   * 0.16 T4 (design §6.5, D2): the release is SHIPPED to each target rather
   * than pulled or rebuilt — the image the panel or a build server built, or
   * the primary's own build of a pack a target cannot reproduce. `ship`
   * transfers it (recording its `image_transfers` row) and answers what the
   * target runs; it throws with the reason for a target that cannot receive it.
   */
  prebuilt?: { ship: (target: FanoutTarget, log: (line: string) => void) => Promise<{ tag: string; imageId: string }> };
  deploymentId: number;
  /** Image services: the resolved release (digest-pinned on rollback), already pulled on the primary. */
  image?: string;
  env: Record<string, string>;
  registryAuth?: { username: string; password: string; server?: string };
  /** The PRIMARY placement — targets equal to it are skipped. */
  primaryServerId: number | null;
  /** Source builds (phase 2) whose primary built a Dockerfile: each target
   * node builds the SAME commit itself through git.* + docker.build. Any other
   * pack is shipped instead (`prebuilt`, D2). */
  source?: {
    repoUrl: string;
    branch: string | null;
    commitSha: string;
    dockerfilePath: string;
    baseDir: string;
  };
  /**
   * 0.13 (T5): the service's per-job Git credential for a source build — a
   * GitHub App token minted per TARGET, refused for a target whose agent
   * cannot take it (that target fails, the others proceed), and revoked once
   * its checkout is done. Absent = anonymous clone.
   */
  gitCredential?: NodeGitCredentialSource;
  /**
   * Multi-node (M5; T4 fills it for D1): why this target must not receive the
   * release, or null. Asked before anything is sent to the target; a refused
   * target is recorded as failed with the reason, its previous runtime keeps
   * serving, and the other targets proceed. Absent = no refusal (0.15).
   */
  targetRefusal?: (target: FanoutTarget) => Promise<string | null>;
}

/**
 * Push the release to every extra target node. Best-effort per node; returns
 * the per-target outcome so the caller can persist `service_targets`.
 */
export async function deployToTargets(
  db: DB,
  ctx: FanoutContext,
  log: (line: string) => void,
): Promise<Array<{ serverId: number; runtimeId: string | null; ok: boolean; error?: string }>> {
  const rows = await db
    .select({ serverId: serviceTargets.serverId, runtimeId: serviceTargets.runtimeId })
    .from(serviceTargets)
    .where(eq(serviceTargets.serviceId, ctx.service.id));
  const results: Array<{ serverId: number; runtimeId: string | null; ok: boolean; error?: string }> = [];

  for (const target of rows) {
    if (ctx.primaryServerId !== null && target.serverId === ctx.primaryServerId) continue;
    // ── 0.16 T4 per-target refusal (M5, D1) ──
    const refusal = ctx.targetRefusal ? await ctx.targetRefusal(target) : null;
    if (refusal) {
      results.push({ serverId: target.serverId, runtimeId: target.runtimeId, ok: false, error: refusal });
      log(`✗ target node #${target.serverId}: ${refusal} — the primary release is unaffected`);
      continue;
    }
    // ── end 0.16 T4 ──
    const name = `${ctx.service.slug}-t${target.serverId}-${ctx.deploymentId}`;
    const agent: AgentCaller = (op, params, sink) => agentOp(db, target.serverId, op, params, sink);
    // ── 0.16 T4 run shape (D1) ──
    // A command, the Docker socket or volume attachments need the target's
    // `docker.runSpec` (sealed); asked before anything is sent, never dropped.
    const attachments = ctx.volumeAttachments ?? [];
    const runSpec = nodeRunNeeds(ctx.service, attachments).length > 0;
    if (runSpec) {
      const why = await capabilityRefusal(agent, await nodeLabel(db, target.serverId), await agentTransportSealed(db, target.serverId), {
        cap: nodeRunCapabilities(ctx.service, attachments),
        feature: NODE_RUN_SPEC_FEATURE,
        sealedRequired: true,
      }).catch((err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }));
      if (why) {
        results.push({ serverId: target.serverId, runtimeId: target.runtimeId, ok: false, error: why.message });
        log(`✗ target node #${target.serverId}: ${why.message} — the primary release is unaffected`);
        continue;
      }
    }
    // ── end 0.16 T4 ──
    try {
      let release: string;
      if (!ctx.image && !ctx.source && !ctx.prebuilt) {
        throw new Error('fan-out context has neither an image nor a buildable source');
      }
      // ── 0.16 T4 shipped release (design §6.5) ──
      if (ctx.prebuilt) {
        release = (await ctx.prebuilt.ship(target, log)).tag;
      } else {
      // ── end 0.16 T4 ──
      // r526: one registry session around BOTH ways a target obtains the
      // release. The login used to happen after the source build, so a
      // Dockerfile whose base image lives in a private registry was pulled
      // anonymously during `docker build` and failed on every target.
      const releaseRegistry = ctx.registryAuth
        ? await acquireRegistryLock(registryLockKey(target.serverId, ctx.registryAuth.server))
        : null;
      try {
        if (ctx.registryAuth) {
          const login = agent(
            'docker.login',
            { username: ctx.registryAuth.username, password: ctx.registryAuth.password, ...(ctx.registryAuth.server ? { server: ctx.registryAuth.server } : {}) },
            log,
          );
          if (ctx.image) {
            await login;
          } else {
            // r592: a source build only gained this login in 0.10.38; before,
            // it built anonymously and public base images worked. A stale or
            // rejected credential must not turn those working targets into
            // failures — warn and build anonymously, as before.
            await login.catch((err: unknown) => {
              log(
                `target node #${target.serverId}: registry login to ${ctx.registryAuth!.server || 'docker.io'} failed ` +
                  `(${err instanceof Error ? err.message : String(err)}) — building without it; private base images will not pull`,
              );
            });
          }
        }
        try {
          if (ctx.image) {
            release = ctx.image;
            await agent('docker.pull', { image: release }, log);
          } else {
            // Each target builds the pinned commit ITSELF — the image never
            // travels between nodes (that would need a registry).
            const { repoUrl, branch, commitSha, dockerfilePath, baseDir } = ctx.source!;
            log(`target node #${target.serverId}: building from ${repoUrl} @ ${commitSha.slice(0, 7)} …`);
            // r353: same egress gate as the primary's remote checkout (r099) —
            // the clone runs from the target NODE's network position, and this
            // path used to skip it.
            await assertCloneTargetAllowed(repoUrl);
            // r660: refuse the source build on a target whose agent cannot
            // symlink-walk the build paths (an image release still fans out).
            const label = await nodeLabel(db, target.serverId);
            await assertAgentGuardsBuildPaths(agent, label);
            const git = ctx.gitCredential
              ? await ctx.gitCredential(agent, { label, serverId: target.serverId })
              : { git: agent, release: async () => undefined };
            try {
              await git.git('git.ensure', { workspace: ctx.service.slug, url: repoUrl, depth: '1' }, log);
              if (branch) {
                await git.git('git.fetch', { workspace: ctx.service.slug }, log);
                await git.git('git.checkout', { workspace: ctx.service.slug, ref: branch }, log);
              }
              if (commitSha) await git.git('git.reset', { workspace: ctx.service.slug, sha: commitSha }, log);
            } finally {
              await git.release();
            }
            release = `ninedeploy/${ctx.service.slug}:t${target.serverId}-${commitSha.slice(0, 7) || 'latest'}`;
            await agent('docker.build', { workspace: ctx.service.slug, tag: release, dockerfile: dockerfilePath, context: baseDir }, log);
          }
        } finally {
          if (ctx.registryAuth) {
            await agent('docker.logout', ctx.registryAuth.server ? { server: ctx.registryAuth.server } : {}, log).catch(() => undefined);
          }
        }
      } finally {
        releaseRegistry?.();
      }
      } // 0.16 T4: end of the pull / rebuild branch
      // r226: the previous generation keeps serving until the new one is
      // proven. It used to be removed FIRST ("a duplicate name" — but the new
      // name carries the deployment id, so it never collides): a failed run or
      // state check left the node serving nothing, while the row still
      // pointed at the container just removed. Only a host-port publish
      // forces the old one out first (both cannot bind the port).
      const retire = async (runtimeId: string) => {
        await agent('docker.stop', { name: runtimeId }, () => undefined).catch(() => undefined);
        await agent('docker.rm', { name: runtimeId }, () => undefined).catch(() => undefined);
      };
      const sequential = Boolean(ctx.service.publishedPort && ctx.service.port);
      if (target.runtimeId && sequential) await retire(target.runtimeId);
      const envName = `${ctx.service.slug}-t${target.serverId}-${ctx.deploymentId}`;
      // r267: multi-line values travel escaped, as for the primary.
      const wrote = await agent('file.writeEnv', { name: envName, env: envForAgent(ctx.env) }, log);
      const envFile = wrote.lines.find((l) => l.startsWith('wrote '))?.slice('wrote '.length) ?? `.agent-env/${envName}.env`;
      const runParams: Record<string, unknown> = { name, image: release, envFile };
      if (ctx.service.cpuShares > 0) runParams['cpuShares'] = String(ctx.service.cpuShares);
      if (ctx.service.cpuLimitMilli > 0) runParams['cpuLimitMilli'] = String(ctx.service.cpuLimitMilli);
      if (ctx.service.memLimitMb > 0) runParams['memLimitMb'] = String(ctx.service.memLimitMb);
      if (ctx.service.volumeMount) {
        runParams['volume'] = `nd-svc-${ctx.service.slug}-data`;
        runParams['mount'] = ctx.service.volumeMount;
      }
      if (ctx.service.publishedPort && ctx.service.port) {
        runParams['publish'] = `${ctx.service.publishedPort}:${ctx.service.port}`;
      }
      try {
        // ── 0.16 T4 run shape (D1) ──
        if (runSpec) {
          const volumes = [
            ...(ctx.service.volumeMount ? [{ name: `nd-svc-${ctx.service.slug}-data`, mount: ctx.service.volumeMount, readOnly: false }] : []),
            ...attachments.map((a) => ({ name: a.volumeName, mount: a.containerPath, readOnly: a.readOnly === true })),
          ];
          if (volumes.length > 0) {
            const { missingDatabaseVolumes } = await ensureNodeVolumes(
              agent,
              volumes.map((v) => v.name),
              nodeVolumeLabels({ serviceId: ctx.service.id, userId: ctx.service.ownerUserId ?? null }),
              log,
            );
            if (missingDatabaseVolumes.length > 0) {
              throw new Error(`Database volume ${missingDatabaseVolumes.join(', ')} does not exist on node #${target.serverId}`);
            }
          }
          await agent(
            'docker.runSpec',
            runSpecParams(ctx.service as never, {
              name,
              image: release,
              envFile,
              envFileName: envName,
              deploymentId: ctx.deploymentId,
              volumes,
              publish: runParams['publish'] as string | undefined,
            }),
            log,
          );
        } else {
          await agent('docker.runEnv', runParams, log);
        }
        // ── end 0.16 T4 ──
      } catch (err) {
        // F116: `docker run -d` that fails after create leaves a Created
        // container under this name, and the catch below records the OLD
        // runtime — nothing would ever reference (or remove) it again. Same
        // cleanup as the primary (remoteDocker r264); never the tracked one.
        if (name !== target.runtimeId) await agent('docker.rm', { name }, () => undefined).catch(() => undefined);
        throw err;
      } finally {
        await agent('file.deleteEnv', { name: envName }, log).catch(() => undefined);
      }
      const ok = await waitRunning(agent, name, log);
      if (ok && target.runtimeId && !sequential) await retire(target.runtimeId);
      if (!ok && target.runtimeId && !sequential) {
        // The new generation is not trusted: drop it, keep the proven one.
        await retire(name);
        results.push({ serverId: target.serverId, runtimeId: target.runtimeId, ok: false, error: 'container did not reach running state' });
        log(`✗ target node #${target.serverId}: ${name} failed its container-state check — ${target.runtimeId} keeps serving`);
        continue;
      }
      results.push({ serverId: target.serverId, runtimeId: name, ok, error: ok ? undefined : 'container did not reach running state' });
      log(ok ? `✓ target node #${target.serverId} is serving ${name}` : `✗ target node #${target.serverId}: ${name} failed its container-state check`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ serverId: target.serverId, runtimeId: target.runtimeId, ok: false, error: message });
      log(`✗ target node #${target.serverId}: ${message} — the primary release is unaffected`);
    }
  }
  return results;
}

/**
 * r226: a reference the TARGET node can pull. A local primary reports its
 * image as `docker inspect --format {{.Image}}` — the local image ID
 * (`sha256:<hex>`), which a node's `docker pull` reads as
 * `docker.io/library/sha256` and fails, so every target of an image service
 * with a local primary ended in `error`. Resolve the ID to the repo digest the
 * image was pulled by (same bytes on every node), else fall back to the tag.
 */
export async function pullableReleaseRef(image: string, digest: string | undefined): Promise<string> {
  if (!digest) return image;
  if (!/^sha256:[0-9a-f]{64}$/i.test(digest)) return digest;
  try {
    const { capture } = await import('../lib/exec.js');
    const repo = image.replace(/@.*$/, '').replace(/:[^/:]+$/, '');
    // F973: a local metadata read awaited by deploy, rollback and fan-out;
    // capture()'s 30-minute default held them on a wedged daemon. Past the
    // bound the catch falls back to the tag, as on any other inspect failure.
    const digests = (await capture('docker', ['image', 'inspect', digest, '--format', '{{join .RepoDigests " "}}'], { timeoutMs: RELEASE_REF_INSPECT_TIMEOUT_MS }))
      .split(/\s+/)
      .filter(Boolean);
    return digests.find((d) => d.startsWith(`${repo}@`)) ?? digests[0] ?? image;
  } catch {
    return image;
  }
}

/** Tear every target container down (service delete / targets cleared). */
export async function teardownTargets(
  db: DB,
  serviceId: number,
  log: (line: string) => void,
  // r662: the service delete reads its targets BEFORE deleting the row —
  // the FK cascade removes them with it, and reading afterwards found none,
  // so every target container outlived the service on its node.
  knownRows?: FanoutTarget[],
): Promise<void> {
  const rows = knownRows ?? (await targetsForService(db, serviceId));
  for (const target of rows) {
    if (!target.runtimeId) continue;
    const agent: AgentCaller = (op, params, sink) => agentOp(db, target.serverId, op, params, sink);
    await agent('docker.stop', { name: target.runtimeId }, () => undefined).catch(() => undefined);
    await agent('docker.rm', { name: target.runtimeId }, () => undefined).catch(() => undefined);
    log(`target node #${target.serverId}: removed ${target.runtimeId}`);
  }
  await db.delete(serviceTargets).where(eq(serviceTargets.serviceId, serviceId));
}

/** Persist fan-out outcomes onto the target rows (upsert by (service, server)). */
export async function recordFanoutResults(
  db: DB,
  serviceId: number,
  results: Array<{ serverId: number; runtimeId: string | null; ok: boolean; error?: string }>,
): Promise<void> {
  for (const r of results) {
    const [existing] = await db
      .select({ id: serviceTargets.id })
      .from(serviceTargets)
      .where(and(eq(serviceTargets.serviceId, serviceId), eq(serviceTargets.serverId, r.serverId)))
      .limit(1);
    const values = {
      runtimeId: r.runtimeId,
      status: r.ok ? ('running' as const) : ('error' as const),
      updatedAt: new Date(),
    };
    if (existing) {
      await db.update(serviceTargets).set(values).where(eq(serviceTargets.id, existing.id));
    } else {
      // The target row was REMOVED while this deploy's fan-out was running
      // (PATCH targets / service delete raced it). Re-inserting would
      // resurrect a row the operator just deleted — and the container this
      // deploy started on the node must not be left running untracked, so
      // retire it best-effort instead (r403).
      if (r.runtimeId) {
        await agentOp(db, r.serverId, 'docker.stop', { name: r.runtimeId }, () => undefined).catch(() => undefined);
        await agentOp(db, r.serverId, 'docker.rm', { name: r.runtimeId }, () => undefined).catch(() => undefined);
      }
    }
  }
}

/** Server rows (operator UI) that a service may fan out to. */
export async function listFanoutCandidates(db: DB): Promise<Array<{ id: number; name: string }>> {
  return db.select({ id: servers.id, name: servers.name }).from(servers);
}
