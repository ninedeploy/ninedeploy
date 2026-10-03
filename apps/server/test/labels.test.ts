import { beforeEach, describe, expect, it, vi } from 'vitest';
import { labelRoutes, visibleLabelIds } from '../src/modules/labels.js';
import { asUser, buildTestApp, createFakeDb, NOW } from './helpers.js';

const auditMocks = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMocks);

const labelRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  workspaceId: 1,
  name: 'production',
  color: 'rose',
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

/** A member (non-operator) with a seat in workspace 1 only. */
const asMember = () => asUser({ id: 7, isOperator: false });
const memberSeat = [{ id: 1, workspaceId: 1, userId: 7, role: 'member' }];

async function appWith(fixtures: Record<string, unknown>) {
  const app = await buildTestApp({ db: createFakeDb(fixtures as never) });
  await app.register(labelRoutes, { prefix: '/labels' });
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe('label routes', () => {
  it('requires authentication', async () => {
    const app = await appWith({});
    expect((await app.inject({ method: 'GET', url: '/labels' })).statusCode).toBe(401);
  });

  it('lists every label for an operator with its service count', async () => {
    const app = await appWith({
      findMany: { labels: [labelRow(), labelRow({ id: 2, workspaceId: null, name: 'global' })] },
      select: { service_labels: [{ labelId: 1 }, { labelId: 1 }] },
    });
    const res = await app.inject({ method: 'GET', url: '/labels', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ id: 1, name: 'production', color: 'rose', serviceCount: 2 }),
      expect.objectContaining({ id: 2, workspaceId: null, serviceCount: 0 }),
    ]);
  });

  it('hides unscoped labels and other workspaces from a member', async () => {
    const app = await appWith({
      findMany: {
        labels: [
          labelRow({ id: 1, workspaceId: 1 }),
          labelRow({ id: 2, workspaceId: 2, name: 'theirs' }),
          labelRow({ id: 3, workspaceId: null, name: 'global' }),
        ],
        workspaceMembers: memberSeat,
      },
    });
    const res = await app.inject({ method: 'GET', url: '/labels', headers: asMember() });
    expect(res.json().map((l: { id: number }) => l.id)).toEqual([1]);
  });

  it('narrows the list by ?workspaceId and ignores a non-numeric one', async () => {
    const fixtures = {
      findMany: {
        labels: [labelRow({ id: 1, workspaceId: 1 }), labelRow({ id: 2, workspaceId: 2 })],
      },
    };
    const app = await appWith(fixtures);
    const scoped = await app.inject({ method: 'GET', url: '/labels?workspaceId=2', headers: asUser() });
    expect(scoped.json().map((l: { id: number }) => l.id)).toEqual([2]);

    const bogus = await app.inject({ method: 'GET', url: '/labels?workspaceId=abc', headers: asUser() });
    expect(bogus.json()).toHaveLength(2);
  });

  it('creates a workspace label and audits it with the workspace id', async () => {
    const app = await appWith({
      insert: { labels: [labelRow({ id: 5, color: 'indigo' })] },
      findFirst: { workspaceMembers: { id: 1, workspaceId: 1, userId: 1, role: 'owner' } },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/labels',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { name: '  production  ', color: 'indigo', workspaceId: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expect.objectContaining({ id: 5, color: 'indigo', serviceCount: 0 }));
    expect(auditMocks.audit).toHaveBeenCalledWith(expect.anything(), 1, 'label.create', 'production (ws 1)');
  });

  it('rejects a color outside the palette', async () => {
    const app = await appWith({ findFirst: { workspaceMembers: { id: 1, workspaceId: 1, userId: 1, role: 'owner' } } });
    const res = await app.inject({
      method: 'POST',
      url: '/labels',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { name: 'x', color: 'chartreuse', workspaceId: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps a known color and defaults a missing one', async () => {
    const app = await appWith({
      insert: { labels: (v: Record<string, unknown>) => [labelRow({ id: 6, color: v['color'] })] },
      findFirst: { workspaceMembers: { id: 1, workspaceId: 1, userId: 1, role: 'owner' } },
    });
    const kept = await app.inject({
      method: 'POST',
      url: '/labels',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { name: 'a', color: 'sky', workspaceId: 1 },
    });
    expect(kept.json().color).toBe('sky');

    const defaulted = await app.inject({
      method: 'POST',
      url: '/labels',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { name: 'b', workspaceId: 1 },
    });
    expect(defaulted.json().color).toBe('indigo');
  });

  it('lets an operator create an unscoped label', async () => {
    const app = await appWith({ insert: { labels: [labelRow({ id: 7, workspaceId: null, name: 'global' })] } });
    const res = await app.inject({
      method: 'POST',
      url: '/labels',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { name: 'global' },
    });
    expect(res.statusCode).toBe(200);
    expect(auditMocks.audit).toHaveBeenCalledWith(expect.anything(), 1, 'label.create', 'global');
  });

  it('forbids a member from creating an unscoped label', async () => {
    const app = await appWith({ findMany: { workspaceMembers: memberSeat } });
    const res = await app.inject({
      method: 'POST',
      url: '/labels',
      headers: { ...asMember(), 'content-type': 'application/json' },
      payload: { name: 'sneaky' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/operator-only/);
  });

  it('forbids a member from creating a label in a workspace they are not in', async () => {
    const app = await appWith({ findMany: { workspaceMembers: memberSeat }, findFirst: { workspaceMembers: undefined } });
    const res = await app.inject({
      method: 'POST',
      url: '/labels',
      headers: { ...asMember(), 'content-type': 'application/json' },
      payload: { name: 'sneaky', workspaceId: 9 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('reports a create that returns no row', async () => {
    const app = await appWith({ insert: { labels: () => [] } });
    const res = await app.inject({
      method: 'POST',
      url: '/labels',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('updates a label name and color, reporting its service count', async () => {
    const app = await appWith({
      findFirst: { labels: labelRow(), workspaceMembers: { id: 1, workspaceId: 1, userId: 1, role: 'owner' } },
      update: { labels: [labelRow({ name: 'prod', color: 'sky' })] },
      counts: { service_labels: [{ n: 1 }, { n: 1 }, { n: 1 }] },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/labels/1',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { name: ' prod ', color: 'sky' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expect.objectContaining({ name: 'prod', color: 'sky', serviceCount: 3 }));
  });

  it('rejects an empty patch body', async () => {
    const app = await appWith({
      findFirst: { labels: labelRow(), workspaceMembers: { id: 1, workspaceId: 1, userId: 1, role: 'owner' } },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/labels/1',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('patches only the color, leaving the name alone', async () => {
    const app = await appWith({
      findFirst: { labels: labelRow(), workspaceMembers: { id: 1, workspaceId: 1, userId: 1, role: 'owner' } },
      update: { labels: [labelRow({ color: 'amber' })] },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/labels/1',
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { color: 'amber' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expect.objectContaining({ name: 'production', color: 'amber', serviceCount: 0 }));
  });

  it('404s a patch for a missing label, and for one that vanishes mid-update', async () => {
    const missing = await appWith({ findFirst: { labels: undefined } });
    expect(
      (await missing.inject({
        method: 'PATCH',
        url: '/labels/1',
        headers: { ...asUser(), 'content-type': 'application/json' },
        payload: { name: 'x' },
      })).statusCode,
    ).toBe(404);

    const vanished = await appWith({
      findFirst: { labels: labelRow({ workspaceId: null }) },
      update: { labels: () => [] },
    });
    expect(
      (await vanished.inject({
        method: 'PATCH',
        url: '/labels/1',
        headers: { ...asUser(), 'content-type': 'application/json' },
        payload: { name: 'x' },
      })).statusCode,
    ).toBe(404);
  });

  it('r361: an unscoped label answers a member the same 404 as a missing one', async () => {
    const app = await appWith({
      findFirst: { labels: labelRow({ workspaceId: null }) },
      findMany: { workspaceMembers: memberSeat },
    });
    const patch = await app.inject({
      method: 'PATCH',
      url: '/labels/1',
      headers: { ...asMember(), 'content-type': 'application/json' },
      payload: { name: 'x' },
    });
    expect(patch.statusCode).toBe(404);
    expect(patch.json().error.message).toBe('Label not found');

    const del = await app.inject({ method: 'DELETE', url: '/labels/1', headers: asMember() });
    expect(del.statusCode).toBe(404);
    expect(del.json().error.message).toBe('Label not found');
  });

  it("r361: another tenant's label answers the same 404 as a missing id, not 403", async () => {
    // Label 1 lives in workspace 2; the member holds no seat there.
    const app = await appWith({
      findFirst: { labels: labelRow({ workspaceId: 2 }), workspaceMembers: undefined },
      findMany: { workspaceMembers: memberSeat },
    });
    const missing = await appWith({ findFirst: { labels: undefined } });
    const patchBody = { headers: { ...asMember(), 'content-type': 'application/json' }, payload: { name: 'x' } };
    const foreignPatch = await app.inject({ method: 'PATCH', url: '/labels/1', ...patchBody });
    const missingPatch = await missing.inject({ method: 'PATCH', url: '/labels/1', ...patchBody });
    expect(foreignPatch.statusCode).toBe(404);
    expect(foreignPatch.json()).toEqual(missingPatch.json());

    const foreignDel = await app.inject({ method: 'DELETE', url: '/labels/1', headers: asMember() });
    const missingDel = await missing.inject({ method: 'DELETE', url: '/labels/1', headers: asMember() });
    expect(foreignDel.statusCode).toBe(404);
    expect(foreignDel.json()).toEqual(missingDel.json());
  });

  it('still 403s a viewer seat, who can already see the label', async () => {
    const app = await appWith({
      findFirst: { labels: labelRow(), workspaceMembers: { id: 1, workspaceId: 1, userId: 7, role: 'viewer' } },
    });
    const del = await app.inject({ method: 'DELETE', url: '/labels/1', headers: asMember() });
    expect(del.statusCode).toBe(403);
  });

  it('deletes a label the caller may manage', async () => {
    const app = await appWith({
      findFirst: { labels: labelRow(), workspaceMembers: { id: 1, workspaceId: 1, userId: 1, role: 'owner' } },
    });
    const res = await app.inject({ method: 'DELETE', url: '/labels/1', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(auditMocks.audit).toHaveBeenCalledWith(expect.anything(), 1, 'label.delete', 'production');
  });

  it('404s a delete for a missing label', async () => {
    const app = await appWith({ findFirst: { labels: undefined } });
    expect((await app.inject({ method: 'DELETE', url: '/labels/1', headers: asUser() })).statusCode).toBe(404);
  });
});

describe('visibleLabelIds', () => {
  const db = (fixtures: Record<string, unknown>) => createFakeDb(fixtures as never);

  it('returns nothing for an empty request', async () => {
    expect(await visibleLabelIds(db({}), { id: 1, isOperator: true }, [])).toEqual([]);
  });

  it('returns every existing id for an operator', async () => {
    const fake = db({ findMany: { labels: [labelRow({ id: 1 }), labelRow({ id: 2 })] } });
    expect(await visibleLabelIds(fake, { id: 1, isOperator: true }, [1, 2, 3])).toEqual([1, 2]);
  });

  it('drops unscoped and out-of-workspace ids for a member', async () => {
    const fake = db({
      findMany: {
        labels: [
          labelRow({ id: 1, workspaceId: 1 }),
          labelRow({ id: 2, workspaceId: 2 }),
          labelRow({ id: 3, workspaceId: null }),
        ],
        workspaceMembers: memberSeat,
      },
    });
    expect(await visibleLabelIds(fake, { id: 7, isOperator: false }, [1, 2, 3])).toEqual([1]);
  });
});
