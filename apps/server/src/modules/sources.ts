import { eq } from 'drizzle-orm';
import { audit } from '../lib/audit.js';
import { sources, type Source } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { createSource, sourcePatch } from '@ninedeploy/schemas';
import { decrypt, encrypt } from '../lib/crypto.js';
import { badRequest, notFound, parseId } from '../lib/errors.js';
// Every outbound provider call below rides the egress SSRF guard like the
// rest of the panel's webhooks/API clients — the hosts are hardcoded today,
// the guard keeps that invariant from silently drifting.
import { guardedFetch } from '../lib/egressGuard.js';
import { ensureRegistryBindingsInitialised, setBoundRegistryHosts, type RegistryBindings } from '../lib/registryBinding.js';

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
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/**
 * F568: a failed provider call as diagnostic text that never carries the
 * decrypted token. fetch's header validation rejects a token holding CR/LF/NUL
 * with a message that embeds the whole header value, and the token is
 * write-only everywhere else in this module.
 */
function providerErrorText(err: unknown, token: string): string {
  let text = err instanceof Error ? err.message : String(err);
  const lines = token.split(/[\r\n\0]+/).filter((p) => p.trim().length >= 4);
  const pieces = [token, token.trim(), ...lines].filter((p) => p.length > 0);
  for (const piece of pieces.sort((a, b) => b.length - a.length)) text = text.split(piece).join('[redacted]');
  return text;
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
}

/** A response header, tolerant of minimal Response stand-ins. */
function headerOf(res: Response, name: string): string | null {
  return typeof res.headers?.get === 'function' ? res.headers.get(name) : null;
}

/** RFC 8288 `Link` header announcing a next page (GitHub, GitLab). */
function linkHasNext(res: Response): boolean {
  return /<[^>]*>\s*;[^,]*\brel="?next"?/i.test(headerOf(res, 'link') ?? '');
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
    const [created] = await app.db
      .insert(sources)
      .values({
        name: input.name,
        type: input.type,
        tokenEncrypted: input.token ? encrypt(input.token) : null,
        deployKeyEncrypted: input.deployKey ? encrypt(input.deployKey) : null,
        registryUsername: input.registryUsername ?? null,
        defaultBranch: input.defaultBranch ?? 'main',
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
    const changed = (['token', 'deployKey', 'registryUsername', 'registryHosts', 'name', 'defaultBranch'] as const).filter((k) => input[k] !== undefined);
    void audit(app.db, req.user!.id, 'source.update', `${updated.name}: ${changed.join(',') || 'no-op'}`);
    return serialize(updated, await ensureRegistryBindingsInitialised(app.db));
  });

  app.get('/:id/repos', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const src = await app.db.query.sources.findFirst({ where: eq(sources.id, id) });
    if (!src) throw notFound('Source not found');
    if (!src.tokenEncrypted) return [];

    const token = decrypt(src.tokenEncrypted);
    // F1007: page 1 keeps the exact URL it always used; later pages add `&page=N`.
    const paged = (base: string) => (page: number) => (page === 1 ? base : `${base}&page=${page}`);
    let listed: { rows: RepoRow[]; diag?: string } | null = null;
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

    if (listed) {
      if (listed.diag) reply.header('x-nd-source-error', listed.diag);
      return listed.rows;
    }

    return [];
  });

  app.get('/:id/branches', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const src = await app.db.query.sources.findFirst({ where: eq(sources.id, id) });
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
          return { ok: true, provider: 'github', login: data.login, name: data.name ?? null };
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
        return { ok: false, error: 'Live credential test is not supported for gitea sources — verify manually' };
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
