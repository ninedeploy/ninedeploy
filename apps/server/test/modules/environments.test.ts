import { describe, expect, it, vi } from 'vitest';
import { environmentRoutes } from '../../src/modules/environments.js';
import { asUser, buildTestApp, createFakeDb } from '../helpers.js';

const member = (role: string) => ({
  id: 1,
  workspaceId: 1,
  userId: 7,
  role,
  createdAt: new Date('2026-01-01T00:00:00Z'),
});

const envRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  workspaceId: 1,
  name: 'Production',
  slug: 'production',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
});

describe('environments', () => {
  it('lists environments with service counts for a workspace member', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          workspaceMembers: [member('member')],
          environments: [envRow()],
        },
        select: { services: [{ environmentId: 1 }, { environmentId: 1 }, { environmentId: null }] },
      }),
    });
    await app.register(environmentRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser({ id: 7, isOperator: false }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([expect.objectContaining({ id: 1, name: 'Production', serviceCount: 2 })]);
    await app.close();
  });

  it('hides other workspaces’ environments from a member', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          workspaceMembers: [],
          environments: [envRow({ workspaceId: 9 })],
        },
        select: { services: [] },
      }),
    });
    await app.register(environmentRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser({ id: 7, isOperator: false }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it('creates an environment for a workspace member', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { workspaceMembers: member('member') },
        insert: {
          environments: [envRow({ id: 2, name: 'Staging', slug: 'staging' })],
        },
      }),
    });
    await app.register(environmentRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser({ id: 7, isOperator: false }),
      payload: { workspaceId: 1, name: 'Staging' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 2, name: 'Staging', slug: 'staging' });
    await app.close();
  });

  it('refuses creation from a viewer seat (403)', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { workspaceMembers: member('viewer') },
      }),
    });
    await app.register(environmentRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser({ id: 7, isOperator: false }),
      payload: { workspaceId: 1, name: 'Staging' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('renames an environment for a member', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          environments: envRow(),
          workspaceMembers: member('member'),
        },
        update: { environments: [envRow({ name: 'Prod' })] },
      }),
    });
    await app.register(environmentRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/1',
      headers: asUser({ id: 7, isOperator: false }),
      payload: { name: 'Prod' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Prod' });
    await app.close();
  });

  it('deletes an environment for an admin and keeps services', async () => {
    const deleteCalls: Array<Record<string, unknown>> = [];
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          environments: envRow(),
          workspaceMembers: member('admin'),
        },
        delete: {
          environments: () => {
            deleteCalls.push({ id: 1 });
            return [{ id: 1 }];
          },
        },
      }),
    });
    await app.register(environmentRoutes);
    const res = await app.inject({
      method: 'DELETE',
      url: '/1',
      headers: asUser({ id: 7, isOperator: false }),
    });
    expect(res.statusCode).toBe(200);
    expect(deleteCalls).toHaveLength(1);
    await app.close();
  });

  it('refuses deletion from a member (admin floor)', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          environments: envRow(),
          workspaceMembers: member('member'),
        },
        delete: { environments: [{ id: 1 }] },
      }),
    });
    await app.register(environmentRoutes);
    const res = await app.inject({
      method: 'DELETE',
      url: '/1',
      headers: asUser({ id: 7, isOperator: false }),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
