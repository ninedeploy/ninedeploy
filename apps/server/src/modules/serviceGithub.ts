import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  githubAppInstallations,
  githubApps,
  serviceGithubLinks,
  services,
  sources,
  webhooks,
  type DB,
  type GithubApp,
  type GithubAppInstallation,
  type Service,
  type ServiceGithubLink,
} from '@ninedeploy/db';
import { serviceGithubFeedbackPatch, serviceGithubLinkPut, serviceGithubMigrate } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, HttpError, isUniqueViolation, notFound, parseId } from '../lib/errors.js';
import { GithubAppError, githubApi, installationToken } from '../lib/githubApp.js';
import { assertServiceRole, loadServiceForUser } from '../lib/resourceAccess.js';
import { githubRepoFromUrl } from '../lib/sourceCreds.js';

/**
 * A service's GitHub App link (0.13), mounted under /services:
 *
 *   GET    /:id/github           viewer   — the link and whether the App drives the service
 *   PUT    /:id/github           operator — link (or re-link) to an installation's repository
 *   PATCH  /:id/github/feedback  admin    — commit statuses / PR comments on or off
 *   POST   /:id/github/migrate   operator — link a PAT/webhook service, keeping both as fallback
 *   POST   /:id/github/finalize  operator — detach the old source, deactivate the webhooks
 *   DELETE /:id/github           operator — revert: restore the old source and webhooks, unlink
 *
 * The link decides which credential clones the repository, so every route
 * that writes it mirrors the operator-only source-attach gate
 * (`modules/services.ts`); the feedback toggles only make the panel talk to
 * GitHub about deploys it already runs, so they sit at the service-admin tier.
 * Authorization runs before the body is parsed, and every mutation is audited
 * with ids and names only.
 */

function serializeLink(link: ServiceGithubLink, inst: GithubAppInstallation) {
  return {
    id: link.id,
    serviceId: link.serviceId,
    installationRowId: link.installationRowId,
    githubAppId: inst.githubAppId,
    sourceId: inst.sourceId ?? null,
    repoId: link.repoId,
    repoFullName: link.repoFullName,
    enabled: link.enabled,
    tokenScope: link.tokenScope,
    watchPaths: link.watchPaths ?? null,
    reportStatus: link.reportStatus,
    prComment: link.prComment,
    previousSourceId: link.previousSourceId ?? null,
    active: link.enabled && !inst.suspendedAt && !inst.removedAt,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
  };
}

function assertOperator(req: FastifyRequest): void {
  if (req.user?.isOperator !== true) throw forbidden('Only operators may change which credential clones a service');
}

/** The caller may see the service (404 otherwise); `operator` additionally needs the instance operator flag. */
async function loadService(db: DB, req: FastifyRequest, floor: 'viewer' | 'admin' | 'operator'): Promise<Service> {
  const svc = await loadServiceForUser(db, parseId((req.params as { id: string }).id), req.user!);
  if (floor === 'operator') assertOperator(req);
  else if (floor === 'admin') await assertServiceRole(db, svc, req.user!, 'admin');
  return svc;
}

function refuseOnPreview(svc: Service): void {
  if (svc.isEphemeralPreview || svc.previewParentServiceId != null) {
    throw badRequest("A PR preview uses its parent service's GitHub link", 'github_link_preview');
  }
}

async function loadLink(db: DB, serviceId: number): Promise<{ link: ServiceGithubLink; inst: GithubAppInstallation } | null> {
  const link = await db.query.serviceGithubLinks.findFirst({ where: eq(serviceGithubLinks.serviceId, serviceId) });
  if (!link) return null;
  const inst = await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.id, link.installationRowId) });
  return inst ? { link, inst } : null;
}

async function requireLink(db: DB, serviceId: number): Promise<{ link: ServiceGithubLink; inst: GithubAppInstallation }> {
  const found = await loadLink(db, serviceId);
  if (!found) throw notFound('This service is not linked to a GitHub App installation');
  return found;
}

