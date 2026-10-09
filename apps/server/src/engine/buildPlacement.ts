import { existsSync } from 'node:fs';
import path from 'node:path';
import { and, desc, eq, lt } from 'drizzle-orm';
import { type DB, deployments, servers } from '@ninedeploy/db';
import { effectiveBuildOn } from '@ninedeploy/schemas';
import { agentOp, agentTransportSealed } from '../lib/agentClient.js';
import { type AgentCaller, capabilityRefusal, nodeLabel } from '../lib/agentCapabilities.js';
import { HttpError } from '../lib/errors.js';
import {
  buildTag,
  hostLabel,
  type ImageHost,
  nodeImageInfo,
  panelImageInfo,
  type PushTarget,
  pullImageByDigest,
  pushImage,
  resolvePushTarget,
  shipImageByStream,
} from '../lib/imageTransfer.js';
import { nodeGitCredentialSource } from '../lib/nodeGitCredential.js';
import { type BuildSlots, buildSlotKey, createBuildSlots } from './buildSlots.js';
import type { BuildContext } from './types.js';

/**
 * Build placement (multi-node, design §6.2, §6.3): where a service's image is
 * built — where it runs (`target`, today), on the panel host, or on a build
 * server — before it is shipped to every host that runs it.
 *
 * Every service whose `build_on` is NULL (every pre-0072 row) resolves to
 * `target` WITHOUT a database read, and the pipeline then builds where the
 * service runs exactly as in 0.15. The rest is opt-in per service
 * (`PUT /v1/services/:id/placement`, operator).
 */

export type BuildPlacement =
  /** Build where the service runs (NULL `build_on`, every pre-0072 row). */
  | { kind: 'target' }
  /** Build on the panel host, then ship. */
  | { kind: 'panel' }
  /** Build on the build server `serverId`, then ship. */
  | { kind: 'server'; serverId: number };

/** Why a placement cannot be honoured. The deploy fails; it never falls back to another host. */
export class BuildPlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildPlacementError';
  }
}

/** Design §6.2: `build_on = server` whose server was deleted (ON DELETE SET NULL). */
export const BUILD_SERVER_REMOVED =
  'The build server of this service was removed; choose another or build on the target (Service → Settings → Build → Build on).';

export async function resolveBuildPlacement(
  db: DB,
  service: { id: number; serverId?: number | null; buildOn?: string | null; buildServerId?: number | null },
): Promise<BuildPlacement> {
  const buildOn = effectiveBuildOn((service.buildOn ?? null) as 'target' | 'panel' | 'server' | null);
  if (buildOn === 'target') return { kind: 'target' };
  const runsOn = service.serverId ?? null;
  if (buildOn === 'panel') return runsOn == null ? { kind: 'target' } : { kind: 'panel' };
  // build_on = server
  if (service.buildServerId == null) throw new BuildPlacementError(BUILD_SERVER_REMOVED);
  const row = await db.query.servers.findFirst({ where: eq(servers.id, service.buildServerId) });
  if (!row) throw new BuildPlacementError(BUILD_SERVER_REMOVED);
  if (!row.isBuildServer) {
    throw new BuildPlacementError(
      `Node "${row.name}" (#${row.id}) is no longer a build server; turn its build-server role back on (Servers → node), choose another, or build on the target.`,
    );
  }
  if (row.id === runsOn) return { kind: 'target' };
  return { kind: 'server', serverId: row.id };
}

/** The build host of a placement that builds elsewhere. */
export const placementHost = (p: Exclude<BuildPlacement, { kind: 'target' }>): ImageHost => (p.kind === 'panel' ? null : p.serverId);

/** `deployments.build_host`: `panel` or `node:<id>`. */
export const buildHostColumn = (host: ImageHost): string => (host == null ? 'panel' : `node:${host}`);

// ── build slots (design §6.3 "Concurrency") ──────────────────────────────────

/** The panel's build slots, when the worker did not register its own (direct pipeline callers, tests). */
let defaultSlots: BuildSlots | null = null;
function fallbackSlots(db: DB): BuildSlots {
  defaultSlots ??= createBuildSlots(async (key) => {
    if (key === 'build:panel') return 1;
    const id = Number(key.slice('build:'.length));
    const row = await db.query.servers.findFirst({ where: eq(servers.id, id) });
    return row?.buildConcurrency ?? 1;
  });
  return defaultSlots;
}

