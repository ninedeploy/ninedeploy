import { describe, expect, it, vi } from 'vitest';
import { activityRoutes } from '../src/modules/activity.js';
import { asUser, auditRow, buildTestApp, createFakeDb } from './helpers.js';

/** Recursively collect bound values from a drizzle where clause (and/eq nest SQL chunks). */
function collectValues(node: unknown, out: unknown[] = []): unknown[] {
  if (node && typeof node === 'object') {
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      for (const c of chunks) collectValues(c, out);
    } else {
      const value = (node as { value?: unknown }).value;
      if (value !== undefined) out.push(value);
    }
  }
  return out;
}

describe('activity routes', () => {
  it('requires authentication', async () => {
    const app = await buildTestApp();
    await app.register(activityRoutes);
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects non-admin users because audit rows have no tenant scope', async () => {
    const app = await buildTestApp();
    await app.register(activityRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser({ isOperator: false }) });
    expect(res.statusCode).toBe(403);
  });

  it('maps audit log rows to ISO strings and enriches with user metadata', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          auditLog: [
            auditRow({ id: 7, userId: 2, action: 'service.create', entity: 'web', meta: { ip: '10.0.0.1' } }),
            auditRow({ id: 8, userId: null, action: 'backup.completed', entity: 'pg' }),
          ],
          users: [
            { id: 2, name: 'Ada', email: 'ada@example.com' },
          ],
        },
      }),
    });
    await app.register(activityRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      entries: [
        { id: 7, userId: 2, userName: 'Ada', userEmail: 'ada@example.com', action: 'service.create', entity: 'web', meta: { ip: '10.0.0.1' }, ts: '2026-01-01T00:00:00.000Z' },
        { id: 8, userId: null, userName: null, userEmail: null, action: 'backup.completed', entity: 'pg', meta: null, ts: '2026-01-01T00:00:00.000Z' },
      ],
      nextCursor: null,
    });
  });

  it('filters rows server-side by ?entity=', async () => {
    const findMany = vi.fn(() => [
      auditRow({ id: 7, userId: 2, action: 'service.create', entity: 'web' }),
    ]);
    const app = await buildTestApp({
      db: createFakeDb({ findMany: { auditLog: findMany } }),
    });
    await app.register(activityRoutes);
    const res = await app.inject({ method: 'GET', url: '/?entity=web', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toEqual([
      { id: 7, userId: 2, userName: null, userEmail: null, action: 'service.create', entity: 'web', meta: null, ts: '2026-01-01T00:00:00.000Z' },
    ]);
    // the where clause pins the audit row entity to the query param
    const where = findMany.mock.calls[0]![0]!.where;
    expect(where).toBeDefined();
    expect(collectValues(where)).toContain('web');
  });

  it('returns an empty page when there is no activity', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(activityRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: [], nextCursor: null });
  });

  it('emits a pagination cursor when a full page is returned', async () => {
    const page = Array.from({ length: 50 }, (_, i) => auditRow({ id: i + 1 }));
    const app = await buildTestApp({ db: createFakeDb({ findMany: { auditLog: page } }) });
    await app.register(activityRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.json().entries).toHaveLength(50);
    expect(res.json().nextCursor).toBe(50);
  });

  it('passes action/userId/before filters into the where clause', async () => {
    const findMany = vi.fn(() => []);
    const app = await buildTestApp({
      db: createFakeDb({ findMany: { auditLog: findMany } }),
    });
    await app.register(activityRoutes);
    const res = await app.inject({
      method: 'GET',
      url: '/?action=deploy.trigger&userId=3&before=99',
      headers: asUser(),
    });
    expect(res.statusCode).toBe(200);
    const where = findMany.mock.calls[0]![0]!.where;
    const values = collectValues(where);
    expect(values).toContain('deploy.trigger');
    expect(values).toContain(3);
    expect(values).toContain(99);
  });

  it('gracefully handles user query failure during user enrichment', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          auditLog: [auditRow({ id: 10, userId: 5, action: 'service.restart', entity: 'api' })],
          users: () => {
            throw new Error('users table query failed');
          },
        },
      }),
    });
    await app.register(activityRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries[0]).toEqual({
      id: 10,
      userId: 5,
      userName: null,
      userEmail: null,
      action: 'service.restart',
      entity: 'api',
      meta: null,
      ts: '2026-01-01T00:00:00.000Z',
    });
  });
});
