import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDefaultTags,
  getServiceTags,
  replaceServiceTags,
  serviceTagRoutes,
} from '../src/modules/serviceTags.js';
import { asUser, buildTestApp, createFakeDb, svcRow } from './helpers.js';

const auditMocks = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMocks);

const project = { id: 3, name: 'Acme', slug: 'acme' };
const workspace = { id: 4, name: 'Core', slug: 'core' };
const label = { id: 5, name: 'production', color: 'rose' };

/** The three joined selects the tag reader issues, keyed by their join table. */
const joinRows = {
  service_projects: [project],
  service_workspaces: [workspace],
  service_labels: [label],
};

async function appWith(fixtures: Record<string, unknown>) {
  const app = await buildTestApp({ db: createFakeDb(fixtures as never) });
  await app.register(serviceTagRoutes, { prefix: '/services' });
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe('service tag routes', () => {
  it('requires authentication', async () => {
    const app = await appWith({});
    expect((await app.inject({ method: 'GET', url: '/services/1/tags' })).statusCode).toBe(401);
  });

  it('reads the resolved tag set of a visible service', async () => {
    const app = await appWith({ findFirst: { services: svcRow({ id: 1 }) }, select: joinRows });
    const res = await app.inject({ method: 'GET', url: '/services/1/tags', headers: asUser() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      serviceId: 1,
      projects: [project],
      workspaces: [workspace],
      labels: [label],
    });
  });

  it('404s for a service the caller cannot see', async () => {
    const app = await appWith({ findFirst: { services: undefined } });
    const res = await app.inject({ method: 'GET', url: '/services/1/tags', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('replaces the whole tag set for an operator', async () => {
    const app = await appWith({ findFirst: { services: svcRow({ id: 1 }) }, select: joinRows });
    const res = await app.inject({
      method: 'PUT',
      url: '/services/1/tags',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { projectIds: [3], workspaceIds: [4], labelIds: [5] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().projects).toEqual([project]);
    expect(auditMocks.audit).toHaveBeenCalledWith(expect.anything(), 1, 'service.tags', 'service #1');
  });

  it('clears every dimension when the id sets are empty', async () => {
    const app = await appWith({
      findFirst: { services: svcRow({ id: 1 }) },
      select: { service_projects: [], service_workspaces: [], service_labels: [] },
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/services/1/tags',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { projectIds: [], workspaceIds: [], labelIds: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ serviceId: 1, projects: [], workspaces: [], labels: [] });
  });

  describe('member guards', () => {
    const asMember = () => asUser({ id: 7, isOperator: false });
    const seat = [{ id: 1, workspaceId: 4, userId: 7, role: 'member' }];

    it('rejects a workspace the member cannot see', async () => {
      const app = await appWith({
        findFirst: { services: svcRow({ id: 1, ownerUserId: 7 }) },
        findMany: { workspaceMembers: seat },
      });
      const res = await app.inject({
        method: 'PUT',
        url: '/services/1/tags',
        headers: { ...asMember(), 'content-type': 'application/json' },
        // The fake db ignores predicates, so ask for one seat the member holds
        // plus one they do not: the guard trips on the length mismatch.
        payload: { projectIds: [], workspaceIds: [4, 99], labelIds: [] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toMatch(/workspaces are not visible/);
    });

    it('rejects a project the member cannot see', async () => {
      const app = await appWith({
        findFirst: { services: svcRow({ id: 1, ownerUserId: 7 }) },
        findMany: { workspaceMembers: seat, projects: [] },
      });
      const res = await app.inject({
        method: 'PUT',
        url: '/services/1/tags',
        headers: { ...asMember(), 'content-type': 'application/json' },
        payload: { projectIds: [99], workspaceIds: [4], labelIds: [] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toMatch(/projects are not visible/);
    });

    it('rejects a label the member cannot see', async () => {
      const app = await appWith({
        findFirst: { services: svcRow({ id: 1, ownerUserId: 7 }) },
        findMany: { workspaceMembers: seat, projects: [{ id: 3, workspaceId: 4 }], labels: [] },
      });
      const res = await app.inject({
        method: 'PUT',
        url: '/services/1/tags',
        headers: { ...asMember(), 'content-type': 'application/json' },
        payload: { projectIds: [3], workspaceIds: [4], labelIds: [99] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toMatch(/labels are not visible/);
    });

    it('rejects tagging into a project where the caller only holds a viewer seat (r095)', async () => {
      // The attack: own a service (workspace 4), hold a viewer seat in the
      // victim's workspace 10, tag the service into victim project 3, deploy —
      // the pipeline would decrypt project 3's shared secrets into it.
      const app = await appWith({
        findFirst: { services: svcRow({ id: 1, ownerUserId: 7 }) },
        findMany: {
          workspaceMembers: [...seat, { id: 2, workspaceId: 10, userId: 7, role: 'viewer' }],
          projects: [{ id: 3, workspaceId: 10 }],
        },
      });
      const res = await app.inject({
        method: 'PUT',
        url: '/services/1/tags',
        headers: { ...asMember(), 'content-type': 'application/json' },
        // Workspace 10 itself is taggable with a viewer seat (visibility); it is
        // the project link — the secrets sink — that needs member+.
        payload: { projectIds: [3], workspaceIds: [4, 10], labelIds: [] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toMatch(/projects are not visible/);
    });

    it('accepts a set the member is entitled to', async () => {
      const app = await appWith({
        findFirst: { services: svcRow({ id: 1, ownerUserId: 7 }) },
        findMany: {
          workspaceMembers: seat,
          projects: [{ id: 3, workspaceId: 4 }],
          labels: [{ id: 5, workspaceId: 4 }],
        },
        select: joinRows,
      });
      const res = await app.inject({
        method: 'PUT',
        url: '/services/1/tags',
        headers: { ...asMember(), 'content-type': 'application/json' },
        payload: { projectIds: [3], workspaceIds: [4], labelIds: [5] },
      });
      expect(res.statusCode).toBe(200);
    });
  });
});

describe('tag helpers', () => {
  it('getServiceTags resolves each join independently', async () => {
    const db = createFakeDb({ select: joinRows } as never);
    expect(await getServiceTags(db, 9)).toEqual({
      serviceId: 9,
      projects: [project],
      workspaces: [workspace],
      labels: [label],
    });
  });

  it('replaceServiceTags only inserts the non-empty dimensions', async () => {
    const inserted: unknown[] = [];
    const db = createFakeDb({
      insert: {
        service_projects: (v: unknown) => {
          inserted.push(['projects', v]);
          return [];
        },
        service_workspaces: (v: unknown) => {
          inserted.push(['workspaces', v]);
          return [];
        },
        service_labels: (v: unknown) => {
          inserted.push(['labels', v]);
          return [];
        },
      },
    } as never);

    await replaceServiceTags(db, 1, [3], [], [5]);
    expect(inserted.map((i) => (i as [string, unknown])[0])).toEqual(['projects', 'labels']);
  });

  it('applyDefaultTags gives an operator every workspace', async () => {
    const inserted: unknown[] = [];
    const db = createFakeDb({
      findMany: { workspaces: [{ id: 1 }, { id: 2 }] },
      insert: {
        service_workspaces: (v: unknown) => {
          inserted.push(v);
          return [];
        },
      },
    } as never);

    await applyDefaultTags(db, { id: 1, isOperator: true }, 5);
    expect(inserted[0]).toEqual([
      { serviceId: 5, workspaceId: 1 },
      { serviceId: 5, workspaceId: 2 },
    ]);
  });

  it('applyDefaultTags gives a member only their own seats', async () => {
    const inserted: unknown[] = [];
    const db = createFakeDb({
      findMany: { workspaceMembers: [{ workspaceId: 4, userId: 7 }] },
      insert: {
        service_workspaces: (v: unknown) => {
          inserted.push(v);
          return [];
        },
      },
    } as never);

    await applyDefaultTags(db, { id: 7, isOperator: false }, 5);
    expect(inserted[0]).toEqual([{ serviceId: 5, workspaceId: 4 }]);
  });
});
