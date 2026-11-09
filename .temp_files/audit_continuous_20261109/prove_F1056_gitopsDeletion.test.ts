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

  for (const removeConfig of [false, true]) {
    it(`${removeConfig ? 'deletion stays cleared' : 'control: unchanged config stores a check'} after a gated checkout`, async () => {
      let entered!: () => void; let release!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const original = repo({ 'ninedeploy-instance.yaml': FILE });
      const deps = { checkout: vi.fn(async (...args: Parameters<typeof original.checkout>) => {
        entered(); await blocked; return original.checkout(...args);
      }) };
      const a = await app(deps, []);
      await a.inject({ method: 'PUT', url: '/gitops', headers: asUser(1), payload: CFG });
      const pending = a.inject({ method: 'POST', url: '/gitops/check', headers: asUser(1) }).then(result => result);
      try {
        await waiting;
        if (removeConfig) {
          expect((await a.inject({ method: 'DELETE', url: '/gitops', headers: asUser(1) })).statusCode).toBe(200);
          expect(await lib.getGitopsConfig(db)).toBeNull();
          expect(await lib.getLastCheck(db)).toBeNull();
        }
      } finally { release(); }
      try {
        const result = await pending;
        if (removeConfig) { const actual = await lib.getLastCheck(db); console.log('EXPECTED: lastCheck remains null; ACTUAL:', actual); console.log(actual === null ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED'); expect(actual).toBeNull(); }
        else {
          expect(result.statusCode).toBe(200);
          expect(await lib.getLastCheck(db)).toMatchObject({ commit: 'abc1234def', error: null });
        }
      } finally { await a.close(); }
    });
  }
});
