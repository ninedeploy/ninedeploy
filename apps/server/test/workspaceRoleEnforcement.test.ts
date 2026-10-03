/**
 * Regression guard: the workspace role hierarchy is actually enforced.
 *
 * `docs/WORKSPACES_RBAC.md` publishes a permission matrix across
 * owner > admin > member > viewer. Until 0.3.5 the helpers that implement it
 * (`roleAtLeast`, `assertWorkspaceRole`) had ZERO call sites in the route
 * layer, so a `viewer` could create services, rewrite environment variables
 * and trigger deploys exactly like an `owner` — the roles existed in the UI
 * and in the docs, and nowhere else.
 *
 * `assertServiceRole` is the enforcement point. These tests pin the two
 * decisions that matter:
 *   • a viewer can READ a shared service but not write to it, and
 *   • an ordinary member can write but not destroy or re-home it.
 */
import { describe, expect, it, vi } from 'vitest';
import { assertDatabaseRole, assertServiceRole, databaseRole, serviceRole } from '../src/lib/resourceAccess.js';
import { deploysRoutes } from '../src/modules/deploys.js';
import { servicesRoutes } from '../src/modules/services.js';
import { envRoutes } from '../src/modules/env.js';
import { asUser, buildTestApp, createFakeDb, dbRow, svcRow } from './helpers.js';

vi.mock('../src/lib/exec.js', () => ({
  capture: vi.fn(async () => 'out'),
  run: vi.fn(async () => undefined),
}));
vi.mock('../src/engine/proxy.js', () => ({
  writeDynamicConfig: vi.fn(async () => undefined),
  NETWORK: 'ninedeploy',
}));

const VIEWER = 21;
const MEMBER = 22;
const ADMIN = 23;
/** A service owned by nobody in particular, shared through workspace 1. */
const shared = svcRow({ id: 5, ownerUserId: 99, runtimeId: 'nd-app-shared' });

/**
 * Fake db where the service is tagged into workspace 1 and the caller holds
 * `role` there. `serviceRole` reads `service_workspaces` then the caller's
 * seats in those workspaces.
 */
function dbWithSeat(role: string, userId: number, extra: Record<string, unknown> = {}) {
  return createFakeDb({
    findFirst: { services: shared, ...(extra['findFirst'] as object) },
    findMany: {
      serviceWorkspaces: [{ serviceId: shared.id, workspaceId: 1 }],
      workspaceMembers: [{ id: 1, workspaceId: 1, userId, role }],
      ...(extra['findMany'] as object),
    },
    ...extra,
  } as never);
}

describe('serviceRole', () => {
  it('reports the highest seat the caller holds across the service tags', async () => {
    const db = dbWithSeat('admin', ADMIN);
    expect(await serviceRole(db, shared, { id: ADMIN, isOperator: false })).toBe('admin');
  });

  it('treats the service owner as owner even without a workspace tag', async () => {
    const db = createFakeDb({ findMany: { serviceWorkspaces: [], workspaceMembers: [] } } as never);
    expect(await serviceRole(db, shared, { id: 99, isOperator: false })).toBe('owner');
  });

  it('treats an instance operator as owner everywhere', async () => {
    const db = createFakeDb({ findMany: { serviceWorkspaces: [], workspaceMembers: [] } } as never);
    expect(await serviceRole(db, shared, { id: 1234, isOperator: true })).toBe('owner');
  });

  it('returns null for someone with no relationship to the service', async () => {
    const db = createFakeDb({
      findMany: { serviceWorkspaces: [{ serviceId: shared.id, workspaceId: 1 }], workspaceMembers: [] },
    } as never);
    expect(await serviceRole(db, shared, { id: 404, isOperator: false })).toBeNull();
  });
});

describe('assertServiceRole', () => {
  it('accepts a seat at or above the required role', async () => {
    const db = dbWithSeat('admin', ADMIN);
    await expect(
      assertServiceRole(db, shared, { id: ADMIN, isOperator: false }, 'member'),
    ).resolves.toBeUndefined();
  });

  it('rejects a seat below the required role', async () => {
    const db = dbWithSeat('viewer', VIEWER);
    await expect(
      assertServiceRole(db, shared, { id: VIEWER, isOperator: false }, 'member'),
    ).rejects.toThrow(/requires the "member" role/);
  });

  it('rejects a caller with no seat at all', async () => {
    const db = createFakeDb({
      findMany: { serviceWorkspaces: [{ serviceId: shared.id, workspaceId: 1 }], workspaceMembers: [] },
    } as never);
    await expect(
      assertServiceRole(db, shared, { id: 404, isOperator: false }, 'viewer'),
    ).rejects.toThrow(/requires the "viewer" role/);
  });
});

