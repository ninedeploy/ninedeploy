import { eq } from 'drizzle-orm';
import { type DB, databaseAttachments, type ServiceRuntimeOptions, serviceTargets, serviceVolumeAttachments } from '@ninedeploy/db';
import { MAX_REPLICAS, TRAEFIK_CONTAINER } from './dockerNames.js';
import { SwarmOrchestrator, STACK_DEPLOY_TIMEOUT_MS } from '../kernel/drivers/swarmOrchestrator.js';
import type { StackServiceSpec, StackSpec } from '../kernel/types.js';
import { capture, run, sleep } from '../lib/exec.js';
import { buildTag, panelImageInfo, resolvePushTarget, shipImageByStream } from '../lib/imageTransfer.js';
import { safeProbePath } from '../lib/probeUrl.js';
import {
  ensureSwarmNetwork,
  listSwarmNodes,
  localSwarmInfo,
  removeSwarmStack,
  SWARM_MEMBER_CONSTRAINT,
  SWARM_MEMBER_LABEL,
  swarmClusterRefusal,
  swarmImageTag,
  swarmServiceName,
  swarmStackName,
  updateNodeLabel,
  withDeployDockerConfig,
} from '../lib/swarm.js';
import { buildElsewhere, recordBuildHost } from './buildPlacement.js';
import { dockerBuilder, userDockerLabels } from './builders/docker.js';
import { pullableReleaseRef } from './fanout.js';
import type { BuildContext, Builder, DeployRuntime } from './types.js';
import { unusedSwarmPreloadLabel } from './swarmPreload.js';
import { verifySwarmTaskImages } from './swarmArtifact.js';
import { SwarmRecoveryPending } from './swarmRecovery.js';
import { pinSwarmImage } from './swarmImage.js';
import { loadNodeServiceFiles } from '../lib/serviceFiles.js';
import { ensureSwarmFileSecrets, pruneUnusedFileSecrets } from '../lib/swarmFileSecrets.js';

/**
 * Swarm deploy flow (multi-node, design §7.4; owner decisions O4, O12): build
 * on the panel (or ship from a build server), distribute the image, join
 * Traefik to the service's overlay, `docker stack deploy` with a convergence
 * wait, probe, and route through the overlay — `services.runtimeId` becomes
 * the Swarm service `nd-<slug>_web`, whose VIP Traefik resolves, so the proxy
 * renders it like any runtime.
 *
 * Entered from the pipeline (mount point M5, block `0.16 T7 swarm`) only for
 * a service with `orchestrator = 'swarm'`. Every other service — every row
 * with a NULL orchestrator, i.e. every service before an operator opts one
 * in — never reaches this module and deploys exactly as before.
 *
 * Rolling updates are Swarm's (start-first, one task at a time, rolled back
 * by Swarm when a new task fails); when the panel's own probe fails after the
 * update converged, this builder rolls the service back to its previous spec
 * (`docker service rollback`). The pipeline's failure path then finds the
 * previous version healthy and keeps the service running on it.
 */

/** Does this service deploy through Swarm? Never for a preview: a preview of a Swarm service runs as a local container (design §7.1). */
export function isSwarmService(service: { orchestrator?: string | null; isEphemeralPreview?: boolean | null }): boolean {
  return service.orchestrator === 'swarm' && service.isEphemeralPreview !== true;
}

/** The service's container options a Swarm task can carry; null when none of them is set. GPUs are left out. */
export function swarmContainerOptions(options: ServiceRuntimeOptions | null | undefined): StackServiceSpec['containerOptions'] | null {
  if (!options) return null;
  const out: NonNullable<StackServiceSpec['containerOptions']> = {};
  if (options.init) out.init = true;
  if (options.ulimitNofile) out.ulimitNofile = options.ulimitNofile;
  if (options.capAdd?.length) out.capAdd = options.capAdd.map((c) => `CAP_${c}`);
  if (options.shmSizeMb) out.shmSizeMb = options.shmSizeMb;
  return Object.keys(out).length > 0 ? out : null;
}

