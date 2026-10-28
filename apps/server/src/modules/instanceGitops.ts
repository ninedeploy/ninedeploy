import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { sources } from '@ninedeploy/db';
import { gitopsConfigInput, type GitopsApplyStep, type GitopsCheck, type GitopsView, type InstanceSpec } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import {
  getGitopsConfig,
  getLastCheck,
  loadLive,
  readSpecFromRepo,
  renderInstanceSpec,
  runGitopsCheck,
  setGitopsConfig,
  setLastCheck,
  computeDrift,
  type GitopsDeps,
} from '../lib/instanceGitops.js';

/**
 * G5.3 instance-wide GitOps, mounted under /v1/gitops. Operators only: the
 * file describes every project of the instance.
 *
 * Applying calls the ordinary API with the caller's own credentials, so
 * every check those routes make still applies. It creates and updates; it
 * never deletes (`extra` items stay until someone removes them).
 */
export function instanceGitopsRoutes(deps?: GitopsDeps): FastifyPluginAsync {
  return async (app) => {
    app.addHook('onRequest', app.authenticate);
    app.addHook('preHandler', app.requireOperator);

    app.get('/', async (): Promise<GitopsView> => ({ config: await getGitopsConfig(app.db), lastCheck: await getLastCheck(app.db) }));

    app.put('/', async (req): Promise<GitopsView> => {
      const cfg = gitopsConfigInput.parse(req.body ?? {});
      if (cfg.sourceId != null && !(await app.db.query.sources.findFirst({ where: eq(sources.id, cfg.sourceId) }))) {
        throw badRequest('That git source does not exist', 'gitops_source_unknown');
      }
      await setGitopsConfig(app.db, cfg);
      void audit(app.db, req.user!.id, 'gitops.config', `${cfg.repoUrl}#${cfg.branch}:${cfg.path}${cfg.enabled ? '' : ' (paused)'}`);
      return { config: cfg, lastCheck: await getLastCheck(app.db) };
    });

    app.delete('/', async (req) => {
      await setGitopsConfig(app.db, null);
      await setLastCheck(app.db, null);
      void audit(app.db, req.user!.id, 'gitops.config', 'removed');
      return { ok: true };
    });

    app.post('/check', async (req): Promise<GitopsCheck> => {
      if (!(await getGitopsConfig(app.db))) throw badRequest('Configure the repository first', 'gitops_not_configured');
      const { check } = await runGitopsCheck(app.db, deps);
      void audit(app.db, req.user!.id, 'gitops.check', check.error ? `failed: ${check.error}`.slice(0, 300) : `${check.drift.length} difference(s)`);
      return check;
    });

    // The live instance as the file: the write-back of edits made in the UI.
    app.get('/export', async (req, reply) => {
      const file = renderInstanceSpec((await loadLive(app.db)).spec);
      if ((req.query as { format?: string }).format === 'json') return { file };
      reply.header('content-type', 'application/yaml; charset=utf-8');
      reply.header('content-disposition', 'attachment; filename="ninedeploy-instance.yaml"');
      return file;
    });

    app.post('/apply', async (req): Promise<{ steps: GitopsApplyStep[]; check: GitopsCheck }> => {
      const cfg = await getGitopsConfig(app.db);
      if (!cfg) throw badRequest('Configure the repository first', 'gitops_not_configured');
      // Applied from a fresh read, never from a stored check.
      let desired: InstanceSpec;
      let commit: string | null;
      try {
        ({ spec: desired, commit } = await readSpecFromRepo(app.db, cfg, deps));
      } catch (err) {
        throw badRequest(err instanceof Error ? err.message : String(err), 'gitops_read_failed');
      }
      const steps = await applySpec(app, req, desired);
      const check: GitopsCheck = { at: new Date().toISOString(), commit, error: null, drift: computeDrift(desired, (await loadLive(app.db)).spec) };
      await setLastCheck(app.db, check);
      const failed = steps.filter((s) => !s.ok).length;
      void audit(app.db, req.user!.id, 'gitops.apply', `${commit?.slice(0, 7) ?? '?'}: ${steps.length - failed} applied, ${failed} failed, ${check.drift.length} difference(s) left`);
      return { steps, check };
    });
  };
}

