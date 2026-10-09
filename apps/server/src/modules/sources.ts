import { eq } from 'drizzle-orm';
import { audit } from '../lib/audit.js';
import { githubAppInstallations, githubApps, sources, users, type DB, type GithubApp, type GithubAppInstallation, type Source } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { createSource, sourcePatch } from '@ninedeploy/schemas';
import { decrypt, encrypt } from '../lib/crypto.js';
import { badRequest, HttpError, notFound, parseId } from '../lib/errors.js';
// Every outbound provider call below rides the egress SSRF guard like the
// rest of the panel's webhooks/API clients. The github/gitlab/bitbucket hosts
// are hardcoded; since 0.13 a Gitea base URL and a GitHub App's (GHES) API base
// are operator-supplied, so the guard (private addresses refused unless
// NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1) is what keeps them off the LAN.
import { guardedFetch, privateEgressAllowed } from '../lib/egressGuard.js';
import { apiBase, appJwt, GithubAppError, githubApi, installationToken } from '../lib/githubApp.js';
import { providerErrorText } from '../lib/redactSecret.js';
import { githubRepoFromUrl } from '../lib/sourceCreds.js';
import { ensureRegistryBindingsInitialised, setBoundRegistryHosts, type RegistryBindings } from '../lib/registryBinding.js';
import { assertStepUp } from '../lib/stepUp.js';

