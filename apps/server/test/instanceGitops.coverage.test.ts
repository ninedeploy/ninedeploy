/**
 * G5.3 instance GitOps routes (`modules/instanceGitops.ts`), the edges the
 * main suite leaves: config validation, removal, the JSON export, refusals
 * before a read, and an apply whose API calls fail in every way the step list
 * reports (an unknown workspace, a slug taken outside the project, a project
 * in no workspace, JSON and non-JSON error bodies). The API the apply calls
 * is a recording stand-in.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessGrants, projects, serviceProjects, services, users, workspaces, type DB } from '@ninedeploy/db';
import type { GitopsDeps } from '../src/lib/instanceGitops.js';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
const audit = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock('../src/lib/audit.js', () => ({ audit }));

const lib = await import('../src/lib/instanceGitops.js');
const { instanceGitopsRoutes } = await import('../src/modules/instanceGitops.js');
const { buildTestApp, asUser } = await import('./helpers.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

let db: DB;
beforeEach(async () => {
  audit.mockClear();
  db = await migratedDb();
  await db.insert(users).values([
    { id: 1, email: 'op@example.com', passwordHash: 'x', isOperator: true },
    { id: 2, email: 'bob@example.com', passwordHash: 'x' },
    { id: 3, email: 'carol@example.com', passwordHash: 'x' },
  ] as never);
  await db.insert(workspaces).values([
    { id: 1, name: 'Main', slug: 'main', ownerId: 1 },
    { id: 2, name: 'Other', slug: 'other', ownerId: 1 },
  ] as never);
  await db.insert(projects).values([
    { id: 10, workspaceId: 1, name: 'Shop', slug: 'shop' },
    { id: 13, workspaceId: null, name: 'Orphan', slug: 'orphan' },
  ] as never);
  await db.insert(services).values([
    { id: 5, name: 'api', slug: 'api', type: 'docker', branch: 'main', ownerUserId: 1, image: 'nginx:1.26' },
    { id: 6, name: 'loose', slug: 'loose', type: 'docker', branch: 'main', ownerUserId: 1, image: 'nginx:1' },
  ] as never);
  await db.insert(serviceProjects).values({ serviceId: 5, projectId: 10 } as never);
  await db.insert(accessGrants).values({ id: 40, workspaceId: 1, userId: 2, projectId: 10, targetKey: 'p:10', role: 'member' } as never);
});
afterEach(() => closeMigratedDb(db));

const repo = (files: Record<string, string>, commit = 'abc1234def') => ({
  checkout: vi.fn(async (_url: string, _branch: string, _sha: string | undefined, dir: string) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    return commit;
  }),
});

const FILE = `version: "1"
projects:
  - slug: shop
    name: Shop Renamed
    description: The shop
    workspace: other
    services:
      - slug: api
        name: API
        type: compose
        repoUrl: https://github.com/acme/api
        branch: dev
        port: 8080
        domains: [API.example.com]
      - slug: loose
        image: nginx:1
      - slug: worker
        repoUrl: https://github.com/acme/worker
        branch: main
        port: 9000
    grants:
      - { email: bob@example.com, role: admin }
  - slug: ghost
    name: Ghost
    workspace: nope
  - slug: newp
    name: New P
    services:
      - slug: fresh
        image: nginx:1
  - slug: orphan
    name: Orphan
    grants:
      - { email: carol@example.com, role: viewer }
`;

type Call = [string, string, unknown];
async function app(deps: GitopsDeps, calls: Call[] = []) {
  const a = await buildTestApp({ db });
  for (const method of ['POST', 'PATCH'] as const) {
    a.route({
      method,
      url: '/v1/*',
      handler: async (req, reply) => {
        calls.push([method, req.url, req.body]);
        if (method === 'POST' && req.url === '/v1/projects') return reply.code(500).send({ error: { message: 'quota reached' } });
        if (method === 'POST' && req.url === '/v1/services') return reply.code(502).type('text/plain').send('bad gateway');
        if (method === 'PATCH' && req.url.includes('/access-grants/')) return reply.code(403).send({ error: {} });
        return {};
      },
    });
  }
  await a.register(instanceGitopsRoutes(deps), { prefix: '/gitops' });
  return a;
}

const CFG = { enabled: true, repoUrl: 'https://github.com/acme/instance' };

describe('configuration routes', () => {
  it('reads nothing before configuring, refuses an unknown git source and records a paused config', async () => {
    const a = await app(repo({}));
    expect((await a.inject({ method: 'GET', url: '/gitops', headers: asUser(1) })).json()).toEqual({ config: null, lastCheck: null });

    const unknown = await a.inject({ method: 'PUT', url: '/gitops', headers: asUser(1), payload: { ...CFG, sourceId: 999 } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('gitops_source_unknown');
    expect((await a.inject({ method: 'PUT', url: '/gitops', headers: asUser(1) })).statusCode).toBe(400);

    const paused = await a.inject({ method: 'PUT', url: '/gitops', headers: asUser(1), payload: { ...CFG, enabled: false, branch: 'prod', path: 'ops/instance.yaml' } });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ config: { enabled: false, branch: 'prod', path: 'ops/instance.yaml' }, lastCheck: null });
    expect(audit).toHaveBeenLastCalledWith(db, 1, 'gitops.config', 'https://github.com/acme/instance#prod:ops/instance.yaml (paused)');
    await a.close();
  });

  // Regression: clearing stored SQL NULL into settings.value (NOT NULL), so DELETE answered 500.
  it('removes the config and the last check', async () => {
    const a = await app(repo({}));
    await a.inject({ method: 'PUT', url: '/gitops', headers: asUser(1), payload: CFG });
    const removed = await a.inject({ method: 'DELETE', url: '/gitops', headers: asUser(1) });
    await a.close();
    expect(removed.json()).toEqual({ ok: true });
    expect(audit).toHaveBeenLastCalledWith(db, 1, 'gitops.config', 'removed');
    expect(await lib.getGitopsConfig(db)).toBeNull();
    expect(await lib.getLastCheck(db)).toBeNull();
  });

  it('audits a failed check by its error', async () => {
    const a = await app(repo({}));
    await a.inject({ method: 'PUT', url: '/gitops', headers: asUser(1), payload: CFG });
    const check = (await a.inject({ method: 'POST', url: '/gitops/check', headers: asUser(1) })).json();
    expect(check).toMatchObject({ commit: null, drift: [] });
    expect(audit).toHaveBeenLastCalledWith(db, 1, 'gitops.check', expect.stringMatching(/^failed: ninedeploy-instance\.yaml is not in the repository/));
    // The stored check is what GET answers now.
    expect((await a.inject({ method: 'GET', url: '/gitops', headers: asUser(1) })).json().lastCheck).toEqual(check);
    await a.close();
  });

  it('exports the live instance as JSON on request', async () => {
    const a = await app(repo({}));
    const res = await a.inject({ method: 'GET', url: '/gitops/export?format=json', headers: asUser(1) });
    expect(res.headers['content-type']).toContain('application/json');
    const { file } = res.json() as { file: string };
    expect(file).toContain('slug: shop');
    expect(file).toContain('slug: orphan');
    expect(lib.parseInstanceSpec(file).projects.map((p) => p.slug)).toEqual(['orphan', 'shop']);
    await a.close();
  });
});

describe('apply', () => {
  it('refuses before a repository is configured, and when the file cannot be read', async () => {
    const a = await app(repo({}));
    const none = await a.inject({ method: 'POST', url: '/gitops/apply', headers: asUser(1) });
    expect(none.statusCode).toBe(400);
    expect(none.json().error.code).toBe('gitops_not_configured');
    await a.inject({ method: 'PUT', url: '/gitops', headers: asUser(1), payload: CFG });
    const unread = await a.inject({ method: 'POST', url: '/gitops/apply', headers: asUser(1) });
    expect(unread.statusCode).toBe(400);
    expect(unread.json().error).toMatchObject({ code: 'gitops_read_failed', message: expect.stringContaining('is not in the repository') });
    // Members never reach any of it.
    expect((await a.inject({ method: 'POST', url: '/gitops/apply', headers: asUser({ id: 2, isOperator: false }) })).statusCode).toBe(403);
    await a.close();
  });

  it('reports each step that could not be applied, with the reason, and calls the API for the rest', async () => {
    const calls: Call[] = [];
    const a = await app(repo({ 'ninedeploy-instance.yaml': FILE }, ''), calls);
    await a.inject({ method: 'PUT', url: '/gitops', headers: asUser(1), payload: CFG });
    const res = await a.inject({ method: 'POST', url: '/gitops/apply', headers: asUser(1) });
    expect(res.statusCode).toBe(200);
    const { steps, check } = res.json() as { steps: Array<{ item: string; ok: boolean; error?: string }>; check: { commit: string | null; drift: unknown[] } };
    expect(steps).toEqual([
      { item: 'update project shop', ok: true },
      { item: 'project ghost', ok: false, error: 'No workspace nope' },
      { item: 'create project newp', ok: false, error: 'quota reached' },
      { item: 'update service shop/api', ok: true },
      { item: 'create service shop/loose', ok: false, error: 'The slug loose is taken by a service outside project shop' },
      { item: 'create service shop/worker', ok: false, error: 'HTTP 502' },
      { item: 'add domain API.example.com to shop/api', ok: true },
      { item: 'set bob@example.com to admin on shop', ok: false, error: 'HTTP 403' },
      { item: 'grant carol@example.com on orphan', ok: false, error: 'Project orphan is in no workspace' },
    ]);
    expect(calls).toEqual([
      ['PATCH', '/v1/projects/10', { name: 'Shop Renamed', description: 'The shop', workspaceId: 2 }],
      ['POST', '/v1/projects', { name: 'New P', slug: 'newp', description: null }],
      ['PATCH', '/v1/services/5', { name: 'API', type: 'compose', repoUrl: 'https://github.com/acme/api', branch: 'dev', port: 8080 }],
      ['POST', '/v1/services', { name: 'worker', slug: 'worker', type: 'docker', tagProjectIds: [10], repoUrl: 'https://github.com/acme/worker', branch: 'main', port: 9000 }],
      ['POST', '/v1/services/5/domains', { hostname: 'api.example.com' }],
      ['PATCH', '/v1/workspaces/1/access-grants/40', { role: 'admin' }],
    ]);
    // The stand-ins changed nothing, so the drift is still there, and the stored check says so.
    expect(check.commit).toBeNull();
    expect(check.drift.length).toBeGreaterThan(0);
    expect(await lib.getLastCheck(db)).toEqual(check);
    expect(audit).toHaveBeenLastCalledWith(db, 1, 'gitops.apply', `?: 3 applied, 6 failed, ${check.drift.length} difference(s) left`);
    await a.close();
  });

  it('changes nothing for a file that matches the instance', async () => {
    const calls: Call[] = [];
    const a = await app({ checkout: vi.fn() } as never, calls);
    const live = lib.renderInstanceSpec((await lib.loadLive(db)).spec);
    const deps = repo({ 'ninedeploy-instance.yaml': live });
    await a.close();
    const b = await app(deps, calls);
    await b.inject({ method: 'PUT', url: '/gitops', headers: asUser(1), payload: CFG });
    const res = (await b.inject({ method: 'POST', url: '/gitops/apply', headers: asUser(1) })).json();
    expect(res.steps).toEqual([]);
    expect(res.check).toMatchObject({ commit: 'abc1234def', drift: [] });
    expect(calls).toEqual([]);
    expect(audit).toHaveBeenLastCalledWith(db, 1, 'gitops.apply', 'abc1234: 0 applied, 0 failed, 0 difference(s) left');
    await b.close();
  });
});