type SwarmCandidate = {
  healthCheck?: string | null;
  id: number;
  type: string;
  composeContent?: string | null;
  serverId?: number | null;
  volumeMount?: string | null;
  dockerSocket?: boolean | null;
  publishedPort?: number | null;
  portMappings?: unknown[] | null;
  templateDatabaseEnv?: unknown;
  image?: string | null;
  repoUrl?: string | null;
};

/**
 * Why this service cannot run on Swarm (design §7.1), or null. Checked when
 * an operator switches it to Swarm (`PUT /v1/services/:id/placement`) and
 * again by every deploy.
 */
export async function swarmServiceRefusal(db: DB, svc: SwarmCandidate): Promise<string | null> {
  if (svc.healthCheck === 'http-strict' || svc.healthCheck === 'tcp') {
    return 'HTTP/TCP readiness probes apply to plain Docker containers. Use a command healthcheck for Swarm.';
  }
  const fix = 'Set the orchestrator back to plain containers, or change the service.';
  if (svc.type !== 'docker' || svc.composeContent) {
    return `Swarm runs docker services built from an image or a repository; a ${svc.composeContent ? 'compose stack' : `${svc.type} service`} cannot run on Swarm. ${fix}`;
  }
  if (!svc.image && !svc.repoUrl) return `The service has neither an image nor a repository to run. ${fix}`;
  if (svc.serverId != null) {
    return `The service is pinned to a node; on Swarm the cluster places the replicas itself. Clear the node (run it on the panel host) first. ${fix}`;
  }
  if (svc.volumeMount) return `A persistent volume (${svc.volumeMount}) cannot follow Swarm replicas: named volumes are per node. ${fix}`;
  if (svc.dockerSocket) return `The Docker socket is not mounted into Swarm tasks. ${fix}`;
  if (svc.publishedPort != null) return `A published host port is refused on Swarm: Traefik is the only ingress (no --publish). ${fix}`;
  if (svc.portMappings?.length) return `Port mappings are refused on Swarm: Traefik is the only ingress (no --publish). ${fix}`;
  const [attachment] = await db.select({ id: serviceVolumeAttachments.id }).from(serviceVolumeAttachments).where(eq(serviceVolumeAttachments.serviceId, svc.id)).limit(1);
  if (attachment) return `Volume attachments cannot follow Swarm replicas: named volumes are per node. ${fix}`;
  const [database] = await db.select({ id: databaseAttachments.id }).from(databaseAttachments).where(eq(databaseAttachments.serviceId, svc.id)).limit(1);
  if (database || (svc.templateDatabaseEnv && Object.keys(svc.templateDatabaseEnv as object).length > 0)) {
    return `Managed databases are not reachable from Swarm tasks in this release: detach the database first. ${fix}`;
  }
  const [target] = await db.select({ id: serviceTargets.id }).from(serviceTargets).where(eq(serviceTargets.serviceId, svc.id)).limit(1);
  if (target) return `Fan-out targets do not apply to a Swarm service (Swarm spreads the replicas); clear the targets first. ${fix}`;
  return null;
}

/** The deploy-time check (design §7.4 step 1): the service's own rules, then the cluster's. */
export async function swarmDeployRefusal(db: DB, svc: SwarmCandidate): Promise<string | null> {
  return (await swarmServiceRefusal(db, svc)) ?? (await swarmClusterRefusal(db));
}

/** The image a Swarm deploy runs, and how the nodes get it. */
interface SwarmImage {
  ref: string;
  /** Only on the panel host (and wherever it was preloaded): deployed with `--resolve-image never`. */
  local: boolean;
  imageId?: string;
  artifactBuild?: NonNullable<DeployRuntime['artifactBuild']>;
  sizeBytes?: number;
  auth?: { username: string; password: string; server?: string };
}

/** Test seams. */
export interface SwarmBuilderDeps {
  driver?: Pick<SwarmOrchestrator, 'deployStack'>;
  buildOnPanel?: typeof buildElsewhere;
  ship?: typeof shipImageByStream;
}