/** A `github_app` source's live installation and App. */
async function installationForSource(db: DB, sourceId: number): Promise<{ ghApp: GithubApp; inst: GithubAppInstallation }> {
  const src = await db.query.sources.findFirst({ where: eq(sources.id, sourceId) });
  if (!src) throw notFound('Source not found');
  if (src.type !== 'github_app') throw badRequest('sourceId must be a GitHub App source', 'github_source_required');
  const inst = await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.sourceId, sourceId) });
  if (!inst) throw badRequest('No GitHub App installation is behind this source; sync the App installations first', 'github_no_installation');
  const ownerName = inst.accountLogin ?? `installation ${inst.installationId}`;
  if (inst.removedAt) throw conflict(`The GitHub App installation on ${ownerName} was removed`);
  if (inst.suspendedAt) throw conflict(`The GitHub App installation on ${ownerName} is suspended`);
  const ghApp = await db.query.githubApps.findFirst({ where: eq(githubApps.id, inst.githubAppId) });
  if (!ghApp) throw badRequest('The GitHub App behind this source no longer exists', 'github_no_installation');
  return { ghApp, inst };
}

/** A GitHub App failure as the HTTP error the caller sees (messages are already redacted). */
function githubFailure(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof GithubAppError) {
    if (err.reason === 'host_mismatch' || err.reason === 'bad_repo_url') return badRequest(err.message, 'github_repo_url_invalid');
    if (err.reason === 'not_accessible' || err.reason === 'not_found') return badRequest(err.message, 'github_repo_not_accessible');
    if (err.reason === 'removed' || err.reason === 'suspended') return conflict(err.message);
    if (err.reason === 'bad_key' || err.reason === 'bad_base_url') return badRequest(err.message, 'github_app_misconfigured');
    return new HttpError(502, 'github_api_error', err.message);
  }
  return new HttpError(502, 'github_api_error', 'GitHub API call failed');
}

/**
 * The repository behind the service's URL, resolved through the
 * installation: the URL must be on the App's host (a token is never minted
 * for another host), and the installation must be able to see it. A given
 * `repoId` must be that repository's id.
 */
async function resolveRepo(
  db: DB,
  ghApp: GithubApp,
  inst: GithubAppInstallation,
  repoUrl: string | null,
  repoId?: number,
): Promise<{ id: number; fullName: string }> {
  if (!repoUrl) throw badRequest('The service has no repository URL to link', 'github_repo_url_invalid');
  try {
    const { owner, repo, fullName } = githubRepoFromUrl(repoUrl, ghApp.webBaseUrl);
    const token = await installationToken(db, ghApp, inst, { permissions: { metadata: 'read' } });
    let res: Awaited<ReturnType<typeof githubApi<{ id?: unknown; full_name?: unknown }>>>;
    try {
      res = await githubApi<{ id?: unknown; full_name?: unknown }>(
        ghApp,
        token,
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      );
    } catch (err) {
      if (err instanceof GithubAppError && err.status === 404) {
        throw new GithubAppError(
          `The GitHub App installation on ${inst.accountLogin ?? `installation ${inst.installationId}`} cannot see ${fullName}: add it to the installation's selected repositories`,
          'not_accessible',
          404,
        );
      }
      throw err;
    }
    const id = res.data?.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new GithubAppError(`GitHub returned no repository id for ${fullName}`, 'http', res.status);
    }
    if (repoId !== undefined && repoId !== id) {
      throw badRequest(`repoId ${repoId} is not the id of ${fullName} (${id})`, 'github_repo_id_mismatch');
    }
    return { id, fullName: typeof res.data.full_name === 'string' ? res.data.full_name : fullName };
  } catch (err) {
    throw githubFailure(err);
  }
}

/** The watch paths of the webhook that deploys the service's branch, so a migration keeps its filter. */
async function webhookWatchPaths(db: DB, svc: Service): Promise<string | null> {
  const rows = await db.query.webhooks.findMany({ where: and(eq(webhooks.serviceId, svc.id), eq(webhooks.active, true)) });
  const match = rows.find((w) => w.branch === svc.branch && w.watchPaths?.trim());
  return match?.watchPaths?.trim() || null;
}

