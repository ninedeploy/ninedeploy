import { describe, expect, it, vi } from 'vitest';
import {
  assertWorkspaceRole,
  maxRole,
  requireAccess,
  requireResourceAccess,
  roleAtLeast,
  userWorkspaceIds,
} from '../../src/lib/resourceAccess.js';
import { createFakeDb, dbRow, NOW, svcRow } from '../helpers.js';

/** Minimal `projects` row (the shared helpers do not ship one). */
const projectRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  workspaceId: 1,
  name: 'Acme',
  slug: 'acme',
  description: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const operator = { id: 1, role: 'admin' as const, isOperator: true };
const member = { id: 7, role: 'member' as const, isOperator: false };

/** Minimal Fastify request shape the prehandlers read. */
const reqFor = (db: unknown, params: Record<string, string>, user = operator) =>
  ({ params, user, server: { db } }) as never;

describe('roleAtLeast', () => {
  it('ranks owner above admin above member above viewer', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'admin')).toBe(true);
    expect(roleAtLeast('member', 'admin')).toBe(false);
    expect(roleAtLeast('viewer', 'member')).toBe(false);
  });
});

describe('maxRole', () => {
  it('returns null without any seat', () => {
    expect(maxRole([])).toBeNull();
  });

  it('picks the highest seat the user holds', () => {
    expect(
      maxRole([
        { workspaceId: 1, role: 'viewer' },
        { workspaceId: 2, role: 'admin' },
        { workspaceId: 3, role: 'member' },
      ]),
    ).toBe('admin');
  });

  it('keeps the floor when every seat is a viewer', () => {
    expect(maxRole([{ workspaceId: 1, role: 'viewer' }])).toBe('viewer');
  });
});

describe('assertWorkspaceRole', () => {
  it('accepts a seat that meets the required role', async () => {
    const db = createFakeDb({ findFirst: { workspaceMembers: { workspaceId: 1, userId: 7, role: 'admin' } } } as never);
    await expect(assertWorkspaceRole(db, 1, member, 'member')).resolves.toBeUndefined();
  });

  it('accepts any of a list of acceptable roles', async () => {
    const db = createFakeDb({ findFirst: { workspaceMembers: { workspaceId: 1, userId: 7, role: 'viewer' } } } as never);
    await expect(assertWorkspaceRole(db, 1, member, ['owner', 'viewer'])).resolves.toBeUndefined();
  });

  it('r219: lets an instance operator through without a seat', async () => {
    const db = createFakeDb({ findFirst: { workspaceMembers: undefined } } as never);
    await expect(assertWorkspaceRole(db, 1, { ...member, isOperator: true }, 'admin')).resolves.toBeUndefined();
    await expect(assertWorkspaceRole(db, 1, { ...member, isOperator: false }, 'viewer')).rejects.toThrow(/Insufficient role/);
  });

  it('rejects a seat below the required role', async () => {
    const db = createFakeDb({ findFirst: { workspaceMembers: { workspaceId: 1, userId: 7, role: 'viewer' } } } as never);
    await expect(assertWorkspaceRole(db, 1, member, 'admin')).rejects.toThrow(/Insufficient role/);
  });

  it('rejects a caller with no seat at all', async () => {
    const db = createFakeDb({ findFirst: { workspaceMembers: undefined } } as never);
    await expect(assertWorkspaceRole(db, 1, member, 'viewer')).rejects.toThrow(/Insufficient role/);
  });
});

describe('userWorkspaceIds', () => {
  it('maps the memberships down to their workspace ids', async () => {
    const db = createFakeDb({
      findMany: {
        workspaceMembers: [
          { workspaceId: 4, userId: 7, role: 'member' },
          { workspaceId: 5, userId: 7, role: 'viewer' },
        ],
      },
    } as never);
    expect(await userWorkspaceIds(db, 7)).toEqual([4, 5]);
  });
});

describe('requireResourceAccess', () => {
  const operatorDb = (fixtures: Record<string, unknown>) =>
    createFakeDb({
      ...fixtures,
      findMany: { workspaceMembers: [{ workspaceId: 1, userId: 1, role: 'owner' }] },
    } as never);

  it('dispatches to the service loader', async () => {
    const db = operatorDb({ findFirst: { services: svcRow({ id: 1 }) } });
    expect(await requireResourceAccess(db, 'service', 1, operator)).toEqual(expect.objectContaining({ id: 1 }));
  });

  it('dispatches to the project loader', async () => {
    const db = operatorDb({ findFirst: { projects: projectRow({ id: 2 }) } });
    expect(await requireResourceAccess(db, 'project', 2, operator)).toEqual(expect.objectContaining({ id: 2 }));
  });

  it('dispatches to the database loader', async () => {
    const db = operatorDb({ findFirst: { databases: dbRow({ id: 3 }) } });
    expect(await requireResourceAccess(db, 'database', 3, operator)).toEqual(expect.objectContaining({ id: 3 }));
  });
});

describe('requireAccess prehandler', () => {
  const db = createFakeDb({
    findFirst: { services: svcRow({ id: 1 }) },
    findMany: { workspaceMembers: [{ workspaceId: 1, userId: 1, role: 'owner' }] },
  } as never);

  it('resolves for a visible resource', async () => {
    await expect(requireAccess('service')(reqFor(db, { id: '1' }), {} as never)).resolves.toBeUndefined();
  });

  it('reads a custom route parameter', async () => {
    await expect(
      requireAccess('service', 'serviceId')(reqFor(db, { serviceId: '1' }), {} as never),
    ).resolves.toBeUndefined();
  });

  it('404s when the route parameter is absent', async () => {
    await expect(requireAccess('service')(reqFor(db, {}), {} as never)).rejects.toThrow(/Resource not found/);
  });

  it('404s when the resource is not visible', async () => {
    const empty = createFakeDb({ findFirst: { services: undefined } } as never);
    await expect(requireAccess('service')(reqFor(empty, { id: '9' }), {} as never)).rejects.toThrow();
  });
});

// Guard against an accidental import-time side effect in the module.
it('exposes the helpers as plain functions', () => {
  expect(vi.isMockFunction(roleAtLeast)).toBe(false);
});
