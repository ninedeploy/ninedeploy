import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import {
  githubAppInstallations,
  githubApps,
  serviceGithubLinks,
  services,
  type DB,
  type GithubApp,
  type GithubAppInstallation,
  type Service,
  type ServiceGithubLink,
} from '@ninedeploy/db';
import { githubRepoFullName } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { decrypt } from '../lib/crypto.js';
import { HttpError, notFound, unauthorized } from '../lib/errors.js';
import { clearGithubAppCaches } from '../lib/githubApp.js';
import { githubRepoFromUrl } from '../lib/sourceCreds.js';
import { handlePullRequest, handlePush, repositoryIdentity, type DispatchResult } from '../lib/webhookDispatch.js';
import { isPing, isReplayedDelivery, parsePullRequest, parsePush, verifyWebhook } from '../lib/webhooks.js';
import { upsertInstallation, withInstallationSyncLock, type GithubInstallationPayload } from './githubApps.js';

/**
 * GitHub App webhook receiver (0.13): `POST /v1/hooks/github-app/:hookKey`,
 * one endpoint per registered App (its manifest points `hook_attributes.url`
 * here). Public like `/v1/hooks/:id`; the HMAC over the body, made with the
 * App's webhook secret, is the credential.
 *
 * Deliveries route by GitHub's numeric repository id through
 * `service_github_links` — never by URL — so a renamed or transferred
 * repository keeps deploying, and the clone URL is corrected (audited as
 * `service.repo_renamed`). Pushes and pull requests then go through the same
 * gates and the same preview lifecycle as the per-service receiver
 * (`lib/webhookDispatch.ts`). A service the App drives skips its per-service
 * deliveries (`modules/hooks.ts`), so one push never deploys twice.
 */

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const posInt = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null);

/** A string→string map from GitHub's JSON (installation permissions); anything else dropped. */
function stringMap(value: unknown): Record<string, string> | null {
  const o = obj(value);
  if (!o) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** Bounded `{id, fullName}` list of an `installation_repositories` payload field. */
function repoList(value: unknown): Array<{ id: number; fullName: string | null }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ id: number; fullName: string | null }> = [];
  for (const item of value.slice(0, 100)) {
    const id = posInt(obj(item)?.['id']);
    if (id) out.push({ id, fullName: str(obj(item)?.['full_name'])?.slice(0, 200) ?? null });
  }
  return out;
}

const who = (inst: Pick<GithubAppInstallation, 'accountLogin' | 'installationId'>) =>
  inst.accountLogin ?? `installation#${inst.installationId}`;

// ── installation lifecycle ─────────────────────────────────────────────────

async function installationEvent(db: DB, ghApp: GithubApp, body: Json, known: GithubAppInstallation | undefined): Promise<DispatchResult> {
  const action = str(body['action']);
  const item = obj(body['installation']) ?? {};
  const meta = (inst: GithubAppInstallation) => ({
    installationRowId: inst.id,
    installationId: inst.installationId,
    githubAppId: ghApp.id,
    detectedBy: 'webhook',
  });

  if (action === 'created') {
    const upserted = await withInstallationSyncLock(ghApp.id, () =>
      upsertInstallation(db, ghApp, item as GithubInstallationPayload),
    );
    if (!upserted) return { ok: 'ignored', reason: 'invalid_installation' };
    await audit(db, null, 'github_installation.created', who(upserted.inst), {
      ...meta(upserted.inst),
      sourceId: upserted.inst.sourceId,
      sourceCreated: upserted.sourceCreated,
    });
    return { ok: true, action: 'installation_created', installationRowId: upserted.inst.id, sourceId: upserted.inst.sourceId };
  }

  // Every other installation event names a row we already know.
  if (!known) return { ok: 'ignored', reason: 'unknown_installation' };
  const now = new Date();

  if (action === 'deleted') {
    const changed = await db
      .update(githubAppInstallations)
      .set({ removedAt: now })
      .where(and(eq(githubAppInstallations.id, known.id), isNull(githubAppInstallations.removedAt)))
      .returning({ id: githubAppInstallations.id });
    clearGithubAppCaches();
    if (changed.length > 0) await audit(db, null, 'github_installation.removed', who(known), meta(known));
    return { ok: true, action: 'installation_removed', installationRowId: known.id };
  }

  if (action === 'suspend') {
    const at = str(item['suspended_at']);
    const parsed = at ? new Date(at) : now;
    const changed = await db
      .update(githubAppInstallations)
      .set({ suspendedAt: Number.isNaN(parsed.getTime()) ? now : parsed })
      .where(and(eq(githubAppInstallations.id, known.id), isNull(githubAppInstallations.suspendedAt)))
      .returning({ id: githubAppInstallations.id });
    clearGithubAppCaches();
    if (changed.length > 0) await audit(db, null, 'github_installation.suspended', who(known), meta(known));
    return { ok: true, action: 'installation_suspended', installationRowId: known.id };
  }

  if (action === 'unsuspend') {
    if (known.suspendedAt) {
      await db.update(githubAppInstallations).set({ suspendedAt: null }).where(eq(githubAppInstallations.id, known.id));
      await audit(db, null, 'github_installation.unsuspended', who(known), meta(known));
    }
    return { ok: true, action: 'installation_unsuspended', installationRowId: known.id };
  }

  if (action === 'new_permissions_accepted') {
    const permissions = stringMap(item['permissions']);
    if (permissions) {
      await db.update(githubAppInstallations).set({ permissions }).where(eq(githubAppInstallations.id, known.id));
      clearGithubAppCaches();
      await audit(db, null, 'github_installation.permissions_updated', who(known), {
        ...meta(known),
        permissions: Object.keys(permissions).sort(),
      });
    }
    return { ok: true, action: 'installation_permissions_updated', installationRowId: known.id };
  }

  return { ok: 'ignored', reason: 'installation_action_not_handled' };
}

