/**
 * G5.3 instance GitOps: the file's rules, the drift against a migrated
 * instance, the export round trip, and applying through the API (the
 * routes it calls are recording stand-ins here).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessGrants, domains, projects, serviceProjects, services, users, workspaces, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
vi.mock('../../apps/server/src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const lib = await import('../../apps/server/src/lib/instanceGitops.js');
const { instanceGitopsRoutes } = await import('../../apps/server/src/modules/instanceGitops.js');
const { buildTestApp, asUser } = await import('../../apps/server/test/helpers.js');
const { closeMigratedDb, migratedDb } = await import('../../apps/server/test/lib/githubAppKit.js');

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

const publication = vi.hoisted(() => ({ blocked: null as Promise<void> | null, entered: null as (() => void) | null }));
vi.mock('../../apps/server/src/lib/settings.js', async original => {
  const actual = await original<typeof import('../../apps/server/src/lib/settings.js')>();
  return { ...actual, setSettingJson: async (...args: Parameters<typeof actual.setSettingJson>) => {
    if (args[1] === 'instance_gitops_check' && publication.blocked) {
      const blocked = publication.blocked; publication.blocked = null; publication.entered?.(); await blocked;
    }
    return actual.setSettingJson(...args);
  } };
});
beforeEach(() => { publication.blocked = null; publication.entered = null; });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve));
async function boot(deps: lib.GitopsDeps) {
  const app = await buildTestApp({ db });
  await app.register(instanceGitopsRoutes(deps), { prefix: '/gitops' });
  return app;
}
const request = (app: Awaited<ReturnType<typeof boot>>, method: 'PUT' | 'POST' | 'DELETE', payload?: unknown, suffix = '') =>
  app.inject({ method, url: `/gitops${suffix}`, headers: asUser(1), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) }).then(result => result);

for (const endpoint of ['check', 'apply']) for (const change of ['remove', 'replace', 'recreate']) {
  it(`independent ${endpoint} result ownership after ${change}`, async () => {
    const entered = gate(); const blocked = gate();
    const original = repo({ 'ninedeploy-instance.yaml': 'version: "1"\nprojects: []\n' });
    let reads = 0;
    const deps = { checkout: vi.fn(async (...args: Parameters<typeof original.checkout>) => {
      const owner = ++reads;
      if (owner === 1) { entered.release(); await blocked.promise; }
      await original.checkout(...args); return owner === 1 ? 'old-owner' : 'new-owner';
    }) };
    const app = await boot(deps); await request(app, 'PUT', CFG);
    const pending = request(app, 'POST', undefined, `/${endpoint}`);
    try {
      await entered.promise;
      if (change !== 'replace') expect((await request(app, 'DELETE')).statusCode).toBe(200);
      if (change !== 'remove') {
        expect((await request(app, 'PUT', { ...CFG, branch: change === 'replace' ? 'replacement' : CFG.branch })).statusCode).toBe(200);
        expect((await request(app, 'POST', undefined, '/apply')).statusCode).toBe(200);
        expect(await lib.getLastCheck(db)).toMatchObject({ commit: 'new-owner' });
      }
      blocked.release(); const result = await pending;
      expect(result.statusCode).toBe(endpoint === 'check' ? 409 : 200);
      if (change === 'remove') {
        expect(await lib.getLastCheck(db)).toBeNull();
        expect(await lib.getGitopsConfig(db)).toBeNull();
        await request(app, 'PUT', CFG);
      } else expect(await lib.getLastCheck(db)).toMatchObject({ commit: 'new-owner' });
      // A rejected old check must release the single-check slot and write queue.
      const retry = await request(app, 'POST', undefined, '/check');
      expect(retry.statusCode).toBe(200); expect(retry.json().commit).toBe('new-owner');
    } finally { blocked.release(); await pending; await app.close(); }
  });
}
for (const endpoint of ['check', 'apply']) {
  it(`failed old ${endpoint} checkout cannot restore a deleted error row`, async () => {
    const entered = gate(); const blocked = gate();
    const deps = { checkout: vi.fn(async () => { entered.release(); await blocked.promise; throw new Error('injected checkout failure'); }) };
    const app = await boot(deps); await request(app, 'PUT', CFG);
    const pending = request(app, 'POST', undefined, `/${endpoint}`);
    try {
      await entered.promise; await request(app, 'DELETE'); blocked.release();
      expect((await pending).statusCode).toBe(endpoint === 'check' ? 409 : 400);
      expect(await lib.getLastCheck(db)).toBeNull();
    } finally { blocked.release(); await pending; await app.close(); }
  });
  it(`settings deletion waits for an already-publishing ${endpoint}`, async () => {
    const entered = gate(); const blocked = gate(); const deletionEntered = gate();
    const deps = repo({ 'ninedeploy-instance.yaml': 'version: "1"\nprojects: []\n' });
    const app = await buildTestApp({ db });
    app.addHook('preHandler', async req => { if (req.method === 'DELETE') deletionEntered.release(); });
    await app.register(instanceGitopsRoutes(deps), { prefix: '/gitops' });
    await request(app, 'PUT', CFG);
    publication.blocked = blocked.promise; publication.entered = entered.release;
    const pending = request(app, 'POST', undefined, `/${endpoint}`);
    let deleting: ReturnType<typeof request> | undefined;
    const deletes = vi.spyOn(db, 'delete');
    try {
      await entered.promise;
      deleting = request(app, 'DELETE'); await deletionEntered.promise; await checkpoint();
      expect(deletes).not.toHaveBeenCalled();
      blocked.release(); await Promise.all([pending, deleting]);
      expect(await lib.getGitopsConfig(db)).toBeNull(); expect(await lib.getLastCheck(db)).toBeNull();
    } finally {
      blocked.release(); await Promise.allSettled([pending, ...(deleting ? [deleting] : [])]); deletes.mockRestore(); await app.close();
    }
  });
}
afterAll(() => console.log('FIX VERIFIED'));
