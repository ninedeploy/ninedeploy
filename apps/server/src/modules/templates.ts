import {
  buildConfigs,
  deployments,
  envVars,
  services,
  workspaceMembers,
  type Service,
} from '@ninedeploy/db';
import { deployTemplate, sameImageRepository, type DeployTemplate } from '@ninedeploy/schemas';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { audit } from '../lib/audit.js';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { getTemplates, type Template } from '../templates/registry.js';
import {
  importCommunityTemplate as importCommunityTemplateLib,
  listCommunityTemplates,
  removeCommunityTemplate as removeCommunityTemplateLib,
} from '../lib/communityTemplates.js';
import { encrypt, randomToken } from '../lib/crypto.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { assertMayUseHostPrivilege } from '../lib/hostPrivilege.js';
import type { AuthedUser } from '../lib/resourceAccess.js';
import { assertMayPublishPort } from '../lib/hostPort.js';
import { slugify } from '../lib/slug.js';
import { applyDefaultTags, replaceServiceTags } from './serviceTags.js';
import { prepareComposeStack } from './composeStacks.js';

const summary = (t: Template) => ({
  id: t.id,
  name: t.name,
  tagline: t.tagline,
  category: t.category,
  emoji: t.emoji,
  featured: t.featured,
  runtimeVerified: t.runtimeVerified === true,
  verifiedAt: t.verifiedAt,
});

type ProvisionStage = {
  id: 'service' | 'environment' | 'database' | 'attachment' | 'deployment';
  status: 'success' | 'skipped';
  message: string;
};

/**
 * A template-deployed service is "the same template" if every template-controlled
 * field matches. The image compares by REPOSITORY, not by exact reference: the
 * Hub allows pinning a different tag of the template's own image at install
 * time (`:latest` → `:11.5`). Project membership is no longer in the
 * comparison (tags are N-N now and an empty/refreshed set is a valid re-deploy).
 */
function sameTemplateService(service: Service, template: Template, ownerUserId: number): boolean {
  return service.ownerUserId === ownerUserId
    && service.type === 'docker'
    && sameImageRepository(template.image, service.image ?? '')
    && service.port === template.port
    && service.volumeMount === (template.volumeMount ?? null)
    && ['idle', 'error', 'stopped'].includes(service.status);
}

/**
 * One environment entry a service is seeded with — a template's declared env,
 * or the values a compose stack's magic tokens resolved to.
 */
export interface EnvSeed {
  key: string;
  value: string;
  secret?: boolean;
  /**
   * `false` = `value` is already final and must be stored verbatim. Compose
   * stacks resolve their own secrets (`resolveStackEnvironment`), so the
   * generator below would otherwise throw away a `SERVICE_URL_*` value — or
   * any other resolved token — and replace it with unrelated entropy.
   * Omitted for ordinary template entries, which are generated on install.
   */
  generate?: boolean;
}

/** Upsert template defaults and user overrides without rotating existing secrets on retry. */
export async function reconcileEnvironment(
  app: FastifyInstance,
  serviceId: number,
  template: { env?: EnvSeed[] },
  overrides: Array<{ key: string; value: string; isSecret: boolean }>,
): Promise<Array<{ key: string; value: string }>> {
  const existing = await app.db.query.envVars.findMany({ where: eq(envVars.serviceId, serviceId) });
  const byKey = new Map(existing.map((row) => [row.key, row]));
  const requested = new Map(overrides.map((row) => [row.key, row]));
  const desired = new Map<string, { value: string; isSecret: boolean; generated: boolean }>();
  const generatedSecrets: Array<{ key: string; value: string }> = [];

  for (const entry of template.env ?? []) {
    const override = requested.get(entry.key);
    if (override) {
      desired.set(entry.key, { value: override.value, isSecret: override.isSecret, generated: false });
      requested.delete(entry.key);
    } else if (!byKey.has(entry.key)) {
      // 32 BYTES (43 base64url chars), not 32 chars: template secrets feed
      // variables like Directus SECRET and n8n N8N_ENCRYPTION_KEY whose
      // ecosystems either require or recommend ≥32-char values, and a longer
      // value can never fail such a policy. Only generated on first install —
      // retries never rotate existing secrets.
      const mint = entry.secret === true && entry.generate !== false;
      const value = mint ? randomToken(32) : entry.value;
      // Pre-resolved secrets are still reported back for one-time display —
      // a compose stack's generated password is exactly what the installer
      // needs to see once.
      desired.set(entry.key, { value, isSecret: entry.secret ?? false, generated: entry.secret === true });
    }
  }
  for (const [key, entry] of requested) {
    desired.set(key, { value: entry.value, isSecret: entry.isSecret, generated: false });
  }

  for (const [key, entry] of desired) {
    const values = { valueEncrypted: encrypt(entry.value), isSecret: entry.isSecret };
    const current = byKey.get(key);
    if (current) {
      await app.db.update(envVars).set(values).where(eq(envVars.id, current.id));
    } else {
      await app.db.insert(envVars).values({ serviceId, scope: 'service', scopeKey: serviceId, key, ...values });
    }
    if (entry.generated) generatedSecrets.push({ key, value: entry.value });
  }
  return generatedSecrets;
}