/** `installation_repositories.added|removed`: record which linked services are affected. */
async function repositoriesEvent(db: DB, ghApp: GithubApp, body: Json, inst: GithubAppInstallation): Promise<DispatchResult> {
  const added = repoList(body['repositories_added']);
  const removed = repoList(body['repositories_removed']);
  const ids = [...new Set([...added, ...removed].map((r) => r.id))];
  const links = ids.length
    ? await db.query.serviceGithubLinks.findMany({
        where: and(eq(serviceGithubLinks.installationRowId, inst.id), inArray(serviceGithubLinks.repoId, ids)),
      })
    : [];
  const removedIds = new Set(removed.map((r) => r.id));
  const selection = body['repository_selection'];
  if ((selection === 'all' || selection === 'selected') && selection !== inst.repositorySelection) {
    await db.update(githubAppInstallations).set({ repositorySelection: selection }).where(eq(githubAppInstallations.id, inst.id));
  }
  await audit(db, null, 'github.repos_changed', who(inst), {
    installationRowId: inst.id,
    installationId: inst.installationId,
    githubAppId: ghApp.id,
    action: str(body['action']),
    added,
    removed,
    affectedServiceIds: links.map((l) => l.serviceId),
    // These services can no longer clone through the App until the repository is re-added.
    lostAccessServiceIds: links.filter((l) => removedIds.has(l.repoId)).map((l) => l.serviceId),
  });
  return { ok: true, action: 'repositories_changed', affectedServiceIds: links.map((l) => l.serviceId) };
}

// ── repository routing ─────────────────────────────────────────────────────

/**
 * GitHub kept the repository id but its clone URL changed (rename or
 * transfer): point the service at the new URL. Only when both the old and the
 * new URL are on the App's own host — nothing here can move a service to
 * another git host. git refuses the 301 GitHub serves for the old name
 * (`http.followRedirects=false`), so without this a rename stops every deploy.
 */
async function followRename(db: DB, ghApp: GithubApp, link: ServiceGithubLink, svc: Service, repo: Json): Promise<Service> {
  const cloneUrl = str(repo['clone_url']);
  if (!cloneUrl || !svc.repoUrl) return svc;
  let next: ReturnType<typeof githubRepoFromUrl>;
  try {
    githubRepoFromUrl(svc.repoUrl, ghApp.webBaseUrl);
    next = githubRepoFromUrl(cloneUrl, ghApp.webBaseUrl);
  } catch {
    return svc;
  }
  const reported = str(repo['full_name']);
  const fullName = reported && githubRepoFullName.safeParse(reported).success ? reported : next.fullName;
  const urlChanged = repositoryIdentity(svc.repoUrl) !== repositoryIdentity(cloneUrl);
  const nameChanged = link.repoFullName !== fullName;
  if (!urlChanged && !nameChanged) return svc;
  if (nameChanged) {
    await db
      .update(serviceGithubLinks)
      .set({ repoFullName: fullName, updatedAt: new Date() })
      .where(eq(serviceGithubLinks.id, link.id));
  }
  if (!urlChanged) return svc;
  const [updated] = await db.update(services).set({ repoUrl: cloneUrl }).where(eq(services.id, svc.id)).returning();
  await audit(db, null, 'service.repo_renamed', svc.name, {
    serviceId: svc.id,
    repoId: link.repoId,
    from: svc.repoUrl,
    to: cloneUrl,
    repoFullName: fullName,
  });
  return updated ?? { ...svc, repoUrl: cloneUrl };
}

/** Run one service's dispatch; an authorization refusal answers for that service only. */
async function perService(serviceId: number, run: () => Promise<DispatchResult>): Promise<DispatchResult> {
  try {
    return { serviceId, ...(await run()) };
  } catch (err) {
    if (err instanceof HttpError && err.statusCode < 500) return { serviceId, ok: 'refused', reason: err.message };
    throw err;
  }
}

