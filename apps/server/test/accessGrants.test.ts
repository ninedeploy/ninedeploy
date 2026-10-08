/**
 * 0.15 T5 — project- and environment-level access grants (DESIGN §4), against
 * a real migrated SQLite seeded with the shared access world
 * (fixtures/accessWorld.ts):
 *
 *   • semantics: what a project / environment / project+environment grant
 *     covers, raise-only precedence, suspended / deactivated / moved-project
 *     grants ignored, `owner` never grantable, guests kept off workspace-level
 *     rights, FK cascades;
 *   • the routes (modules/accessGrants.ts): who may grant, the role cap, 404
 *     without enumeration, 409 on duplicates, audit rows;
 *   • the lifecycle mount points, each through its real route so removing the
 *     wiring fails here: member removal (M21), SCIM suspend / reinstate /
 *     delete (M22), project move (M23), project-targeted writes (M19) and the
 *     bypass sites (M20: environment selection and list, project links, the
 *     pipeline's shared-env trust).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accessGrants,
  auditLog,
  createDb,
  environments,
  projects,
  scimTokens,
  services,
  users,
  workspaceMembers,
  workspaces,
  type DB,
} from '@ninedeploy/db';

vi.mock('../src/lib/retainedSlugVolume.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/retainedSlugVolume.js')>()),
  assertPrimaryVolumeNotAttachedElsewhere: vi.fn(async () => undefined),
  assertSlugVolumeNotRetained: vi.fn(async () => undefined),
}));
// Database create (M19 cases): nothing may reach Docker.
const engine = vi.hoisted(() => ({ started: [] as string[] }));
vi.mock('../src/engine/database.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/database.js')>()),
  startDatabase: vi.fn(async (row: { name: string }) => {
    engine.started.push(row.name);
  }),
  adoptRetainedVolume: vi.fn(async () => undefined),
  volumeExists: vi.fn(async () => false),
}));
vi.mock('../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/proxy.js')>()),
  writeDynamicConfig: vi.fn(async () => undefined),
}));

const ra = await import('../src/lib/resourceAccess.js');
const ag = await import('../src/lib/accessGrants.js');
const { visibleProjectIds } = await import('../src/modules/projects.js');
const { filterTrustworthyProjectLinks } = await import('../src/engine/pipeline.js');
const { visibleLabelIds } = await import('../src/modules/labels.js');
const { defaultWorkspaceIdsForUser } = await import('../src/modules/serviceTags.js');
const { accessGrantRoutes, accessMeRoutes, projectAccessRoutes } = await import('../src/modules/accessGrants.js');
const { servicesRoutes } = await import('../src/modules/services.js');
const { environmentRoutes } = await import('../src/modules/environments.js');
const { projectRoutes } = await import('../src/modules/projects.js');
const { projectEnvRoutes } = await import('../src/modules/env.js');
const { databasesRoutes } = await import('../src/modules/databases.js');
const { workspaceRoutes } = await import('../src/modules/workspaces.js');
const { scimRoutes } = await import('../src/modules/scim.js');
const { sha256 } = await import('../src/lib/crypto.js');
const { buildTestApp } = await import('./helpers.js');
const world = await import('./fixtures/accessWorld.js');

const { U, W, P, E } = world;
const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));

let dir: string;
let db: DB;
let close: () => void;

beforeEach(async () => {
  vi.stubEnv('DOCKER_HOST', 'tcp://127.0.0.1:9');
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-grants-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await world.seedWorld(db);
});

afterEach(() => {
  close();
  vi.unstubAllEnvs();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

const as = (id: number, isOperator = false) => ({ id, isOperator });
type GrantSpec = { ws: number; project?: number; env?: number; role: string; suspended?: boolean };
async function grant(userId: number, g: GrantSpec): Promise<number> {
  const [row] = await db
    .insert(accessGrants)
    .values({
      workspaceId: g.ws,
      userId,
      projectId: g.project ?? null,
      environmentId: g.env ?? null,
      targetKey: g.project != null && g.env != null ? `pe:${g.project}:${g.env}` : g.project != null ? `p:${g.project}` : `e:${g.env}`,
      role: g.role as 'viewer',
      suspendedAt: g.suspended ? new Date() : null,
    })
    .returning();
  return row!.id;
}
const svc = async (id: number) => (await db.query.services.findFirst({ where: eq(services.id, id) }))!;
const dbRow = async (id: number) => (await db.query.databases.findFirst({ where: (d, { eq: e }) => e(d.id, id) }))!;
const proj = async (id: number) => (await db.query.projects.findFirst({ where: eq(projects.id, id) }))!;
const loads = async (fn: () => Promise<unknown>) => (await world.outcome(fn)) === 'ok';
const visible = async (userId: number) => [...((await ra.visibleServiceIdSet(db, as(userId))) ?? [])].sort((a, b) => a - b);

describe('what a grant covers', () => {
  it('a project grant: the project row, its databases and the services linked to it', async () => {
    await grant(U.viewerW2, { ws: W.W1, project: P.P1, role: 'viewer' });
    const u = as(U.viewerW2);
    expect(await loads(() => ra.loadProjectForUser(db, P.P1, u))).toBe(true);
    expect(await loads(() => ra.loadProjectForUser(db, P.P1b, u))).toBe(false);
    // Linked to P1: 104, 106, 110, 111 — and 112, a W2 service someone linked to W1's project.
    for (const id of [104, 110, 111]) {
      expect(await loads(() => ra.loadServiceForUser(db, id, u)), `svc ${id}`).toBe(true);
      expect(await ra.serviceRole(db, await svc(id), u)).toBe('viewer');
    }
    expect(await loads(() => ra.loadServiceForUser(db, 105, u))).toBe(false);
    expect(await visible(U.viewerW2)).toEqual([104, 106, 107, 109, 110, 111, 112, 212]);
    expect(await loads(() => ra.loadDatabaseForUser(db, 304, u))).toBe(true);
    expect(await ra.databaseRole(db, await dbRow(305), u)).toBe('viewer');
    expect(await loads(() => ra.loadDatabaseForUser(db, 308, u))).toBe(false); // P1b
    expect((await ra.visibleDatabaseIds(db, u))!.sort()).toEqual([304, 305, 306, 307, 309]);
    // No workspace-level right comes with it.
    await expect(ra.assertWorkspaceRole(db, W.W1, u, 'viewer')).rejects.toThrow(/Insufficient role/);
    expect(await ra.isWorkspaceMember(db, W.W1, u)).toBe(false);
  });

  it('an environment grant: services in E tagged into E’s workspace, never a database', async () => {
    await grant(U.outsider, { ws: W.W1, env: E.E1, role: 'member' });
    const u = as(U.outsider);
    // In E1 and tagged W1: 104, 108, 110. 102 is in E1 but untagged; 112 is in E1 but tagged W2 only.
    for (const id of [104, 108, 110]) expect(await ra.serviceRole(db, await svc(id), u), `svc ${id}`).toBe('member');
    expect(await ra.serviceRole(db, await svc(102), u)).toBeNull();
    expect(await loads(() => ra.loadServiceForUser(db, 105, u))).toBe(false); // E1b
    // 309 is its own, but in W2 where it holds no seat (r694): still invisible.
    expect(await ra.visibleDatabaseIds(db, u)).toEqual([]);
    expect(await loads(() => ra.loadProjectForUser(db, P.P1, u))).toBe(false);
    expect(await ra.mayUseEnvironment(db, u, { id: E.E1, workspaceId: W.W1 })).toBe(true);
    expect(await ra.mayUseEnvironment(db, u, { id: E.E1b, workspaceId: W.W1 })).toBe(false);
  });

  it('a project + environment grant: services linked to P AND in E — not the project row, not its databases', async () => {
    await grant(U.outsider, { ws: W.W1, project: P.P1, env: E.E1, role: 'admin' });
    const u = as(U.outsider);
    expect(await ra.serviceRole(db, await svc(104), u)).toBe('admin');
    expect(await ra.serviceRole(db, await svc(110), u)).toBe('admin');
    expect(await ra.serviceRole(db, await svc(106), u)).toBeNull(); // P1 but E2
    expect(await ra.serviceRole(db, await svc(111), u)).toBeNull(); // P1 but E1b
    expect(await ra.serviceRole(db, await svc(108), u)).toBeNull(); // E1 but P0
    expect(await loads(() => ra.loadProjectForUser(db, P.P1, u))).toBe(false);
    expect(await loads(() => ra.loadDatabaseForUser(db, 304, u))).toBe(false);
  });

  it('a service row without environmentId still resolves environment grants', async () => {
    await grant(U.outsider, { ws: W.W1, env: E.E1, role: 'viewer' });
    expect(await ra.serviceRole(db, { id: 104, ownerUserId: U.leaver }, as(U.outsider))).toBe('viewer');
  });
});

describe('raise-only precedence (owner decision O5)', () => {
  it('max(seat, grants): a grant raises a lower seat, never lowers a higher one', async () => {
    await grant(U.viewerW1, { ws: W.W1, project: P.P1, role: 'member' });
    await grant(U.adminW1, { ws: W.W1, project: P.P1, role: 'viewer' });
    await grant(U.memberW1, { ws: W.W1, project: P.P1, role: 'viewer' });
    expect(await ra.serviceRole(db, await svc(104), as(U.viewerW1))).toBe('member');
    expect(await ra.serviceRole(db, await svc(104), as(U.memberW1))).toBe('member');
    expect(await ra.databaseRole(db, await dbRow(305), as(U.memberW1))).toBe('member');
    expect(await ra.projectRole(db, await proj(P.P1), as(U.memberW1))).toBe('member');
    expect(await ra.serviceRole(db, await svc(105), as(U.viewerW1))).toBe('viewer'); // not covered: the seat
    expect(await ra.serviceRole(db, await svc(104), as(U.adminW1))).toBe('admin');
    expect(await ra.databaseRole(db, await dbRow(305), as(U.viewerW1))).toBe('member');
    expect(await ra.databaseRole(db, await dbRow(305), as(U.adminW1))).toBe('admin');
    expect(await ra.projectRole(db, await proj(P.P1), as(U.viewerW1))).toBe('member');
    await expect(ra.assertProjectRole(db, await proj(P.P1), as(U.viewerW1), 'member')).resolves.toBeUndefined();
    await expect(ra.assertProjectRole(db, await proj(P.P1b), as(U.viewerW1), 'member')).rejects.toThrow(/Insufficient role/);
  });

  it('several grants on one resource: the highest wins', async () => {
    await grant(U.outsider, { ws: W.W1, project: P.P1, role: 'viewer' });
    await grant(U.outsider, { ws: W.W1, env: E.E1, role: 'admin' });
    await grant(U.outsider, { ws: W.W1, project: P.P1, env: E.E1, role: 'member' });
    expect(await ra.serviceRole(db, await svc(104), as(U.outsider))).toBe('admin');
    expect(await ra.serviceRole(db, await svc(111), as(U.outsider))).toBe('viewer'); // P1 only
  });

  it('the creator is owner while a covering grant stands (r694 extended), and loses it with the grant', async () => {
    // 104 was created by `leaver`, who holds no seat: no role in 0.14.
    expect(await ra.serviceRole(db, await svc(104), as(U.leaver))).toBeNull();
    const id = await grant(U.leaver, { ws: W.W1, project: P.P1, role: 'viewer' });
    expect(await ra.serviceRole(db, await svc(104), as(U.leaver))).toBe('owner');
    expect(await ra.databaseRole(db, await dbRow(304), as(U.leaver))).toBe('owner');
    await db.delete(accessGrants).where(eq(accessGrants.id, id));
    expect(await ra.serviceRole(db, await svc(104), as(U.leaver))).toBeNull();
    expect(await ra.databaseRole(db, await dbRow(304), as(U.leaver))).toBeNull();
  });

  it('owner is never grantable: a row written around the API with role owner counts for nothing', async () => {
    await grant(U.outsider, { ws: W.W1, project: P.P1, role: 'owner' });
    expect(await ra.serviceRole(db, await svc(104), as(U.outsider))).toBeNull();
    expect(await ag.grantsForUser(db, U.outsider)).toEqual([]);
  });
});

describe('grants that do not count', () => {
  it('a suspended grant is ignored', async () => {
    await grant(U.outsider, { ws: W.W1, project: P.P1, role: 'admin', suspended: true });
    expect(await ra.serviceRole(db, await svc(104), as(U.outsider))).toBeNull();
    expect(await loads(() => ra.loadProjectForUser(db, P.P1, as(U.outsider)))).toBe(false);
  });

  it('a deactivated account’s grants are ignored (the no-request paths too)', async () => {
    await grant(U.deactivated, { ws: W.W1, project: P.P1b, role: 'admin' });
    expect(await ag.grantsForUser(db, U.deactivated)).toEqual([]);
  });

  it('a moved project stops matching its grants at once (read-time join), then the move deletes them (M23)', async () => {
    await grant(U.outsider, { ws: W.W1, project: P.P1, role: 'member' });
    await db.update(projects).set({ workspaceId: W.W2 }).where(eq(projects.id, P.P1));
    expect(await ra.serviceRole(db, await svc(104), as(U.outsider))).toBeNull();
    expect(await ag.grantsForUser(db, U.outsider)).toEqual([]);
    await db.update(projects).set({ workspaceId: W.W1 }).where(eq(projects.id, P.P1));
    // Through the route: the PATCH that moves a project deletes its grants.
    // (An operator moving a project needs a seat in the destination.)
    await db.insert(workspaceMembers).values({ workspaceId: W.W2, userId: U.operator, role: 'admin' });
    const app = await buildTestApp({ db });
    await app.register(projectRoutes, { prefix: '/projects' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/projects/${P.P1}`,
      headers: { 'x-test-user': String(U.operator), 'x-test-operator': 'true' },
      payload: { workspaceId: W.W2 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await db.select().from(accessGrants).where(eq(accessGrants.projectId, P.P1))).toEqual([]);
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'workspace.access_grant.delete'))).length).toBe(1);
  });

  it('a rename that does not move the project keeps its grants', async () => {
    await grant(U.outsider, { ws: W.W1, project: P.P1, role: 'member' });
    const app = await buildTestApp({ db });
    await app.register(projectRoutes, { prefix: '/projects' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/projects/${P.P1}`,
      headers: { 'x-test-user': String(U.ownerW1), 'x-test-operator': 'false' },
      payload: { name: 'P1-renamed', workspaceId: W.W1 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await db.select().from(accessGrants)).length).toBe(1);
  });
});

describe('guests: grants only, nothing workspace-level', () => {
  it('a guest sees no labels, gets no default tags, and is no workspace member', async () => {
    await grant(U.outsider, { ws: W.W1, project: P.P1, role: 'admin' });
    const u = as(U.outsider);
    expect(await visibleLabelIds(db, u, [1, 2, 3])).toEqual([]);
    expect(await defaultWorkspaceIdsForUser(db, u)).toEqual([]);
    await expect(ra.assertWorkspaceMember(db, W.W1, u)).rejects.toThrow(/do not have access/);
    // An admin project grant is still not a workspace admin: renaming or deleting the project stays refused.
    const app = await buildTestApp({ db });
    await app.register(projectRoutes, { prefix: '/projects' });
    const headers = { 'x-test-user': String(U.outsider), 'x-test-operator': 'false' };
    const listed = (await app.inject({ method: 'GET', url: '/projects', headers })).json() as Array<{ id: number }>;
    expect(listed.map((p) => p.id)).toEqual([P.P1]);
    expect((await app.inject({ method: 'PATCH', url: `/projects/${P.P1}`, headers, payload: { name: 'renamed-by-guest' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/projects/${P.P1}`, headers })).statusCode).toBe(403);
    expect((await proj(P.P1)).name).toBe('P1');
  });

  it('a grant is local: it changes nothing for any other user', async () => {
    const before = await world.snapshot(db, await world.liveImpl(db));
    await grant(U.outsider, { ws: W.W1, project: P.P1, role: 'admin' });
    const after = await world.snapshot(db, await world.liveImpl(db));
    const moved = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.filter((k) => !k.startsWith('outsider|') && !k.startsWith('pipeline|'))).toEqual([]);
  });
});

describe('cascades: a grant never outlives what it names', () => {
  it.each([
    ['user', async () => db.delete(users).where(eq(users.id, U.outsider))],
    ['workspace', async () => db.delete(workspaces).where(eq(workspaces.id, W.W1))],
    ['project', async () => db.delete(projects).where(eq(projects.id, P.P1))],
    ['environment', async () => db.delete(environments).where(eq(environments.id, E.E1))],
  ] as const)('deleting the %s deletes its grants (FK ON DELETE CASCADE)', async (_what, del) => {
    await grant(U.outsider, { ws: W.W1, project: P.P1, env: E.E1, role: 'member' });
    await del();
    expect(await db.select().from(accessGrants)).toEqual([]);
  });
});

// ── the bypass sites (M20) and project-targeted writes (M19), through their routes ──

describe('environment selection and the environment list honour grants (M20)', () => {
  async function app() {
    const a = await buildTestApp({ db });
    await a.register(servicesRoutes, { prefix: '/services' });
    await a.register(environmentRoutes, { prefix: '/environments' });
    return a;
  }
  const h = (id: number) => ({ 'x-test-user': String(id), 'x-test-operator': 'false' });
  const probe = world.probeServiceId(U.viewerW2);

  it('a grant naming E lets its holder select E and lists E', async () => {
    const a = await app();
    const pick = () => a.inject({ method: 'PATCH', url: `/services/${probe}`, headers: h(U.viewerW2), payload: { environmentId: E.E1 } });
    const list = async () => ((await a.inject({ method: 'GET', url: '/environments', headers: h(U.viewerW2) })).json() as Array<{ id: number }>).map((e) => e.id);
    expect((await pick()).statusCode).toBe(403);
    expect(await list()).toEqual([E.E2]);
    await grant(U.viewerW2, { ws: W.W1, project: P.P1, env: E.E1, role: 'viewer' });
    const res = await pick();
    expect(res.statusCode, res.body).toBe(200);
    expect((await svc(probe)).environmentId).toBe(E.E1);
    expect(await list()).toEqual([E.E1, E.E2]);
  });

  it('a project grant names no environment: selection stays refused', async () => {
    await grant(U.viewerW2, { ws: W.W1, project: P.P1, role: 'admin' });
    const a = await app();
    const res = await a.inject({ method: 'PATCH', url: `/services/${probe}`, headers: h(U.viewerW2), payload: { environmentId: E.E1 } });
    expect(res.statusCode).toBe(403);
  });
});

describe('project-targeted writes use assertProjectRole (M19)', () => {
  it('a member project grant may write the project’s shared env; a viewer grant may not', async () => {
    const a = await buildTestApp({ db });
    await a.register(projectEnvRoutes, { prefix: '/projects' });
    const headers = { 'x-test-user': String(U.outsider), 'x-test-operator': 'false' };
    const write = () => a.inject({ method: 'POST', url: `/projects/${P.P1}/env`, headers, payload: { key: 'FROM_GUEST', value: 'v' } });
    expect((await write()).statusCode).toBe(404); // no relationship at all: the loader's 404
    const id = await grant(U.outsider, { ws: W.W1, project: P.P1, role: 'viewer' });
    expect((await write()).statusCode).toBe(403);
    await db.update(accessGrants).set({ role: 'member' }).where(eq(accessGrants.id, id));
    const res = await write();
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('database create: a project grant raises a seat, but a guest creates nothing (M19, DESIGN §4.1)', () => {
  async function create(userId: number, name: string) {
    const a = await buildTestApp({ db });
    await a.register(databasesRoutes, { prefix: '/databases' });
    return a.inject({
      method: 'POST',
      url: '/databases',
      headers: { 'x-test-user': String(userId), 'x-test-operator': 'false' },
      payload: { name, engine: 'postgres', projectId: P.P1 },
    });
  }

  it('a guest with a member project grant is refused, exactly as a non-member is', async () => {
    const nonMember = await create(U.outsider, 'guest-db-before');
    await grant(U.outsider, { ws: W.W1, project: P.P1, role: 'member' });
    const guest = await create(U.outsider, 'guest-db');
    expect(guest.statusCode).toBe(403);
    expect(guest.json()).toEqual(nonMember.json());
    expect(await db.query.databases.findFirst({ where: (d, { eq: e }) => e(d.name, 'guest-db') })).toBeUndefined();
    expect(engine.started).not.toContain('guest-db');
  });

  it('a viewer seat with a member project grant creates in that project, and only there', async () => {
    expect((await create(U.viewerW1, 'viewer-db-before')).statusCode).toBe(403);
    await grant(U.viewerW1, { ws: W.W1, project: P.P1, role: 'member' });
    const res = await create(U.viewerW1, 'viewer-db');
    expect(res.statusCode, res.body).toBe(200);
    expect(await db.query.databases.findFirst({ where: (d, { eq: e }) => e(d.name, 'viewer-db') })).toMatchObject({ projectId: P.P1, ownerUserId: U.viewerW1 });
    expect(engine.started).toContain('viewer-db');
    // P1b is outside the grant: the viewer seat alone stays read-only.
    const a = await buildTestApp({ db });
    await a.register(databasesRoutes, { prefix: '/databases' });
    const other = await a.inject({
      method: 'POST',
      url: '/databases',
      headers: { 'x-test-user': String(U.viewerW1), 'x-test-operator': 'false' },
      payload: { name: 'viewer-db-p1b', engine: 'postgres', projectId: P.P1b },
    });
    expect(other.statusCode).toBe(403);
  });
});

describe('project links and the pipeline’s shared-env trust honour project grants (M20)', () => {
  it('visibleProjectIds: max(seat, project grant) ≥ minRole', async () => {
    const u = as(U.viewerW2);
    expect(await visibleProjectIds(db, u, [P.P1, P.P2], 'member')).toEqual([]);
    await grant(U.viewerW2, { ws: W.W1, project: P.P1, role: 'member' });
    expect(await visibleProjectIds(db, u, [P.P1, P.P2], 'member')).toEqual([P.P1]);
    expect(await visibleProjectIds(db, u, [P.P1, P.P2], 'viewer')).toEqual([P.P1, P.P2]);
    expect(await visibleProjectIds(db, u, [P.P1, P.P2], 'admin')).toEqual([]);
  });

  it('filterTrustworthyProjectLinks: the owner’s member project grant counts, a viewer or suspended one does not', async () => {
    // 112 is owned by `outsider` (no seat in W1) and linked to P1.
    const links = [{ projectId: P.P1 }, { projectId: P.P2 }];
    const owner = { ownerUserId: U.outsider };
    expect(await filterTrustworthyProjectLinks(db, owner, links)).toEqual([]);
    const id = await grant(U.outsider, { ws: W.W1, project: P.P1, role: 'viewer' });
    expect(await filterTrustworthyProjectLinks(db, owner, links)).toEqual([]);
    await db.update(accessGrants).set({ role: 'member' }).where(eq(accessGrants.id, id));
    expect(await filterTrustworthyProjectLinks(db, owner, links)).toEqual([{ projectId: P.P1 }]);
    await db.update(accessGrants).set({ suspendedAt: new Date() }).where(eq(accessGrants.id, id));
    expect(await filterTrustworthyProjectLinks(db, owner, links)).toEqual([]);
  });
});

// ── lifecycle (M21, M22) ──

describe('member removal deletes the member’s grants in that workspace (M21)', () => {
  it('through DELETE /workspaces/:id/members/:memberId', async () => {
    await grant(U.memberW1, { ws: W.W1, project: P.P1, role: 'admin' });
    await grant(U.memberW1, { ws: W.W2, project: P.P2, role: 'viewer' });
    const seat = await db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, W.W1), eq(workspaceMembers.userId, U.memberW1)),
    });
    const app = await buildTestApp({ db });
    await app.register(workspaceRoutes, { prefix: '/workspaces' });
    const res = await app.inject({
      method: 'DELETE',
      url: `/workspaces/${W.W1}/members/${seat!.id}`,
      headers: { 'x-test-user': String(U.ownerW1), 'x-test-operator': 'false' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const left = await db.select().from(accessGrants).where(eq(accessGrants.userId, U.memberW1));
    expect(left.map((g) => g.workspaceId)).toEqual([W.W2]);
    // Removed, and no guest either.
    expect(await loads(() => ra.loadServiceForUser(db, 104, as(U.memberW1)))).toBe(false);
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'workspace.access_grant.delete'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({ userId: U.memberW1, workspaceId: W.W1, reason: 'member_removed' });
  });
});

describe('SCIM suspend, reinstate and delete (M22)', () => {
  const TOKEN = ['scim', 'w1', 'grants'].join('_');
  const LOCAL_HASH = '$argon2id$v=19$m=19456,t=2,p=1$fixture$fixture';
  async function scimApp() {
    await db.insert(scimTokens).values({ name: 'IdP W1', tokenHash: sha256(TOKEN), workspaceId: W.W1 });
    // A local account (argon2 hash): W1's IdP suspends its seat, never the account.
    await db.update(users).set({ passwordHash: LOCAL_HASH }).where(eq(users.id, U.multi));
    const app = await buildTestApp({ db });
    await app.register(scimRoutes, { prefix: '/scim/v2' });
    return app;
  }
  const patch = (app: FastifyInstance, active: boolean) =>
    app.inject({
      method: 'PATCH',
      url: `/scim/v2/Users/${U.multi}`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { Operations: [{ op: 'replace', path: 'active', value: active }] },
    });
  const grantsOf = () => db.select().from(accessGrants).where(eq(accessGrants.userId, U.multi));

  it('suspends the user’s grants in the workspace with the seat, and reinstates them', async () => {
    await grant(U.multi, { ws: W.W1, project: P.P1b, role: 'admin' });
    await grant(U.multi, { ws: W.W2, env: E.E2, role: 'admin' });
    const app = await scimApp();
    expect((await patch(app, false)).statusCode).toBe(200);
    const suspended = await grantsOf();
    expect(suspended.find((g) => g.workspaceId === W.W1)!.suspendedAt).not.toBeNull();
    expect(suspended.find((g) => g.workspaceId === W.W2)!.suspendedAt).toBeNull();
    expect(projectGrantOf(await ag.grantsForUser(db, U.multi), P.P1b)).toBeNull();
    expect(await ra.databaseRole(db, await dbRow(308), as(U.multi))).toBeNull();
    expect((await patch(app, true)).statusCode).toBe(200);
    expect((await grantsOf()).every((g) => g.suspendedAt === null)).toBe(true);
    expect(await ra.databaseRole(db, await dbRow(308), as(U.multi))).toBe('admin');
    const actions = (await db.select().from(auditLog)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['workspace.access_grant.suspend', 'workspace.access_grant.reinstate']));
  });

  it('DELETE removes the user’s grants in the workspace', async () => {
    await grant(U.multi, { ws: W.W1, project: P.P1b, role: 'admin' });
    await grant(U.multi, { ws: W.W2, env: E.E2, role: 'admin' });
    const app = await scimApp();
    const res = await app.inject({ method: 'DELETE', url: `/scim/v2/Users/${U.multi}`, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await grantsOf()).map((g) => g.workspaceId)).toEqual([W.W2]);
  });

  it('a refused DELETE (the workspace owner) leaves the grants alone', async () => {
    await grant(U.ownerW1, { ws: W.W1, project: P.P1, role: 'admin' });
    await db.update(users).set({ passwordHash: LOCAL_HASH }).where(eq(users.id, U.ownerW1));
    const app = await scimApp();
    const res = await app.inject({ method: 'DELETE', url: `/scim/v2/Users/${U.ownerW1}`, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(403);
    expect(await db.select().from(accessGrants).where(eq(accessGrants.userId, U.ownerW1))).toHaveLength(1);
  });
});

const projectGrantOf = (grants: Awaited<ReturnType<typeof ag.grantsForUser>>, projectId: number) => ag.projectGrantRole(grants, projectId);

// ── the routes (modules/accessGrants.ts) ──

describe('grant routes', () => {
  async function app() {
    // adminW1 also sits (as a viewer) in W2, so W2's members are accounts it
    // can already see in a member list — the only ones it may name.
    await db.insert(workspaceMembers).values({ workspaceId: W.W2, userId: U.adminW1, role: 'viewer' });
    const a = await buildTestApp({ db });
    await a.register(accessGrantRoutes, { prefix: '/workspaces' });
    await a.register(projectAccessRoutes, { prefix: '/projects' });
    await a.register(accessMeRoutes, { prefix: '/access' });
    return a;
  }
  const h = (id: number, operator = false) => ({ 'x-test-user': String(id), 'x-test-operator': String(operator) });
  const base = `/workspaces/${W.W1}/access-grants`;

  it('a workspace admin grants, lists, changes and revokes — every write audited', async () => {
    const a = await app();
    const created = await a.inject({ method: 'POST', url: base, headers: h(U.adminW1), payload: { email: 'VIEWERW2@world.test', projectId: P.P1, role: 'member' } });
    expect(created.statusCode, created.body).toBe(201);
    const g = created.json();
    expect(g).toMatchObject({
      workspaceId: W.W1,
      user: { id: U.viewerW2, email: 'viewerw2@world.test', name: 'viewerW2' },
      project: { id: P.P1, name: 'P1' },
      environment: null,
      role: 'member',
      suspended: false,
      createdBy: { id: U.adminW1 },
      isGuest: true,
    });
    expect(await ra.serviceRole(db, await svc(104), as(U.viewerW2))).toBe('member');

    const list = await a.inject({ method: 'GET', url: `${base}?userId=${U.viewerW2}`, headers: h(U.adminW1) });
    expect(list.json()).toHaveLength(1);
    expect((await a.inject({ method: 'GET', url: `${base}?environmentId=${E.E1}`, headers: h(U.adminW1) })).json()).toEqual([]);

    const changed = await a.inject({ method: 'PATCH', url: `${base}/${g.id}`, headers: h(U.adminW1), payload: { role: 'viewer' } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().role).toBe('viewer');

    const gone = await a.inject({ method: 'DELETE', url: `${base}/${g.id}`, headers: h(U.adminW1) });
    expect(gone.statusCode).toBe(200);
    expect(await ra.serviceRole(db, await svc(104), as(U.viewerW2))).toBeNull();

    const audit = await db.select().from(auditLog).where(inArray(auditLog.action, ['workspace.access_grant.create', 'workspace.access_grant.update', 'workspace.access_grant.delete']));
    expect(audit.map((r) => r.action)).toEqual(['workspace.access_grant.create', 'workspace.access_grant.update', 'workspace.access_grant.delete']);
    expect(audit[1]!.meta).toMatchObject({ grantId: g.id, userId: U.viewerW2, projectId: P.P1, environmentId: null, role: 'viewer', previousRole: 'member' });
  });

  it('refuses members, viewers and non-members (404 for non-members, like a missing workspace)', async () => {
    const a = await app();
    const payload = { userId: U.viewerW2, projectId: P.P1, role: 'viewer' };
    expect((await a.inject({ method: 'POST', url: base, headers: h(U.memberW1), payload })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: base, headers: h(U.viewerW1) })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: base, headers: h(U.ownerW2) })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/workspaces/999/access-grants', headers: h(U.operator, true) })).statusCode).toBe(404);
    // A guest holding an admin grant is still no workspace admin.
    await grant(U.outsider, { ws: W.W1, project: P.P1, role: 'admin' });
    expect((await a.inject({ method: 'POST', url: base, headers: h(U.outsider), payload })).statusCode).toBe(404);
    expect(await db.select().from(accessGrants)).toHaveLength(1);
  });

  it('never grants owner, needs a target and one subject', async () => {
    const a = await app();
    for (const payload of [
      { userId: U.viewerW2, projectId: P.P1, role: 'owner' },
      { userId: U.viewerW2, role: 'member' },
      { userId: U.viewerW2, email: 'viewerw2@world.test', projectId: P.P1, role: 'member' },
    ]) {
      expect((await a.inject({ method: 'POST', url: base, headers: h(U.ownerW1), payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await a.inject({ method: 'POST', url: base, headers: h(U.operator, true), payload: { userId: U.viewerW2, projectId: P.P1, role: 'owner' } })).statusCode).toBe(400);
  });

  it('targets must sit in the grant’s workspace', async () => {
    const a = await app();
    const post = (payload: object) => a.inject({ method: 'POST', url: base, headers: h(U.adminW1), payload: { userId: U.viewerW2, role: 'member', ...payload } });
    expect((await post({ projectId: P.P2 })).statusCode).toBe(404);
    expect((await post({ projectId: P.P0 })).statusCode).toBe(404);
    expect((await post({ environmentId: E.E2 })).statusCode).toBe(404);
    expect((await post({ projectId: 999 })).statusCode).toBe(404);
    expect((await post({ projectId: P.P1, environmentId: E.E1b })).statusCode).toBe(201);
  });

  it('409 on a duplicate target; an unknown or unseen account gets the same 404', async () => {
    const a = await app();
    const post = (payload: object) => a.inject({ method: 'POST', url: base, headers: h(U.adminW1), payload: { projectId: P.P1, role: 'member', ...payload } });
    expect((await post({ userId: U.viewerW2 })).statusCode).toBe(201);
    const dup = await post({ email: 'viewerw2@world.test' });
    expect(dup.statusCode).toBe(409);
    // `outsider` shares no workspace with adminW1: indistinguishable from an unknown address.
    const unseen = await post({ email: 'outsider@world.test' });
    const unknown = await post({ email: 'nobody@world.test' });
    expect([unseen.statusCode, unknown.statusCode]).toEqual([404, 404]);
    expect(unseen.json().error.message).toBe(unknown.json().error.message);
    expect((await post({ userId: 999 })).statusCode).toBe(404);
    // An operator sees every account, so may name one no admin could.
    const op = await a.inject({ method: 'POST', url: base, headers: h(U.operator, true), payload: { email: 'outsider@world.test', projectId: P.P1, role: 'viewer' } });
    expect(op.statusCode, op.body).toBe(201);
    // …and once a grant exists here, the workspace's admins can see and extend it.
    expect((await post({ email: 'outsider@world.test', environmentId: E.E1, projectId: undefined })).statusCode).toBe(201);
  });

  it('refuses a deactivated account', async () => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: base, headers: h(U.adminW1), payload: { userId: U.deactivated, projectId: P.P1, role: 'viewer' } });
    expect(res.statusCode).toBe(409);
  });

  it('PATCH and DELETE only reach grants of the workspace in the path', async () => {
    const other = await grant(U.viewerW1, { ws: W.W2, project: P.P2, role: 'viewer' });
    const a = await app();
    expect((await a.inject({ method: 'PATCH', url: `${base}/${other}`, headers: h(U.adminW1), payload: { role: 'admin' } })).statusCode).toBe(404);
    expect((await a.inject({ method: 'DELETE', url: `${base}/${other}`, headers: h(U.adminW1) })).statusCode).toBe(404);
    expect((await db.select().from(accessGrants))[0]!.role).toBe('viewer');
  });

  it('GET /projects/:id/access explains every path to the project (project admin only)', async () => {
    await grant(U.viewerW1, { ws: W.W1, project: P.P1, role: 'member' });
    await grant(U.outsider, { ws: W.W1, project: P.P1, role: 'admin' });
    await grant(U.viewerW2, { ws: W.W1, project: P.P1, env: E.E1, role: 'admin' }); // not a project grant
    await grant(U.ownerW2, { ws: W.W1, project: P.P1, role: 'admin', suspended: true });
    const a = await app();
    const res = await a.inject({ method: 'GET', url: `/projects/${P.P1}/access`, headers: h(U.adminW1) });
    expect(res.statusCode, res.body).toBe(200);
    const by = new Map((res.json() as Array<{ user: { id: number }; role: string; via: string[] }>).map((e) => [e.user.id, e]));
    expect(by.get(U.operator)).toMatchObject({ role: 'owner', via: ['operator'] });
    expect(by.get(U.ownerW1)).toMatchObject({ role: 'owner', via: ['seat'] });
    expect(by.get(U.viewerW1)).toMatchObject({ role: 'member', via: ['seat', 'grant'] });
    expect(by.get(U.outsider)).toMatchObject({ role: 'admin', via: ['grant'] });
    expect(by.has(U.viewerW2)).toBe(false);
    expect(by.has(U.ownerW2)).toBe(false);
    expect(by.has(U.deactivated)).toBe(false);
    // A member seat is below the floor; a guest with an admin project grant reaches it.
    expect((await a.inject({ method: 'GET', url: `/projects/${P.P1}/access`, headers: h(U.memberW1) })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: `/projects/${P.P1}/access`, headers: h(U.outsider) })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: `/projects/${P.P2}/access`, headers: h(U.outsider) })).statusCode).toBe(404);
  });

  it('GET /access/me lists the caller’s own grants and the workspaces they reach only as a guest', async () => {
    await grant(U.viewerW2, { ws: W.W1, project: P.P1, role: 'member' });
    await grant(U.viewerW2, { ws: W.W2, project: P.P2, role: 'admin' });
    const a = await app();
    const res = await a.inject({ method: 'GET', url: '/access/me', headers: h(U.viewerW2) });
    expect(res.statusCode).toBe(200);
    const me = res.json() as { grants: Array<{ workspaceId: number; isGuest: boolean }>; guestWorkspaces: Array<{ id: number; slug: string }> };
    expect(me.grants.map((g) => [g.workspaceId, g.isGuest])).toEqual(expect.arrayContaining([[W.W1, true], [W.W2, false]]));
    expect(me.guestWorkspaces).toEqual([{ id: W.W1, name: 'W1', slug: 'w1' }]);
    const empty = await a.inject({ method: 'GET', url: '/access/me', headers: h(U.outsider) });
    expect(empty.json()).toEqual({ grants: [], guestWorkspaces: [] });
  });
});