describe('viewer seats are read-only over HTTP', () => {
  async function appAs(role: string, userId: number) {
    const app = await buildTestApp({ db: dbWithSeat(role, userId) });
    await app.register(servicesRoutes, { prefix: '/services' });
    await app.register(deploysRoutes, { prefix: '/services' });
    await app.register(envRoutes, { prefix: '/services' });
    return app;
  }

  it('lets a viewer read the service', async () => {
    const app = await appAs('viewer', VIEWER);
    const res = await app.inject({
      method: 'GET',
      url: '/services/5',
      headers: asUser({ id: VIEWER, isOperator: false }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a viewer-triggered deploy', async () => {
    const app = await appAs('viewer', VIEWER);
    const res = await app.inject({
      method: 'POST',
      url: '/services/5/deploys',
      headers: asUser({ id: VIEWER, isOperator: false }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a viewer-written environment variable', async () => {
    const app = await appAs('viewer', VIEWER);
    const res = await app.inject({
      method: 'POST',
      url: '/services/5/env',
      headers: asUser({ id: VIEWER, isOperator: false }),
      payload: { key: 'SNEAKY', value: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a viewer-triggered restart', async () => {
    const app = await appAs('viewer', VIEWER);
    const res = await app.inject({
      method: 'POST',
      url: '/services/5/restart',
      headers: asUser({ id: VIEWER, isOperator: false }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a viewer from cloning a service with its secrets', async () => {
    const app = await appAs('viewer', VIEWER);
    const res = await app.inject({
      method: 'POST',
      url: '/services/5/clone',
      headers: asUser({ id: VIEWER, isOperator: false }),
      payload: { name: 'copied-secrets' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets a member write the same environment variable', async () => {
    const app = await appAs('member', MEMBER);
    const res = await app.inject({
      method: 'POST',
      url: '/services/5/env',
      headers: asUser({ id: MEMBER, isOperator: false }),
      payload: { key: 'OK', value: 'x' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('destroying a service needs admin, not member', () => {
  async function appAs(role: string, userId: number) {
    const app = await buildTestApp({ db: dbWithSeat(role, userId) });
    await app.register(servicesRoutes, { prefix: '/services' });
    return app;
  }

  it('refuses a member-initiated delete', async () => {
    const app = await appAs('member', MEMBER);
    const res = await app.inject({
      method: 'DELETE',
      url: '/services/5',
      headers: asUser({ id: MEMBER, isOperator: false }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows an admin-initiated delete to get past the role gate', async () => {
    const app = await appAs('admin', ADMIN);
    const res = await app.inject({
      method: 'DELETE',
      url: '/services/5',
      headers: asUser({ id: ADMIN, isOperator: false }),
    });
    // Past the role gate — whatever the delete flow answers, it is not the
    // role rejection.
    expect(res.statusCode).not.toBe(403);
  });
});

// ── managed databases ──────────────────────────────────────────────────────
//
// A database has no tag table: its workspace comes from its PROJECT. These
// pin the same hierarchy on that path, including the two fallbacks (creator
// and instance operator both resolve as `owner`).

const managed = dbRow({ id: 11, ownerUserId: 99, projectId: 5 });

function dbWithProjectSeat(role: string, userId: number) {
  return createFakeDb({
    findFirst: {
      databases: managed,
      projects: { id: 5, workspaceId: 1, name: 'P', slug: 'p' },
      workspaceMembers: { id: 1, workspaceId: 1, userId, role },
    },
  } as never);
}

describe('databaseRole', () => {
  it('resolves the seat held in the owning project’s workspace', async () => {
    const db = dbWithProjectSeat('admin', ADMIN);
    expect(await databaseRole(db, managed, { id: ADMIN, isOperator: false })).toBe('admin');
  });

  it('treats the database creator as owner even without a project', async () => {
    const db = createFakeDb({} as never);
    expect(await databaseRole(db, { ownerUserId: 99, projectId: null }, { id: 99, isOperator: false })).toBe('owner');
  });

  it('treats an instance operator as owner', async () => {
    const db = createFakeDb({} as never);
    expect(await databaseRole(db, managed, { id: 1234, isOperator: true })).toBe('owner');
  });

  it('returns null for an unscoped database the caller does not own', async () => {
    const db = createFakeDb({} as never);
    expect(
      await databaseRole(db, { ownerUserId: 99, projectId: null }, { id: 7, isOperator: false }),
    ).toBeNull();
  });

  it('returns null when the owning project has no workspace', async () => {
    const db = createFakeDb({ findFirst: { projects: { id: 5, workspaceId: null } } } as never);
    expect(await databaseRole(db, managed, { id: 7, isOperator: false })).toBeNull();
  });

  it('returns null when the caller holds no seat in that workspace', async () => {
    const db = createFakeDb({
      findFirst: { projects: { id: 5, workspaceId: 1 }, workspaceMembers: undefined },
    } as never);
    expect(await databaseRole(db, managed, { id: 7, isOperator: false })).toBeNull();
  });
});

describe('assertDatabaseRole', () => {
  it('accepts a seat at or above the required role', async () => {
    const db = dbWithProjectSeat('admin', ADMIN);
    await expect(
      assertDatabaseRole(db, managed, { id: ADMIN, isOperator: false }, 'member'),
    ).resolves.toBeUndefined();
  });

  it('rejects a member asked for admin — e.g. taking a full data dump', async () => {
    const db = dbWithProjectSeat('member', MEMBER);
    await expect(
      assertDatabaseRole(db, managed, { id: MEMBER, isOperator: false }, 'admin'),
    ).rejects.toThrow(/requires the "admin" role/);
  });

  it('rejects a caller with no relationship at all', async () => {
    const db = createFakeDb({} as never);
    await expect(
      assertDatabaseRole(db, { ownerUserId: 99, projectId: null }, { id: 7, isOperator: false }, 'viewer'),
    ).rejects.toThrow(/requires the "viewer" role/);
  });
});
