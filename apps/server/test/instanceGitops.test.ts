/**
 * G5.3 instance GitOps: the file's rules, the drift against a migrated
 * instance, the export round trip, and applying through the API (the
 * routes it calls are recording stand-ins here).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessGrants, domains, projects, serviceProjects, services, users, workspaces, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const lib = await import('../src/lib/instanceGitops.js');
const { instanceGitopsRoutes } = await import('../src/modules/instanceGitops.js');
const { buildTestApp, asUser } = await import('./helpers.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

const FILE = `version: "1"
projects:
  - slug: shop
    name: Shop
    workspace: main
    services:
      - slug: api
        image: nginx:1.27
        domains: [api.example.com]
      - slug: web
        image: nginx:1.27
    grants:
      - { email: bob@example.com, role: admin }
      - { email: carol@example.com, role: viewer }
  - slug: blog
    name: Blog
    workspace: main
    services:
      - slug: blog-app
        image: ghost:5
`;

let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(users).values([
    { id: 1, email: 'op@example.com', passwordHash: 'x', isOperator: true },
    { id: 2, email: 'bob@example.com', passwordHash: 'x' },
    { id: 3, email: 'carol@example.com', passwordHash: 'x' },
  ] as never);
  await db.insert(workspaces).values({ id: 1, name: 'Main', slug: 'main', ownerId: 1 } as never);
  await db.insert(projects).values([
    { id: 10, workspaceId: 1, name: 'Shop', slug: 'shop' },
    { id: 11, workspaceId: 1, name: 'Legacy', slug: 'legacy' },
  ] as never);
  await db.insert(services).values({ id: 5, name: 'api', slug: 'api', type: 'docker', branch: 'main', ownerUserId: 1, image: 'nginx:1.26' } as never);
  await db.insert(serviceProjects).values({ serviceId: 5, projectId: 10 } as never);
  await db.insert(domains).values({ serviceId: 5, hostname: 'old.example.com', path: '/' } as never);
  await db.insert(accessGrants).values({ workspaceId: 1, userId: 2, projectId: 10, targetKey: 'p:10', role: 'member' } as never);
});
afterEach(() => closeMigratedDb(db));

/** A fresh checkout (as a real clone is) holding the given files. */
const repo = (files: Record<string, string>, extra?: (dir: string) => void) => ({
  checkout: vi.fn(async (_url: string, _branch: string, _sha: string | undefined, dir: string) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    extra?.(dir);
    return 'abc1234def';
  }),
});

const CFG = { enabled: true, repoUrl: 'https://github.com/acme/instance', branch: 'main', path: 'ninedeploy-instance.yaml', sourceId: null, intervalMinutes: 15 };

describe('the instance file', () => {
  it('refuses secrets, unknown keys and a name given twice', () => {
    expect(() => lib.parseInstanceSpec('version: "1"\nprojects:\n  - slug: a\n    name: A\n    description: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n')).toThrow(/secret/);
    expect(() => lib.parseInstanceSpec('version: "1"\nprojects:\n  - slug: a\n    name: A\n    env: {}\n')).toThrow(/invalid/);
    expect(() => lib.parseInstanceSpec('version: "1"\nprojects:\n  - { slug: a, name: Aa }\n  - { slug: a, name: Ab }\n')).toThrow(/twice/);
    expect(() => lib.parseInstanceSpec('version: "1"\nprojects: !!js/function "function(){}"\n')).toThrow(/YAML/);
  });

  it('reports what is missing, changed and extra', async () => {
    const drift = lib.computeDrift(lib.parseInstanceSpec(FILE), (await lib.loadLive(db)).spec);
    expect(drift.map((d) => `${d.change} ${d.kind} ${d.key}`).sort()).toEqual(
      [
        'changed service shop/api',
        'missing domain shop/api/api.example.com',
        'extra domain shop/api/old.example.com',
        'missing service shop/web',
        'changed grant shop/bob@example.com',
        'missing grant shop/carol@example.com',
        'missing project blog',
        'missing service blog/blog-app',
        'extra project legacy',
      ].sort(),
    );
    expect(drift.find((d) => d.key === 'shop/api')?.fields).toEqual([{ field: 'image', desired: 'nginx:1.27', actual: 'nginx:1.26' }]);
  });

  it('exports the live instance as a file that reads back without drift', async () => {
    const live = (await lib.loadLive(db)).spec;
    const text = lib.renderInstanceSpec(live);
    expect(lib.computeDrift(lib.parseInstanceSpec(text), live)).toEqual([]);
  });

  it('does not follow a symlink out of the repository', async () => {
    const outside = path.join(mkdtempSync(path.join(os.tmpdir(), 'nd-gitops-')), 'host-file.yaml');
    writeFileSync(outside, 'version: "1"\n');
    let linked = true;
    const deps = repo({}, (dir) => {
      try {
        symlinkSync(outside, path.join(dir, 'ninedeploy-instance.yaml'));
      } catch {
        linked = false; // no symlink rights (Windows without developer mode)
      }
    });
    if (linked) await expect(lib.readSpecFromRepo(db, CFG, deps)).rejects.toThrow(/outside the repository/);
    else await expect(lib.readSpecFromRepo(db, CFG, deps)).rejects.toThrow(/not in the repository/);
  });
});