async function routeRepositoryEvent(
  db: DB,
  log: FastifyBaseLogger,
  ghApp: GithubApp,
  inst: GithubAppInstallation,
  event: 'push' | 'pull_request',
  body: Json,
  headers: Record<string, string | string[] | undefined>,
): Promise<DispatchResult> {
  const repo = obj(body['repository']);
  const repoId = posInt(repo?.['id']);
  if (!repo || !repoId) return { ok: 'ignored', reason: 'no_repository' };

  if (event === 'pull_request') {
    // A fork's head is code from outside the repository; previews inherit the
    // parent's environment. Compared by id: a URL can be made to look alike.
    const headRepoId = posInt(obj(obj(obj(body['pull_request'])?.['head'])?.['repo'])?.['id']);
    if (headRepoId !== repoId) return { ok: 'skipped', reason: 'external_pr_repository' };
  }

  const links = await db.query.serviceGithubLinks.findMany({
    where: and(
      eq(serviceGithubLinks.installationRowId, inst.id),
      eq(serviceGithubLinks.repoId, repoId),
      eq(serviceGithubLinks.enabled, true),
    ),
  });
  if (links.length === 0) return { ok: 'ignored', reason: 'no_linked_service' };

  const push = event === 'push' ? parsePush(body, 'github') : null;
  const pr = event === 'pull_request' ? parsePullRequest(body, 'github', headers) : null;
  if (event === 'push' && !push) return { ok: 'ignored', reason: 'not_a_push' };
  if (event === 'pull_request' && !pr) return { ok: 'ignored', reason: 'not_a_valid_pr' };

  const results: DispatchResult[] = [];
  for (const link of links.sort((a, b) => a.serviceId - b.serviceId)) {
    const found = await db.query.services.findFirst({ where: eq(services.id, link.serviceId) });
    // A preview never owns a link (it inherits its parent's).
    if (!found || found.isEphemeralPreview) continue;
    const svc = await followRename(db, ghApp, link, found, repo);
    if (push) {
      results.push(
        await perService(svc.id, () =>
          handlePush(db, svc.id, push, { branch: svc.branch, watchPaths: link.watchPaths, provider: 'github' }),
        ),
      );
    } else if (pr) {
      results.push(await perService(svc.id, () => handlePullRequest(db, svc, pr, 'github', log)));
    }
  }
  return { ok: true, event, results };
}

// ── route ──────────────────────────────────────────────────────────────────

/** Public GitHub App webhook receiver. Mounted under /hooks/github-app. */
export const githubAppHookRoutes: FastifyPluginAsync = async (app) => {
  // Public endpoint (auth bypassed, verified by HMAC). One App serves many
  // repositories, so its budget is twice a per-service hook's.
  app.post('/:hookKey', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const hookKey = String((req.params as { hookKey: string }).hookKey ?? '');
    const ghApp =
      hookKey.length > 0 && hookKey.length <= 128
        ? await app.db.query.githubApps.findFirst({ where: eq(githubApps.hookKey, hookKey) })
        : undefined;
    if (!ghApp) throw notFound('Unknown webhook');

    const rawBody = req.rawBody?.toString('utf8') ?? '';
    // The App's deliveries are GitHub's by construction: any other provider
    // shape is refused even if a secret happened to match.
    if (verifyWebhook(req.headers, rawBody, decrypt(ghApp.webhookSecretEncrypted)) !== 'github') {
      throw unauthorized('Invalid webhook signature');
    }
    if (isPing(req.headers, 'github')) return { ok: 'pong' };

    // Same replay window as the per-service hook, scoped to this App.
    if (isReplayedDelivery(req.headers, 'github', { rawBody, scope: `app:${ghApp.id}` })) {
      return { ok: 'ignored', reason: 'replayed_delivery' };
    }

    const event = typeof req.headers['x-github-event'] === 'string' ? req.headers['x-github-event'] : '';
    const body = obj(req.body);
    if (!body) return { ok: 'ignored', reason: 'empty_payload' };
    const installationId = posInt(obj(body['installation'])?.['id']);
    if (!installationId) return { ok: 'ignored', reason: 'no_installation' };
    // The installation must be one of THIS App's. An id we have not seen is
    // accepted only from `installation.created`; anything else is ignored.
    const inst = await app.db.query.githubAppInstallations.findFirst({
      where: and(eq(githubAppInstallations.githubAppId, ghApp.id), eq(githubAppInstallations.installationId, installationId)),
    });

    if (event === 'installation') {
      const appId = obj(body['installation'])?.['app_id'];
      if (appId !== undefined && appId !== ghApp.appId) return { ok: 'ignored', reason: 'foreign_installation' };
      return installationEvent(app.db, ghApp, body, inst);
    }
    if (!inst) return { ok: 'ignored', reason: 'unknown_installation' };
    if (event === 'installation_repositories') return repositoriesEvent(app.db, ghApp, body, inst);
    if (inst.removedAt || inst.suspendedAt) return { ok: 'ignored', reason: 'installation_inactive' };
    if (event === 'push' || event === 'pull_request') {
      return routeRepositoryEvent(app.db, req.log, ghApp, inst, event, body, req.headers);
    }
    return { ok: 'ignored', reason: 'event_not_handled', event: event.slice(0, 64) };
  });
};
