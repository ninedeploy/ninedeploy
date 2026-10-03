import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectRoutes } from '../src/modules/projects.js';
import { asUser, buildTestApp, createFakeDb } from './helpers.js';

const cryptoNotNeeded = undefined;
void cryptoNotNeeded;

const auditMocks = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMocks);

const projectRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'Acme',
  slug: 'acme',
  description: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const appWith = async (fixtures: Record<string, unknown>) => {
  const app = await buildTestApp({ db: createFakeDb(fixtures as never) });
  await app.register(projectRoutes, { prefix: '/projects' });
  return app;
};

describe('projects routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires authentication', async () => {
    const app = await appWith({});
    const res = await app.inject({ method: 'GET', url: '/projects' });
    expect(res.statusCode).toBe(401);
  });

  it('lists projects with service and database counts', async () => {
    const app = await appWith({
      findMany: { projects: [projectRow()] },
      select: {
        service_projects: [{ projectId: 1 }, { projectId: 1 }, { projectId: null }],
        databases: [{ projectId: 1 }],
      },
    });
    const res = await app.inject({ method: 'GET', url: '/projects', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ id: 1, name: 'Acme', slug: 'acme', serviceCount: 2, databaseCount: 1 });
    expect(res.json()[0]).not.toHaveProperty('descriptionEncrypted');
  });

  it('reports zero counts for a project with no resources', async () => {
    const app = await appWith({
      findMany: { projects: [projectRow()] },
      select: { services: [], databases: [] },
    });
    const res = await app.inject({ method: 'GET', url: '/projects', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ serviceCount: 0, databaseCount: 0 });
  });

  it('reports a failed insert as 400', async () => {
    const app = await appWith({ insert: { projects: [] } });
    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { ...asUser({ isOperator: false }), 'content-type': 'application/json' },
      payload: { name: 'Acme' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('reports a failed update as 400', async () => {
    const app = await appWith({
      findFirst: { projects: projectRow() },
      update: { projects: [] },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/projects/1',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { name: 'Renamed' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a project, slugifying the name when absent', async () => {
    const app = await appWith({
      insert: { projects: [projectRow({ name: 'My App', slug: 'my-app' })] },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { name: 'My App', description: 'main workloads' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'My App', slug: 'my-app' });
    expect(auditMocks.audit).toHaveBeenCalledWith(expect.anything(), 1, 'project.create', 'My App');
  });

  it('honors an explicit slug', async () => {
    const app = await appWith({
      insert: { projects: [projectRow({ name: 'Acme', slug: 'custom-slug' })] },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { name: 'Acme', slug: 'custom-slug' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ slug: 'custom-slug' });
  });

  it('rejects a duplicate slug with 409', async () => {
    const app = await appWith({ findFirst: { projects: projectRow() } });
    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { name: 'Acme' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
  });

  it('rejects invalid bodies with 400', async () => {
    const app = await appWith({});
    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { name: 'a' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('patches name and description', async () => {
    const app = await appWith({
      findFirst: { projects: projectRow() },
      update: { projects: [projectRow({ name: 'Renamed', description: 'd' })] },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/projects/1',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { name: 'Renamed', description: 'd' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Renamed', description: 'd' });
  });

  it('forbids a viewer from changing or deleting a workspace project', async () => {
    const app = await appWith({
      findFirst: {
        projects: projectRow({ workspaceId: 5 }),
        workspaceMembers: { id: 2, workspaceId: 5, userId: 1, role: 'viewer' },
      },
    });
    const patch = await app.inject({
      method: 'PATCH',
      url: '/projects/1',
      headers: { ...asUser({ isOperator: false }), 'content-type': 'application/json' },
      payload: { name: 'Renamed' },
    });
    expect(patch.statusCode).toBe(403);
    const del = await app.inject({ method: 'DELETE', url: '/projects/1', headers: asUser({ isOperator: false }) });
    expect(del.statusCode).toBe(403);
  });

  it('rejects an empty patch with 400', async () => {
    const app = await appWith({});
    const res = await app.inject({
      method: 'PATCH',
      url: '/projects/1',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when patching or deleting a missing project', async () => {
    const app = await appWith({});
    const patch = await app.inject({
      method: 'PATCH',
      url: '/projects/9',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { name: 'Xyz' },
    });
    expect(patch.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: '/projects/9', headers: asUser() });
    expect(del.statusCode).toBe(404);
  });

  it('deletes a project', async () => {
    const app = await appWith({ findFirst: { projects: projectRow() } });
    const res = await app.inject({ method: 'DELETE', url: '/projects/1', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(auditMocks.audit).toHaveBeenCalledWith(expect.anything(), 1, 'project.delete', 'Acme');
  });

  it('filters projects by workspaceId and creates/patches with workspaceId', async () => {
    let projectDb: any;
    const app = await appWith({
      findMany: {
        projects: [projectRow({ id: 1, workspaceId: 5 })],
        // A project may only be created/moved inside a workspace the caller
        // belongs to, so the acting user needs seats in both 5 and 7.
        workspaceMembers: [
          { id: 1, workspaceId: 5, userId: 1, role: 'owner' },
          { id: 2, workspaceId: 7, userId: 1, role: 'owner' },
        ],
      },
      insert: { projects: [projectRow({ id: 2, workspaceId: 5 })] },
      findFirst: {
        projects: () => projectDb,
        // `isWorkspaceMember` looks the seat up with findFirst, not findMany.
        workspaceMembers: { id: 1, workspaceId: 5, userId: 1, role: 'owner' },
      },
      update: { projects: [projectRow({ id: 2, workspaceId: 7 })] },
    });

    const listRes = await app.inject({ method: 'GET', url: '/projects?workspaceId=5', headers: asUser() });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()[0].workspaceId).toBe(5);

    const createRes = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { name: 'Scoped Project', workspaceId: 5 },
    });
    expect(createRes.statusCode).toBe(200);

    projectDb = projectRow({ id: 2, workspaceId: 5 });
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/projects/2',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { workspaceId: 7 },
    });
    expect(patchRes.statusCode).toBe(200);
  });
});