async function prepareTemplateService(
  app: FastifyInstance,
  template: Template,
  input: DeployTemplate,
  user: AuthedUser,
): Promise<{ service: Service; generatedSecrets: Array<{ key: string; value: string }>; stages: ProvisionStage[] }> {
  const ownerUserId = user.id;
  // Remote-server placement is operator-only, same as POST/PATCH /services
  // (r097). Covers both the fresh-create and the reuseExisting path below.
  if (input.serverId != null && !user.isOperator) {
    throw forbidden('Only operators may place a service on a remote server');
  }
  // The Hub may pin a different TAG of the template's own image (:latest →
  // :11.5). Anything else — a different repository or a digest reference —
  // would run unverified bytes under a vetted template's name, so it is
  // rejected here, where the override enters the system.
  const image = input.image ?? template.image;
  if (!sameImageRepository(template.image, image)) {
    throw badRequest(`Image override must keep the template's repository (${template.image})`);
  }
  // The legacy `input.projectId` was the single FK on `services`. Templates
  // now use the N-N tag system; the request body still accepts `projectId`
  // (singular) for back-compat and we map it to the new join table.
  const inputProjectIds = input.projectId != null ? [input.projectId] : [];
  const name = input.name ?? template.name;
  const requestedSlug = input.name ? slugify(name) : `${slugify(template.name)}-${Date.now().toString(36).slice(-4)}`;
  const stages: ProvisionStage[] = [];

  let slug = requestedSlug;
  let service = await app.db.query.services.findFirst({ where: eq(services.slug, slug) });
  // L-12: `slug_taken` used to answer for services the caller cannot see,
  // turning template deploy into a probe for other tenants' service names.
  // A collision with someone else's service is now resolved by picking a free
  // slug instead of reporting theirs — the caller gets a working service and
  // learns nothing. A collision with a service they CAN see keeps the explicit
  // error, because that one is actionable.
  if (service && service.ownerUserId !== ownerUserId && !user.isOperator) {
    let attempt = 0;
    do {
      slug = `${requestedSlug}-${randomToken(3).slice(0, 4)}`;
      service = await app.db.query.services.findFirst({ where: eq(services.slug, slug) });
    } while (service && ++attempt < 5);
    if (service) throw badRequest('Could not allocate a free service slug — try a different name');
  }
  if (service) {
    if (!input.reuseExisting || !sameTemplateService(service, template, ownerUserId)) {
      throw badRequest(`A service with slug '${slug}' already exists`, 'slug_taken');
    }
    const trusted = {
      name,
      serverId: input.serverId === undefined ? service.serverId : input.serverId,
      publishedPort: input.publishedPort === undefined ? service.publishedPort : input.publishedPort,
      healthPath: input.healthPath ?? service.healthPath,
      cpuShares: input.cpuShares ?? service.cpuShares,
      memLimitMb: input.memLimitMb ?? service.memLimitMb,
      cmd: template.cmd ?? null,
      dockerSocket: template.dockerSocket ?? false,
      templateId: template.id,
      templateDatabaseEnv: template.databaseEnv ?? null,
    };
    await app.db.update(services).set(trusted).where(eq(services.id, service.id));
    service = { ...service, ...trusted };
    stages.push({ id: 'service', status: 'success', message: 'Existing interrupted service reconciled' });
  } else {
    const [created] = await app.db.insert(services).values({
      ownerUserId,
      name,
      slug,
      type: 'docker',
      image,
      port: template.port,
      publishedPort: input.publishedPort ?? null,
      healthPath: input.healthPath ?? '/',
      volumeMount: template.volumeMount ?? null,
      repoUrl: null,
      serverId: input.serverId ?? null,
      cpuShares: input.cpuShares ?? 0,
      memLimitMb: input.memLimitMb ?? 0,
      cmd: template.cmd ?? null,
      dockerSocket: template.dockerSocket ?? false,
      templateId: template.id,
      templateDatabaseEnv: template.databaseEnv ?? null,
    }).returning();
    if (!created) throw badRequest('Could not create template service');
    service = created;
    await app.db.insert(buildConfigs).values({ serviceId: service.id, buildPack: 'auto', baseDir: '/' });
    stages.push({ id: 'service', status: 'success', message: 'Service configuration created' });
  }

  // Apply tag scope: every workspace the caller belongs to (so the new
  // service is visible from all of their workspaces), plus the project's
  // membership if one was passed on the request.
  if (inputProjectIds.length > 0) {
    // Single-project deployment: tag the service into the named project.
    const workspaceIds = await defaultWorkspaceIdsForUser(app.db, user);
    await replaceServiceTags(app.db, service.id, inputProjectIds, workspaceIds, []);
  } else {
    await applyDefaultTags(app.db, user, service.id);
  }

  const generatedSecrets = await reconcileEnvironment(app, service.id, template, input.env ?? []);
  stages.push({ id: 'environment', status: 'success', message: 'Environment and secrets reconciled' });
  return { service, generatedSecrets, stages };
}