const HEALTH_POLL_MS = 3000;
const ROLLBACK_WAIT_MS = 5 * 60_000;
const READ_TIMEOUT_MS = 30_000;
const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The pipeline's builder for the Swarm service `slug`. A runtime id that is
 * not THIS service's Swarm service (the previous generation of a service
 * switched from plain containers) is handed to the local docker builder, so
 * its health probe and its retirement after the switch work as before. The
 * stack it removes is always named from `slug`, never parsed out of a runtime
 * id (security review L1).
 */
export function createSwarmBuilder(db: DB, slug: string, deps: SwarmBuilderDeps = {}): Builder {
  const local = dockerBuilder;
  const own = swarmServiceName(slug);
  /** Set when this deploy updated an existing Swarm service in place: its previous spec is what a failed probe rolls back to. */
  let rollbackTarget: string | null = null;
  let expectedTaskImage: Parameters<typeof verifySwarmTaskImages>[1] | null = null;
  let journalled = false;

  return {
    async buildAndRun(ctx: BuildContext, previous?: DeployRuntime): Promise<DeployRuntime> {
      void previous;
      const { service, log } = ctx;
      if (service.slug !== slug) throw new Error(`Swarm builder for ${slug} handed service ${service.slug}`);
      const runtimeId = own;
      log(`Swarm: deploying "${service.name}" as the Swarm service ${runtimeId} (${clampReplicas(service.replicas)} replica${clampReplicas(service.replicas) === 1 ? '' : 's'})`);

      const image = await resolveImage(db, ctx, deps);
      if (ctx.recordDockerArtifact) {
        if (!image.imageId || !image.artifactBuild || !ctx.captureSwarmArtifact) throw new Error('Swarm source artifact capture is required before stack submission');
        await ctx.captureSwarmArtifact({ imageId: image.imageId, ...image.artifactBuild });
      }
      // M1c: the panel's own node is a member (labelled at init; re-asserted here, idempotent).
      const info = await localSwarmInfo();
      if (info.nodeId) await updateNodeLabel(info.nodeId, '--label-add', `${SWARM_MEMBER_LABEL}=1`);
      const constraints = [SWARM_MEMBER_CONSTRAINT, ...(image.local ? await preloadImage(db, ctx, image, deps, info.nodeId) : [])];
      const network = await ensureSwarmNetwork(slug, log);
      // File mounts (ROADMAP item 10): each file as a Swarm secret, mounted read-only at its path.
      const fileSecrets = await ensureSwarmFileSecrets(swarmStackName(slug), await loadNodeServiceFiles(db, service.id), log);

      // ROADMAP item 10: init, nofile, capabilities and shared memory ride in the task spec; GPUs cannot.
      const containerOptions = swarmContainerOptions(ctx.service.runtimeOptions);
      if (ctx.service.runtimeOptions?.gpus != null) {
        ctx.log('⚠ GPUs are not applied to a Swarm service: Swarm has no equivalent of --gpus. The other container options apply.');
      }
      const spec: StackSpec = {
        name: swarmStackName(slug),
        services: [
          {
            name: 'web',
            image: image.ref,
            replicas: clampReplicas(service.replicas),
            port: ctx.service.port ?? null,
            env: ctx.env,
            networks: [network],
            secrets: [],
            configs: [],
            healthPath: ctx.service.healthPath ?? '/',
            labels: {
              'ninedeploy.managed': 'service',
              'ninedeploy.service': String(service.id),
              'ninedeploy.deployment': String(ctx.deploymentId),
            },
            constraints,
            ...(Array.isArray(service.cmd) && service.cmd.length > 0 ? { command: service.cmd } : {}),
            cpuLimitMilli: ctx.service.cpuLimitMilli ?? 0,
            memLimitMb: ctx.service.memLimitMb ?? 0,
            ...(typeof ctx.buildConfig?.stopGraceSeconds === 'number' ? { stopGraceSeconds: ctx.buildConfig.stopGraceSeconds } : {}),
            // 0.16.4: custom labels and the command healthcheck.
            ...(userDockerLabels(service.dockerLabels).length > 0 ? { containerLabels: Object.fromEntries(userDockerLabels(service.dockerLabels)) } : {}),
            ...(service.healthCheck === 'command' && service.healthCommand?.trim() ? { healthCommand: service.healthCommand.trim() } : {}),
            ...(fileSecrets.length > 0 ? { fileSecrets } : {}),
            ...(containerOptions ? { containerOptions } : {}),
          },
        ],
        networks: [{ name: network, driver: 'overlay', attachable: true }],
        secrets: [],
        configs: [],
        volumes: [],
        ...(image.local ? { resolveImage: 'never' as const } : {}),
      };
      if ((ctx.service.cpuShares ?? 0) > 0) log('note: CPU shares have no Swarm equivalent; the CPU and memory limits apply.');

      const transition = ctx.prepareSwarmTransition ? await ctx.prepareSwarmTransition(spec, {
        runtimeId, port: ctx.service.port ?? null, healthPath: ctx.service.healthPath ?? '/',
        ...(image.imageId ? { imageDigest: image.imageId } : {}),
        ...(service.healthCheck === 'command' && service.healthCommand?.trim() ? { healthCheck: 'command' as const, healthCommand: service.healthCommand.trim() } : {}),
      }, image.auth) : undefined;
      if (!transition && !deps.driver) throw new SwarmRecoveryPending('Managed Swarm deployment requires a durable transition journal');
      journalled = transition !== undefined;

      const existed = await serviceExists(runtimeId);
      const driver = deps.driver ?? new SwarmOrchestrator(db);
      log(`Swarm: ${transition ? `applying journalled native service ${runtimeId}` : `docker stack deploy ${spec.name}`} (rolling, start-first; waits up to ${STACK_DEPLOY_TIMEOUT_MS / 60_000} minutes for convergence)`);
      let error: string | undefined;
      let imageUnconfirmed = false;
      const submittedAt = Date.now();
      try {
        // M4: a private client config per deploy, logged in only for a
        // registry service, forwarded only then, and gone once the spec is
        // submitted — the convergence wait runs without it.
        const status = await withDeployDockerConfig(image.auth, log, (dockerConfig) =>
          driver.deployStack(spec, { log, timeoutMs: STACK_DEPLOY_TIMEOUT_MS, wait: false, dockerConfig, withRegistryAuth: image.auth !== undefined, ...(transition ? { nativeApply: () => transition.submit() } : {}) }),
        );
        error = status.error;
      } catch (err) {
        error = msg(err);
      }
      if (!error) error = (await waitForConvergence(runtimeId, submittedAt, STACK_DEPLOY_TIMEOUT_MS, log)) ?? undefined;
      if (!error && image.imageId) {
        try {
          const expected = { runtimeId, imageRef: image.ref, imageId: image.imageId, replicas: clampReplicas(service.replicas), serviceId: service.id, deploymentId: ctx.deploymentId, panelNodeId: info.nodeId };
          await verifySwarmTaskImages(db, expected);
          expectedTaskImage = expected;
        } catch (err) { error = msg(err); imageUnconfirmed = true; }
      }
      if (error) {
        await logTaskErrors(runtimeId, log);
        if (transition) throw new SwarmRecoveryPending(`Swarm transition needs reconciliation: ${error}`);
        if (imageUnconfirmed) {
          log(`Swarm: image identity could not be confirmed; ${runtimeId} is retained for review without an automatic spec change`);
        } else if (existed) {
          await ensureRolledBack(runtimeId, log);
        } else {
          // A first deploy that never converged leaves nothing behind.
          await removeSwarmStack(db, slug, log);
        }
        throw new Error(`Swarm deploy failed: ${error}`);
      }
      rollbackTarget = existed ? runtimeId : null;
      await pruneUnusedFileSecrets(swarmStackName(slug), runtimeId, fileSecrets.map((f) => f.secretName), log);
      const imageDigest = image.imageId ?? await deployedImageRef(runtimeId);
      return {
        runtimeId,
        port: ctx.service.port ?? null,
        healthPath: ctx.service.healthPath ?? '/',
        // The VIP balances across the tasks: Traefik needs one backend.
        replicas: 1,
        ...(imageDigest ? { imageDigest } : {}),
        ...(image.artifactBuild ? { artifactBuild: image.artifactBuild } : {}),
        // 0.16.4: Swarm gated each task on the command; no HTTP probe after it.
        ...(service.healthCheck === 'command' && service.healthCommand?.trim() ? { healthCheck: 'command' as const, healthCommand: service.healthCommand.trim() } : {}),
      };
    },

    async isHealthy(runtime, timeoutMs = 300_000, directGraceMs = 10_000, log: (line: string) => void = () => undefined) {
      if (runtime.runtimeId !== own) return local.isHealthy(runtime, timeoutMs, directGraceMs, log);
      const healthy = await swarmHealthy(runtime, timeoutMs, log);
      if (healthy && expectedTaskImage) {
        try { await verifySwarmTaskImages(db, expectedTaskImage); }
        catch {
          rollbackTarget = null;
          if (journalled) throw new SwarmRecoveryPending('Swarm task image identity changed during readiness; service retained');
          log('Swarm task image identity changed during readiness; current service retained for review');
          return false;
        }
      }
      if (!healthy && !journalled && rollbackTarget === runtime.runtimeId) {
        rollbackTarget = null;
        log('↩ Swarm: the new spec is not healthy — rolling the service back to its previous spec');
        await rollbackSwarmService(runtime.runtimeId, log);
      }
      return healthy;
    },

    async stop(runtimeId, opts) {
      if (runtimeId !== own) return local.stop(runtimeId, opts);
      await removeSwarmStack(db, slug, () => undefined);
    },
  };
}

