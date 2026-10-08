import { eq } from 'drizzle-orm';
import {
  githubAppInstallations,
  githubApps,
  serviceGithubLinks,
  sources,
  type DB,
  type GithubApp,
  type GithubAppInstallation,
  type ServiceGithubLink,
} from '@ninedeploy/db';
import { audit } from './audit.js';
import { decrypt } from './crypto.js';
import type { CloneCreds } from './git.js';
import { GithubAppError, githubApi, installationToken, revokeInstallationToken } from './githubApp.js';

/**
 * Clone credentials for a service (0.13). Replaces the credential blocks the
 * deploy pipeline and the insights routes each carried.
 *
 * 1. An ENABLED `service_github_links` row on a live (not suspended, not
 *    removed) installation wins — the service's own, else, for a PR preview,
 *    its parent's.
 * 2. Otherwise a `github_app` source clones through its installation.
 * 3. Otherwise the attached source's token / deploy key, exactly as before:
 *    `{ type, token, deployKey }` with `undefined` for a missing secret, and
 *    `undefined` with no source (or a deleted one).
 *
 * An App path returns `{ type: 'github_app', token }`: a `contents: read`
 * installation token scoped to the one repository (the whole installation
 * only when the link's `token_scope` is `installation`). `checkoutCommit`
 * sends it as `x-access-token:<token>@`, which is what GitHub expects.
 */
export interface CloneCredsTarget {
  /** Absent for a pre-deploy analysis (no service yet): no link is read or written. */
  id?: number | null;
  name?: string | null;
  sourceId?: number | null;
  repoUrl?: string | null;
  previewParentServiceId?: number | null;
}

/**
 * 0.13 (T5): `perJob` mints a token for ONE remote-node job — never from or
 * into the token cache (it is revoked when the job ends, see
 * `revokeInstallationToken`), and always scoped to the one repository: the
 * node clones no submodules, so the `installation` token scope buys nothing
 * there. The App path then also returns `revoke`. Without it, the output is
 * exactly what it was.
 */
export interface CloneCredsOptions {
  perJob?: boolean;
}

/** {@link resolveCloneCreds}' answer; `revoke` is set only for a `perJob` App token. */
export type ResolvedCloneCreds = CloneCreds & { revoke?: () => Promise<boolean> };

const CLONE_PERMISSIONS = { contents: 'read' } as const;
const LOOKUP_PERMISSIONS = { metadata: 'read' } as const;

/** The hint the deploy log prints when a GitHub App clone (or its token) fails. */
export function githubAppCloneHint(): string {
  return 'hint: cloning used a GitHub App installation token. Check that this repository is among the installation’s selected repositories (GitHub → Settings → Installed GitHub Apps → Configure → Repository access) and that the installation is neither suspended nor uninstalled (System → Sources). If a SUBMODULE in another repository failed, set the service’s GitHub token scope to "installation" (Service → Settings → GitHub) so the token covers the installation’s other repositories.';
}

function isSshUrl(url: string): boolean {
  return url.startsWith('git@') || url.startsWith('ssh://') || url.startsWith('ssh+git://');
}

/**
 * `owner/repo` of a clone URL on the App's GitHub host. Refuses any other
 * host (the token would be sent there by git), a different scheme, embedded
 * credentials and SSH URLs (an installation token is an HTTPS credential).
 */
