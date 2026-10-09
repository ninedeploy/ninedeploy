import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import {
  buildConfigs,
  databaseAttachments,
  deployments,
  environments,
  envVars,
  serviceLabels,
  serviceProjects,
  serviceTargets,
  services,
  servers,
  serviceWorkspaces,
  sources,
  type DB,
  type Service,
} from '@ninedeploy/db';
import { composePreviewRequest, createService, sameImageRepository, setLimits, updateService } from '@ninedeploy/schemas';
import { findCatalogTemplate } from '../templates/catalog.js';

/** Fan-out target set for a service — up to 10 extra nodes, operator-set. */
const setTargets = z.object({ serverIds: z.array(z.number().int().positive()).max(10) });
import { capture } from '../lib/exec.js';
import { replicaNames } from '../engine/dockerNames.js';
import { targetsForService, teardownTargets, type FanoutTarget } from '../engine/fanout.js';
import { audit } from '../lib/audit.js';
import { agentOp } from '../lib/agentClient.js';
import { removeNodeWorkspace } from '../lib/agentCapabilities.js';
import { config } from '../config.js';
import { getStickyEnabledForService } from '../engine/proxy.js';
import { setSettingString } from '../lib/settings.js';
import { badRequest, conflict, forbidden, HttpError, isUniqueViolation, notFound, parseId as num } from '../lib/errors.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';
import {
  assertServiceRole,
  maxRole,
  mayUseEnvironment,
  roleAtLeast,
  userWorkspaceMemberships,
  visibleServiceIdSet,
} from '../lib/resourceAccess.js';
import { visibleProjectIds } from './projects.js';
import { visibleWorkspaceIds } from './workspaces.js';
import { visibleLabelIds } from './labels.js';
import { assertMayUseHostPrivilege } from '../lib/hostPrivilege.js';
import { assertMayPublishPort } from '../lib/hostPort.js';
import { slugify, slugifyWithSuffix } from '../lib/slug.js';
import { assertPrimaryVolumeNotAttachedElsewhere, assertSlugVolumeNotRetained } from '../lib/retainedSlugVolume.js';
import { composeBuilder } from '../engine/builders/compose.js';
import { dockerBuilder, railpackRefusedForInstall } from '../engine/builders/docker.js';
import { remoteHookRefusal } from '../lib/remoteDeploy.js';
import { pm2Builder, pm2Logs, pm2Restart, pm2Start, pm2Stop } from '../engine/builders/pm2.js';
import { deleteLog } from '../engine/logs.js';
import { writeDynamicConfig } from '../engine/proxy.js';
import { removeServiceBridgeIfEmpty, serviceBridgeName } from '../lib/serviceBridge.js';
import { removeSwarmStack, restartSwarmService, scaleSwarmService, swarmRuntimeOf, swarmServiceLogs } from '../lib/swarm.js';
import { applyDefaultTags, replaceServiceTags } from './serviceTags.js';
import { analyseComposeContent, stackEnvSeeds, stackPublicUrl } from './composeStacks.js';
import { materialiseComposeFile } from '../lib/composeWorkspace.js';
import { reconcileEnvironment } from './templates.js';
import { resolveStackEnvironment } from '../engine/magicVars.js';
import { previewPatternError } from '../lib/previewDomain.js';
import { bindRegistryHostForImage, boundRegistryHosts, registryHostOf } from '../lib/registryBinding.js';
// ── 0.16 T8 surfaces ──
import { placementView } from './servicePlacement.js';
// ── end 0.16 T8 ──

/** The three tag id lists a service row is serialized with. */
interface TagIds {
  projectIds: number[];
  workspaceIds: number[];
  labelIds: number[];
}

const NO_TAGS: TagIds = { projectIds: [], workspaceIds: [], labelIds: [] };

/**
 * Read the project / workspace / label links of many services in three
 * queries rather than three per service. Returns an empty entry for a service
 * with no links so callers can index without a null check.
 */
async function loadTagIds(db: DB, serviceIds: number[]): Promise<Map<number, TagIds>> {
  const byId = new Map<number, TagIds>();
  if (serviceIds.length === 0) return byId;
  for (const id of serviceIds) byId.set(id, { projectIds: [], workspaceIds: [], labelIds: [] });

  const [projectLinks, workspaceLinks, labelLinks] = await Promise.all([
    db.query.serviceProjects.findMany({ where: inArray(serviceProjects.serviceId, serviceIds) }),
    db.query.serviceWorkspaces.findMany({ where: inArray(serviceWorkspaces.serviceId, serviceIds) }),
    db.query.serviceLabels.findMany({ where: inArray(serviceLabels.serviceId, serviceIds) }),
  ]);
  for (const link of projectLinks) byId.get(link.serviceId)?.projectIds.push(link.projectId);
  for (const link of workspaceLinks) byId.get(link.serviceId)?.workspaceIds.push(link.workspaceId);
  for (const link of labelLinks) byId.get(link.serviceId)?.labelIds.push(link.labelId);
  return byId;
}

/** Tag ids of a single service, in the shape `serialize` expects. */
async function tagIdsOf(db: DB, serviceId: number): Promise<TagIds> {
  return (await loadTagIds(db, [serviceId])).get(serviceId) ?? NO_TAGS;
}