/**
 * The previous generation of a service that left Swarm (orchestrator set back
 * to plain containers) is its stack. The pipeline retires the previous
 * runtime only after the new container is live and routed (design §7.5), so
 * this wrapper routes that one retirement — and the failure-path probe of the
 * previous version — to the stack of `slug`; everything else is the wrapped
 * builder's.
 */
export function withSwarmRetirement(db: DB, builder: Builder, slug: string): Builder {
  const own = swarmServiceName(slug);
  return {
    buildAndRun: (ctx, previous) => builder.buildAndRun(ctx, previous),
    async isHealthy(runtime, timeoutMs, directGraceMs, log) {
      if (runtime.runtimeId !== own) return builder.isHealthy(runtime, timeoutMs, directGraceMs, log);
      return swarmHealthy(runtime, timeoutMs ?? 3000, log ?? (() => undefined));
    },
    async stop(runtimeId, opts) {
      if (runtimeId !== own) return builder.stop(runtimeId, opts);
      await removeSwarmStack(db, slug, () => undefined);
    },
  };
}

const clampReplicas = (n: number | null | undefined): number => Math.max(1, Math.min(Math.floor(n ?? 1) || 1, MAX_REPLICAS));

/** Design §7.4 step 2: an image release, an image shipped from a build server, or a build on the panel (`target` means the panel for Swarm). */
async function resolveImage(db: DB, ctx: BuildContext, deps: SwarmBuilderDeps): Promise<SwarmImage> {
  const { service, log } = ctx;
  if (service.image) {
    // A rollback pins the digest the earlier deploy ran.
    let ref = await pullableReleaseRef(service.image, ctx.imageDigest);
    if (ctx.prepareSwarmTransition) {
      if (ctx.imageDigest && !ref.includes('@sha256:')) throw new Error('Swarm rollback digest is unavailable; no mutable image tag will be pulled');
      ref = await pinSwarmImage(ref, ctx.registryAuth, log);
    }
    return { ref, local: false, ...(ctx.registryAuth ? { auth: ctx.registryAuth } : {}) };
  }
  if (ctx.prebuiltImage) {
    // Built on a build server and shipped here (0.16 T4): by registry (a
    // pullable `repo@sha256` reference) or by stream relay (a local tag).
    applyPackPorts(ctx, ctx.prebuiltImage.builtWithNixpacks === true, ctx.prebuiltImage.builtStatic === true);
    const artifactBuild = { builtWithNixpacks: ctx.prebuiltImage.builtWithNixpacks === true, builtStatic: ctx.prebuiltImage.builtStatic === true };
    if (ctx.prebuiltImage.tag.includes('@sha256:')) {
      const target = await resolvePushTarget(db, service);
      return { ref: ctx.prebuiltImage.tag, imageId: ctx.prebuiltImage.imageId, artifactBuild, local: false, ...(target ? { auth: { username: target.username, password: target.password, server: target.server } } : {}) };
    }
    let ref = ctx.prebuiltImage.tag;
    if (ref === ctx.prebuiltImage.imageId) {
      ref = buildTag(service.slug, ctx.commitSha, ctx.deploymentId);
      await run('docker', ['tag', ctx.prebuiltImage.imageId, ref], { timeoutMs: READ_TIMEOUT_MS }, log);
      if ((await panelImageInfo(ref)).id !== ctx.prebuiltImage.imageId) throw new Error('Swarm artifact tag identity does not match the recorded image');
    }
    return { ref, local: true, imageId: ctx.prebuiltImage.imageId, artifactBuild };
  }
  log('Swarm: building on the panel host (a Swarm service builds on the panel or on a build server, never on the tasks’ nodes)');
  const placed = await (deps.buildOnPanel ?? buildElsewhere)(db, { kind: 'panel' }, ctx);
  await recordBuildHost(db, ctx.deploymentId, placed);
  applyPackPorts(ctx, placed.builtWithNixpacks, placed.builtStatic);
  if (placed.registry) {
    const t = placed.registry.target;
    return { ref: `${t.repository}@${placed.registry.digest}`, imageId: placed.imageId, artifactBuild: { builtWithNixpacks: placed.builtWithNixpacks, builtStatic: placed.builtStatic }, local: false, auth: { username: t.username, password: t.password, ...(t.server ? { server: t.server } : {}) } };
  }
  return { ref: placed.tag, local: true, imageId: placed.imageId, sizeBytes: placed.sizeBytes, artifactBuild: { builtWithNixpacks: placed.builtWithNixpacks, builtStatic: placed.builtStatic } };
}