async function insertLink(db: DB, values: typeof serviceGithubLinks.$inferInsert): Promise<ServiceGithubLink> {
  try {
    const [row] = await db.insert(serviceGithubLinks).values(values).returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('This service is already linked; change the link with PUT');
    throw err;
  }
}

export const serviceGithubRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/github', async (req) => {
    const svc = await loadService(app.db, req, 'viewer');
    const found = await loadLink(app.db, svc.id);
    return { link: found ? serializeLink(found.link, found.inst) : null };
  });

  app.put('/:id/github', async (req) => {
    const svc = await loadService(app.db, req, 'operator');
    const input = serviceGithubLinkPut.parse(req.body ?? {});
    refuseOnPreview(svc);
    const { ghApp, inst } = await installationForSource(app.db, input.sourceId);
    const repo = await resolveRepo(app.db, ghApp, inst, svc.repoUrl, input.repoId);
    const existing = await app.db.query.serviceGithubLinks.findFirst({ where: eq(serviceGithubLinks.serviceId, svc.id) });
    const watchPaths = input.watchPaths === undefined ? undefined : input.watchPaths?.trim() || null;
    let link: ServiceGithubLink;
    if (existing) {
      const [row] = await app.db
        .update(serviceGithubLinks)
        .set({
          installationRowId: inst.id,
          repoId: repo.id,
          repoFullName: repo.fullName,
          ...(input.tokenScope !== undefined ? { tokenScope: input.tokenScope } : {}),
          ...(watchPaths !== undefined ? { watchPaths } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          updatedAt: new Date(),
        })
        .where(eq(serviceGithubLinks.id, existing.id))
        .returning();
      link = row!;
    } else {
      link = await insertLink(app.db, {
        serviceId: svc.id,
        installationRowId: inst.id,
        repoId: repo.id,
        repoFullName: repo.fullName,
        tokenScope: input.tokenScope ?? 'repository',
        watchPaths: watchPaths ?? null,
        enabled: input.enabled ?? true,
      });
    }
    await audit(app.db, req.user!.id, 'service.github_link', svc.name, {
      serviceId: svc.id,
      githubAppId: ghApp.id,
      installationRowId: inst.id,
      repoId: repo.id,
      repoFullName: repo.fullName,
      tokenScope: link.tokenScope,
      enabled: link.enabled,
      created: !existing,
    });
    return { link: serializeLink(link, inst) };
  });

  app.patch('/:id/github/feedback', async (req) => {
    const svc = await loadService(app.db, req, 'admin');
    const input = serviceGithubFeedbackPatch.parse(req.body ?? {});
    const { link, inst } = await requireLink(app.db, svc.id);
    const [row] = await app.db
      .update(serviceGithubLinks)
      .set({
        ...(input.reportStatus !== undefined ? { reportStatus: input.reportStatus } : {}),
        ...(input.prComment !== undefined ? { prComment: input.prComment } : {}),
        updatedAt: new Date(),
      })
      .where(eq(serviceGithubLinks.id, link.id))
      .returning();
    await audit(app.db, req.user!.id, 'service.github_link', svc.name, {
      serviceId: svc.id,
      change: 'feedback',
      reportStatus: row!.reportStatus,
      prComment: row!.prComment,
    });
    return { link: serializeLink(row!, inst) };
  });

  /**
   * Move a PAT/webhook service onto the App without cutting anything off:
   * the link drives deploys (the per-service webhook is skipped while the
   * installation is live), and the old source and webhook stay as they are,
   * so a suspended installation — or a revert — falls straight back to them.
   */
  app.post('/:id/github/migrate', async (req) => {
    const svc = await loadService(app.db, req, 'operator');
    const input = serviceGithubMigrate.parse(req.body ?? {});
    refuseOnPreview(svc);
    if (await loadLink(app.db, svc.id)) throw conflict('This service is already linked to a GitHub App installation');
    if (svc.sourceId === input.sourceId) throw badRequest('The service already uses this source', 'github_already_on_source');
    if (svc.sourceId != null) {
      const current = await app.db.query.sources.findFirst({ where: eq(sources.id, svc.sourceId) });
      if (current?.type === 'registry') {
        throw badRequest('The service is attached to a registry credential, not a git source', 'github_migrate_registry_source');
      }
    }
    const { ghApp, inst } = await installationForSource(app.db, input.sourceId);
    const repo = await resolveRepo(app.db, ghApp, inst, svc.repoUrl);
    const link = await insertLink(app.db, {
      serviceId: svc.id,
      installationRowId: inst.id,
      repoId: repo.id,
      repoFullName: repo.fullName,
      watchPaths: await webhookWatchPaths(app.db, svc),
      enabled: true,
      previousSourceId: svc.sourceId ?? null,
    });
    await audit(app.db, req.user!.id, 'service.github_migrate', svc.name, {
      serviceId: svc.id,
      githubAppId: ghApp.id,
      installationRowId: inst.id,
      sourceId: input.sourceId,
      previousSourceId: svc.sourceId ?? null,
      repoId: repo.id,
      repoFullName: repo.fullName,
    });
    return { link: serializeLink(link, inst) };
  });

  /** Make the move permanent: the service's source becomes the App source and its webhooks stop. */
  app.post('/:id/github/finalize', async (req) => {
    const svc = await loadService(app.db, req, 'operator');
    const { link, inst } = await requireLink(app.db, svc.id);
    if (!link.enabled || inst.suspendedAt || inst.removedAt) {
      throw conflict('Finalizing needs an enabled link on a live installation; deploys would otherwise stop');
    }
    const sourceId = inst.sourceId ?? null;
    if (svc.sourceId !== sourceId) await app.db.update(services).set({ sourceId }).where(eq(services.id, svc.id));
    const deactivated = await app.db
      .update(webhooks)
      .set({ active: false })
      .where(and(eq(webhooks.serviceId, svc.id), eq(webhooks.active, true)))
      .returning({ id: webhooks.id });
    await audit(app.db, req.user!.id, 'service.github_finalize', svc.name, {
      serviceId: svc.id,
      installationRowId: inst.id,
      detachedSourceId: svc.sourceId !== sourceId ? (svc.sourceId ?? null) : null,
      sourceId,
      previousSourceId: link.previousSourceId ?? null,
      webhooksDeactivated: deactivated.length,
    });
    return { link: serializeLink(link, inst), webhooksDeactivated: deactivated.length };
  });

  /**
   * Revert: the source the service had before migrating comes back, every
   * deactivated webhook is switched on again, and the link is removed.
   */
  app.delete('/:id/github', async (req) => {
    const svc = await loadService(app.db, req, 'operator');
    const { link, inst } = await requireLink(app.db, svc.id);
    const restoreTo = link.previousSourceId ?? svc.sourceId ?? null;
    // Cloning through this same installation's source would re-create the
    // link on the next deploy, so unlinking would not stick.
    if (restoreTo != null && restoreTo === inst.sourceId) {
      throw conflict(
        'This service clones through the GitHub App source itself; attach another source first, or disable the link instead (PUT with enabled: false)',
      );
    }
    if (svc.sourceId !== restoreTo) await app.db.update(services).set({ sourceId: restoreTo }).where(eq(services.id, svc.id));
    const reactivated = await app.db
      .update(webhooks)
      .set({ active: true })
      .where(and(eq(webhooks.serviceId, svc.id), eq(webhooks.active, false)))
      .returning({ id: webhooks.id });
    await app.db.delete(serviceGithubLinks).where(eq(serviceGithubLinks.id, link.id));
    await audit(app.db, req.user!.id, 'service.github_unlink', svc.name, {
      serviceId: svc.id,
      installationRowId: inst.id,
      repoId: link.repoId,
      repoFullName: link.repoFullName,
      restoredSourceId: svc.sourceId !== restoreTo ? restoreTo : null,
      webhooksReactivated: reactivated.length,
    });
    return { ok: true, sourceId: restoreTo, webhooksReactivated: reactivated.length };
  });
};
