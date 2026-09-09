import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import {
  buildConfigs,
  deployments,
  envVars,
  serviceLabels,
  serviceProjects,
  services,
  serviceWorkspaces,
  sources,
  type DB,
  type Service,
} from '@ninedeploy/db';
import { composePreviewRequest, createService, sameImageRepository, setLimits, updateService } from '@ninedeploy/schemas';
import { getTemplates } from '../templates/registry.js';
import { capture } from '../lib/exec.js';
import { audit } from '../lib/audit.js';
import { config } from '../config.js';
import { getStickyEnabledForService } from '../engine/proxy.js';
import { setSettingString } from '../lib/settings.js';
import { badRequest, conflict, forbidden, HttpError, notFound, parseId as num } from '../lib/errors.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';
import {
  assertServiceRole,
  maxRole,
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
import { composeBuilder } from '../engine/builders/compose.js';
import { dockerBuilder } from '../engine/builders/docker.js';
import { pm2Builder, pm2Logs, pm2Restart, pm2Start, pm2Stop } from '../engine/builders/pm2.js';
import { deleteLog } from '../engine/logs.js';
import { writeDynamicConfig } from '../engine/proxy.js';
import { removeServiceBridgeIfEmpty } from '../lib/serviceBridge.js';
import { applyDefaultTags, replaceServiceTags } from './serviceTags.js';
import { analyseComposeContent, stackEnvSeeds, stackPublicUrl } from './composeStacks.js';
import { materialiseComposeFile } from '../lib/composeWorkspace.js';
import { reconcileEnvironment } from './templates.js';
import { resolveStackEnvironment } from '../engine/magicVars.js';

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
    memLimitMb: s.memLimitMb,
    previewDeploymentsEnabled: s.previewDeploymentsEnabled,
    previewAutoDestroyOnClose: s.previewAutoDestroyOnClose,
    previewDomainPattern: s.previewDomainPattern,
    previewMaxActive: s.previewMaxActive,
    isEphemeralPreview: s.isEphemeralPreview,
    previewParentServiceId: s.previewParentServiceId,
    prNumber: s.prNumber,
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
      ? (await getTemplates(app.db)).find((candidate) => candidate.id === input.templateId)
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
    const slug = input.slug ?? slugify(input.name);
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
        memLimitMb: input.memLimitMb ?? 0,
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
      })
      .returning()
      // The duplicate check above is check-then-insert: two concurrent
      // creates with the same slug both pass it, and the services_slug_unique
      // index (migration 0049) is the actual backstop — translate the
      // constraint into the same clean slug_taken response the pre-check
      // produces. Any other insert failure keeps failing loudly.
      .catch((err: unknown): Array<typeof services.$inferSelect> => {
        if (err instanceof Error && /UNIQUE constraint failed.*services\.slug/.test(err.message)) {
          throw badRequest(`A service with slug '${slug}' already exists`, 'slug_taken');
        }
        throw err;
      });
    if (!svc) throw notFound('Could not create service');
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
    // wins, otherwise the service lands in every workspace the caller belongs
    // to so it is visible to their team by default.
    if (input.tagProjectIds || input.tagWorkspaceIds || input.tagLabelIds) {
      // Same rule as PUT /:id/tags: a member may only tag with projects,
      // workspaces and labels they can see. Without this check a member could
      // tag their service with ANOTHER tenant's project id, and the deploy
      // pipeline (engine/pipeline.ts loadRuntimeEnv) would decrypt that
      // project's shared env values straight into the member's container.
      if (!req.user!.isOperator) {
        const projectIds = input.tagProjectIds ?? [];
        const allowedProjects = await visibleProjectIds(app.db, req.user!, projectIds);
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
    };
  });

  app.patch('/:id', async (req) => {
    const id = num((req.params as { id: string }).id);
    const existing = await loadServiceForUser(app.db, id, req.user!);
    // Read access is any workspace seat; editing the definition is `member`+.
    await assertServiceRole(app.db, existing, req.user!, 'member');
    const { build, ...patch } = updateService.parse(req.body ?? {});
    // Same rule as create: attaching a managed source is operator-only. A
    // member editing their own service must not bolt an operator credential
    // onto it afterwards.
    if (patch.sourceId !== undefined && patch.sourceId !== null && !req.user!.isOperator) {
      throw forbidden('Only operators may attach a managed source to a service');
    }
    // The gate has to consider the MERGED result, not just the payload: a
    // member could otherwise switch `type` to pm2 on its own, or add a single
    // lifecycle hook, and reach host execution one field at a time.
    const currentBuild = await app.db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, id) });
    const merged = (key: 'preDeployCmd' | 'postDeployCmd' | 'preStopCmd') =>
      build?.[key] !== undefined ? build[key] : currentBuild?.[key];
    assertMayUseHostPrivilege(req.user!, {
      type: patch.type ?? existing.type,
      dockerSocket: existing.dockerSocket ?? false,
      build: {
        preDeployCmd: merged('preDeployCmd'),
        postDeployCmd: merged('postDeployCmd'),
        preStopCmd: merged('preStopCmd'),
      },
    });
    // Same merged-result reasoning for the host port.
    assertMayPublishPort(req.user!, patch.publishedPort === undefined ? existing.publishedPort : patch.publishedPort);
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
    // Build-config keys are optional; null out omitted-but-cleared ones via `set` semantics.
    const [svc] = await app.db.update(services).set(patch).where(eq(services.id, id)).returning();
    if (!svc) throw notFound('Service not found');
    if (build) {
      // Only overwrite the keys the client sent — a PATCH must not reset the
      // rest of the build config back to defaults.
      const values: Partial<typeof buildConfigs.$inferInsert> = {};
      if (build.buildPack !== undefined) values.buildPack = build.buildPack;
      if (build.baseDir !== undefined) values.baseDir = build.baseDir;
      if (build.restartPolicy !== undefined) values.restartPolicy = build.restartPolicy;
      if (build.stopGraceSeconds !== undefined) values.stopGraceSeconds = build.stopGraceSeconds;
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
    if (patch.composeContent !== undefined) materialiseComposeFile(id, patch.composeContent);
    void audit(app.db, req.user!.id, 'service.update', svc.name);
    return serialize(svc, await sourceNameFor(app.db, svc.sourceId), await tagIdsOf(app.db, svc.id));
  });

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
    if (svc.runtimeId) {
      if (svc.type === 'pm2') await pm2Builder.stop(svc.runtimeId);
      else if (svc.type === 'docker') await dockerBuilder.stop(svc.runtimeId);
      else if (svc.type === 'compose') await composeBuilder.stop(svc.runtimeId);
      else req.log.warn({ type: svc.type, runtimeId: svc.runtimeId }, 'unsupported service type — leaving runtime in place');
    }
    // Model B: reap the service's private bridge. A no-op when a database is
    // still attached to it (so the DB keeps resolving the service's bridge
    // and the panel can still show the connection). Failures are logged, not
    // thrown — the row is already gone and a stale bridge is recoverable.
    try {
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

  // Resource limits (applied on next deploy).
  app.patch('/:id/limits', async (req) => {
    const id = num((req.params as { id: string }).id);
    const limitTarget = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, limitTarget, req.user!, 'member');
    const input = setLimits.parse(req.body);
    const updateData: { cpuShares?: number; memLimitMb?: number } = {};
    if (input.cpuShares !== undefined) {
      updateData.cpuShares = input.cpuShares && input.cpuShares > 0 ? input.cpuShares : 0;
    }
    if (input.memLimitMb !== undefined) {
      updateData.memLimitMb = input.memLimitMb && input.memLimitMb > 0 ? input.memLimitMb : 0;
    }
    const [svc] = await app.db.update(services).set(updateData).where(eq(services.id, id)).returning();
    if (!svc) throw notFound('Service not found');
    return { cpuShares: svc.cpuShares, memLimitMb: svc.memLimitMb };
  });

  // G-28: per-service sticky-session toggle. The setting lives in the
  // settings table at `sticky_session:<id>:enabled` (string `"true"` /
  // `"1"`); `engine/proxy.ts:writeDynamicConfig` reads it on every domain
  // / deploy change and emits the Traefik `mw_sticky_<id>` middleware
  // block. The endpoint is POST (not PATCH) because it is a command, not
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

  app.post('/:id/stop', async (req) => {
    const svc = await loadServiceForUser(app.db, num((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    if (!svc?.runtimeId) throw notFound('Service not found or not deployed');
    // PM2 and Docker have disjoint runtimes — an unknown type must not silently
    // misroute to the docker CLI (which would no-op on a PM2 process name).
    if (svc.type === 'pm2') {
      // Stopping a process that is already gone is success, not failure.
      await pm2Stop(svc.runtimeId).catch((err: unknown) => {
        if (!isMissingRuntime(err)) throw err;
        req.log.warn({ err, runtimeId: svc.runtimeId }, 'pm2 process already gone; stop is idempotent');
      });
    } else if (svc.type === 'docker' || svc.type === 'compose') {
      await capture('docker', ['stop', '-t', '5', svc.runtimeId]).catch((err: unknown) => {
        if (isDaemonDown(err)) throw daemonUnavailable(err);
        if (!isMissingRuntime(err)) throw err;
        req.log.warn({ err, runtimeId: svc.runtimeId }, 'container already gone; stop is idempotent');
      });
    } else {
      req.log.warn({ type: svc.type, runtimeId: svc.runtimeId }, 'unsupported service type — cannot stop runtime');
      throw badRequest('Unsupported service type');
    }
    await app.db.update(services).set({ status: 'stopped' }).where(eq(services.id, svc.id));
    void audit(app.db, req.user!.id, 'service.stop', svc.name);
    app.kernel?.events.emit('service.stopped', {
      serviceId: svc.id,
    });
    return { ok: true, status: 'stopped' };
  });

  app.post('/:id/start', async (req) => {
    const svc = await loadServiceForUser(app.db, num((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    if (!svc?.runtimeId) throw notFound('Service not found or not deployed');
    if (svc.type === 'pm2') {
      await pm2Start(svc.runtimeId).catch(async (err: unknown) => {
        if (isMissingRuntime(err)) {
          await app.db.update(services).set({ status: 'error' }).where(eq(services.id, svc.id));
          throw runtimeGone('PM2 process', svc.runtimeId!);
        }
        throw err;
      });
    } else if (svc.type === 'docker' || svc.type === 'compose') {
      await capture('docker', ['start', svc.runtimeId]).catch(async (err: unknown) => {
        if (isDaemonDown(err)) throw daemonUnavailable(err);
        if (isMissingRuntime(err)) {
          await app.db.update(services).set({ status: 'error' }).where(eq(services.id, svc.id));
          throw runtimeGone('Container', svc.runtimeId!);
        }
        throw err;
      });
    } else {
      req.log.warn({ type: svc.type, runtimeId: svc.runtimeId }, 'unsupported service type — cannot start runtime');
      throw badRequest('Unsupported service type');
    }
    await app.db.update(services).set({ status: 'running' }).where(eq(services.id, svc.id));
    void audit(app.db, req.user!.id, 'service.start', svc.name);
    return { ok: true, status: 'running' };
  });

  app.post('/:id/restart', async (req) => {
    const svc = await loadServiceForUser(app.db, num((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    if (!svc?.runtimeId) throw notFound('Service not found or not deployed');
    if (svc.type === 'pm2') {
      await pm2Restart(svc.runtimeId).catch(async (err: unknown) => {
        if (isMissingRuntime(err)) {
          await app.db.update(services).set({ status: 'error' }).where(eq(services.id, svc.id));
          throw runtimeGone('PM2 process', svc.runtimeId!);
        }
        throw err;
      });
    } else if (svc.type === 'docker' || svc.type === 'compose') {
      await capture('docker', ['restart', svc.runtimeId]).catch(async (err: unknown) => {
        if (isDaemonDown(err)) throw daemonUnavailable(err);
        if (isMissingRuntime(err)) {
          await app.db.update(services).set({ status: 'error' }).where(eq(services.id, svc.id));
          throw runtimeGone('Container', svc.runtimeId!);
        }
        throw err;
      });
    } else {
      req.log.warn({ type: svc.type, runtimeId: svc.runtimeId }, 'unsupported service type — cannot restart runtime');
      throw badRequest('Unsupported service type');
    }
    // docker restart / pm2.restart bring a stopped runtime back up — persist
    // the transition, or a stop → restart flow would forever show 'stopped'.
    await app.db.update(services).set({ status: 'running' }).where(eq(services.id, svc.id));
    void audit(app.db, req.user!.id, 'service.restart', svc.name);
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
      const out = await capture('docker', ['logs', '--tail', '300', '--timestamps', svc.runtimeId]);
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
        sourceId: svc.sourceId,
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
        if (err instanceof Error && /UNIQUE constraint failed.*services\.slug/.test(err.message)) {
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
