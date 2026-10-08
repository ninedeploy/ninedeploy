/**
 * 0.15 T5 — the upgrade proof for access grants (DESIGN §4.6, §4.7).
 *
 * Grants are raise-only (owner decision O5): a user's role is
 * `max(seat, grants)`, so with `access_grants` empty every access decision
 * must be exactly v0.14.0's. This file compares the LIVE resolution code with
 * a frozen verbatim copy of v0.14.0's (`fixtures/resourceAccess014.ts`) for
 * every user × resource × action of a world that holds every shape the v0.14
 * code distinguishes (operators, owners, admins, members, viewers, a member of
 * two workspaces, a creator who left, an outsider, deactivated accounts,
 * untagged / multi-tagged / ownerless services, databases with no project or
 * an unscoped one, …).
 *
 * The two seat reads that live inside route handlers (environment selection on
 * service PATCH and the environment list) are compared through the real routes.
 *
 * `ND_EQUIV_OUT=<file>` writes the compared decisions (with their count and a
 * digest) to a file: the evidence kept for the before/after runs.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, services, type DB } from '@ninedeploy/db';

vi.mock('../src/lib/retainedSlugVolume.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/retainedSlugVolume.js')>()),
  assertPrimaryVolumeNotAttachedElsewhere: vi.fn(async () => undefined),
  assertSlugVolumeNotRetained: vi.fn(async () => undefined),
}));
vi.mock('../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/proxy.js')>()),
  writeDynamicConfig: vi.fn(async () => undefined),
}));

const v014 = await import('./fixtures/resourceAccess014.js');
const live = await import('../src/lib/resourceAccess.js');
const { visibleProjectIds } = await import('../src/modules/projects.js');
const { filterTrustworthyProjectLinks } = await import('../src/engine/pipeline.js');
const { defaultWorkspaceIdsForUser } = await import('../src/modules/serviceTags.js');
const { visibleLabelIds } = await import('../src/modules/labels.js');
const { servicesRoutes } = await import('../src/modules/services.js');
const { environmentRoutes } = await import('../src/modules/environments.js');
const { buildTestApp } = await import('./helpers.js');
const world = await import('./fixtures/accessWorld.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));

let dir: string;
let db: DB;
let close: () => void;
let app: FastifyInstance;

type AnyUser = { id: number; isOperator: boolean };
const headers = (u: AnyUser) => ({ 'x-test-user': String(u.id), 'x-test-operator': String(u.isOperator) });
const probeIds = Object.values(world.U).map(world.probeServiceId);

/** The two in-handler seat reads, asked through the real routes. */
const http = {
  async environmentSelectable(u: AnyUser, envId: number): Promise<boolean> {
    if (!probeIds.includes(world.probeServiceId(u.id))) return false; // no probe service: the ghost user
    const res = await app.inject({
      method: 'PATCH',
      url: `/services/${world.probeServiceId(u.id)}`,
      headers: headers(u),
      payload: { environmentId: envId },
    });
    // Put the probe back, so no later decision sees the lane it took.
    await db.update(services).set({ environmentId: null }).where(inArray(services.id, probeIds));
    if (res.statusCode === 200) return true;
    if (res.statusCode === 403 && /access to this environment/.test(res.body)) return false;
    throw new Error(`environment probe for user ${u.id}: ${res.statusCode} ${res.body}`);
  },
  async visibleEnvironmentIds(u: AnyUser): Promise<number[]> {
    const res = await app.inject({ method: 'GET', url: '/environments', headers: headers(u) });
    if (res.statusCode !== 200) throw new Error(`environment list for user ${u.id}: ${res.statusCode} ${res.body}`);
    return (res.json() as Array<{ id: number }>).map((e) => e.id);
  },
};