export function githubRepoFromUrl(repoUrl: string, webBaseUrl: string): { owner: string; repo: string; fullName: string } {
  const web = new URL(webBaseUrl);
  if (isSshUrl(repoUrl)) {
    const host = /^(?:ssh(?:\+git)?:\/\/)?(?:[^@/]+@)?([^:/]+)/.exec(repoUrl)?.[1] ?? 'an SSH host';
    if (host.toLowerCase() !== web.hostname.toLowerCase()) {
      throw new GithubAppError(`Refusing to send a GitHub App token to ${host}: the App belongs to ${web.host}`, 'host_mismatch');
    }
    throw new GithubAppError(
      `A GitHub App clones over HTTPS; change the repository URL to ${web.origin}/<owner>/<repo>.git`,
      'bad_repo_url',
    );
  }
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    throw new GithubAppError('The repository URL is not a valid URL', 'bad_repo_url');
  }
  if (url.host.toLowerCase() !== web.host.toLowerCase()) {
    throw new GithubAppError(`Refusing to send a GitHub App token to ${url.host || 'that URL'}: the App belongs to ${web.host}`, 'host_mismatch');
  }
  if (url.protocol !== web.protocol) {
    throw new GithubAppError(`Refusing to send a GitHub App token over ${url.protocol.replace(':', '')}: use ${web.protocol}//${web.host}`, 'host_mismatch');
  }
  if (url.username || url.password) {
    throw new GithubAppError('The repository URL carries credentials; remove them, the GitHub App supplies its own', 'bad_repo_url');
  }
  const parts = url.pathname
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .split('/');
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    throw new GithubAppError(`The repository URL is not ${web.origin}/<owner>/<repo>`, 'bad_repo_url');
  }
  return { owner, repo, fullName: `${owner}/${repo}` };
}

function assertLive(inst: GithubAppInstallation): void {
  const who = inst.accountLogin ?? `installation ${inst.installationId}`;
  if (inst.removedAt) {
    throw new GithubAppError(`The GitHub App installation on ${who} was removed. Reinstall the App and link the service again.`, 'removed');
  }
  if (inst.suspendedAt) {
    throw new GithubAppError(`The GitHub App installation on ${who} is suspended. Unsuspend it in GitHub before deploying.`, 'suspended');
  }
}

async function loadApp(db: DB, inst: GithubAppInstallation): Promise<GithubApp> {
  const app = await db.query.githubApps.findFirst({ where: eq(githubApps.id, inst.githubAppId) });
  if (!app) throw new GithubAppError(`The GitHub App for installation ${inst.installationId} no longer exists`, 'no_installation');
  return app;
}

/** Step 1: an enabled link on a live installation — the service's own, else the preview parent's. */
async function activeLink(
  db: DB,
  target: CloneCredsTarget,
): Promise<{ link: ServiceGithubLink; inst: GithubAppInstallation } | null> {
  const ids = [target.id, target.previewParentServiceId].filter((v): v is number => typeof v === 'number');
  for (const serviceId of ids) {
    const link = await db.query.serviceGithubLinks.findFirst({ where: eq(serviceGithubLinks.serviceId, serviceId) });
    if (!link?.enabled) continue;
    const inst = await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.id, link.installationRowId) });
    if (!inst || inst.suspendedAt || inst.removedAt) continue;
    return { link, inst };
  }
  return null;
}

async function mintCloneToken(
  db: DB,
  app: GithubApp,
  inst: GithubAppInstallation,
  repoId: number,
  tokenScope: ServiceGithubLink['tokenScope'],
  opts: CloneCredsOptions = {},
): Promise<ResolvedCloneCreds> {
  if (opts.perJob) {
    const token = await installationToken(db, app, inst, { repositoryIds: [repoId], permissions: CLONE_PERMISSIONS, fresh: true });
    return { type: 'github_app', token, revoke: () => revokeInstallationToken(app, token) };
  }
  const token = await installationToken(db, app, inst, {
    ...(tokenScope === 'installation' ? {} : { repositoryIds: [repoId] }),
    permissions: CLONE_PERMISSIONS,
  });
  return { type: 'github_app', token };
}