/** Shape a DB row into the API representation (Date → ISO string). */
function serialize(s: Service, sourceName: string | null = null, tags: TagIds = NO_TAGS) {
  return {
    id: s.id,
    // Services link to any number of projects, workspaces and labels through
    // the join tables; the single `projectId` column is gone.
    projectIds: tags.projectIds,
    workspaceIds: tags.workspaceIds,
    labelIds: tags.labelIds,
    name: s.name,
    slug: s.slug,
    type: s.type,
    status: s.status,
    repoUrl: s.repoUrl,
    branch: s.branch,
    sourceId: s.sourceId,
    // Which stored credential private-repo cloning runs with — surfaced so
    // the UI can explain the link without exposing the token itself.
    sourceName: s.sourceId ? sourceName : null,
    image: s.image,
    autoUpdate: s.autoUpdate,
    volumeMount: s.volumeMount,
    composeService: s.composeService,
    commitSha: s.commitSha,
    runtimeId: s.runtimeId,
    serverId: s.serverId ?? null,
    healthPath: s.healthPath,
    port: s.port,
    publishedPort: s.publishedPort ?? null,
    autoUrl: config.wildcardDomain ? `${s.slug}.${config.wildcardDomain}` : null,
    cpuShares: s.cpuShares,
    cpuLimitMilli: s.cpuLimitMilli,
    memLimitMb: s.memLimitMb,
    replicas: s.replicas,
    previewDeploymentsEnabled: s.previewDeploymentsEnabled,
    previewAutoDestroyOnClose: s.previewAutoDestroyOnClose,
    previewDomainPattern: s.previewDomainPattern,
    previewMaxActive: s.previewMaxActive,
    isEphemeralPreview: s.isEphemeralPreview,
    previewParentServiceId: s.previewParentServiceId,
    prNumber: s.prNumber,
    environmentId: s.environmentId ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** Build-config row → API representation. */
function serializeBuild(b: typeof buildConfigs.$inferSelect) {
  return {
    buildPack: b.buildPack,
    baseDir: b.baseDir,
    installCmd: b.installCmd,
    buildCmd: b.buildCmd,
    startCmd: b.startCmd,
    dockerfilePath: b.dockerfilePath,
    outputDir: b.outputDir,
    staticSpa: b.staticSpa,
    preDeployCmd: b.preDeployCmd,
    postDeployCmd: b.postDeployCmd,
    preStopCmd: b.preStopCmd,
    restartPolicy: b.restartPolicy,
    stopGraceSeconds: b.stopGraceSeconds,
  };
}

/** Resolve a service's credential display name (null = public / none). */
async function sourceNameFor(db: DB, sourceId: number | null): Promise<string | null> {
  if (!sourceId) return null;
  const src = await db.query.sources.findFirst({ where: eq(sources.id, sourceId) });
  return src?.name ?? null;
}

/**
 * F961: settings a compose service cannot use — the compose builder publishes
 * no host port and applies no docker resource flags (the stack's YAML owns
 * both), and the limits route's live `docker update` is docker-only. Same rule
 * as compose template deploys (F904): 0/null mean "unset" (the Network tab
 * clears a port with null), and re-sending the stored value introduces nothing.
 */
type ComposeInertFields = Pick<Service, 'publishedPort' | 'cpuShares' | 'cpuLimitMilli' | 'memLimitMb'>;
function composeInertFields(sent: { [K in keyof ComposeInertFields]?: number | null }, stored: ComposeInertFields): string[] {
  return (['publishedPort', 'cpuShares', 'cpuLimitMilli', 'memLimitMb'] as const).filter((k) => {
    const v = sent[k];
    return v != null && v > 0 && v !== stored[k];
  });
}
function assertComposeAccepts(sent: { [K in keyof ComposeInertFields]?: number | null }, stored: ComposeInertFields): void {
  const inert = composeInertFields(sent, stored);
  if (inert.length > 0) {
    throw badRequest(`Compose services do not support ${inert.join(', ')} — the stack's compose file controls ports and resource limits`);
  }
}

export const servicesRoutes: FastifyPluginAsync = async (app) => {
  // Every route here requires authentication.
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (req) => {
    // The top bar filters on three independent dimensions. Within one group
    // the ids are OR-ed (any match); across groups they are AND-ed, so a
    // service must satisfy every group that was narrowed.
    const query = req.query as {
      tagProjectIds?: string;
      tagWorkspaceIds?: string;
      tagLabelIds?: string;
      environmentId?: string;
    };
    const ids = (raw: string | undefined): number[] =>
      (raw ?? '')
        .split(',')
        .map((part) => Number(part))
        .filter((n) => Number.isInteger(n) && n > 0);
    const wantedProjects = ids(query.tagProjectIds);
    const wantedWorkspaces = ids(query.tagWorkspaceIds);
    const wantedLabels = ids(query.tagLabelIds);

    // Visibility: owned services PLUS every service tagged into a workspace
    // the caller belongs to; operators see the whole instance.
    //
    // This used to filter on `ownerUserId` alone, which disagreed with
    // `/dashboard`, `/domains` and `loadServiceForUser` — all of which already
    // honoured workspace tags. A teammate could therefore open and deploy a
    // shared service by id while their own list came back empty and the
    // dashboard counted it. All four now call `visibleServiceIdSet`.
    const visibleIds = await visibleServiceIdSet(app.db, req.user!);
    const allRows = await app.db.query.services.findMany({
      orderBy: (s, { desc }) => [desc(s.id)],
    });
    const rows = visibleIds === null ? allRows : allRows.filter((s) => visibleIds.has(s.id));

    const tagsById = await loadTagIds(app.db, rows.map((s) => s.id));
    const matches = (have: number[], wanted: number[]) =>
      wanted.length === 0 || wanted.some((id) => have.includes(id));
    const visible = rows.filter((s) => {
      const tags = tagsById.get(s.id) ?? NO_TAGS;
      // Deployment lane filter: the query names an environment id; a service
      // matches when its own lane matches (or the filter names every lane).
      if (query.environmentId !== undefined) {
        const wanted = Number(query.environmentId);
        if ((s.environmentId ?? null) !== wanted) return false;
      }
      return (
        matches(tags.projectIds, wantedProjects) &&
        matches(tags.workspaceIds, wantedWorkspaces) &&
        matches(tags.labelIds, wantedLabels)
      );
    });

    // List view omits the build config (detail endpoint joins it); keep the shape stable.
    const sourceNames = new Map((await app.db.query.sources.findMany()).map((s) => [s.id, s.name]));
    return visible.map((s) => ({
      ...serialize(s, s.sourceId ? (sourceNames.get(s.sourceId) ?? null) : null, tagsById.get(s.id) ?? NO_TAGS),
      build: null,
    }));
  });

  app.post('/', async (req) => {
    const input = createService.parse(req.body);
    // Viewer is read-only (docs/WORKSPACES_RBAC.md): creating a service is a
    // write — it provisions runtime, ports and (by default) visibility in
    // every workspace the caller sits in. A user whose ONLY seats are
    // `viewer` therefore cannot create one; operators and anyone holding
    // `member` or higher somewhere can.
    if (!req.user!.isOperator) {
      const memberships = await userWorkspaceMemberships(app.db, req.user!.id);
      const best = maxRole(memberships);
      if (best === null || !roleAtLeast(best, 'member')) {
        throw forbidden('Creating a service requires the "member" role in a workspace');
      }
    }
    const template = input.templateId
      // r330: the same catalog the Hub lists (curated + community).
      ? await findCatalogTemplate(app.db, input.templateId)
      : undefined;
    if (input.templateId && !template) throw badRequest('Template not found');
    // The image may be pinned to a different TAG of the template's own
    // repository (sameImageRepository); anything else — a different repo or a
    // digest reference — runs unverified bytes under a vetted template's name
    // and is refused. Port and volume stay registry-controlled outright.
    if (template && (
      input.type !== 'docker' ||
      (input.image !== undefined && !sameImageRepository(template.image, input.image)) ||
      input.port !== template.port ||
      (input.volumeMount ?? null) !== (template.volumeMount ?? null)
    )) throw badRequest('Template image overrides must keep the same repository; port and volume are registry-controlled');
    // Host-privilege gate: PM2/compose services, lifecycle hooks and
    // docker-socket templates all give host-level execution, which is exactly
    // what the admin-only exec/volume/container routes exist to withhold.
    assertMayUseHostPrivilege(req.user!, {
      type: input.type,
      dockerSocket: template?.dockerSocket ?? false,
      build: input.build,
    });
    assertMayPublishPort(req.user!, input.publishedPort);
    // F985: create is held to the same rule as PATCH and /limits (F961) — a
    // compose row would store these and nothing would ever apply them.
    if (input.type === 'compose') {
      assertComposeAccepts(input, { publishedPort: null, cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0 });
    }
    // r522: deploy hooks run on the panel host, so a node-pinned service
    // cannot carry one; r520/r582: railpack is refused where it cannot build
    // (no BuildKit daemon configured via BUILDKIT_HOST).
    if (input.serverId != null) {
      const hookRefusal = remoteHookRefusal(input.build);
      if (hookRefusal) throw badRequest(hookRefusal, 'remote_deploy_unsupported');
    }
    // 0.16 T4: not when a node whose agent builds Railpack itself builds it.
    if (input.build.buildPack === 'railpack' && !(await (await import('../engine/buildPlacement.js')).railpackBuildsOnCapableNode(app.db, { serverId: input.serverId ?? null }))) {
      const railpackRefusal = railpackRefusedForInstall();
      if (railpackRefusal) throw badRequest(railpackRefusal, 'railpack_unavailable');
    }
    // Inline compose stack: validate the pasted YAML with the SAME analysis
    // the wizard previewed, and settle the routed service now — the builder
    // falls back to the slug, which is almost never a service name in a file
    // the user wrote by hand.
    let inlineComposeService: string | null = null;
    if (input.composeContent) {
      const analysis = analyseComposeContent(input.composeContent, input.port);
      if (!analysis.ok) throw badRequest(`Compose file cannot run here: ${analysis.reasons.join('; ')}`);
      inlineComposeService = input.composeService ?? analysis.suggestedService;
      if (!inlineComposeService) throw badRequest('Could not determine the main compose service — set composeService explicitly');
      if (!analysis.services.includes(inlineComposeService)) {
        throw badRequest(`composeService '${inlineComposeService}' is not declared in the compose file`);
      }
    }
    // Sources hold OPERATOR-managed git credentials (sourcesRoutes is
    // requireAdmin). A member attaching a guessed sourceId here would have
    // the pipeline clone the operator's private repos with the decrypted
    // token into a container they own — full source exfiltration.
    if (input.sourceId != null && !req.user!.isOperator) {
      throw forbidden('Only operators may attach a managed source to a service');
    }
    // Remote servers are registered and listed by operators only — they are
    // operator-allocated capacity (and each node's Traefik is a public edge).
    // Placing a service on one is the operator's call (r097).
    if (input.serverId != null && !req.user!.isOperator) {
      throw forbidden('Only operators may place a service on a remote server');
    }
    // r692: every reference the new row will carry is decided BEFORE the row
    // exists. The tag and lane checks used to run after the insert, so a
    // refused request (another tenant's project, workspace, label or
    // environment) answered 403 but left a half-created, untagged service —
    // and its slug — behind.
    const explicitTags = Boolean(input.tagProjectIds || input.tagWorkspaceIds || input.tagLabelIds);
    if (explicitTags && !req.user!.isOperator) {
      // Same rule as PUT /:id/tags: a member may only tag with projects,
      // workspaces and labels they can see. Without this check a member could
      // tag their service with ANOTHER tenant's project id, and the deploy
      // pipeline (engine/pipeline.ts loadRuntimeEnv) would decrypt that
      // project's shared env values straight into the member's container.
      const projectIds = input.tagProjectIds ?? [];
      const allowedProjects = await visibleProjectIds(app.db, req.user!, projectIds, 'member');
      if (allowedProjects.length !== projectIds.length) {
        throw forbidden('One or more target projects are not visible to you');
      }
      const workspaceIds = input.tagWorkspaceIds ?? [];
      const allowedWorkspaces = await visibleWorkspaceIds(app.db, req.user!, workspaceIds);
      if (allowedWorkspaces.length !== workspaceIds.length) {
        throw forbidden('One or more target workspaces are not visible to you');
      }
      const labelIds = input.tagLabelIds ?? [];
      const allowedLabels = await visibleLabelIds(app.db, req.user!, labelIds);
      if (allowedLabels.length !== labelIds.length) {
        throw forbidden('One or more target labels are not visible to you');
      }
    }
    // Deployment lane at create time: the environment must belong to a
    // workspace the caller holds a seat in, or (0.15) be named by one of
    // their access grants — same rule as PATCH. Operators skip the check.
    let environmentId: number | null = null;
    if (input.environmentId !== undefined) {
      const envRow = await app.db.query.environments.findFirst({
        where: eq(environments.id, input.environmentId),
      });
      if (!envRow) throw badRequest('Environment not found');
      if (!(await mayUseEnvironment(app.db, req.user!, envRow))) {
        throw forbidden('You do not have access to this environment');
      }
      environmentId = envRow.id;
    }
    const slug = input.slug ?? slugify(input.name);
    // r511: a preview pattern must name this service's own PR hosts.
    if (input.previewDomainPattern) {
      const patternError = previewPatternError(input.previewDomainPattern, slug);
      if (patternError) throw badRequest(patternError, 'invalid_preview_domain_pattern');
    }
    // Explicit duplicate-slug check → a clean 409 instead of an uncaught
    // unique-index error (500). Covers the NULL-project case too, where
    // SQLite's unique index treats NULLs as distinct.
    const dup = await app.db.query.services.findFirst({ where: eq(services.slug, slug) });
    if (dup) {
      const sameDefinition =
        dup.ownerUserId === req.user!.id &&
        dup.type === input.type &&
        dup.repoUrl === (input.repoUrl ?? null) &&
        dup.branch === input.branch &&
        dup.sourceId === (input.sourceId ?? null) &&
        dup.serverId === (input.serverId ?? null) &&
        dup.image === (input.image ?? null) &&
        dup.volumeMount === (input.volumeMount ?? null) &&
        dup.composeService === (input.composeService ?? null) &&
        dup.port === (input.port ?? null) &&
        dup.publishedPort === (input.publishedPort ?? null);
      const reusable =
        input.reuseExisting === true &&
        dup.status === 'idle' &&
        sameDefinition &&
        (!template || (
          dup.templateId === template.id &&
          JSON.stringify(dup.templateDatabaseEnv) === JSON.stringify(template.databaseEnv ?? null) &&
          JSON.stringify(dup.cmd) === JSON.stringify(template.cmd ?? null) &&
          dup.dockerSocket === (template.dockerSocket ?? false)
        ));
      if (reusable) {
        void audit(app.db, req.user!.id, 'service.reuse', input.name);
        return serialize(dup, null, await tagIdsOf(app.db, dup.id));
      }
      // A failed/stopped Hub service may have been created from an older,
      // incomplete template contract (for example Ghost before its required
      // MySQL mapping was declared). A Hub retry is allowed to repair only the
      // registry-controlled fields of the same caller-owned definition. The
      // wizard then provisions/attaches the newly declared database before it
      // triggers another deployment.
      const repairableTemplate =
        input.reuseExisting === true &&
        template != null &&
        sameDefinition &&
        ['idle', 'error', 'stopped'].includes(dup.status);
      if (repairableTemplate) {
        const trusted = {
          templateId: template.id,
          templateDatabaseEnv: template.databaseEnv ?? null,
          cmd: template.cmd ?? null,
          dockerSocket: template.dockerSocket ?? false,
        };
        await app.db.update(services).set(trusted).where(eq(services.id, dup.id));
        void audit(app.db, req.user!.id, 'service.repair_template', input.name);
        return serialize({ ...dup, ...trusted }, null, await tagIdsOf(app.db, dup.id));
      }
      throw badRequest(`A service with slug '${slug}' already exists`, 'slug_taken');
    }
    // r351: no live row holds the slug — but a deleted service's
    // `nd-svc-<slug>-data` may still be on the host, and the new row would
    // mount it on its first deploy (another tenant's data, read-write).
    // r351/r466: a remote service mounts its data volume ON THE NODE — the
    // guard probes the node's agent for those, the local daemon otherwise.
    await assertSlugVolumeNotRetained(slug, input.type, { db: app.db, serverId: input.serverId ?? null });
    // r648: nor one another service already attaches as an extra volume.
    if (input.volumeMount) await assertPrimaryVolumeNotAttachedElsewhere(app.db, slug, null);
    const [svc] = await app.db
      .insert(services)
      .values({
        ownerUserId: req.user!.id,
        name: input.name,
        slug,
        type: input.type,
        repoUrl: input.repoUrl,
        branch: input.branch,
        sourceId: input.sourceId ?? null,
        image: input.image ?? null,
        volumeMount: input.volumeMount ?? null,
        composeService: inlineComposeService ?? input.composeService ?? null,
        composeContent: input.composeContent ?? null,
        serverId: input.serverId ?? null,
        cpuShares: input.cpuShares ?? 0,
        cpuLimitMilli: input.cpuLimitMilli ?? 0,
        memLimitMb: input.memLimitMb ?? 0,
        replicas: input.replicas ?? 1,
        healthPath: input.healthPath ?? '/',
        port: input.port ?? null,
        publishedPort: input.publishedPort ?? null,
        cmd: template?.cmd ?? null,
        dockerSocket: template?.dockerSocket ?? false,
        templateId: template?.id ?? null,
        templateDatabaseEnv: template?.databaseEnv ?? null,
        previewDeploymentsEnabled: input.previewDeploymentsEnabled ?? false,
        previewAutoDestroyOnClose: input.previewAutoDestroyOnClose ?? true,
        previewDomainPattern: input.previewDomainPattern ?? null,
        previewMaxActive: input.previewMaxActive ?? 5,
        environmentId,
      })
      .returning()
      // The duplicate check above is check-then-insert: two concurrent
      // creates with the same slug both pass it, and the services_slug_unique
      // index (migration 0049) is the actual backstop — translate the
      // constraint into the same clean slug_taken response the pre-check
      // produces. Any other insert failure keeps failing loudly.
      .catch((err: unknown): Array<typeof services.$inferSelect> => {
        if (isUniqueViolation(err, /UNIQUE constraint failed.*services\.slug/)) {
          throw badRequest(`A service with slug '${slug}' already exists`, 'slug_taken');
        }
        throw err;
      });
    if (!svc) throw notFound('Could not create service');
    // r512: attaching a registry source is operator-only (above), so this is
    // the operator binding the credential to the image's registry host.
    if (svc.sourceId != null && svc.image) await bindRegistryHostForImage(app.db, svc.sourceId, svc.image);
    await app.db
      .insert(buildConfigs)
      .values({
        serviceId: svc.id,
        buildPack: input.build.buildPack,
        baseDir: input.build.baseDir,
        installCmd: input.build.installCmd ?? null,
        buildCmd: input.build.buildCmd ?? null,
        startCmd: input.build.startCmd ?? null,
        dockerfilePath: input.build.dockerfilePath ?? null,
        outputDir: input.build.outputDir ?? null,
        preDeployCmd: input.build.preDeployCmd ?? null,
        postDeployCmd: input.build.postDeployCmd ?? null,
        preStopCmd: input.build.preStopCmd ?? null,
        restartPolicy: input.build.restartPolicy ?? 'unless-stopped',
        stopGraceSeconds: input.build.stopGraceSeconds ?? 5,
      });
    if (input.composeContent) {
      // Write the workspace copy now so the very first deploy has it, and
      // resolve `SERVICE_*` tokens into persistent env rows exactly the way a
      // Hub compose template does (composeStacks.ts) — same generator, same
      // "existing values are never rotated" reconciliation.
      materialiseComposeFile(svc.id, input.composeContent);
      const resolved = resolveStackEnvironment(input.composeContent, {
        publicUrl: await stackPublicUrl(app.db, svc.slug),
      });
      const stackEnv = stackEnvSeeds(resolved);
      if (stackEnv.length > 0) await reconcileEnvironment(app, svc.id, { env: stackEnv }, []);
    }
    // Tagging is a separate concern from the row itself: an explicit tag set
    // (validated above) wins, otherwise the service lands in every workspace
    // the caller belongs to so it is visible to their team by default.
    if (explicitTags) {
      await replaceServiceTags(
        app.db,
        svc!.id,
        input.tagProjectIds ?? [],
        input.tagWorkspaceIds ?? [],
        input.tagLabelIds ?? [],
      );
    } else {
      await applyDefaultTags(app.db, req.user!, svc!.id);
    }
    void audit(app.db, req.user!.id, 'service.create', input.name);
    app.kernel?.events.emit('service.created', {
      serviceId: svc!.id,
      // Services link to projects via tags now (services.projectId is gone);
      // the event contract keeps the field, so unlinked = 0.
      projectId: 0,
      name: input.name,
    });
    return serialize(svc, await sourceNameFor(app.db, svc.sourceId), await tagIdsOf(app.db, svc!.id));
  });

  /**
   * Dry-run a pasted compose file. Nothing is written and no service is
   * created — the wizard calls this while the user types so blocking problems
   * and the routable service list appear inline instead of as a 400 after the
   * row exists. Admin-only for the same reason `type: 'compose'` is: this is
   * the analysis half of a host-privileged deploy.
   */
  app.post('/compose/preview', { preHandler: app.requireAdmin }, async (req) => {
    const input = composePreviewRequest.parse(req.body ?? {});
    return analyseComposeContent(input.content, input.port);
  });

  app.get('/:id', async (req) => {
    const id = num((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    const build = await app.db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, id) });
    return {
      ...serialize(svc, await sourceNameFor(app.db, svc.sourceId), await tagIdsOf(app.db, svc.id)),
      // Detail only — a stack's YAML is up to 256 KiB and `serialize` also
      // feeds the list endpoint, which would then ship every stack on the
      // host in one response.
      //
      // Operators only, matching who may write it (PATCH runs the compose
      // host-privilege gate): a compose file can carry a literal password
      // inline, and members are deliberately kept away from secret VALUES
      // everywhere else.
      composeContent: req.user!.isOperator ? svc.composeContent ?? null : null,
      build: build ? serializeBuild(build) : null,
      // ── 0.16 T8 surfaces ── multi-node (design §6.6, additive): the same
      // view as GET /:id/placement; every null is the 0.15 default. Detail
      // only, like `build`.
      placement: placementView(svc),
      // ── end 0.16 T8 ──
    };
  });

  app.patch('/:id', async (req) => {
    const id = num((req.params as { id: string }).id);
    const existing = await loadServiceForUser(app.db, id, req.user!);
    // Read access is any workspace seat; editing the definition is `member`+.
    await assertServiceRole(app.db, existing, req.user!, 'member');
    // r335: tag assignment has its own route with its own (admin) gate.
    // PATCH used to accept the tag fields and silently drop them — the caller
    // got a 200 and unchanged tags. Refuse loudly instead of pretending.
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const tagFields = ['tagProjectIds', 'tagWorkspaceIds', 'tagLabelIds'].filter((k) => rawBody[k] !== undefined);
    if (tagFields.length > 0) {
      throw badRequest(
        `${tagFields.join(', ')} cannot be changed with PATCH — use PUT /v1/services/${id}/tags`,
        'tags_via_put',
      );
    }
    const { build, ...patch } = updateService.parse(req.body ?? {});
    // r182: the slug is an identity, not a label — it names the data volume
    // (`nd-svc-<slug>-data`), the private bridge and the auto-domain. A rename
    // made the next deploy mount a fresh EMPTY volume, left the old one
    // ownerless, and `POST /volumes/prune` then deleted the data.
    if (patch.slug !== undefined && patch.slug !== existing.slug) {
      throw badRequest('A service slug cannot be changed after creation (it names the volume and network)', 'slug_immutable');
    }
    // Same rule as create: attaching a managed source is operator-only. A
    // member editing their own service must not bolt an operator credential
    // onto it afterwards.
    if (patch.sourceId !== undefined && patch.sourceId !== null && !req.user!.isOperator) {
      throw forbidden('Only operators may attach a managed source to a service');
    }
    // The mirror image of that gate: while a service USES a managed source,
    // its repository pointer is part of the operator attachment. A member
    // retargeting repoUrl/branch would point the operator's decrypted token
    // at an arbitrary repository and stream the clone log — the same
    // exfiltration the sourceId gate exists to block. No-op sends (same
    // value) stay allowed so full-object PATCHes keep working.
    if (!req.user!.isOperator && existing.sourceId != null) {
      const repoChanged = patch.repoUrl !== undefined && patch.repoUrl !== existing.repoUrl;
      const branchChanged = patch.branch !== undefined && patch.branch !== existing.branch;
      if (repoChanged || branchChanged) {
        throw forbidden('Only operators may change the repository of a service that uses a managed git source');
      }
      // r512: the same for a registry credential — its `docker login` target
      // is derived from the image, so a member pointing the image at another
      // registry host would send the operator's credential there.
      if (patch.image != null && patch.image !== existing.image) {
        const src = await app.db.query.sources.findFirst({ where: eq(sources.id, existing.sourceId) });
        const newHost = registryHostOf(patch.image);
        if (
          src?.type === 'registry' &&
          newHost !== (existing.image ? registryHostOf(existing.image) : null) &&
          !(await boundRegistryHosts(app.db, src.id)).includes(newHost)
        ) {
          throw forbidden(
            `Only operators may point this service's image at another registry (${newHost}) — it uses the operator-managed registry credential "${src.name}"`,
          );
        }
      }
    }
    // r511: a CHANGED preview pattern must name this service's own PR hosts.
    // Re-sending the stored value (the web form sends it on every save) stays
    // allowed so legacy patterns do not block unrelated edits; the webhook
    // skips their domain provisioning instead.
    if (
      patch.previewDomainPattern != null &&
      patch.previewDomainPattern !== '' &&
      patch.previewDomainPattern !== existing.previewDomainPattern
    ) {
      const patternError = previewPatternError(patch.previewDomainPattern, existing.slug);
      if (patternError) throw badRequest(patternError, 'invalid_preview_domain_pattern');
    }
    // Same for remote-server placement (r097). Moving a service back to the
    // local host (`serverId: null`) stays open: it takes nothing from anyone.
    if (patch.serverId !== undefined && patch.serverId !== null && !req.user!.isOperator) {
      throw forbidden('Only operators may place a service on a remote server');
    }
    // Deployment lane assignment: the environment must belong to a workspace
    // the caller holds a seat in, or (0.15) be named by one of their access
    // grants. null clears the lane (ungrouped).
    if (patch.environmentId !== undefined) {
      if (patch.environmentId === null) {
        patch.environmentId = null;
      } else {
        const envRow = await app.db.query.environments.findFirst({
          where: eq(environments.id, patch.environmentId),
        });
        if (!envRow) throw badRequest('Environment not found');
        if (!(await mayUseEnvironment(app.db, req.user!, envRow))) {
          throw forbidden('You do not have access to this environment');
        }
      }
    }
    // The gate has to consider the MERGED result, not just the payload: a
    // member could otherwise switch `type` to pm2 on its own, or add a single
    // lifecycle hook — or select the static build pack — and reach host
    // execution one field at a time.
    const currentBuild = await app.db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, id) });
    const merged = (key: 'buildPack' | 'preDeployCmd' | 'postDeployCmd' | 'preStopCmd') =>
      build?.[key] !== undefined ? build[key] : currentBuild?.[key];
    assertMayUseHostPrivilege(req.user!, {
      type: patch.type ?? existing.type,
      dockerSocket: existing.dockerSocket ?? false,
      build: {
        buildPack: merged('buildPack'),
        preDeployCmd: merged('preDeployCmd'),
        postDeployCmd: merged('postDeployCmd'),
        preStopCmd: merged('preStopCmd'),
      },
    });
    // r648: turning the primary volume ON mounts `nd-svc-<slug>-data` — refuse
    // it when another service already attaches a volume under that name (it
    // could have been pre-created by that service's owner). Re-sends of an
    // already-enabled mount stay allowed.
    if (patch.volumeMount && !existing.volumeMount) {
      await assertPrimaryVolumeNotAttachedElsewhere(app.db, existing.slug, existing.id);
    }
    // Same merged-result reasoning for the host port.
    assertMayPublishPort(req.user!, patch.publishedPort === undefined ? existing.publishedPort : patch.publishedPort);
    // F961: judged on the MERGED type — switching to docker in the same PATCH
    // makes the port and limits real again.
    if ((patch.type ?? existing.type) === 'compose') assertComposeAccepts(patch, existing);
    // r522: only a PATCH that introduces the conflict is refused — pinning a
    // hook-carrying service to a node, or setting a hook on a pinned one — so
    // an existing pinned service with a hook can still be edited (its deploy
    // is refused with the same fix named).
    const mergedServerId = patch.serverId !== undefined ? patch.serverId : existing.serverId;
    const placing = patch.serverId != null && patch.serverId !== existing.serverId;
    const settingHook = (['preDeployCmd', 'postDeployCmd', 'preStopCmd'] as const).some((k) => !!build?.[k]?.trim());
    if (mergedServerId != null && (placing || settingHook)) {
      const hookRefusal = remoteHookRefusal({
        preDeployCmd: merged('preDeployCmd'),
        postDeployCmd: merged('postDeployCmd'),
        preStopCmd: merged('preStopCmd'),
      });
      if (hookRefusal) throw badRequest(hookRefusal, 'remote_deploy_unsupported');
    }
    // r520/r582: switching TO railpack on an install that cannot run it.
    // 0.16 T4: not when a node whose agent builds Railpack itself builds it.
    if (
      build?.buildPack === 'railpack' &&
      currentBuild?.buildPack !== 'railpack' &&
      !(await (await import('../engine/buildPlacement.js')).railpackBuildsOnCapableNode(app.db, { serverId: mergedServerId, buildOn: existing.buildOn, buildServerId: existing.buildServerId }))
    ) {
      const railpackRefusal = railpackRefusedForInstall();
      if (railpackRefusal) throw badRequest(railpackRefusal, 'railpack_unavailable');
    }
    // Editing an inline stack's YAML. Only a service that already stores one
    // may receive it: `type` alone cannot distinguish an inline stack from a
    // git-repo compose service, whose file lives in the repository and would
    // be overwritten by the next checkout anyway.
    if (patch.composeContent !== undefined) {
      if (!existing.composeContent) {
        throw badRequest('This service has no inline compose stack — its compose file comes from its repository');
      }
      const analysis = analyseComposeContent(patch.composeContent, patch.port ?? existing.port ?? undefined);
      if (!analysis.ok) throw badRequest(`Compose file cannot run here: ${analysis.reasons.join('; ')}`);
      const routed = patch.composeService ?? existing.composeService;
      if (routed && !analysis.services.includes(routed)) {
        throw badRequest(`composeService '${routed}' is not declared in the compose file`);
      }
    }
    // Image auto-update only makes sense on image-based docker services —
    // the sweep watches the registry, and the enqueued deployment reaches a
    // remote node through the normal agent path. Repo-backed services (and
    // non-docker types) are refused rather than silently ignored: the
    // toggle would be a lie in the UI.
    if (patch.autoUpdate !== undefined) {
      const mergedImage = patch.image !== undefined ? patch.image : existing.image;
      const mergedType = patch.type ?? existing.type;
      if (patch.autoUpdate && (!mergedImage || mergedType !== 'docker')) {
        throw badRequest('Auto-update applies only to image-based docker services');
      }
    }
    // Build-config keys are optional; null out omitted-but-cleared ones via `set` semantics.
    // Disabling the watch also clears the stored baseline digest, so a later
    // re-enable starts from a fresh first observation instead of a stale one.
    const servicePatch =
      patch.autoUpdate === false ? { ...patch, autoUpdateDigest: null as string | null } : patch;
    // r225: moving a DEPLOYED service to another node (or back to the panel
    // host) retires the runtime where it runs now; the next deploy creates it
    // on the new node. Otherwise the old container kept serving, unmanaged.
    const moving = patch.serverId !== undefined && (patch.serverId ?? null) !== (existing.serverId ?? null);
    // r662: the slug-volume guard (r351/r466) ran only at CREATE, for the
    // placement chosen then. Moving the service later mounted whatever
    // `nd-svc-<slug>-data` the destination held — a deleted service's data on
    // that node or host. Checked before anything is retired; the service's
    // own volume from an earlier placement there is told apart by its age.
    // ── 0.16 T6 node databases (design §5.5) ── a service never moves away
    // from a node database it is attached to: the database resolves only on
    // its own host. Checked before anything is retired.
    if (moving) {
      const { attachedDatabasesHostMismatch } = await import('../lib/remoteDatabaseRefusal.js');
      const hostRefusal = await attachedDatabasesHostMismatch(app.db, existing, patch.serverId ?? null);
      if (hostRefusal) throw hostRefusal;
    }
    // ── end 0.16 T6 ──
    if (moving) {
      await assertSlugVolumeNotRetained(existing.slug, patch.type ?? existing.type, {
        db: app.db,
        serverId: patch.serverId ?? null,
        ownerCreatedAt: existing.createdAt ?? null,
      });
    }
    // F842: pm2 is exempt from that guard while Docker cannot answer, so a pm2
    // row may never have been checked. Leaving pm2 makes it a docker-volume
    // user — check now (a move above already did).
    if (!moving && existing.type === 'pm2' && patch.type !== undefined && patch.type !== 'pm2') {
      await assertSlugVolumeNotRetained(existing.slug, patch.type, {
        db: app.db,
        serverId: existing.serverId ?? null,
        ownerCreatedAt: existing.createdAt ?? null,
      });
    }
    if (moving && existing.runtimeId) {
      await retireRuntime(existing, (msg) => req.log.warn({ serviceId: id }, msg));
      Object.assign(servicePatch, { runtimeId: null, status: 'idle' });
      void audit(app.db, req.user!.id, 'service.move', `${existing.name}: node ${existing.serverId ?? 'local'} → ${patch.serverId ?? 'local'}`);
    }
    // r662: the checkout it leaves behind on the old node goes too.
    if (moving && existing.serverId != null) {
      await removeNodeWorkspace(app.db, existing.serverId, existing.slug, (msg) => req.log.warn({ serviceId: id }, msg));
    }
    const [svc] = await app.db.update(services).set(servicePatch).where(eq(services.id, id)).returning();
    if (!svc) throw notFound('Service not found');
    // r512: an OPERATOR attaching a registry source or changing the image of
    // a service that uses one binds the credential to that registry host.
    if (req.user!.isOperator && (patch.image !== undefined || patch.sourceId !== undefined) && svc.sourceId != null && svc.image) {
      await bindRegistryHostForImage(app.db, svc.sourceId, svc.image);
    }
    if (build) {
      // Only overwrite the keys the client sent — a PATCH must not reset the
      // rest of the build config back to defaults.
      const values: Partial<typeof buildConfigs.$inferInsert> = {};
      if (build.buildPack !== undefined) values.buildPack = build.buildPack;
      if (build.baseDir !== undefined) values.baseDir = build.baseDir;
      if (build.restartPolicy !== undefined) values.restartPolicy = build.restartPolicy;
      if (build.stopGraceSeconds !== undefined) values.stopGraceSeconds = build.stopGraceSeconds;
      if (build.outputDir !== undefined) values.outputDir = build.outputDir === '' ? null : build.outputDir;
      if (build.staticSpa !== undefined) values.staticSpa = build.staticSpa;
      for (const key of ['installCmd', 'buildCmd', 'startCmd', 'dockerfilePath', 'preDeployCmd', 'postDeployCmd', 'preStopCmd'] as const) {
        const v = build[key];
        if (v !== undefined) values[key] = v === '' ? null : v;
      }
      if (Object.keys(values).length > 0) {
        const updated = await app.db.update(buildConfigs).set(values).where(eq(buildConfigs.serviceId, id)).returning();
        if (updated.length === 0) throw notFound('Service not found');
      }
    }
    // The internal container port is also Traefik's upstream port. Apply a
    // manual correction to routing immediately for an already-running service;
    // the next redeploy will additionally pass it to buildpack apps as $PORT.
    if (patch.port !== undefined && svc.runtimeId) {
      try {
        await writeDynamicConfig(app.db);
      } catch (err) {
        req.log.warn({ err, serviceId: id, port: patch.port }, 'failed to rewrite traefik config after container port update');
      }
    }
    // Keep the workspace copy in step with the row. The deploy would rewrite
    // it anyway, but a stale file on disk makes `docker compose` run by hand
    // (or a File Browser peek) disagree with what the panel shows.
    if (patch.composeContent !== undefined) {
      materialiseComposeFile(id, patch.composeContent);
      // r424: NEW `SERVICE_*` tokens in the edited YAML used to deploy GREEN
      // with blank values — compose interpolates an unset variable to an
      // empty string with a warning, `config --quiet` still passes, and the
      // stack boots with empty credentials. Seed exactly like the create
      // path (same generator, same never-rotate reconciliation).
      const resolved = resolveStackEnvironment(patch.composeContent, {
        publicUrl: await stackPublicUrl(app.db, svc.slug),
      });
      const stackEnv = stackEnvSeeds(resolved);
      if (stackEnv.length > 0) await reconcileEnvironment(app, id, { env: stackEnv }, []);
    }
    void audit(app.db, req.user!.id, 'service.update', svc.name);
    return serialize(svc, await sourceNameFor(app.db, svc.sourceId), await tagIdsOf(app.db, svc.id));
  });

  // r225: a service with `serverId` runs on a remote NODE. Its lifecycle,
  // logs and teardown used to run the LOCAL docker CLI: stop answered "no such
  // container" (read as success) and marked the row stopped while the node
  // kept serving; start/restart marked it `error`; logs came back empty;
  // delete left the node's container running as an orphan. These go through
  // the node's agent instead.
  const remoteDocker = async (
    serverId: number,
    op: 'docker.stop' | 'docker.start' | 'docker.rm' | 'docker.logs' | 'docker.composeDown',
    params: Record<string, unknown>,
  ): Promise<string> => {
    const out: string[] = [];
    try {
      await agentOp(app.db, serverId, op, params, (line) => out.push(line));
    } catch (err) {
      // Fold the command's output into the error so "no such container" is
      // recognisable to the same classifiers as a local CLI failure.
      throw new Error(`${err instanceof Error ? err.message : String(err)}: ${out.join(' ').slice(0, 400)}`);
    }
    return out.join('\n');
  };
  /** Tear a runtime down wherever it lives (non-throwing, like the builders' stop). */
  const retireRuntime = async (
    svc: { type: string; slug: string; runtimeId: string | null; replicas: number; serverId: number | null },
    log: (msg: string) => void,
  ): Promise<void> => {
    if (!svc.runtimeId) return;
    // ── 0.16 T7 swarm ── a Swarm runtime is its stack (and overlay) on the panel host's swarm.
    if (swarmRuntimeOf(svc)) {
      await removeSwarmStack(app.db, svc.slug, log);
      return;
    }
    // ── end 0.16 T7 ──
    if (svc.serverId != null) {
      const serverId = svc.serverId;
      if (svc.type === 'compose') {
        await remoteDocker(serverId, 'docker.composeDown', { project: `ndcmp-${svc.slug}` }).catch((err: unknown) => log(String(err)));
      } else {
        for (const name of replicaNames(svc.runtimeId, svc.replicas)) {
          await remoteDocker(serverId, 'docker.rm', { name }).catch((err: unknown) => log(String(err)));
        }
      }
      return;
    }
    if (svc.type === 'pm2') await pm2Builder.stop(svc.runtimeId);
    else if (svc.type === 'docker') await dockerBuilder.stop(svc.runtimeId);
    else if (svc.type === 'compose') await composeBuilder.stop(svc.runtimeId);
    else log(`unsupported service type ${svc.type} — leaving runtime ${svc.runtimeId} in place`);
  };

  app.delete('/:id', async (req, reply) => {
    const id = num((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    // Destroying a service (and its volumes) is an `admin`+ action.
    await assertServiceRole(app.db, svc, req.user!, 'admin');
    // A deployment queued or building for this service keeps writing state
    // against the row and its candidate runtime. Deleting now would orphan the
    // mid-flight build's runtime — refuse until the pipeline settles; the user
    // can cancel first.
    const activeDeploy = await app.db.query.deployments.findFirst({
      where: and(eq(deployments.serviceId, id), inArray(deployments.status, ['queued', 'building'])),
    });
    if (activeDeploy) {
      throw conflict('A deployment is queued or building — cancel it or wait for it to finish before deleting');
    }
    // The deployment ids are read BEFORE the row goes: the FK cascade removes
    // the rows but knows nothing about the log files on disk, which would
    // otherwise sit in the logs directory for up to the 30-day retention window
    // after the service they describe is gone — and build logs routinely echo
    // configuration.
    // Best-effort: a failure reading them must not block the destructive
    // operation the caller actually asked for. The 30-day sweep is the backstop.
    // r662: the fan-out targets, read while the row (and its FK-cascaded
    // target rows) still exist — see teardownTargets.
    const targetRows: FanoutTarget[] = await targetsForService(app.db, id).catch(() => []);
    // F843: the databases attached to it sit on its bridge (templateDependencies
    // → attachDatabaseToServiceBridges); read them while the FK-cascaded
    // attachment rows still exist.
    let attachedDbContainers: string[] = [];
    try {
      const rows = await app.db.query.databaseAttachments.findMany({
        where: eq(databaseAttachments.serviceId, id),
        with: { database: { columns: { containerName: true } } },
      });
      attachedDbContainers = rows.flatMap((r) => (r.database?.containerName ? [r.database.containerName] : []));
    } catch (err) {
      req.log.warn({ err, serviceId: id }, 'could not list attached databases to take off the service bridge');
    }
    let orphanLogs: Array<{ id: number }> = [];
    try {
      orphanLogs = await app.db.select({ id: deployments.id }).from(deployments).where(eq(deployments.serviceId, id));
    } catch (err) {
      req.log.warn({ err, serviceId: id }, 'could not list deploy logs to clean up');
    }
    // Row first (a single DELETE is atomic; FK cascade removes the build
    // config, env vars, domains and deployments) — a failed delete must never
    // leave a live row whose runtime has already been destroyed.
    await app.db.delete(services).where(eq(services.id, id));
    for (const row of orphanLogs) deleteLog(row.id);
    // Rewrite Traefik routing — the service's domains cascade-deleted with the
    // row, so its routers/services drop out of the dynamic config. Routing must
    // never block delete, so failures are logged, not thrown.
    try {
      await writeDynamicConfig(app.db);
    } catch (err) {
      req.log.warn({ err }, 'failed to rewrite traefik config after service delete');
    }
    // Retire the runtime AFTER the row commit — mirrors the blue-green rule
    // (routing flips before the old container stops). Both builders' `stop` is
    // contractually non-throwing (they swallow missing/dead runtimes). An
    // unknown type cannot silently misroute to the docker teardown.
    await retireRuntime(svc, (msg) => req.log.warn({ runtimeId: svc.runtimeId, serverId: svc.serverId }, msg));
    // Fan-out targets: tear down every extra node's container and drop the
    // rows — deleting the service deletes the whole fleet footprint.
    await teardownTargets(app.db, svc.id, (line) => req.log.info({ fanout: line }, line), targetRows).catch((err: unknown) =>
      req.log.warn({ err }, 'fan-out teardown failed (rows remain recoverable on next deploy)'),
    );
    // r662: and every node checkout of it — the primary's and each target's.
    for (const serverId of new Set([...(svc.serverId != null ? [svc.serverId] : []), ...targetRows.map((t) => t.serverId)])) {
      await removeNodeWorkspace(app.db, serverId, svc.slug, (line) => req.log.warn({ serverId }, line));
    }
    // Model B: reap the service's private bridge. A no-op when a database is
    // still attached to it (so the DB keeps resolving the service's bridge
    // and the panel can still show the connection). Failures are logged, not
    // thrown — the row is already gone and a stale bridge is recoverable.
    try {
      // F843: the slug is free now — whoever takes it next gets this bridge,
      // so the deleted service's databases leave it first.
      for (const container of attachedDbContainers) {
        await capture('docker', ['network', 'disconnect', serviceBridgeName(svc.slug), container]).catch((err: unknown) =>
          req.log.warn({ err, container }, 'could not disconnect database from the service bridge'),
        );
      }
      await removeServiceBridgeIfEmpty(svc.slug, (line) => req.log.info({ bridge: svc.slug }, line));
    } catch (err) {
      req.log.warn({ err, slug: svc.slug }, 'failed to reap per-service bridge');
    }
    void audit(app.db, req.user!.id, 'service.delete', svc.name);
    app.kernel?.events.emit('service.deleted', {
      serviceId: svc.id,
      name: svc.name,
    });
    reply.status(204);
  });

  // Resource limits. Persisted for the next deploy's `docker run`; a running
  // docker container also gets a best-effort live `docker update` so the new
  // ceiling takes effect without a redeploy (memory can only be raised live —
  // lowering below current usage fails at the kernel, which we swallow and
  // leave to the next deploy).
  app.patch('/:id/limits', async (req) => {
    const id = num((req.params as { id: string }).id);
    const limitTarget = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, limitTarget, req.user!, 'member');
    const input = setLimits.parse(req.body);
    if (limitTarget.type === 'compose') assertComposeAccepts(input, limitTarget);
    const updateData: { cpuShares?: number; cpuLimitMilli?: number; memLimitMb?: number } = {};
    if (input.cpuShares !== undefined) {
      updateData.cpuShares = input.cpuShares && input.cpuShares > 0 ? input.cpuShares : 0;
    }
    if (input.cpuLimitMilli !== undefined) {
      updateData.cpuLimitMilli = input.cpuLimitMilli && input.cpuLimitMilli > 0 ? input.cpuLimitMilli : 0;
    }
    if (input.memLimitMb !== undefined) {
      updateData.memLimitMb = input.memLimitMb && input.memLimitMb > 0 ? input.memLimitMb : 0;
    }
    const [svc] = await app.db.update(services).set(updateData).where(eq(services.id, id)).returning();
    if (!svc) throw notFound('Service not found');
    let liveApplied = false;
    // 0.16 T7: a Swarm service takes new limits at its next deploy (the stack is redeployed), never by `docker update`.
    if (svc.type === 'docker' && svc.status === 'running' && svc.runtimeId && !swarmRuntimeOf(svc)) {
      const argv = ['update'];
      if (svc.cpuShares > 0) argv.push('--cpu-shares', String(svc.cpuShares));
      if (svc.cpuLimitMilli > 0) argv.push('--cpus', String(svc.cpuLimitMilli / 1000));
      if (svc.memLimitMb > 0) argv.push('--memory', `${svc.memLimitMb}m`, '--memory-swap', `${svc.memLimitMb}m`);
      if (argv.length > 1) {
        liveApplied = await capture('docker', [...argv, svc.runtimeId])
          .then(() => true)
          .catch(() => false);
      }
    }
    void audit(app.db, req.user!.id, 'service.limits', `${svc.name}: cpu=${svc.cpuShares} cpus=${svc.cpuLimitMilli / 1000} mem=${svc.memLimitMb}MB`);
    return { cpuShares: svc.cpuShares, cpuLimitMilli: svc.cpuLimitMilli, memLimitMb: svc.memLimitMb, liveApplied };
  });

  // Multi-server fan-out targets (phase 1): image-based docker services only
  // (a source build's image exists solely on the node that built it).
  app.patch('/:id/targets', async (req) => {
    const id = num((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    if (!req.user!.isOperator) throw forbidden('Only operators may change fan-out targets');
    // Image releases pull; Dockerfile releases build per node (r132). Anything
    // else (pm2, compose, Dockerfile-less nixpacks sources) has no honest
    // node-side story.
    if (svc.type !== 'docker' || (!svc.image && !svc.repoUrl)) {
      throw badRequest('Fan-out targets apply only to docker services with an image or a Dockerfile repository');
    }
    const input = setTargets.parse(req.body ?? {});
    const requested = [...new Set(input.serverIds)];
    // ── 0.16 T6 node databases (design §5.5) ── targets on other nodes never reach a node database.
    {
      const { fanoutDatabaseHostRefusal } = await import('../lib/remoteDatabaseRefusal.js');
      const hostRefusal = await fanoutDatabaseHostRefusal(app.db, svc, requested);
      if (hostRefusal) throw hostRefusal;
    }
    // ── end 0.16 T6 ──
    const existing = await app.db.select().from(serviceTargets).where(eq(serviceTargets.serviceId, id));
    // F840: a NEW target node mounts `nd-svc-<slug>-data` there (fanout.ts) —
    // ask that node the same retained-volume question a move asks (r662),
    // before anything is torn down or inserted.
    for (const serverId of requested) {
      if (serverId === svc.serverId || existing.some((t) => t.serverId === serverId)) continue;
      const node = await app.db.query.servers.findFirst({ where: eq(servers.id, serverId) });
      if (!node) throw notFound(`Server ${serverId} not found`);
      await assertSlugVolumeNotRetained(svc.slug, svc.type, { db: app.db, serverId, ownerCreatedAt: svc.createdAt ?? null });
    }
    if (existing.some((t) => !requested.includes(t.serverId))) {
      await teardownTargets(app.db, id, () => undefined);
    }
    for (const serverId of requested) {
      if (serverId === svc.serverId) continue;
      const node = await app.db.query.servers.findFirst({ where: eq(servers.id, serverId) });
      if (!node) throw notFound(`Server ${serverId} not found`);
      if (!existing.some((t) => t.serverId === serverId)) {
        await app.db.insert(serviceTargets).values({ serviceId: id, serverId, status: 'idle' });
      }
    }
    for (const t of existing) {
      if (!requested.includes(t.serverId)) {
        await app.db.delete(serviceTargets).where(eq(serviceTargets.id, t.id));
        // r662: a node that stops being a target keeps no checkout of it.
        if (t.serverId !== svc.serverId) {
          await removeNodeWorkspace(app.db, t.serverId, svc.slug, (line) => req.log.warn({ serverId: t.serverId }, line));
        }
      }
    }
    void audit(app.db, req.user!.id, 'service.targets', `${svc.name}: ${requested.join(',') || 'cleared'}`);
    const rows = await app.db.select().from(serviceTargets).where(eq(serviceTargets.serviceId, id));
    return { targets: rows.map((t) => ({ serverId: t.serverId, runtimeId: t.runtimeId, status: t.status })) };
  });

  app.get('/:id/targets', async (req) => {
    const id = num((req.params as { id: string }).id);
    await loadServiceForUser(app.db, id, req.user!);
    const rows = await app.db.select().from(serviceTargets).where(eq(serviceTargets.serviceId, id));
    return { targets: rows.map((t) => ({ serverId: t.serverId, runtimeId: t.runtimeId, status: t.status })) };
  });

  // G-28: per-service sticky-session toggle. The setting lives in the
  // settings table at `sticky_session:<id>:enabled` (string `"true"` /
  // `"1"`); `engine/proxy.ts:writeDynamicConfig` reads it on every domain
  // / deploy change and adds a sticky cookie to the service's load
  // balancer (r631). The endpoint is POST (not PATCH) because it is a command, not
  // a description of the service's current state.
  app.post('/:id/sticky-session', async (req) => {
    const id = num((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'admin');
    const input = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
    await setSettingString(
      app.db,
      `sticky_session:${id}:enabled`,
      input.enabled ? 'true' : 'false',
    );
    void audit(app.db, req.user!.id, input.enabled ? 'service.sticky_session.enabled' : 'service.sticky_session.disabled', `#${id}`);
    // Re-render the dynamic config so the next reload picks up the change.
    // Best-effort: a write failure must not block the operator's toggle.
    try {
      const { writeDynamicConfig } = await import('../engine/proxy.js');
      await writeDynamicConfig(app.db);
    } catch {
      /* the next deploy or domain change will pick it up anyway */
    }
    return { id, enabled: input.enabled, active: await getStickyEnabledForService(app.db, id) };
  });

  // ── Lifecycle: stop / start / restart ──────────────────────────────────
  // PM2 services run as host processes under the PM2 daemon and must be
  // managed through it — `docker stop/start/restart` would silently no-op on a
  // PM2 process name. Docker services are managed through the docker CLI.
  //
  // These endpoints must tell the truth about the runtime: swallowing a
  // Docker/PM2 failure while still writing `running`/`stopped` to the database
  // makes the panel report containers that do not exist (typically after a
  // reboot or daemon outage). capture() rejections carry the CLI's stderr,
  // which separates "the runtime is gone" (idempotent stop / needs redeploy)
  // from "the daemon itself is unreachable".
  const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  const isMissingRuntime = (err: unknown): boolean =>
    /no such container|no such object|no such process|process (name )?not found|not found/i.test(errText(err));
  const isDaemonDown = (err: unknown): boolean =>
    /cannot connect to the docker daemon|docker daemon is not running|error during connect|is the docker daemon running/i.test(
      errText(err),
    );
  const daemonUnavailable = (err: unknown): HttpError =>
    new HttpError(503, 'runtime_daemon_unavailable', `Docker daemon is unreachable: ${errText(err)}`);
  const runtimeGone = (kind: string, runtimeId: string): HttpError =>
    conflict(`${kind} "${runtimeId}" no longer exists — redeploy the service to recreate it`);
  const nodeUnavailable = (err: unknown): HttpError =>
    new HttpError(503, 'node_unavailable', `The service's node did not complete the operation: ${errText(err)}`);
  /** Start a remote generation: primary first (a stale replica name must not
   *  mask a healthy primary), then the replicas best-effort. */
  const startRemote = async (serverId: number, serviceId: number, runtimeId: string, replicas: number): Promise<void> => {
    await remoteDocker(serverId, 'docker.start', { name: runtimeId }).catch(async (err: unknown) => {
      if (isMissingRuntime(err)) {
        await app.db.update(services).set({ status: 'error' }).where(eq(services.id, serviceId));
        throw runtimeGone('Container', runtimeId);
      }
      throw nodeUnavailable(err);
    });
    for (const name of replicaNames(runtimeId, replicas).slice(1)) {
      await remoteDocker(serverId, 'docker.start', { name }).catch(() => undefined);
    }
  };

  app.post('/:id/stop', async (req) => {
    const svc = await loadServiceForUser(app.db, num((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    if (!svc?.runtimeId) throw notFound('Service not found or not deployed');
    // PM2 and Docker have disjoint runtimes — an unknown type must not silently
    // misroute to the docker CLI (which would no-op on a PM2 process name).
    if (svc.type !== 'pm2' && svc.type !== 'docker' && svc.type !== 'compose') {
      req.log.warn({ type: svc.type, runtimeId: svc.runtimeId }, 'unsupported service type — cannot stop runtime');
      throw badRequest('Unsupported service type');
    }
    // F888: persist `stopped` BEFORE stopping. The runtime reconcile revives a
    // `running` row whose runtime is down, and `docker stop` returns only once
    // the slowest member has exited (a node stops replicas one by one) — a
    // pass inside that window restarted what the user was stopping, then never
    // looked at the `stopped` row again. A failed stop restores the previous
    // status, unless something else has moved the row since.
    await app.db.update(services).set({ status: 'stopped' }).where(eq(services.id, svc.id));
    try {
      // ── 0.16 T7 swarm ── stop = scale to 0 tasks (the stack and its spec stay).
      const swarmRuntime = swarmRuntimeOf(svc);
      if (swarmRuntime) {
        await scaleSwarmService(swarmRuntime, 0).catch((err: unknown) => {
          if (isDaemonDown(err)) throw daemonUnavailable(err);
          if (!isMissingRuntime(err)) throw err;
          req.log.warn({ err, runtimeId: svc.runtimeId }, 'Swarm service already gone; stop is idempotent');
        });
      } else if (svc.type === 'pm2') {
        // ── end 0.16 T7 ──
        // Stopping a process that is already gone is success, not failure.
        await pm2Stop(svc.runtimeId).catch((err: unknown) => {
          if (!isMissingRuntime(err)) throw err;
          req.log.warn({ err, runtimeId: svc.runtimeId }, 'pm2 process already gone; stop is idempotent');
        });
      } else if (svc.serverId != null) {
        for (const name of replicaNames(svc.runtimeId, svc.replicas)) {
          await remoteDocker(svc.serverId, 'docker.stop', { name }).catch((err: unknown) => {
            if (!isMissingRuntime(err)) throw nodeUnavailable(err);
            req.log.warn({ err, name }, 'remote container already gone; stop is idempotent');
          });
        }
      } else {
        // One batched stop covers the whole generation: primary + -r2..-rN
        // replicas. Stopping only the primary would leave replicas serving
        // while the panel says `stopped`.
        await capture('docker', ['stop', '-t', '5', ...replicaNames(svc.runtimeId, svc.replicas)]).catch((err: unknown) => {
          if (isDaemonDown(err)) throw daemonUnavailable(err);
          if (!isMissingRuntime(err)) throw err;
          req.log.warn({ err, runtimeId: svc.runtimeId }, 'container already gone; stop is idempotent');
        });
      }
    } catch (err) {
      try {
        await app.db
          .update(services)
          .set({ status: svc.status })
          .where(and(eq(services.id, svc.id), eq(services.status, 'stopped')));
      } catch (restoreErr) {
        req.log.warn({ err: restoreErr, serviceId: svc.id }, 'could not restore status after a failed stop');
      }
      throw err;
    }
    // D3/F836: `<name> #<id>` is the entity shape kernel/auditBridge decodes
    // (LAST `#<n>`); the bare name gave plugins no serviceId — or another
    // service's, for a name ending in "#<n>". meta.serviceId is what the
    // per-service Activity filter matches (modules/activity.ts).
    void audit(app.db, req.user!.id, 'service.stop', `${svc.name} #${svc.id}`, { serviceId: svc.id });
    app.kernel?.events.emit('service.stopped', {
      serviceId: svc.id,
    });
    return { ok: true, status: 'stopped' };
  });

  app.post('/:id/start', async (req) => {
    const svc = await loadServiceForUser(app.db, num((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    if (!svc?.runtimeId) throw notFound('Service not found or not deployed');
    // ── 0.16 T7 swarm ── start = scale back to the service's replicas.
    const swarmRuntime = swarmRuntimeOf(svc);
    if (swarmRuntime) {
      const swarmId = swarmRuntime;
      await scaleSwarmService(swarmId, svc.replicas ?? 1).catch(async (err: unknown) => {
        if (isDaemonDown(err)) throw daemonUnavailable(err);
        if (isMissingRuntime(err)) {
          await app.db.update(services).set({ status: 'error' }).where(eq(services.id, svc.id));
          throw runtimeGone('Swarm service', swarmId);
        }
        throw err;
      });
    } else if (svc.type === 'pm2') {
      // ── end 0.16 T7 ──
      await pm2Start(svc.runtimeId).catch(async (err: unknown) => {
        if (isMissingRuntime(err)) {
          await app.db.update(services).set({ status: 'error' }).where(eq(services.id, svc.id));
          throw runtimeGone('PM2 process', svc.runtimeId!);
        }
        throw err;
      });
    } else if ((svc.type === 'docker' || svc.type === 'compose') && svc.serverId != null) {
      await startRemote(svc.serverId, svc.id, svc.runtimeId, svc.replicas);
    } else if (svc.type === 'docker' || svc.type === 'compose') {
      // Batched start covers primary + replicas, mirroring stop. `docker
      // start` already-running members is a success (it prints the name),
      // so partial states converge.
      const startId = svc.runtimeId;
      await capture('docker', ['start', ...replicaNames(startId, svc.replicas)]).catch(async (err: unknown) => {
        if (isDaemonDown(err)) throw daemonUnavailable(err);
        if (isMissingRuntime(err)) {
          // A batched start fails when ANY member is missing (a stale replica
          // name from a scaled-down generation). The primary may already be
          // running — retry it alone before declaring the runtime gone.
          await capture('docker', ['start', startId]).catch(async (err2: unknown) => {
            if (isDaemonDown(err2)) throw daemonUnavailable(err2);
            if (isMissingRuntime(err2)) {
              await app.db.update(services).set({ status: 'error' }).where(eq(services.id, svc.id));
              throw runtimeGone('Container', startId);
            }
            throw err2;
          });
        } else {
          throw err;
        }
      });
    } else {
      req.log.warn({ type: svc.type, runtimeId: svc.runtimeId }, 'unsupported service type — cannot start runtime');
      throw badRequest('Unsupported service type');
    }
    await app.db.update(services).set({ status: 'running' }).where(eq(services.id, svc.id));
    // D3/F836: see service.stop.
    void audit(app.db, req.user!.id, 'service.start', `${svc.name} #${svc.id}`, { serviceId: svc.id });
    return { ok: true, status: 'running' };
  });

  app.post('/:id/restart', async (req) => {
    const svc = await loadServiceForUser(app.db, num((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    if (!svc?.runtimeId) throw notFound('Service not found or not deployed');
    // ── 0.16 T7 swarm ── restart = `docker service update --force` (a rolling restart of every task).
    const swarmRuntime = swarmRuntimeOf(svc);
    if (swarmRuntime) {
      const swarmId = swarmRuntime;
      await restartSwarmService(swarmId).catch(async (err: unknown) => {
        if (isDaemonDown(err)) throw daemonUnavailable(err);
        if (isMissingRuntime(err)) {
          await app.db.update(services).set({ status: 'error' }).where(eq(services.id, svc.id));
          throw runtimeGone('Swarm service', swarmId);
        }
        throw err;
      });
    } else if (svc.type === 'pm2') {
      // ── end 0.16 T7 ──
      await pm2Restart(svc.runtimeId).catch(async (err: unknown) => {
        if (isMissingRuntime(err)) {
          await app.db.update(services).set({ status: 'error' }).where(eq(services.id, svc.id));
          throw runtimeGone('PM2 process', svc.runtimeId!);
        }
        throw err;
      });
    } else if ((svc.type === 'docker' || svc.type === 'compose') && svc.serverId != null) {
      // The agent has no restart op: stop (idempotent) then start.
      for (const name of replicaNames(svc.runtimeId, svc.replicas)) {
        await remoteDocker(svc.serverId, 'docker.stop', { name }).catch((err: unknown) => {
          if (!isMissingRuntime(err)) throw nodeUnavailable(err);
        });
      }
      await startRemote(svc.serverId, svc.id, svc.runtimeId, svc.replicas);
    } else if (svc.type === 'docker' || svc.type === 'compose') {
      // Batched over the replica generation — a stop → restart flow must
      // bring the clones back too, or the panel would read `running` while
      // half the capacity stayed down.
      const restartId = svc.runtimeId;
      await capture('docker', ['restart', ...replicaNames(restartId, svc.replicas)]).catch(async (err: unknown) => {
        if (isDaemonDown(err)) throw daemonUnavailable(err);
        if (isMissingRuntime(err)) {
          // A stale replica name fails the whole batch — retry the primary
          // alone before declaring the runtime gone.
          await capture('docker', ['restart', restartId]).catch(async (err2: unknown) => {
            if (isDaemonDown(err2)) throw daemonUnavailable(err2);
            if (isMissingRuntime(err2)) {
              await app.db.update(services).set({ status: 'error' }).where(eq(services.id, svc.id));
              throw runtimeGone('Container', restartId);
            }
            throw err2;
          });
        } else {
          throw err;
        }
      });
    } else {
      req.log.warn({ type: svc.type, runtimeId: svc.runtimeId }, 'unsupported service type — cannot restart runtime');
      throw badRequest('Unsupported service type');
    }
    // docker restart / pm2.restart bring a stopped runtime back up — persist
    // the transition, or a stop → restart flow would forever show 'stopped'.
    await app.db.update(services).set({ status: 'running' }).where(eq(services.id, svc.id));
    // D3/F836: see service.stop.
    void audit(app.db, req.user!.id, 'service.restart', `${svc.name} #${svc.id}`, { serviceId: svc.id });
    return { ok: true, status: 'running' };
  });

  // Runtime logs: PM2 reads the daemon's log files; Docker reads container logs.
  app.get('/:id/logs', async (req) => {
    const svc = await loadServiceForUser(app.db, num((req.params as { id: string }).id), req.user!);
    if (!svc?.runtimeId) throw notFound('Service not found or not deployed');
    if (svc.type === 'pm2') {
      try {
        return { lines: await pm2Logs(svc.runtimeId) };
      } catch {
        return { lines: '' };
      }
    }
    try {
      // ── 0.16 T7 swarm ── every task's logs, wherever it runs.
      const swarmRuntime = swarmRuntimeOf(svc);
      if (swarmRuntime) return { lines: await swarmServiceLogs(swarmRuntime) };
      // ── end 0.16 T7 ──
      if (svc.serverId != null) {
        return { lines: await remoteDocker(svc.serverId, 'docker.logs', { name: svc.runtimeId }) };
      }
      // r667: 300 LINES is no byte bound — a container printing one endless
      // line used to be buffered whole; past 8 MiB the read stops.
      const out = await capture('docker', ['logs', '--tail', '300', '--timestamps', svc.runtimeId], { maxOutputBytes: 8 * 1024 * 1024 });
      return { lines: out };
    } catch {
      return { lines: '' };
    }
  });

  app.post('/:id/clone', async (req) => {
    const id = num((req.params as { id: string }).id);
    const body = (req.body as { name?: string; slug?: string } | undefined) ?? {};
    const svc = await loadServiceForUser(app.db, id, req.user!);
    // A clone copies encrypted environment variables and the full build
    // definition into a service the caller owns, so treat it as an admin-level
    // duplication rather than a read operation.
    await assertServiceRole(app.db, svc, req.user!, 'admin');
    // A clone inherits the source's type and build config — including its
    // lifecycle hooks — so it inherits its host privilege too.
    const sourceBuild = await app.db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, id) });
    assertMayUseHostPrivilege(req.user!, {
      type: svc.type,
      dockerSocket: svc.dockerSocket ?? false,
      build: sourceBuild ?? null,
    });

    const newName = body.name?.trim() || `${svc.name} (Copy)`;
    let newSlug = body.slug?.trim() ? slugify(body.slug) : slugify(newName);

    // Ensure unique slug. Bounded: a pathological number of collisions (or a
    // test/DB layer that answers every probe with a row) must not spin forever.
    let counter = 1;
    while (await app.db.query.services.findFirst({ where: eq(services.slug, newSlug) })) {
      if (counter > 50) {
        newSlug = slugifyWithSuffix(newName, Date.now().toString(36));
        break;
      }
      newSlug = slugifyWithSuffix(newName, String(counter++));
    }
    // r351: same retained-volume gate as create — the clone copies
    // `volumeMount`, so a freed slug would re-mount a deleted service's data.
    await assertSlugVolumeNotRetained(newSlug, svc.type);
    // F841: and, like create (r648), not a name another service attaches.
    if (svc.volumeMount) await assertPrimaryVolumeNotAttachedElsewhere(app.db, newSlug, null);

    const [created] = await app.db
      .insert(services)
      .values({
        ownerUserId: req.user!.id,
        name: newName,
        slug: newSlug,
        type: svc.type,
        status: 'idle',
        repoUrl: svc.repoUrl,
        branch: svc.branch,
        // Same gate as create: a managed source is an operator credential. A
        // member cloning a sourced service must not receive it — the clone is
        // theirs, and PATCHing its repoUrl would retarget the operator's
        // decrypted token at any repository the token can read.
        sourceId: req.user!.isOperator ? svc.sourceId : null,
        image: svc.image,
        volumeMount: svc.volumeMount,
        composeService: svc.composeService,
        // An inline stack's definition travels with the clone; the file is
        // materialised below so the copy is deployable before its first run.
        composeContent: svc.composeContent,
        healthPath: svc.healthPath,
        port: svc.port,
        publishedPort: null, // do not collide host port
        cpuShares: svc.cpuShares,
        memLimitMb: svc.memLimitMb,
        // r220: the runtime-defining columns travel too. A template clone
        // started with the image's default command (no `cmd`) and a generic
        // database URL (no `templateDatabaseEnv`); the CPU cap, replica count
        // and deployment lane were silently reset. `dockerSocket` already
        // passed the host-privilege gate above.
        cpuLimitMilli: svc.cpuLimitMilli,
        replicas: svc.replicas,
        cmd: svc.cmd,
        dockerSocket: svc.dockerSocket ?? false,
        templateId: svc.templateId,
        templateDatabaseEnv: svc.templateDatabaseEnv,
        environmentId: svc.environmentId,
        previewDeploymentsEnabled: svc.previewDeploymentsEnabled,
        previewAutoDestroyOnClose: svc.previewAutoDestroyOnClose,
        previewDomainPattern: svc.previewDomainPattern,
        previewMaxActive: svc.previewMaxActive,
      })
      .returning()
      // The slug-probe loop above is check-then-insert; the unique index is
      // the backstop for the same race as on the create path. Other insert
      // failures keep their original (throwing) behavior.
      .catch((err: unknown): Array<typeof services.$inferSelect> => {
        if (isUniqueViolation(err, /UNIQUE constraint failed.*services\.slug/)) {
          throw badRequest(`A service with slug '${newSlug}' already exists`, 'slug_taken');
        }
        throw err;
      });
    if (!created) throw notFound('Could not create the service clone');
    if (svc.composeContent) materialiseComposeFile(created.id, svc.composeContent);

    // Clone build config if exists
    const b = await app.db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, svc.id) });
    if (b) {
      await app.db.insert(buildConfigs).values({
        serviceId: created!.id,
        buildPack: b.buildPack,
        baseDir: b.baseDir,
        installCmd: b.installCmd,
        buildCmd: b.buildCmd,
        startCmd: b.startCmd,
        dockerfilePath: b.dockerfilePath,
        outputDir: b.outputDir,
        staticSpa: b.staticSpa,
        preDeployCmd: b.preDeployCmd,
        postDeployCmd: b.postDeployCmd,
        preStopCmd: b.preStopCmd,
        restartPolicy: b.restartPolicy,
        stopGraceSeconds: b.stopGraceSeconds,
      });
    }

    // Clone env vars
    const envs = await app.db.query.envVars.findMany({ where: eq(envVars.serviceId, svc.id) });
    for (const env of envs) {
      await app.db.insert(envVars).values({
        serviceId: created!.id,
        key: env.key,
        valueEncrypted: env.valueEncrypted,
        scope: env.scope,
        scopeKey: env.scope === 'service' ? created!.id : env.scopeKey,
        isSecret: env.isSecret,
      });
    }

    void audit(app.db, req.user!.id, 'service.clone', `${svc.name} -> ${created!.name}`);
    // The clone belongs wherever the original did.
    const sourceTags = await tagIdsOf(app.db, svc.id);
    await replaceServiceTags(
      app.db,
      created!.id,
      sourceTags.projectIds,
      sourceTags.workspaceIds,
      sourceTags.labelIds,
    );
    return serialize(created!, await sourceNameFor(app.db, created!.sourceId), await tagIdsOf(app.db, created!.id));
  });
};