/** The API calls that bring the instance to the file, in dependency order. */
async function applySpec(app: FastifyInstance, req: FastifyRequest, desired: InstanceSpec): Promise<GitopsApplyStep[]> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const h of ['authorization', 'cookie']) {
    const v = req.headers[h];
    if (typeof v === 'string') headers[h] = v;
  }
  const steps: GitopsApplyStep[] = [];
  const call = async (item: string, method: 'POST' | 'PATCH', url: string, payload: object) => {
    const res = await app.inject({ method, url, headers, payload });
    if (res.statusCode < 400) {
      steps.push({ item, ok: true });
      return;
    }
    let error = `HTTP ${res.statusCode}`;
    try {
      error = (res.json() as { error?: { message?: string } }).error?.message ?? error;
    } catch {
      /* not JSON */
    }
    steps.push({ item, ok: false, error });
  };

  // 1. Projects.
  let live = await loadLive(app.db);
  const liveProjects = new Map(live.spec.projects.map((p) => [p.slug, p]));
  for (const p of desired.projects) {
    const workspaceId = p.workspace ? live.workspaceIds.get(p.workspace) : undefined;
    if (p.workspace && workspaceId === undefined) {
      steps.push({ item: `project ${p.slug}`, ok: false, error: `No workspace ${p.workspace}` });
      continue;
    }
    const have = liveProjects.get(p.slug);
    if (!have) {
      await call(`create project ${p.slug}`, 'POST', '/v1/projects', { name: p.name, slug: p.slug, description: p.description ?? null, ...(workspaceId ? { workspaceId } : {}) });
    } else {
      const patch: Record<string, unknown> = {};
      if (p.name !== have.name) patch['name'] = p.name;
      if (p.description !== undefined && p.description !== (have.description ?? null)) patch['description'] = p.description;
      if (workspaceId !== undefined && p.workspace !== have.workspace) patch['workspaceId'] = workspaceId;
      if (Object.keys(patch).length) await call(`update project ${p.slug}`, 'PATCH', `/v1/projects/${live.projectIds.get(p.slug)!.id}`, patch);
    }
  }

  // 2. Services, then 3. domains and 4. grants against the refreshed instance.
  live = await loadLive(app.db);
  const liveServices = new Map(live.spec.projects.flatMap((p) => p.services.map((s) => [`${p.slug}/${s.slug}`, s] as const)));
  for (const p of desired.projects) {
    const project = live.projectIds.get(p.slug);
    if (!project) continue; // its creation failed; reported above
    for (const s of p.services) {
      const have = liveServices.get(`${p.slug}/${s.slug}`);
      if (!have) {
        if (live.serviceIds.has(s.slug)) {
          steps.push({ item: `create service ${p.slug}/${s.slug}`, ok: false, error: `The slug ${s.slug} is taken by a service outside project ${p.slug}` });
          continue;
        }
        await call(`create service ${p.slug}/${s.slug}`, 'POST', '/v1/services', {
          name: s.name ?? s.slug,
          slug: s.slug,
          type: s.type,
          tagProjectIds: [project.id],
          ...(s.image ? { image: s.image } : {}),
          ...(s.repoUrl ? { repoUrl: s.repoUrl } : {}),
          ...(s.branch ? { branch: s.branch } : {}),
          ...(s.port ? { port: s.port } : {}),
        });
        continue;
      }
      const patch: Record<string, unknown> = {};
      for (const f of ['name', 'type', 'image', 'repoUrl', 'branch', 'port'] as const) {
        if (s[f] !== undefined && s[f] !== (have[f] ?? null)) patch[f] = s[f];
      }
      if (Object.keys(patch).length) await call(`update service ${p.slug}/${s.slug}`, 'PATCH', `/v1/services/${live.serviceIds.get(s.slug)}`, patch);
    }
  }
  live = await loadLive(app.db);
  const after = new Map(live.spec.projects.flatMap((p) => p.services.map((s) => [`${p.slug}/${s.slug}`, s] as const)));
  for (const p of desired.projects) {
    const project = live.projectIds.get(p.slug);
    for (const s of p.services) {
      const have = after.get(`${p.slug}/${s.slug}`);
      if (!have) continue;
      const got = new Set(have.domains.map((d) => d.toLowerCase()));
      for (const d of s.domains) {
        if (!got.has(d.toLowerCase())) await call(`add domain ${d} to ${p.slug}/${s.slug}`, 'POST', `/v1/services/${live.serviceIds.get(s.slug)}/domains`, { hostname: d.toLowerCase() });
      }
    }
    if (!project) continue;
    const haveGrants = new Map(live.spec.projects.find((x) => x.slug === p.slug)?.grants.map((g) => [g.email, g.role]) ?? []);
    for (const g of p.grants) {
      const role = haveGrants.get(g.email);
      if (role === g.role) continue;
      if (project.workspaceId == null) {
        steps.push({ item: `grant ${g.email} on ${p.slug}`, ok: false, error: `Project ${p.slug} is in no workspace` });
        continue;
      }
      if (role === undefined) {
        await call(`grant ${g.email} ${g.role} on ${p.slug}`, 'POST', `/v1/workspaces/${project.workspaceId}/access-grants`, { email: g.email, projectId: project.id, role: g.role });
      } else {
        const grant = live.grantIds.get(`${p.slug}/${g.email}`)!;
        await call(`set ${g.email} to ${g.role} on ${p.slug}`, 'PATCH', `/v1/workspaces/${grant.workspaceId}/access-grants/${grant.id}`, { role: g.role });
      }
    }
  }
  return steps;
}