/** The run conventions of the pack that built the image (the local docker builder applies the same). */
function applyPackPorts(ctx: BuildContext, nixpacks: boolean, staticPack: boolean): void {
  const port = ctx.service.port ?? (nixpacks ? 3000 : staticPack ? 80 : null);
  if (port !== ctx.service.port) {
    ctx.log(`No container port configured; using the ${staticPack ? 'static image' : 'Nixpacks'} default ${port}/tcp for the Swarm service and Traefik`);
    ctx.service = { ...ctx.service, port };
  }
  if (nixpacks && ctx.env['PORT'] === undefined && port != null) ctx.env['PORT'] = String(port);
}

/**
 * Design §7.4 step 3 (fixes D7f), without a registry: preload the image onto
 * every member node the panel can send it to (stream relay, like build
 * placement), and label exactly the nodes that hold it —
 * a free `nd.preload.<slug>.gN=<full image id>` slot, the panel host included — with a
 * constraint that requires that value (security review M1d: positive, so a
 * node the image never reached can never qualify, and a stale label from an
 * earlier image does not match the new one).
 */
async function preloadImage(db: DB, ctx: BuildContext, image: SwarmImage, deps: SwarmBuilderDeps, panelNodeId: string | null): Promise<string[]> {
  const { service, log } = ctx;
  const label = await unusedSwarmPreloadLabel(service.slug);
  const tag = swarmImageTag(image.imageId ?? image.ref);
  if (panelNodeId) await updateNodeLabel(panelNodeId, '--label-add', `${label}=${tag}`);
  const nodes = await listSwarmNodes(db);
  for (const node of nodes) {
    if (node.id === panelNodeId) continue;
    // Only nodes joined through the panel can run a task at all (M1c); the rest are never sent anything.
    if (node.serverId == null) continue;
    let reason: string;
    if (node.state !== 'ready' || node.availability !== 'active') {
      reason = `it is ${node.state}/${node.availability}`;
    } else if (!image.imageId) {
      reason = 'the image id is unknown';
    } else {
      try {
        await (deps.ship ?? shipImageByStream)(
          db,
          {
            deploymentId: ctx.deploymentId,
            serviceId: service.id,
            source: null,
            target: node.serverId,
            tag: image.ref,
            imageId: image.imageId,
            ...(image.sizeBytes ? { sizeBytes: image.sizeBytes } : {}),
          },
          log,
        );
        await updateNodeLabel(node.id, '--label-add', `${label}=${tag}`);
        continue;
      } catch (err) {
        reason = msg(err);
      }
    }
    if (ctx.requireSwarmMembers && node.state === 'ready' && node.availability === 'active') {
      throw new Error(`Swarm artifact preparation failed for ${node.hostname || node.id}: ${reason}; the current service spec is unchanged`);
    }
    log(`⚠ Swarm: node ${node.hostname || node.id} will run no task of this service: ${reason}. Set a push registry (Service → Settings → Build) to let every node pull the image.`);
  }
  return [`node.labels.${label}==${tag}`];
}