function serialize(s: Source, bindings: RegistryBindings) {
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    hasToken: !!s.tokenEncrypted,
    hasDeployKey: !!s.deployKeyEncrypted,
    registryUsername: s.registryUsername ?? null,
    // r512: where a registry credential may be sent (additive field).
    ...(s.type === 'registry' ? { registryHosts: bindings[String(s.id)] ?? [] } : {}),
    defaultBranch: s.defaultBranch,
    // 0.13: self-hosted provider base (Gitea); additive field, null when unset.
    baseUrl: s.baseUrl ?? null,
    // Multi-node (additive): this static credential may be sent to a node for one clone.
    allowOnNodes: !!s.allowOnNodes,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/**
 * F1007: the repository list read only the provider's first page (100 rows),
 * so an account with more repositories silently lost the rest in the Deploy
 * Wizard. Pages are now followed while the provider announces another one,
 * up to this cap (1000 repositories); a truncated or partly failed list says
 * so in `x-nd-source-error`. Page URLs are built here from the fixed API
 * endpoint (`&page=N`), never taken from the provider's response, so the
 * token is only ever sent to the hardcoded host.
 */
export const REPO_LIST_MAX_PAGES = 10;

interface RepoRow {
  name: string;
  fullName: string;
  url: string;
  defaultBranch: string;
  isPrivate: boolean;
  /** 0.13: GitHub's numeric repository id (GitHub App sources only). */
  repoId?: number;
}

/** A response header, tolerant of minimal Response stand-ins. */
function headerOf(res: Response, name: string): string | null {
  return typeof res.headers?.get === 'function' ? res.headers.get(name) : null;
}

/** RFC 8288 `Link` header announcing a next page (GitHub, GitLab). */
function linkHasNext(res: Response): boolean {
  return /<[^>]*>\s*;[^,]*\brel="?next"?/i.test(headerOf(res, 'link') ?? '');
}

/**
 * F1008: why a GitHub token cannot see private repositories, from its prefix
 * and the scopes GitHub reports in `x-oauth-scopes`. A classic token without
 * `repo` lists and clones public repositories only; a fine-grained token sees
 * only its selected repositories. Only the token's kind is returned — never
 * the token. Scopes are read for scope-based tokens (classic, OAuth); a
 * fine-grained token has permissions instead, so its header is ignored.
 */
type GithubTokenKind = 'classic' | 'fine-grained' | 'oauth' | 'unknown';

function githubTokenDiagnostics(token: string, res: Response): { tokenKind: GithubTokenKind; scopes?: string[]; warnings: string[] } {
  const t = token.trim();
  const header = headerOf(res, 'x-oauth-scopes');
  const tokenKind: GithubTokenKind = t.startsWith('github_pat_')
    ? 'fine-grained'
    : t.startsWith('ghp_')
      ? 'classic'
      : t.startsWith('gho_') || t.startsWith('ghu_')
        ? 'oauth'
        : header !== null
          ? 'classic' // un-prefixed legacy personal access token
          : 'unknown';
  if (tokenKind === 'fine-grained') {
    return {
      tokenKind,
      warnings: [
        "Fine-grained token: private repositories appear only if selected under Repository access, and cloning needs Contents: Read-only; organization repositories also need the organization's approval (and SSO authorization).",
      ],
    };
  }
  if (header === null || tokenKind === 'unknown') return { tokenKind, warnings: [] };
  const scopes = header
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const warnings = scopes.includes('repo')
    ? []
    : [`This ${tokenKind === 'oauth' ? 'OAuth' : 'classic'} token lacks the \`repo\` scope — private repositories are not listed and cannot be cloned.`];
  return { tokenKind, scopes, warnings };
}

async function listRepoPages(
  label: string,
  pageUrl: (page: number) => string,
  init: RequestInit,
  token: string,
  readPage: (res: Response) => Promise<{ rows: RepoRow[]; hasNext: boolean }>,
): Promise<{ rows: RepoRow[]; diag?: string }> {
  const rows: RepoRow[] = [];
  const partial = (page: number) => (page > 1 ? ` on page ${page}; showing the first ${rows.length} repositories` : '');
  for (let page = 1; page <= REPO_LIST_MAX_PAGES; page++) {
    try {
      const res = await guardedFetch(pageUrl(page), init);
      // Surface the real failure to admins — "empty list" silently looked
      // like "no repos" and a stale PAT was the most common operator trap.
      if (!res.ok) return { rows, diag: `${label} API ${res.status}${partial(page)}` };
      const { rows: got, hasNext } = await readPage(res);
      rows.push(...got);
      if (!hasNext || got.length === 0) return { rows };
    } catch (err) {
      return { rows, diag: `${label} API unreachable: ${providerErrorText(err, token)}${partial(page)}` };
    }
  }
  return {
    rows,
    diag: `${label}: showing the first ${rows.length} repositories (list capped at ${REPO_LIST_MAX_PAGES} pages); paste the URL of any other repository`,
  };
}

// ── 0.13: Gitea base URL and GitHub App sources ────────────────────────────

const INSECURE_BASE_URL = 'must use https (http is allowed only with NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1)';

/**
 * A `baseUrl` on create/patch: Gitea sources only, https unless private
 * egress is allowed. These hosts are operator-supplied, so every call to
 * them also rides `guardedFetch` (which refuses private addresses unless
 * NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1).
 */
function assertBaseUrlAllowed(type: string, baseUrl: string): void {
  if (type !== 'gitea') throw badRequest('baseUrl applies to gitea sources only', 'base_url_unsupported');
  if (!baseUrl.startsWith('https:') && !(baseUrl.startsWith('http:') && privateEgressAllowed())) {
    throw badRequest(`baseUrl ${INSECURE_BASE_URL}`, 'insecure_base_url');
  }
}

/** A Gitea source's API root, re-checked at use time (the egress setting may have changed since it was saved). */
function giteaBase(src: Pick<Source, 'baseUrl'>, missing: string): { base: string } | { error: string } {
  if (!src.baseUrl) return { error: missing };
  let url: URL;
  try {
    url = new URL(src.baseUrl);
  } catch {
    return { error: 'The Gitea base URL is not a valid URL' };
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateEgressAllowed())) {
    return { error: `The Gitea base URL ${INSECURE_BASE_URL}` };
  }
  return { base: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

/** `owner/repo` from a full name or a clone URL under `base`, or null when it is neither. */
function repoFullName(repo: string, base: string): string | null {
  const trimmed = repo.startsWith(`${base}/`) ? repo.slice(base.length + 1) : repo;
  const clean = trimmed.replace(/\.git$/, '');
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(clean) && !clean.split('/').some((p) => p === '.' || p === '..') ? clean : null;
}

const encodeRepo = (fullName: string) => fullName.split('/').map(encodeURIComponent).join('/');

/** The installation behind a `github_app` source, and its App. */
async function sourceInstallation(
  db: DB,
  sourceId: number,
  opts: { requireLive: boolean },
): Promise<{ ghApp: GithubApp; inst: GithubAppInstallation } | { error: string }> {
  const inst = await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.sourceId, sourceId) });
  if (!inst) return { error: 'GitHub App: no installation is behind this source (was the App removed?); sync the App installations under Sources' };
  const who = inst.accountLogin ?? `installation ${inst.installationId}`;
  if (opts.requireLive && inst.removedAt) return { error: `GitHub App: the installation on ${who} was removed; reinstall the App and sync` };
  if (opts.requireLive && inst.suspendedAt) return { error: `GitHub App: the installation on ${who} is suspended; unsuspend it on GitHub` };
  const ghApp = await db.query.githubApps.findFirst({ where: eq(githubApps.id, inst.githubAppId) });
  if (!ghApp) return { error: `GitHub App: the App for installation ${inst.installationId} no longer exists` };
  return { ghApp, inst };
}

