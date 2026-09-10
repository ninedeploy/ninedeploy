import { eq } from 'drizzle-orm';
import { audit } from '../lib/audit.js';
import { sources, type Source } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { createSource, sourcePatch } from '@ninedeploy/schemas';
import { decrypt, encrypt } from '../lib/crypto.js';
import { notFound, parseId } from '../lib/errors.js';
// Every outbound provider call below rides the egress SSRF guard like the
// rest of the panel's webhooks/API clients — the hosts are hardcoded today,
// the guard keeps that invariant from silently drifting.
import { guardedFetch } from '../lib/egressGuard.js';

function serialize(s: Source) {
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    hasToken: !!s.tokenEncrypted,
    hasDeployKey: !!s.deployKeyEncrypted,
    registryUsername: s.registryUsername ?? null,
    defaultBranch: s.defaultBranch,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** Source (private-repo credential) management. Mounted under /sources. Admin-only. */
export const sourcesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  // System-wide credentials — admin-only under the agreed RBAC model.
  app.addHook('preHandler', app.requireAdmin);

  app.get('/', async () => {
    const rows = await app.db.query.sources.findMany({ orderBy: (s, { desc }) => [desc(s.id)] });
    return rows.map(serialize);
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
    void audit(app.db, req.user!.id, 'source.create', input.name);
    return serialize(created!);
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
    const [updated] = await app.db.update(sources).set(patch).where(eq(sources.id, id)).returning();
    if (!updated) throw notFound('Source not found');
    return serialize(updated);
  });

  app.get('/:id/repos', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const src = await app.db.query.sources.findFirst({ where: eq(sources.id, id) });
    if (!src) throw notFound('Source not found');
    if (!src.tokenEncrypted) return [];

    const token = decrypt(src.tokenEncrypted);
    if (src.type === 'github') {
      try {
        const res = await guardedFetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'NineDeploy',
          },
        });
        if (!res.ok) {
          // Surface the real failure to admins — "empty list" silently looked
          // like "no repos" and a stale PAT was the most common operator trap.
          reply.header('x-nd-source-error', `GitHub API ${res.status}`);
          return [];
        }
        const data = (await res.json()) as Array<{
          name: string;
          full_name: string;
          clone_url: string;
          default_branch: string;
          private: boolean;
        }>;
        return data.map((r) => ({
          name: r.name,
          fullName: r.full_name,
          url: r.clone_url,
          defaultBranch: r.default_branch || 'main',
          isPrivate: r.private,
        }));
      } catch (err) {
        reply.header('x-nd-source-error', `GitHub API unreachable: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    }

    if (src.type === 'gitlab') {
      try {
        const res = await guardedFetch('https://gitlab.com/api/v4/projects?membership=true&per_page=100&order_by=updated_at', {
          headers: { 'PRIVATE-TOKEN': token },
        });
        if (!res.ok) {
          reply.header('x-nd-source-error', `GitLab API ${res.status}`);
          return [];
        }
        const data = (await res.json()) as Array<{
          name: string;
          path_with_namespace: string;
          http_url_to_repo: string;
          default_branch: string;
          visibility: string;
        }>;
        return data.map((r) => ({
          name: r.name,
          fullName: r.path_with_namespace,
          url: r.http_url_to_repo,
          defaultBranch: r.default_branch || 'main',
          isPrivate: r.visibility !== 'public',
        }));
      } catch (err) {
        reply.header('x-nd-source-error', `GitLab API unreachable: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    }

    if (src.type === 'bitbucket') {
      try {
        const res = await guardedFetch('https://api.bitbucket.org/2.0/repositories?role=contributor&pagelen=100&sort=-updated_on', {
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': 'NineDeploy',
          },
        });
        if (!res.ok) {
          reply.header('x-nd-source-error', `Bitbucket API ${res.status}`);
          return [];
        }
        const data = (await res.json()) as {
          values?: Array<{
            name: string;
            full_name: string;
            is_private: boolean;
            mainbranch?: { name?: string };
            links?: { html?: { href?: string } };
          }>;
        };
        return (data.values ?? []).map((r) => ({
          name: r.name,
          fullName: r.full_name,
          url: `https://bitbucket.org/${r.full_name}.git`,
          defaultBranch: r.mainbranch?.name || 'master',
          isPrivate: r.is_private,
        }));
      } catch (err) {
        reply.header('x-nd-source-error', `Bitbucket API unreachable: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
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
        reply.header('x-nd-source-error', `GitHub API unreachable: ${err instanceof Error ? err.message : String(err)}`);
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
        reply.header('x-nd-source-error', `Bitbucket API unreachable: ${err instanceof Error ? err.message : String(err)}`);
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
    void audit(app.db, req.user!.id, 'source.delete', String(id));
    return { ok: true };
  });
};