async function defaultWorkspaceIdsForUser(db: import('@ninedeploy/db').DB, user: { id: number; isOperator: boolean }): Promise<number[]> {
  if (user.isOperator) {
    const rows = await db.query.workspaces.findMany();
    return rows.map((w) => w.id);
  }
  const ms = await db.query.workspaceMembers.findMany({
    where: eq(workspaceMembers.userId, user.id),
  });
  return ms.map((m) => m.workspaceId);
}

/** Template hub: list, detail, canonical retry-safe one-click provisioning. */
export const templateRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async () => {
    // Community contributions (G-13) are merged into the
    // curated list. The bundled / remote entries are the
    // installable baseline; a community entry that
    // collides on `id` is dropped (the curated entry
    // wins) so the operator can't accidentally shadow a
    // shipped template.
    const curated = await getTemplates(app.db);
    const curatedIds = new Set(curated.map((t) => t.id));
    const community = (await listCommunityTemplates()).entries
      .filter((e) => !curatedIds.has(e.id))
      .map((e) => e.template);
    return [...curated, ...community].map(summary);
  });

  app.get('/:id', async (req) => {
    const t = (await getTemplates(app.db)).find((x) => x.id === (req.params as { id: string }).id);
    if (!t) throw notFound('Template not found');
    return { ...t, runtimeVerified: t.runtimeVerified === true };
  });

  // ── community contributions (G-13) ──────────────────────────────────
  // `GET /templates/community` lists every file in
  // `<dataDir>/community-templates/`. The result includes
  // a per-file error list so a single bad JSON does not
  // hide the rest of the catalog.
  app.get('/community', async () => listCommunityTemplates());

  // Import a community template. The body carries the
  // raw JSON content (the operator pastes it from a PR
  // comment, a `curl | ninedeploy templates community
  // import -` pipeline, etc.). The helper validates the
  // schema and refuses an existing id unless `replace:
  // true` is passed.
  app.post<{ Body: { content?: string; replace?: boolean } }>(
    '/community/import',
    { preHandler: app.requireAdmin },
    async (req) => {
      const body = (req.body ?? {}) as { content?: string; replace?: boolean };
      if (typeof body.content !== 'string' || body.content.length === 0) {
        throw badRequest('content is required (a single-template JSON envelope)');
      }
      try {
        const result = await importCommunityTemplateLib(body.content, { replace: body.replace });
        void audit(
          app.db,
          req.user!.id,
          'templates.community_import',
          `${result.id} (${result.bytes} bytes)`,
        );
        return { ok: true, ...result };
      } catch (err) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Remove a community template by id. The file is
  // unlinked; the next list call will no longer surface
  // it. Bundled templates are unaffected.
  app.delete<{ Params: { id: string } }>(
    '/community/:id',
    { preHandler: app.requireAdmin },
    async (req) => {
      // The id becomes a file name — an unsafe slug is a 400, not a lookup.
      const id = (req.params as { id: string }).id;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes('..')) {
        throw badRequest(`Invalid template id "${id}"`);
      }
      const result = await removeCommunityTemplateLib(id);
      if (!result.removed) throw notFound(`Community template "${result.id}" not found`);
      void audit(app.db, req.user!.id, 'templates.community_remove', result.id);
      return { ok: true, ...result };
    },
  );

  const queue = async (req: FastifyRequest) => {
    const t = (await getTemplates(app.db)).find((x) => x.id === (req.params as { id: string }).id);
    if (!t) throw notFound('Template not found');
    const input = deployTemplate.parse(req.body ?? {});
    // Templates that mount the Docker socket (Portainer, Dockge, Dozzle,
    // Homepage) hand the container control of every other container on the
    // host — admin-only, like the exec terminal.
    //
    // The service type must be the one that will actually be CREATED. A
    // template carrying `composeContent` becomes a `type: 'compose'` service
    // (see composeStacks.ts), and `hostPrivilege.ts` treats compose as a host
    // privilege because a compose file can bind-mount host paths or ask for a
    // privileged container. Hard-coding `'docker'` here skipped that check, so
    // a member could stand up and queue a compose stack through this route —
    // while `assertMayDeployStoredService` correctly refused them the *next*
    // deploy of the very same service.
    assertMayUseHostPrivilege(req.user!, {
      type: t.composeContent ? 'compose' : 'docker',
      dockerSocket: t.dockerSocket ?? false,
    });
    assertMayPublishPort(req.user!, input.publishedPort);
    const prepared = t.composeContent
      ? await (async () => {
          const stack = await prepareComposeStack(app, t, input, req.user!);
          const generatedSecrets = await reconcileEnvironment(app, stack.service.id, { ...t, env: stack.stackEnv }, input.env ?? []);
          return {
            service: stack.service,
            generatedSecrets,
            stages: [
              { id: 'service' as const, status: 'success' as const, message: 'Compose stack service created' },
              { id: 'environment' as const, status: 'success' as const, message: 'Magic variables resolved and persisted' },
              ...stack.warnings.map((w) => ({ id: 'database' as const, status: 'skipped' as const, message: w })),
            ],
          };
        })()
      : await prepareTemplateService(app, t, input, req.user!);
    let deployment = await app.db.query.deployments.findFirst({
      where: and(
        eq(deployments.serviceId, prepared.service.id),
        inArray(deployments.status, ['queued', 'building', 'deploying']),
      ),
      orderBy: desc(deployments.id),
    });
    if (!deployment) {
      [deployment] = await app.db.insert(deployments).values({
        serviceId: prepared.service.id,
        status: 'queued',
        trigger: 'user',
        message: `Deploy from template: ${t.name}`,
      }).returning();
    }
    if (!deployment) throw badRequest('Could not queue template deployment');
    prepared.stages.push({
      id: 'database',
      status: t.dbEngine ? 'success' : 'skipped',
      message: t.dbEngine ? `${t.dbEngine} dependency queued for worker reconciliation` : 'Template has no managed database dependency',
    });
    prepared.stages.push({
      id: 'attachment',
      status: t.dbEngine ? 'success' : 'skipped',
      message: t.dbEngine ? 'Database attachment queued for worker reconciliation' : 'No database attachment required',
    });
    prepared.stages.push({ id: 'deployment', status: 'success', message: 'Durable application deployment queued' });
    void audit(app.db, req.user!.id, 'template.deploy', `${t.name} → ${prepared.service.name}`);
    return {
      serviceId: prepared.service.id,
      serviceName: prepared.service.name,
      serviceSlug: prepared.service.slug,
      deploymentId: deployment.id,
      databaseId: null,
      generatedSecrets: prepared.generatedSecrets,
      stages: prepared.stages,
      alreadyInProgress: deployment.status !== 'queued',
    };
  };

  // Both endpoints are aliases of the same durable operation. There is no
  // browser-owned second phase: once this returns, the worker owns the job.
  app.post('/:id/prepare', queue);
  app.post('/:id/deploy', queue);
};