/** A GitHub App failure as text. `GithubAppError` messages are already redacted. */
function githubAppErrorText(err: unknown, secrets: readonly string[] = []): string {
  let text = err instanceof Error ? err.message : String(err);
  for (const secret of secrets) if (secret) text = providerErrorText(text, secret);
  return text;
}

/** Source (private-repo credential) management. Mounted under /sources. Admin-only. */
export const sourcesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  // System-wide credentials — admin-only under the agreed RBAC model.
  app.addHook('preHandler', app.requireAdmin);
  // F569: the diagnostic header is built from the caller's `repo` and from
  // thrown messages — a CR/LF or a character above U+00FF made Node refuse it
  // and turned the documented fallback into a 500.
  app.addHook('onSend', async (_req, reply, payload) => {
    const diag = reply.getHeader('x-nd-source-error');
    if (typeof diag === 'string') reply.header('x-nd-source-error', diag.replace(/[^\x20-\x7e]/g, '?'));
    return payload;
  });

  app.get('/', async () => {
    const rows = await app.db.query.sources.findMany({ orderBy: (s, { desc }) => [desc(s.id)] });
    const bindings = await ensureRegistryBindingsInitialised(app.db);
    return rows.map((s) => serialize(s, bindings));
  });

  app.post('/', async (req) => {
    const input = createSource.parse(req.body);
    if (input.baseUrl !== undefined) assertBaseUrlAllowed(input.type, input.baseUrl);
    const [created] = await app.db
      .insert(sources)
      .values({
        name: input.name,
        type: input.type,
        tokenEncrypted: input.token ? encrypt(input.token) : null,
        deployKeyEncrypted: input.deployKey ? encrypt(input.deployKey) : null,
        registryUsername: input.registryUsername ?? null,
        defaultBranch: input.defaultBranch ?? 'main',
        baseUrl: input.baseUrl ?? null,
      })
      .returning();
    // r512: always (re)write the binding — an id SQLite reuses after a
    // delete must not inherit a previous credential's hosts.
    if (created!.type === 'registry') await setBoundRegistryHosts(app.db, created!.id, input.registryHosts ?? []);
    void audit(app.db, req.user!.id, 'source.create', input.name);
    return serialize(created!, await ensureRegistryBindingsInitialised(app.db));
  });

  app.patch('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const input = sourcePatch.parse(req.body ?? {});
    const patch: Partial<Source> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.defaultBranch !== undefined) patch.defaultBranch = input.defaultBranch;
    if (input.token !== undefined) patch.tokenEncrypted = input.token ? encrypt(input.token) : null;
    if (input.deployKey !== undefined) patch.deployKeyEncrypted = input.deployKey ? encrypt(input.deployKey) : null;
    if (input.registryUsername !== undefined) patch.registryUsername = input.registryUsername || null;
    if (input.baseUrl !== undefined) {
      if (input.baseUrl !== null) {
        const current = await app.db.query.sources.findFirst({ where: eq(sources.id, id) });
        if (!current) throw notFound('Source not found');
        assertBaseUrlAllowed(current.type, input.baseUrl);
      }
      patch.baseUrl = input.baseUrl;
    }
    // Multi-node (design §3.2, owner decision O5): turning `allowOnNodes` on
    // sends this long-lived PAT or deploy key to a node for each clone there,
    // so it takes an interactive session and a password re-check (step-up),
    // like enabling host shells. Turning it off never does.
    let allowOnNodesBefore: boolean | undefined;
    if (input.allowOnNodes !== undefined) {
      const current = await app.db.query.sources.findFirst({ where: eq(sources.id, id) });
      if (!current) throw notFound('Source not found');
      allowOnNodesBefore = !!current.allowOnNodes;
      if (input.allowOnNodes && !allowOnNodesBefore) {
        if (current.type === 'registry' || current.type === 'github_app') {
          throw badRequest(
            current.type === 'registry'
              ? 'A registry credential is never used to clone a repository; nothing to allow on nodes'
              : 'A GitHub App reaches nodes as a short-lived per-job token already; nothing to allow',
            'allow_on_nodes_unsupported',
          );
        }
        const user = req.user!;
        if (user.viaApiToken) {
          throw new HttpError(403, 'forbidden', 'Allowing a credential on nodes requires an interactive session, not an API token');
        }
        const row = await app.db.query.users.findFirst({ where: eq(users.id, user.id) });
        if (!row) throw new HttpError(401, 'unauthorized', 'Unauthorized');
        await assertStepUp(app.db, req, row, input.password);
      }
      if (input.allowOnNodes !== allowOnNodesBefore) patch.allowOnNodes = input.allowOnNodes;
    }
    // A hosts-only PATCH (r512) changes no column — read the row instead of
    // issuing an empty UPDATE.
    const [updated] =
      Object.keys(patch).length > 0
        ? await app.db.update(sources).set(patch).where(eq(sources.id, id)).returning()
        : [await app.db.query.sources.findFirst({ where: eq(sources.id, id) })];
    if (!updated) throw notFound('Source not found');
    if (input.registryHosts !== undefined && updated.type === 'registry') {
      await setBoundRegistryHosts(app.db, id, input.registryHosts);
    }
    // Which credential fields changed — never their values.
    const changed = (['token', 'deployKey', 'registryUsername', 'registryHosts', 'name', 'defaultBranch', 'baseUrl'] as const).filter((k) => input[k] !== undefined);
    void audit(app.db, req.user!.id, 'source.update', `${updated.name}: ${changed.join(',') || 'no-op'}`);
    if (allowOnNodesBefore !== undefined && input.allowOnNodes !== allowOnNodesBefore) {
      void audit(app.db, req.user!.id, 'source.allow_on_nodes', updated.name, {
        sourceId: updated.id,
        previous: allowOnNodesBefore,
        allowOnNodes: input.allowOnNodes,
      }, { ip: req.ip, userAgent: req.headers['user-agent'] });
    }
    return serialize(updated, await ensureRegistryBindingsInitialised(app.db));
  });

  app.get('/:id/repos', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const src = await app.db.query.sources.findFirst({ where: eq(sources.id, id) });
    if (!src) throw notFound('Source not found');
    // F1007: page 1 keeps the exact URL it always used; later pages add `&page=N`.
    const paged = (base: string) => (page: number) => (page === 1 ? base : `${base}&page=${page}`);

    // 0.13: a GitHub App source has no token of its own; it lists what the
    // installation can see with a metadata-only installation token.
    if (src.type === 'github_app') {
      const ctx = await sourceInstallation(app.db, src.id, { requireLive: true });
      if ('error' in ctx) {
        reply.header('x-nd-source-error', ctx.error);
        return [];
      }
      let appToken: string;
      let base: string;
      try {
        base = apiBase(ctx.ghApp);
        appToken = await installationToken(app.db, ctx.ghApp, ctx.inst, { permissions: { metadata: 'read' } });
      } catch (err) {
        reply.header('x-nd-source-error', `GitHub App: ${githubAppErrorText(err)}`);
        return [];
      }
      const appListed = await listRepoPages(
        'GitHub App',
        paged(`${base}/installation/repositories?per_page=100`),
        {
          headers: {
            Authorization: `Bearer ${appToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'NineDeploy',
          },
        },
        appToken,
        async (res) => {
          const data = (await res.json()) as {
            repositories?: Array<{
              id: number;
              name: string;
              full_name: string;
              clone_url: string;
              default_branch: string;
              private: boolean;
            }>;
          };
          const rows = (Array.isArray(data?.repositories) ? data.repositories : []).map((r) => ({
            name: r.name,
            fullName: r.full_name,
            url: r.clone_url,
            defaultBranch: r.default_branch || 'main',
            isPrivate: r.private,
            repoId: r.id,
          }));
          return { rows, hasNext: linkHasNext(res) };
        },
      );
      if (appListed.diag) reply.header('x-nd-source-error', appListed.diag);
      return appListed.rows;
    }

    if (!src.tokenEncrypted) return [];

    const token = decrypt(src.tokenEncrypted);
    let listed: { rows: RepoRow[]; diag?: string } | null = null;
    // F1008: a classic token without `repo` lists public repositories only.
    let scopeDiag: string | undefined;
    if (src.type === 'github') {
      listed = await listRepoPages(
        'GitHub',
        paged('https://api.github.com/user/repos?per_page=100&sort=updated'),
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'NineDeploy',
          },
        },
        token,
        async (res) => {
          const data = (await res.json()) as Array<{
            name: string;
            full_name: string;
            clone_url: string;
            default_branch: string;
            private: boolean;
          }>;
          const rows = data.map((r) => ({
            name: r.name,
            fullName: r.full_name,
            url: r.clone_url,
            defaultBranch: r.default_branch || 'main',
            isPrivate: r.private,
          }));
          const diagnosis = githubTokenDiagnostics(token, res);
          if (diagnosis.scopes && !diagnosis.scopes.includes('repo')) {
            scopeDiag = `GitHub: this ${diagnosis.tokenKind === 'oauth' ? 'OAuth' : 'classic'} token lacks the repo scope, so private repositories are not listed`;
          }
          return { rows, hasNext: linkHasNext(res) };
        },
      );
    }

    if (src.type === 'gitlab') {
      listed = await listRepoPages(
        'GitLab',
        paged('https://gitlab.com/api/v4/projects?membership=true&per_page=100&order_by=updated_at'),
        { headers: { 'PRIVATE-TOKEN': token } },
        token,
        async (res) => {
          const data = (await res.json()) as Array<{
            name: string;
            path_with_namespace: string;
            http_url_to_repo: string;
            default_branch: string;
            visibility: string;
          }>;
          const rows = data.map((r) => ({
            name: r.name,
            fullName: r.path_with_namespace,
            url: r.http_url_to_repo,
            defaultBranch: r.default_branch || 'main',
            isPrivate: r.visibility !== 'public',
          }));
          return { rows, hasNext: !!headerOf(res, 'x-next-page')?.trim() || linkHasNext(res) };
        },
      );
    }

    if (src.type === 'bitbucket') {
      listed = await listRepoPages(
        'Bitbucket',
        paged('https://api.bitbucket.org/2.0/repositories?role=contributor&pagelen=100&sort=-updated_on'),
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': 'NineDeploy',
          },
        },
        token,
        async (res) => {
          const data = (await res.json()) as {
            next?: string;
            values?: Array<{
              name: string;
              full_name: string;
              is_private: boolean;
              mainbranch?: { name?: string };
              links?: { html?: { href?: string } };
            }>;
          };
          const rows = (data.values ?? []).map((r) => ({
            name: r.name,
            fullName: r.full_name,
            url: `https://bitbucket.org/${r.full_name}.git`,
            defaultBranch: r.mainbranch?.name || 'master',
            isPrivate: r.is_private,
          }));
          return { rows, hasNext: !!data.next };
        },
      );
    }

    if (src.type === 'gitea') {
      const gitea = giteaBase(src, "Gitea: set the source's base URL to list repositories");
      if ('error' in gitea) {
        reply.header('x-nd-source-error', gitea.error);
        return [];
      }
      listed = await listRepoPages(
        'Gitea',
        paged(`${gitea.base}/api/v1/user/repos?limit=50`),
        { headers: { Authorization: `token ${token}`, Accept: 'application/json', 'User-Agent': 'NineDeploy' } },
        token,
        async (res) => {
          const data = (await res.json()) as Array<{
            name: string;
            full_name: string;
            clone_url: string;
            default_branch: string;
            private: boolean;
          }>;
          const rows = (Array.isArray(data) ? data : []).map((r) => ({
            name: r.name,
            fullName: r.full_name,
            url: r.clone_url,
            defaultBranch: r.default_branch || 'main',
            isPrivate: r.private,
          }));
          return { rows, hasNext: linkHasNext(res) };
        },
      );
    }

    if (listed) {
      const diag = [listed.diag, scopeDiag].filter(Boolean).join('; ');
      if (diag) reply.header('x-nd-source-error', diag);
      return listed.rows;
    }

    return [];
  });

  app.get('/:id/branches', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const src = await app.db.query.sources.findFirst({ where: eq(sources.id, id) });
    // 0.13: a GitHub App source has no token of its own; branches come through the installation.
    if (src?.type === 'github_app') {
      const repo = (req.query as { repo?: string }).repo;
      if (!repo) return ['main', 'master'];
      const ctx = await sourceInstallation(app.db, src.id, { requireLive: true });
      if ('error' in ctx) {
        reply.header('x-nd-source-error', ctx.error);
        return ['main', 'master'];
      }
      let fullName = repoFullName(repo, ctx.ghApp.webBaseUrl.replace(/\/+$/, ''));
      if (!fullName) {
        try {
          fullName = githubRepoFromUrl(repo, ctx.ghApp.webBaseUrl).fullName;
        } catch (err) {
          reply.header('x-nd-source-error', `GitHub App: ${githubAppErrorText(err)}`);
          return ['main', 'master'];
        }
      }
      let appToken = '';
      try {
        appToken = await installationToken(app.db, ctx.ghApp, ctx.inst, { permissions: { contents: 'read' } });
        const res = await githubApi<Array<{ name: string }>>(ctx.ghApp, appToken, 'GET', `/repos/${encodeRepo(fullName)}/branches?per_page=100`);
        return (Array.isArray(res.data) ? res.data : []).map((b) => b.name);
      } catch (err) {
        reply.header(
          'x-nd-source-error',
          err instanceof GithubAppError && err.status
            ? `GitHub App API ${err.status} on ${fullName}`
            : `GitHub App: ${githubAppErrorText(err, [appToken])}`,
        );
        return ['main', 'master'];
      }
    }
    if (!src || !src.tokenEncrypted) return ['main', 'master'];
    const repo = (req.query as { repo?: string }).repo;
    if (!repo) return ['main', 'master'];

    const token = decrypt(src.tokenEncrypted);
    if (src.type === 'github') {
      try {
        // repo can be full_name "owner/repo" or clone_url
        const cleanRepo = repo.replace('https://github.com/', '').replace(/\.git$/, '');
        const res = await guardedFetch(`https://api.github.com/repos/${cleanRepo}/branches?per_page=100`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'NineDeploy',
          },
        });
        if (!res.ok) {
          // Same diagnosis surfacing as for /:id/repos: a `['main','master']`
          // fallback hid bad PATs, missing scopes, and 404s on renamed repos.
          reply.header('x-nd-source-error', `GitHub API ${res.status} on ${cleanRepo}`);
          return ['main', 'master'];
        }
        const data = (await res.json()) as Array<{ name: string }>;
        return data.map((b) => b.name);
      } catch (err) {
        reply.header('x-nd-source-error', `GitHub API unreachable: ${providerErrorText(err, token)}`);
        return ['main', 'master'];
      }
    }
    if (src.type === 'bitbucket') {
      try {
        // repo is full_name "workspace/repo" or a bitbucket.org clone URL.
        const cleanRepo = repo.replace(/^https:\/\/bitbucket\.org\//, '').replace(/\.git$/, '');
        const res = await guardedFetch(`https://api.bitbucket.org/2.0/repositories/${cleanRepo}/refs/branches?pagelen=100`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': 'NineDeploy',
          },
        });
        if (!res.ok) {
          reply.header('x-nd-source-error', `Bitbucket API ${res.status} on ${cleanRepo}`);
          return ['main', 'master'];
        }
        const data = (await res.json()) as { values?: Array<{ name: string }> };
        return (data.values ?? []).map((b) => b.name);
      } catch (err) {
        reply.header('x-nd-source-error', `Bitbucket API unreachable: ${providerErrorText(err, token)}`);
        return ['main', 'master'];
      }
    }
    if (src.type === 'gitea') {
      const gitea = giteaBase(src, "Gitea: set the source's base URL to list branches");
      if ('error' in gitea) {
        reply.header('x-nd-source-error', gitea.error);
        return ['main', 'master'];
      }
      const cleanRepo = repoFullName(repo, gitea.base);
      if (!cleanRepo) {
        reply.header('x-nd-source-error', `Gitea: expected owner/repo or a ${gitea.base} clone URL`);
        return ['main', 'master'];
      }
      try {
        const res = await guardedFetch(`${gitea.base}/api/v1/repos/${encodeRepo(cleanRepo)}/branches?limit=50`, {
          headers: { Authorization: `token ${token}`, Accept: 'application/json', 'User-Agent': 'NineDeploy' },
        });
        if (!res.ok) {
          reply.header('x-nd-source-error', `Gitea API ${res.status} on ${cleanRepo}`);
          return ['main', 'master'];
        }
        const data = (await res.json()) as Array<{ name: string }>;
        return (Array.isArray(data) ? data : []).map((b) => b.name);
      } catch (err) {
        reply.header('x-nd-source-error', `Gitea API unreachable: ${providerErrorText(err, token)}`);
        return ['main', 'master'];
      }
    }
    return ['main', 'master'];
  });

  /**
   * Validate that a source's credentials actually work — a CLI/UI sanity
   * check that says "this token can list my repos" without having to open
   * the DeployWizard. Hits the provider's user endpoint, never throws.
   */
  app.get('/:id/test', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const src = await app.db.query.sources.findFirst({ where: eq(sources.id, id) });
    if (!src) throw notFound('Source not found');
    // 0.13: a GitHub App source proves the App key (`GET /app`) and reads its installation.
    if (src.type === 'github_app') {
      const ctx = await sourceInstallation(app.db, src.id, { requireLive: false });
      if ('error' in ctx) return { ok: false, provider: 'github_app', error: ctx.error };
      let jwt = '';
      try {
        jwt = appJwt(ctx.ghApp);
        await githubApi(ctx.ghApp, jwt, 'GET', '/app');
        const res = await githubApi<{
          account?: { login?: string } | null;
          repository_selection?: string;
          permissions?: Record<string, string>;
          suspended_at?: string | null;
        }>(ctx.ghApp, jwt, 'GET', `/app/installations/${ctx.inst.installationId}`);
        const suspended = !!res.data?.suspended_at;
        return {
          ok: !suspended,
          provider: 'github_app',
          login: res.data?.account?.login ?? ctx.inst.accountLogin ?? null,
          repositorySelection: res.data?.repository_selection ?? ctx.inst.repositorySelection,
          permissions: res.data?.permissions ?? {},
          suspended,
          ...(suspended ? { error: 'The installation is suspended on GitHub' } : {}),
        };
      } catch (err) {
        return {
          ok: false,
          provider: 'github_app',
          ...(err instanceof GithubAppError && err.status ? { status: err.status } : {}),
          error: githubAppErrorText(err, [jwt]),
        };
      }
    }
    if (!src.tokenEncrypted) {
      return { ok: false, error: 'No token configured for this source' };
    }
    const token = decrypt(src.tokenEncrypted);
    try {
      if (src.type === 'github') {
        const res = await guardedFetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'NineDeploy',
          },
        });
        if (res.ok) {
          const data = (await res.json()) as { login: string; name?: string };
          // F1008: additive token diagnostics (kind, classic scopes, warnings).
          return { ok: true, provider: 'github', login: data.login, name: data.name ?? null, ...githubTokenDiagnostics(token, res) };
        }
        const body = await res.text().catch(() => '');
        return { ok: false, provider: 'github', status: res.status, error: body.slice(0, 240) };
      }
      if (src.type === 'gitlab') {
        const res = await guardedFetch('https://gitlab.com/api/v4/user', {
          headers: { 'PRIVATE-TOKEN': token },
        });
        if (res.ok) {
          const data = (await res.json()) as { username: string; name: string };
          return { ok: true, provider: 'gitlab', login: data.username, name: data.name };
        }
        const body = await res.text().catch(() => '');
        return { ok: false, provider: 'gitlab', status: res.status, error: body.slice(0, 240) };
      }
      if (src.type === 'bitbucket') {
        // Bearer auth works with Bitbucket Cloud API tokens and repository
        // access tokens; legacy app passwords need Basic auth with the
        // account username, which the sources table does not store.
        const res = await guardedFetch('https://api.bitbucket.org/2.0/user', {
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': 'NineDeploy',
          },
        });
        if (res.ok) {
          const data = (await res.json()) as { account_id: string; display_name?: string };
          return { ok: true, provider: 'bitbucket', login: data.account_id, name: data.display_name ?? null };
        }
        const body = await res.text().catch(() => '');
        return { ok: false, provider: 'bitbucket', status: res.status, error: body.slice(0, 240) };
      }
      if (src.type === 'gitea') {
        // 0.13: a live test against the source's own Gitea; without a base URL, the old `{ ok:false, error }` shape.
        const gitea = giteaBase(src, 'Set the Gitea base URL to enable the live test');
        if ('error' in gitea) return { ok: false, error: gitea.error };
        const res = await guardedFetch(`${gitea.base}/api/v1/user`, {
          headers: { Authorization: `token ${token}`, Accept: 'application/json', 'User-Agent': 'NineDeploy' },
        });
        if (res.ok) {
          const data = (await res.json()) as { login: string; full_name?: string };
          return { ok: true, provider: 'gitea', login: data.login, name: data.full_name || null };
        }
        const body = await res.text().catch(() => '');
        return { ok: false, provider: 'gitea', status: res.status, error: providerErrorText(body.slice(0, 240), token) };
      }
      return { ok: false, error: `Unknown source type: ${src.type}` };
    } catch (err) {
      return { ok: false, error: providerErrorText(err, token) };
    }
  });

  /**
   * Generate a fresh ed25519 SSH deploy key pair on the server, encrypt the
   * private key into the source row, and return the public key (so the operator
   * can paste it into GitHub/GitLab/Gitea's "Deploy keys" UI in one copy).
   *
   * Replaces any existing token on the source — a server-generated key is the
   * canonical credential and the panel cannot store a user-pasted private key
   * alongside a server-generated one without an explicit upgrade path.
   */
  app.post('/:id/generate-deploy-key', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const src = await app.db.query.sources.findFirst({ where: eq(sources.id, id) });
    if (!src) throw notFound('Source not found');
    // F570: a registry source's token IS its password and nothing reads a
    // deploy key for it — generating one would only erase the credential.
    if (src.type === 'registry') throw badRequest('Registry credentials have no deploy key', 'registry_source');
    const { generateDeployKeyPair } = await import('../lib/sshKey.js');
    const pair = await generateDeployKeyPair(`ninedeploy@${src.name}`);
    // The generated key supersedes whatever credential was there — wipe the
    // token so the next clone doesn't fall through to a half-valid auth state.
    await app.db
      .update(sources)
      .set({
        deployKeyEncrypted: encrypt(pair.privateKey),
        tokenEncrypted: null,
        // Update the comment so a re-generate produces a recognisable follow-up.
      })
      .where(eq(sources.id, id));
    void audit(app.db, req.user!.id, 'source.generateDeployKey', src.name);
    return {
      publicKey: pair.publicKey,
      fingerprint: pair.fingerprint,
      // The private key is never returned — it lives only in the encrypted
      // source row, used at clone time by lib/git.ts.
    };
  });

  app.delete('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    await app.db.delete(sources).where(eq(sources.id, id));
    await setBoundRegistryHosts(app.db, id, []);
    void audit(app.db, req.user!.id, 'source.delete', String(id));
    return { ok: true };
  });
};