describe('routes', () => {
  async function app(deps: lib.GitopsDeps, calls: Array<[string, string, unknown]>) {
    const a = await buildTestApp({ db });
    for (const method of ['POST', 'PATCH'] as const) {
      a.route({
        method,
        url: '/v1/*',
        handler: async (req) => {
          calls.push([method, req.url, req.body]);
          // Creating a project creates it, so the services under it can follow.
          if (method === 'POST' && req.url === '/v1/projects') {
            const b = req.body as { name: string; slug: string; workspaceId: number };
            await db.insert(projects).values({ id: 12, name: b.name, slug: b.slug, workspaceId: b.workspaceId } as never);
          }
          return {};
        },
      });
    }
    await a.register(instanceGitopsRoutes(deps), { prefix: '/gitops' });
    return a;
  }

  it('configures, checks and applies the file without deleting anything', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const a = await app(repo({ 'ninedeploy-instance.yaml': FILE }), calls);
    expect((await a.inject({ method: 'POST', url: '/gitops/check', headers: asUser(1) })).statusCode).toBe(400);
    expect((await a.inject({ method: 'PUT', url: '/gitops', headers: asUser(1), payload: { enabled: true, repoUrl: CFG.repoUrl } })).json().config).toEqual(CFG);
    const check = (await a.inject({ method: 'POST', url: '/gitops/check', headers: asUser(1) })).json();
    expect(check).toMatchObject({ commit: 'abc1234def', error: null });
    expect(check.drift).toHaveLength(9);

    const res = await a.inject({ method: 'POST', url: '/gitops/apply', headers: asUser(1) });
    expect(res.statusCode).toBe(200);
    expect(res.json().steps.every((s: { ok: boolean }) => s.ok)).toBe(true);
    expect(calls).toEqual([
      ['POST', '/v1/projects', { name: 'Blog', slug: 'blog', description: null, workspaceId: 1 }],
      ['PATCH', '/v1/services/5', { image: 'nginx:1.27' }],
      ['POST', '/v1/services', { name: 'web', slug: 'web', type: 'docker', tagProjectIds: [10], image: 'nginx:1.27' }],
      ['POST', '/v1/services', { name: 'blog-app', slug: 'blog-app', type: 'docker', tagProjectIds: [12], image: 'ghost:5' }],
      ['POST', '/v1/services/5/domains', { hostname: 'api.example.com' }],
      ['PATCH', '/v1/workspaces/1/access-grants/1', { role: 'admin' }],
      ['POST', '/v1/workspaces/1/access-grants', { email: 'carol@example.com', projectId: 10, role: 'viewer' }],
    ]);
    // Nothing deletes: `legacy` and the extra domain stay.
    expect(await db.query.projects.findFirst({ where: (p, { eq }) => eq(p.slug, 'legacy') })).toBeTruthy();
    await a.close();
  });

  it('stores a read failure as the check, and members cannot see any of it', async () => {
    const a = await app(repo({}), []);
    await a.inject({ method: 'PUT', url: '/gitops', headers: asUser(1), payload: { enabled: true, repoUrl: CFG.repoUrl } });
    const check = (await a.inject({ method: 'POST', url: '/gitops/check', headers: asUser(1) })).json();
    expect(check.error).toMatch(/not in the repository/);
    expect((await a.inject({ method: 'GET', url: '/gitops', headers: asUser({ id: 2, isOperator: false }) })).statusCode).toBe(403);
    const exported = await a.inject({ method: 'GET', url: '/gitops/export', headers: asUser(1) });
    expect(exported.headers['content-type']).toContain('application/yaml');
    expect(exported.body).toContain('slug: legacy');
    await a.close();
  });
});