const impl014: import('./fixtures/accessWorld.js').AccessImpl = {
  loadServiceForUser: v014.loadServiceForUser,
  serviceRole: v014.serviceRole,
  assertServiceRole: v014.assertServiceRole,
  visibleServiceIdSet: v014.visibleServiceIdSet,
  loadProjectForUser: v014.loadProjectForUser,
  projectScopeFilter: v014.projectScopeFilter,
  loadDatabaseForUser: v014.loadDatabaseForUser,
  visibleDatabaseIds: v014.visibleDatabaseIds,
  databaseRole: v014.databaseRole,
  assertDatabaseRole: v014.assertDatabaseRole,
  assertWorkspaceRole: v014.assertWorkspaceRole,
  isWorkspaceMember: v014.isWorkspaceMember,
  assertWorkspaceMember: v014.assertWorkspaceMember,
  userWorkspaceIds: v014.userWorkspaceIds,
  userWorkspaceMemberships: v014.userWorkspaceMemberships,
  isOperator: v014.isOperator,
  requireResourceAccess: v014.requireResourceAccess,
  assertCanManageService: v014.assertCanManageService,
  // v0.14 databases.ts:156 / env.ts:390,420,445 on a project with a workspace.
  projectWrite: async (d, project, user, r) => {
    if (!user.isOperator && project.workspaceId != null) await v014.assertWorkspaceRole(d, project.workspaceId, user, r);
  },
  visibleProjectIds: (d, u, ids, r) => v014.visibleProjectIds014(d, u, ids, r),
  filterTrustworthyProjectLinks: v014.filterTrustworthyProjectLinks014,
  defaultWorkspaceIdsForUser: v014.defaultWorkspaceIdsForUser014,
  visibleLabelIds: v014.visibleLabelIds014,
  environmentSelectable: async (u, envId) => {
    const envRow = await db.query.environments.findFirst({ where: (e, { eq: eqOp }) => eqOp(e.id, envId) });
    return v014.environmentSelectable014(db, u, envRow!);
  },
  visibleEnvironmentIds: (u) => v014.visibleEnvironmentIds014(db, u),
};

const implLive: import('./fixtures/accessWorld.js').AccessImpl = {
  loadServiceForUser: live.loadServiceForUser,
  serviceRole: live.serviceRole,
  assertServiceRole: live.assertServiceRole,
  visibleServiceIdSet: live.visibleServiceIdSet,
  loadProjectForUser: live.loadProjectForUser,
  projectScopeFilter: live.projectScopeFilter,
  loadDatabaseForUser: live.loadDatabaseForUser,
  visibleDatabaseIds: live.visibleDatabaseIds,
  databaseRole: live.databaseRole,
  assertDatabaseRole: live.assertDatabaseRole,
  assertWorkspaceRole: live.assertWorkspaceRole,
  isWorkspaceMember: live.isWorkspaceMember,
  assertWorkspaceMember: live.assertWorkspaceMember,
  userWorkspaceIds: live.userWorkspaceIds,
  userWorkspaceMemberships: live.userWorkspaceMemberships,
  isOperator: live.isOperator,
  requireResourceAccess: live.requireResourceAccess,
  assertCanManageService: live.assertCanManageService,
  // 0.15: the same call sites now ask assertProjectRole (DESIGN §4.2, M19).
  projectWrite: async (d, project, user, r) => {
    if (!user.isOperator && project.workspaceId != null) await live.assertProjectRole(d, project, user, r);
  },
  visibleProjectIds: (d, u, ids, r) => visibleProjectIds(d, u, ids, r),
  filterTrustworthyProjectLinks,
  defaultWorkspaceIdsForUser,
  visibleLabelIds,
  environmentSelectable: (u, envId) => http.environmentSelectable(u, envId),
  visibleEnvironmentIds: (u) => http.visibleEnvironmentIds(u),
};

beforeAll(async () => {
  vi.stubEnv('DOCKER_HOST', 'tcp://127.0.0.1:9');
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-grant-equiv-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await world.seedWorld(db);
}, 60_000);