// ── build elsewhere ──────────────────────────────────────────────────────────

/** An image built away from where the service runs. */
export interface PlacedBuild {
  buildHost: ImageHost;
  tag: string;
  imageId: string;
  sizeBytes: number;
  builtWithNixpacks: boolean;
  builtStatic: boolean;
  /** Set when the service ships by registry (opt-in): the pushed digest. */
  registry?: { target: PushTarget; digest: string };
}

/** Test seams for the two builders (default: the real ones, loaded lazily). */
export interface PlacedBuildDeps {
  buildOnPanel?: (ctx: BuildContext, tag: string) => Promise<{ builtWithNixpacks: boolean; builtStatic: boolean }>;
  buildOnNode?: (
    agent: AgentCaller,
    ctx: BuildContext,
    opts: { nodeLabel: string; gitCredential: ReturnType<typeof nodeGitCredentialSource>; tag: string },
  ) => Promise<{ target: string; builtWithNixpacks: boolean }>;
  panelImageInfo?: typeof panelImageInfo;
  railpackUnavailableReason?: () => Promise<string | null>;
}

/**
 * Build the service's image on its build host (design §6.3 steps 1–2): the
 * panel's own builder (every pack, every credential kind — the credential
 * never leaves the panel), or the remote builder's build half on a build
 * server with the §2/§3 rules applied to THAT node. Then, for a service that
 * ships by registry, push it. A build failure throws before any host that
 * runs the service is touched.
 */
export async function buildElsewhere(
  db: DB,
  placement: Exclude<BuildPlacement, { kind: 'target' }>,
  ctx: BuildContext,
  opts: { slots?: BuildSlots; deps?: PlacedBuildDeps } = {},
): Promise<PlacedBuild> {
  const { service, log } = ctx;
  if (service.type !== 'docker' || service.image || service.composeContent || !service.repoUrl) {
    throw new BuildPlacementError(
      'Building on the panel or a build server applies to docker services built from a repository; this service builds where it runs. Set Build on: target.',
    );
  }
  const host = placementHost(placement);
  const tag = buildTag(service.slug, ctx.commitSha, ctx.deploymentId);
  const pushTarget = await resolvePushTarget(db, service);

  // A build server must be able to hand the image over BEFORE anything is
  // built on it: stream relay needs `stream` + `image.manage` (sealed); a
  // registry push needs `image.manage` (checked again by pushImage).
  let agent: AgentCaller | null = null;
  let label = '';
  if (host != null) {
    const id = host;
    agent = (op, params, sink) => agentOp(db, id, op, params, sink);
    label = await nodeLabel(db, id);
    if ((ctx.buildConfig?.buildPack ?? 'auto') === 'static') {
      throw new BuildPlacementError(
        'The static build pack runs its build commands on the host itself and has no node implementation; build it on the panel (Build on: panel).',
      );
    }
    const refusal = await capabilityRefusal(agent, label, await agentTransportSealed(db, id), {
      cap: pushTarget ? ['image.manage'] : ['stream', 'image.manage'],
      feature: 'hand a built image over as a build server',
      sealedRequired: pushTarget == null,
      persist: { db, serverId: id },
    });
    if (refusal) throw new HttpError(refusal.status, refusal.code, refusal.message);
  } else if ((ctx.buildConfig?.buildPack ?? 'auto') === 'railpack') {
    // r520/r582 for the panel host: refuse before anything is built.
    const reason = await (opts.deps?.railpackUnavailableReason ?? (await import('./builders/docker.js')).railpackUnavailableReason)();
    if (reason) throw new BuildPlacementError(reason);
  }

  const slots = opts.slots ?? fallbackSlots(db);
  const releaseSlot = await slots.acquire(buildSlotKey(host), (ahead) =>
    log(`⏳ waiting for the build ${host == null ? 'slot on the panel host' : `server ${label}`} (${ahead} ahead)`),
  );
  let built: { builtWithNixpacks: boolean; builtStatic: boolean };
  let info: { id: string; size: number };
  try {
    if (host == null || agent == null) {
      log(`Building ${tag} on the panel host (build placement: panel) …`);
      const buildOnPanel = opts.deps?.buildOnPanel ?? (await import('./builders/docker.js')).buildSourceImage;
      built = await buildOnPanel(ctx, tag);
      info = await (opts.deps?.panelImageInfo ?? panelImageInfo)(tag);
    } else {
      log(`Building ${tag} on build server ${label} …`);
      const buildOnNode = opts.deps?.buildOnNode ?? (await import('./builders/remoteDocker.js')).buildSourceOnNode;
      // The §2/§3 rules apply to the BUILD node: it clones (with the
      // per-job credential its source allows there) and builds.
      const nodeCtx: BuildContext = { ...ctx, service: { ...service, serverId: host } };
      const res = await buildOnNode(agent, nodeCtx, { nodeLabel: label, gitCredential: nodeGitCredentialSource(db, service), tag });
      built = { builtWithNixpacks: res.builtWithNixpacks, builtStatic: false };
      info = await nodeImageInfo(agent, tag, label);
    }
  } finally {
    releaseSlot();
  }
  log(`Built ${tag} (${info.id.slice(0, 19)}) on ${hostLabel(host)}`);
  const result: PlacedBuild = { buildHost: host, tag, imageId: info.id, sizeBytes: info.size, ...built };
  if (pushTarget) {
    const { digest } = await pushImage(db, host, { tag, target: pushTarget }, log);
    result.registry = { target: pushTarget, digest };
    log(`Pushed ${pushTarget.repository}@${digest}`);
  }
  return result;
}