/** `GET /repos/{owner}/{repo}` with a metadata-only installation token → the repository id. */
async function lookupRepo(db: DB, app: GithubApp, inst: GithubAppInstallation, fullName: string, owner: string, repo: string) {
  const token = await installationToken(db, app, inst, { permissions: LOOKUP_PERMISSIONS });
  try {
    const res = await githubApi<{ id?: unknown; full_name?: unknown }>(
      app,
      token,
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    );
    const id = res.data?.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new GithubAppError(`GitHub returned no repository id for ${fullName}`, 'http', res.status);
    }
    return { id, fullName: typeof res.data.full_name === 'string' ? res.data.full_name : fullName };
  } catch (err) {
    if (err instanceof GithubAppError && err.status === 404) {
      const who = inst.accountLogin ?? `installation ${inst.installationId}`;
      throw new GithubAppError(
        `The GitHub App installation on ${who} cannot see ${fullName}: it is not among the installation's selected repositories, or it does not exist.`,
        'not_accessible',
        404,
      );
    }
    throw err;
  }
}

/** Step 2: a `github_app` source clones through its own installation. */
async function viaSourceInstallation(
  db: DB,
  target: CloneCredsTarget,
  sourceId: number,
  opts: CloneCredsOptions = {},
): Promise<ResolvedCloneCreds> {
  const inst = await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.sourceId, sourceId) });
  if (!inst) throw new GithubAppError(`Source #${sourceId} is a GitHub App source with no installation behind it`, 'no_installation');
  assertLive(inst);
  const app = await loadApp(db, inst);
  const { owner, repo, fullName } = githubRepoFromUrl(target.repoUrl ?? '', app.webBaseUrl);

  // The service's own link (a disabled one included) on this installation
  // still names the repository id and the token scope, when it is this repo.
  const own =
    typeof target.id === 'number'
      ? await db.query.serviceGithubLinks.findFirst({ where: eq(serviceGithubLinks.serviceId, target.id) })
      : undefined;
  if (own && own.installationRowId === inst.id && own.repoFullName.toLowerCase() === fullName.toLowerCase()) {
    return mintCloneToken(db, app, inst, own.repoId, own.tokenScope, opts);
  }

  const found = await lookupRepo(db, app, inst, fullName, owner, repo);
  // Remember the id for the next deploy (feedback off). Never for a PR
  // preview — it inherits its parent's link — and never over an existing link
  // (one per service).
  if (typeof target.id === 'number' && target.previewParentServiceId == null && !own) {
    try {
      const inserted = await db
        .insert(serviceGithubLinks)
        .values({
          serviceId: target.id,
          installationRowId: inst.id,
          repoId: found.id,
          repoFullName: found.fullName,
          reportStatus: false,
          prComment: false,
        })
        .onConflictDoNothing()
        .returning({ id: serviceGithubLinks.id });
      if (inserted.length > 0) {
        await audit(db, null, 'service.github_link', target.name ?? `service#${target.id}`, {
          serviceId: target.id,
          installationRowId: inst.id,
          repoId: found.id,
          repoFullName: found.fullName,
          lazy: true,
        });
      }
    } catch {
      /* best effort: the clone does not depend on the remembered link */
    }
  }
  return mintCloneToken(db, app, inst, found.id, 'repository', opts);
}

export async function resolveCloneCreds(
  db: DB,
  target: CloneCredsTarget,
  opts: CloneCredsOptions = {},
): Promise<ResolvedCloneCreds | undefined> {
  const linked = await activeLink(db, target);
  if (linked) {
    const app = await loadApp(db, linked.inst);
    githubRepoFromUrl(target.repoUrl ?? '', app.webBaseUrl); // host check before any token is minted
    return mintCloneToken(db, app, linked.inst, linked.link.repoId, linked.link.tokenScope, opts);
  }
  if (!target.sourceId) return undefined;
  const src = await db.query.sources.findFirst({ where: eq(sources.id, target.sourceId) });
  if (!src) return undefined;
  if (src.type === 'github_app') return viaSourceInstallation(db, target, target.sourceId, opts);
  return {
    type: src.type,
    token: src.tokenEncrypted ? decrypt(src.tokenEncrypted) : undefined,
    deployKey: src.deployKeyEncrypted ? decrypt(src.deployKeyEncrypted) : undefined,
  };
}