/**
 * Review M4: the spec is submitted detached, so the convergence wait is the
 * panel's. The service's UpdateStatus says an update is running, completed or
 * rolled back; one older than this apply (an unchanged spec) is ignored and
 * the replica counts decide. Null once converged, else why not.
 */
async function waitForConvergence(runtimeId: string, submittedAt: number, timeoutMs: number, log: (line: string) => void): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let noted = '';
  do {
    const status = await updateStatus(runtimeId);
    const fresh = status !== null && status.startedAt >= submittedAt - 5000;
    if (fresh && /^rollback|^paused$/.test(status.state)) {
      return `the rolling update was ${status.state.replace(/_/g, ' ')}${status.message ? `: ${status.message}` : ''}`;
    }
    if (!(fresh && status.state === 'updating')) {
      const counts = await replicaCounts(runtimeId);
      if (counts && counts.desired > 0 && counts.running >= counts.desired) return null;
      if (counts && noted !== `${counts.running}/${counts.desired}`) {
        noted = `${counts.running}/${counts.desired}`;
        log(`Swarm: ${noted} replicas running …`);
      }
    } else if (noted !== 'updating') {
      noted = 'updating';
      log('Swarm: rolling update in progress …');
    }
    if (Date.now() + HEALTH_POLL_MS >= deadline) break;
    await sleep(HEALTH_POLL_MS);
  } while (Date.now() < deadline);
  return `the service did not converge within ${Math.round(timeoutMs / 60_000)} minutes`;
}