/**
 * Ship a placed build to one host that runs the service (design §6.3 step 3),
 * recording its `image_transfers` row. Returns the reference that host runs.
 * The build host itself needs nothing.
 */
export async function shipPlacedBuild(
  db: DB,
  build: PlacedBuild,
  target: ImageHost,
  ids: { deploymentId: number; serviceId: number },
  log: (line: string) => void,
): Promise<{ tag: string; imageId: string }> {
  if (target === build.buildHost) return { tag: build.tag, imageId: build.imageId };
  if (build.registry) {
    const res = await pullImageByDigest(
      db,
      {
        ...ids,
        source: build.buildHost,
        target,
        imageId: build.imageId,
        repository: build.registry.target.repository,
        digest: build.registry.digest,
      },
      build.registry.target,
      log,
    );
    return { tag: res.ref, imageId: build.imageId };
  }
  await shipImageByStream(
    db,
    { ...ids, source: build.buildHost, target, tag: build.tag, imageId: build.imageId, sizeBytes: build.sizeBytes || undefined },
    log,
  );
  return { tag: build.tag, imageId: build.imageId };
}

/** Record where the deployment's image was built (`deployments.build_host`, `image_id`). Best-effort. */
export async function recordBuildHost(db: DB, deploymentId: number, build: { buildHost: ImageHost; imageId: string }): Promise<void> {
  try {
    await db.update(deployments).set({ buildHost: buildHostColumn(build.buildHost), imageId: build.imageId }).where(eq(deployments.id, deploymentId));
  } catch {
    /* history only */
  }
}

/**
 * Retention on a build NODE (design §6.3 step 6): once every host has the
 * image, remove the previous deployment's build tag of this service there
 * (`docker.imageRm`, never forced: an image a container uses stays). The
 * current tag is kept so a redeploy of the same SHA can ship without a
 * rebuild. The panel keeps today's prune rules.
 */
export async function retainBuildHostTags(
  db: DB,
  build: PlacedBuild,
  service: { id: number; slug: string },
  deploymentId: number,
  log: (line: string) => void,
): Promise<void> {
  if (build.buildHost == null) return;
  const host = build.buildHost;
  try {
    const [previous] = await db
      .select({ id: deployments.id, commitSha: deployments.commitSha })
      .from(deployments)
      .where(and(eq(deployments.serviceId, service.id), eq(deployments.buildHost, buildHostColumn(host)), lt(deployments.id, deploymentId)))
      .orderBy(desc(deployments.id))
      .limit(1);
    if (!previous) return;
    const old = buildTag(service.slug, previous.commitSha ?? '', previous.id);
    if (old === build.tag) return;
    await agentOp(db, host, 'docker.imageRm', { image: old }, () => undefined);
    log(`Removed the previous build ${old} from ${hostLabel(host)}`);
  } catch {
    /* in use, already gone, or an unreachable node: retention is best-effort */
  }
}

