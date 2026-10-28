/**
 * G5.5 deploy freezes (`lib/deployFreeze.ts`, `modules/deployFreezes.ts`)
 * against a migrated in-memory SQLite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { environments, projects, serviceProjects, services, serviceWorkspaces, users, workspaces, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});

const lib = await import('../../src/lib/deployFreeze.js');
const { deployFreezeRoutes } = await import('../../src/modules/deployFreezes.js');
const { buildTestApp, asUser } = await import('../helpers.js');
const { closeMigratedDb, migratedDb } = await import('./githubAppKit.js');

let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(users).values({ id: 2, email: 'ops@example.com', name: 'Ops', passwordHash: 'x' });
  await db.insert(workspaces).values([
    { id: 1, name: 'Acme', slug: 'acme', ownerId: 2 },
    { id: 2, name: 'Other', slug: 'other', ownerId: 2 },
  ]);
  await db.insert(environments).values({ id: 1, workspaceId: 1, name: 'production', slug: 'production' });
  await db.insert(projects).values({ id: 3, workspaceId: 1, name: 'Shop', slug: 'shop' });
  await db.insert(services).values([
    { id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 2, environmentId: 1 },
    { id: 6, name: 'api', slug: 'api', type: 'docker', branch: 'main', ownerUserId: 2 },
    { id: 7, name: 'web-pr-1', slug: 'web-pr-1', type: 'docker', branch: 'pr', ownerUserId: 2, previewParentServiceId: 5 },
    { id: 8, name: 'loner', slug: 'loner', type: 'docker', branch: 'main', ownerUserId: 2 },
  ] as never);
  await db.insert(serviceProjects).values({ serviceId: 6, projectId: 3 });
  await db.insert(serviceWorkspaces).values({ serviceId: 6, workspaceId: 2 });
});
afterEach(() => closeMigratedDb(db));

const svc = (serviceId: number, environmentId: number | null = null, previewParentServiceId: number | null = null) => ({
  serviceId,
  environmentId,
  previewParentServiceId,
});
const holds = async (s: ReturnType<typeof svc>) => (await lib.freezeHolding(db, s))?.id ?? null;

describe('deploy freezes', () => {
  it('match by scope: environment, its workspace, project, and a preview through its parent', async () => {
    expect(await lib.anyDeployFreeze(db)).toBe(false);
    const env = await lib.createDeployFreeze(db, { scope: 'environment', targetId: 1, reason: 'release week' }, 2);
    expect(env).toMatchObject({ targetName: 'production', createdBy: 'Ops', until: null });
    expect(await holds(svc(5, 1))).toBe(env.id);
    expect(await holds(svc(7, null, 5))).toBe(env.id); // preview of web
    expect(await holds(svc(6))).toBeNull();
    await lib.liftDeployFreeze(db, env.id);

    const ws = await lib.createDeployFreeze(db, { scope: 'workspace', targetId: 1, reason: 'audit' }, 2);
    expect(await holds(svc(5, 1))).toBe(ws.id); // its lane belongs to Acme
    expect(await holds(svc(6))).toBeNull(); // api is in workspace Other
    await lib.liftDeployFreeze(db, ws.id);
    const other = await lib.createDeployFreeze(db, { scope: 'workspace', targetId: 2, reason: 'audit' }, 2);
    expect(await holds(svc(6))).toBe(other.id);
    await lib.liftDeployFreeze(db, other.id);

    const proj = await lib.createDeployFreeze(db, { scope: 'project', targetId: 3, reason: 'migration' }, 2);
    expect(await holds(svc(6))).toBe(proj.id);
    expect(await holds(svc(8))).toBeNull();
    await lib.liftDeployFreeze(db, proj.id);

    const all = await lib.createDeployFreeze(db, { scope: 'instance', reason: 'holidays' }, 2);
    expect(await holds(svc(8))).toBe(all.id);
    expect(lib.freezeLogLine(all)).toContain('all deploys until an operator lifts it: holidays');
  });

  it('ends on its own at its expiry and is pruned', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const f = await lib.createDeployFreeze(db, { scope: 'instance', reason: 'x', until: new Date(Date.now() + 60_000).toISOString() }, 2);
      expect(await holds(svc(8))).toBe(f.id);
      vi.setSystemTime(Date.now() + 61_000);
      expect(await holds(svc(8))).toBeNull();
      expect(await lib.listDeployFreezes(db)).toEqual([]);
      await expect(lib.liftDeployFreeze(db, f.id)).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a missing target, a target on the whole instance, and an end in the past', async () => {
    await expect(lib.createDeployFreeze(db, { scope: 'project', targetId: 99, reason: 'x' }, 2)).rejects.toMatchObject({ statusCode: 404 });
    await expect(lib.createDeployFreeze(db, { scope: 'instance', targetId: 1, reason: 'x' }, 2)).rejects.toThrow();
    await expect(lib.createDeployFreeze(db, { scope: 'environment', reason: 'x' }, 2)).rejects.toThrow();
    await expect(lib.createDeployFreeze(db, { scope: 'instance', reason: 'x', until: '2020-01-01T00:00:00Z' }, 2)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('keeps both of two freezes created at once', async () => {
    await Promise.all([
      lib.createDeployFreeze(db, { scope: 'workspace', targetId: 1, reason: 'a' }, 2),
      lib.createDeployFreeze(db, { scope: 'workspace', targetId: 2, reason: 'b' }, 2),
    ]);
    expect((await lib.listDeployFreezes(db)).map((f) => f.reason).sort()).toEqual(['a', 'b']);
  });
});

describe('routes', () => {
  it('create, list and lift for operators, audited; members are refused', async () => {
    const app = await buildTestApp({ db });
    await app.register(deployFreezeRoutes, { prefix: '/deploy-freezes' });
    const created = await app.inject({
      method: 'POST',
      url: '/deploy-freezes',
      headers: asUser(1),
      payload: { scope: 'environment', targetId: 1, reason: 'release week' },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;
    expect((await app.inject({ method: 'GET', url: '/deploy-freezes', headers: asUser(1) })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/deploy-freezes', headers: asUser({ id: 2, isOperator: false }) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/deploy-freezes', headers: asUser(1), payload: { scope: 'instance', reason: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/deploy-freezes/${id}`, headers: asUser(1) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/deploy-freezes/${id}`, headers: asUser(1) })).statusCode).toBe(404);
  });
});