async function updateStatus(runtimeId: string): Promise<{ state: string; message: string; startedAt: number } | null> {
  const raw = await capture('docker', ['service', 'inspect', '--format', '{{json .UpdateStatus}}', runtimeId], { timeoutMs: READ_TIMEOUT_MS }).catch(() => '');
  try {
    const j = JSON.parse(raw.trim() || 'null') as { State?: string; Message?: string; StartedAt?: string } | null;
    if (!j?.State) return null;
    const startedAt = j.StartedAt ? Date.parse(j.StartedAt) : Number.NaN;
    return { state: j.State, message: j.Message ?? '', startedAt: Number.isNaN(startedAt) ? 0 : startedAt };
  } catch {
    return null;
  }
}

async function serviceExists(runtimeId: string): Promise<boolean> {
  return capture('docker', ['service', 'inspect', '--format', '{{.ID}}', runtimeId], { timeoutMs: READ_TIMEOUT_MS })
    .then((out) => out.trim() !== '')
    .catch(() => false);
}

/** The resolved image the service runs (`repo:tag@sha256:…`), the rollback pin of an image release. */
async function deployedImageRef(runtimeId: string): Promise<string | undefined> {
  const out = await capture('docker', ['service', 'inspect', '--format', '{{.Spec.TaskTemplate.ContainerSpec.Image}}', runtimeId], { timeoutMs: READ_TIMEOUT_MS }).catch(
    () => '',
  );
  const ref = out.trim();
  return ref.includes('@sha256:') ? ref : undefined;
}

async function replicaCounts(runtimeId: string): Promise<{ running: number; desired: number } | null> {
  const out = await capture('docker', ['service', 'ls', '--filter', `name=${runtimeId}`, '--format', '{{.Name}} {{.Replicas}}'], { timeoutMs: READ_TIMEOUT_MS }).catch(
    () => '',
  );
  for (const line of out.split('\n')) {
    const [name, replicas] = line.trim().split(/\s+/);
    const m = /^(\d+)\/(\d+)/.exec(replicas ?? '');
    if (name === runtimeId && m) return { running: Number(m[1]), desired: Number(m[2]) };
  }
  return null;
}

