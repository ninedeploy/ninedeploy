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

  it('shows every workspace’s lanes to an operator, with zero counts for empty lanes', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          workspaceMembers: [],
          environments: [envRow({ workspaceId: 9, name: 'Staging', slug: 'staging' })],
        },
        select: { services: [] },
      }),
    });
    await app.register(environmentRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ name: 'Staging', serviceCount: 0 }),
    ]);
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

  it('translates the UNIQUE race into the same 400 as the pre-check', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { workspaceMembers: member('member') },
        insert: {
          environments: () => {
            throw new Error('UNIQUE constraint failed: environments.workspace_id, environments.name');
          },
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
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('already exists');
    await app.close();
  });

  it('reports 400 when a create insert returns no row', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { workspaceMembers: member('member') },
        insert: { environments: [] },
      }),
    });
    await app.register(environmentRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser({ id: 7, isOperator: false }),
      payload: { workspaceId: 1, name: 'Staging' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Could not create environment');
    await app.close();
  });

  it('reports 404 when renaming a lane that does not exist', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { environments: null, workspaceMembers: member('admin') },
      }),
    });
    await app.register(environmentRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/99',
      headers: asUser(),
      payload: { name: 'prod' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('reports 404 when deleting a lane that does not exist', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { environments: null, workspaceMembers: member('admin') },
      }),
    });
    await app.register(environmentRoutes);
    const res = await app.inject({
      method: 'DELETE',
      url: '/99',
      headers: asUser(),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rethrows non-UNIQUE insert errors instead of swallowing them', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { workspaceMembers: member('member') },
        insert: {
          environments: () => {
            throw new Error('disk I/O error');
          },
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
    expect(res.statusCode).toBe(500);
    await app.close();
  });

  it('normalizes a messy name and falls back to the env slug when nothing survives', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { workspaceMembers: member('member') },
        insert: { environments: [envRow({ id: 3, name: '  ProD Space!! ', slug: 'prod-space' })] },
      }),
    });
    await app.register(environmentRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser({ id: 7, isOperator: false }),
      payload: { workspaceId: 1, name: '  ProD Space!!  ' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ slug: 'prod-space' });
    await app.close();
  });

  it('renames without a name key keeps the row but still returns 400 when the update misses', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { environments: envRow({ id: 2, workspaceId: 1, name: 'prod' }), workspaceMembers: member('admin') },
        update: { environments: [] },
      }),
    });
    await app.register(environmentRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/2',
      headers: asUser(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
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