/** The real routes behind the two in-handler seat reads (helpers.ts closes it after the test). */
async function startApp(): Promise<void> {
  app = await buildTestApp({ db });
  await app.register(servicesRoutes, { prefix: '/services' });
  await app.register(environmentRoutes, { prefix: '/environments' });
  await app.ready();
}

afterAll(async () => {
  close?.();
  vi.unstubAllEnvs();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

describe('0.15 access grants: with access_grants empty, every decision is v0.14.0', () => {
  it('the world holds no grant', async () => {
    expect((await world.tableCounts(db)).access_grants).toBe(0);
  });

  it('live code === frozen v0.14.0 copy, for every user × resource × action', async () => {
    await startApp();
    const before = await world.tableCounts(db);
    const expected = await world.snapshot(db, impl014);
    const actual = await world.snapshot(db, implLive);
    // Neither run wrote anything (the environment probe restores its row).
    expect(await world.tableCounts(db)).toEqual(before);
    const keys = Object.keys(expected);
    expect(Object.keys(actual)).toEqual(keys);
    // A world too small to tell anything apart would make this vacuous.
    expect(keys.length).toBeGreaterThan(3000);
    const allowed = Object.values(expected).filter((v) => v === 'ok' || v === true).length;
    const refused = Object.values(expected).filter((v) => typeof v === 'string' && /^40[34]:/.test(v)).length;
    expect(allowed).toBeGreaterThan(300);
    expect(refused).toBeGreaterThan(300);
    const mismatches = keys.filter((k) => JSON.stringify(expected[k]) !== JSON.stringify(actual[k]));
    const out = process.env.ND_EQUIV_OUT;
    if (out) {
      const body = JSON.stringify(expected, Object.keys(expected).sort());
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            decisions: keys.length,
            allowed,
            refused,
            mismatches: mismatches.length,
            sha256: createHash('sha256').update(body).digest('hex'),
          },
          null,
          2,
        )}\n${mismatches.map((k) => `${k}: v0.14=${JSON.stringify(expected[k])} live=${JSON.stringify(actual[k])}`).join('\n')}\n${keys
          .sort()
          .map((k) => `${k} = ${JSON.stringify(expected[k])}`)
          .join('\n')}\n`,
      );
    }
    expect(mismatches.map((k) => `${k}: v0.14=${JSON.stringify(expected[k])} live=${JSON.stringify(actual[k])}`)).toEqual([]);
  }, 120_000);

  it('the extracted environment helpers agree with the v0.14 inline seat reads', async () => {
    const envs = await db.query.environments.findMany();
    const all = await db.query.environments.findMany({ orderBy: (e, { asc }) => [asc(e.name)] });
    for (const u of world.worldUsers()) {
      for (const e of envs) {
        expect(await live.mayUseEnvironment(db, u, e), `${u.key} → env ${e.id}`).toBe(await v014.environmentSelectable014(db, u, e));
      }
      const scope = await live.environmentVisibility(db, u);
      const listed = scope === null ? all : all.filter((e) => scope.workspaceIds.has(e.workspaceId) || scope.environmentIds.has(e.id));
      expect(listed.map((e) => e.id), u.key).toEqual(await v014.visibleEnvironmentIds014(db, u));
    }
  });

  it('the fixture world covers every caller shape the v0.14 code distinguishes', async () => {
    const ws = await db.query.workspaceMembers.findMany();
    const roles = new Set(ws.map((m) => m.role));
    expect([...roles].sort()).toEqual(['admin', 'member', 'owner', 'viewer']);
    const deactivated = await db.query.users.findMany({ where: (u, { isNotNull }) => isNotNull(u.deactivatedAt) });
    expect(deactivated.length).toBe(2);
    const untagged = (await db.select().from(services)).filter((s) => s.ownerUserId == null);
    expect(untagged.length).toBeGreaterThan(0);
    expect(await db.query.services.findFirst({ where: eq(services.id, 106) })).toBeTruthy();
  });
});