/**
 * Probe through Traefik, which sits on the overlay — the path real traffic
 * takes. A status below 500 counts as up, like the container probe (busybox
 * wget exits non-zero on 4xx and says so).
 */
async function probeViaTraefik(runtimeId: string, port: number, path: string): Promise<boolean> {
  try {
    await capture('docker', ['exec', TRAEFIK_CONTAINER, 'wget', '-q', '-O', '/dev/null', '-T', '3', `http://${runtimeId}:${port}${path}`], { timeoutMs: 15_000 });
    return true;
  } catch (err) {
    return /server returned error: HTTP\/[\d.]+ [1-4]\d\d/.test(msg(err));
  }
}

/**
 * Design §7.4 step 6: the running replicas reach the desired count (Swarm
 * already gated each new task on its own healthcheck, if the image has one),
 * and the service answers on its port through Traefik.
 */
export async function swarmHealthy(runtime: DeployRuntime, timeoutMs: number, log: (line: string) => void): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const path = safeProbePath(runtime.healthPath);
  let noted = '';
  do {
    const counts = await replicaCounts(runtime.runtimeId);
    if (counts && counts.desired > 0 && counts.running >= counts.desired) {
      if (!runtime.port || runtime.healthCheck === 'command' || (await probeViaTraefik(runtime.runtimeId, runtime.port, path))) return true;
      if (noted !== 'port') log(`Swarm: ${counts.running}/${counts.desired} replicas running; waiting for port ${runtime.port} to answer through Traefik …`);
      noted = 'port';
    } else if (counts && noted !== `${counts.running}/${counts.desired}`) {
      noted = `${counts.running}/${counts.desired}`;
      log(`Swarm: ${noted} replicas running …`);
    }
    if (Date.now() + HEALTH_POLL_MS >= deadline) break;
    await sleep(HEALTH_POLL_MS);
  } while (Date.now() < deadline);
  await logTaskErrors(runtime.runtimeId, log);
  return false;
}

/** The failed tasks' errors (`docker service ps --no-trunc`) into the deploy log. */
async function logTaskErrors(runtimeId: string, log: (line: string) => void): Promise<void> {
  const out = await capture('docker', ['service', 'ps', '--no-trunc', '--format', '{{.Name}} {{.Node}} {{.CurrentState}} {{.Error}}', runtimeId], {
    timeoutMs: READ_TIMEOUT_MS,
  }).catch(() => '');
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 10);
  if (lines.length > 0) log(`Swarm tasks:\n  ${lines.join('\n  ')}`);
}

/** Swarm's own `failure_action: rollback` may already be restoring the previous spec; otherwise start it, then wait for convergence. */
async function ensureRolledBack(runtimeId: string, log: (line: string) => void): Promise<void> {
  const state = (await capture('docker', ['service', 'inspect', '--format', '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}', runtimeId], { timeoutMs: READ_TIMEOUT_MS }).catch(
    () => '',
  )).trim();
  if (state.startsWith('rollback')) {
    log(`↩ Swarm rolled the update back (${state}); the previous spec keeps serving`);
    await waitConverged(runtimeId);
    return;
  }
  await rollbackSwarmService(runtimeId, log);
}

/** `docker service rollback` to the previous spec, then wait for it to converge. */
export async function rollbackSwarmService(runtimeId: string, log: (line: string) => void): Promise<void> {
  try {
    await run('docker', ['service', 'rollback', '--detach', runtimeId], { timeoutMs: 120_000 }, log);
  } catch (err) {
    log(`warning: docker service rollback ${runtimeId} failed: ${msg(err)}`);
    return;
  }
  await waitConverged(runtimeId);
}

async function waitConverged(runtimeId: string): Promise<void> {
  const deadline = Date.now() + ROLLBACK_WAIT_MS;
  while (Date.now() < deadline) {
    const counts = await replicaCounts(runtimeId);
    if (!counts || (counts.desired > 0 && counts.running >= counts.desired)) return;
    await sleep(HEALTH_POLL_MS);
  }
}