// ── fan-out (design §6.5, D2) ────────────────────────────────────────────────

/** What the primary's source build ran: decides whether a target may rebuild it (D2). */
export type PrimaryPack = 'dockerfile' | 'nixpacks' | 'railpack' | 'static';

/**
 * The pack the primary built with, from the panel's checkout and the local
 * builder's rules (the same rules the node builder resolves with, so a node
 * primary agrees): only a Dockerfile build can be reproduced by a target.
 */
export async function primaryBuildPack(
  workDir: string,
  buildConfig: { buildPack?: string | null; dockerfilePath?: string | null; baseDir?: string | null } | undefined,
): Promise<{ pack: PrimaryPack; dockerfile: string; context: string }> {
  const pack = buildConfig?.buildPack ?? 'auto';
  const dockerfile = (buildConfig?.dockerfilePath || 'Dockerfile').replace(/^\/+/, '') || 'Dockerfile';
  const context = (buildConfig?.baseDir || '.').replace(/^\/+/, '') || '.';
  if (pack === 'static' || pack === 'nixpacks' || pack === 'railpack') return { pack, dockerfile, context };
  if (pack !== 'auto' || !existsSync(path.join(workDir, '.git'))) return { pack: 'dockerfile', dockerfile, context };
  const { resolveNodeBuildPlan } = await import('./builders/remoteDocker.js');
  const plan = await resolveNodeBuildPlan(workDir, buildConfig, () => undefined);
  return plan.pack === 'dockerfile' ? { pack: 'dockerfile', dockerfile: plan.dockerfile, context: plan.context } : { pack: plan.pack, dockerfile, context };
}

/** The image a primary built where it runs (`ninedeploy/<slug>:<sha7>`), as the shipping source for its targets. */
export async function primaryImage(
  db: DB,
  primary: ImageHost,
  slug: string,
  commitSha: string,
): Promise<{ tag: string; imageId: string; sizeBytes: number }> {
  const tag = `ninedeploy/${slug}:${commitSha.slice(0, 7) || 'latest'}`;
  if (primary == null) {
    const info = await panelImageInfo(tag);
    return { tag, imageId: info.id, sizeBytes: info.size };
  }
  const id = primary;
  const agent: AgentCaller = (op, params, sink) => agentOp(db, id, op, params, sink);
  const label = await nodeLabel(db, id);
  const refusal = await capabilityRefusal(agent, label, await agentTransportSealed(db, id), {
    cap: ['stream', 'image.manage'],
    feature: 'send its build to the other nodes of this service',
    sealedRequired: true,
  });
  if (refusal) throw new HttpError(refusal.status, refusal.code, refusal.message);
  const info = await nodeImageInfo(agent, tag, label);
  return { tag, imageId: info.id, sizeBytes: info.size };
}

// ── save-time checks ─────────────────────────────────────────────────────────

/**
 * Design §2.3 (open item for T4): the Railpack save-time check asks for the
 * PANEL's `BUILDKIT_HOST` only when the panel is the one that builds it. A
 * service that builds where it runs, on a node whose cached capabilities
 * include `build.railpack`, builds there (the node needs no BUILDKIT_HOST
 * either). Everything else — the panel host, build placement `panel`, a node
 * whose agent cannot (r520's Dockerfile substitution) — keeps the panel's
 * check exactly as before.
 */
export async function railpackBuildsOnCapableNode(
  db: DB,
  service: { serverId?: number | null; buildOn?: string | null; buildServerId?: number | null },
): Promise<boolean> {
  const buildOn = effectiveBuildOn((service.buildOn ?? null) as 'target' | 'panel' | 'server' | null);
  const host = buildOn === 'target' ? (service.serverId ?? null) : buildOn === 'server' ? (service.buildServerId ?? null) : null;
  if (host == null) return false;
  const row = await db.query.servers.findFirst({ where: eq(servers.id, host) });
  return Array.isArray(row?.agentCaps) && row.agentCaps.includes('build.railpack');
}
