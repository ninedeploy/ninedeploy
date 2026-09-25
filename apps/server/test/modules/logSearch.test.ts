/**
 * G-16 cluster log search — module coverage.
 *
 * `modules/logSearch.ts` is the HTTP surface for the
 * `POST /search` route. The lib helper (`searchLogs`)
 * handles the actual Loki round-trip; this module:
 *  - parses the body (query, serviceId, sinceMinutes,
 *    limit, drainId) and 400s on invalid input,
 *  - narrows the access check to a single service when
 *    `serviceId` is supplied (member-level on that service),
 *  - 404s when no Loki drain is configured,
 *  - 400s when the resolved drain is not Loki (the helper
 *    flags `unsupported: true` with the drain attached).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asUser, buildTestApp, createFakeDb, listen } from '../helpers.js';

const lib = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  throw: null as Error | null,
  result: {
    drain: { id: 1, name: 'main', type: 'loki' },
    lines: [] as Array<{ ts: string; service: string; line: string }>,
    unsupported: false as boolean,
  },
}));

vi.mock('../../src/lib/logSearch.js', () => ({
  searchLogs: vi.fn(async (_db: unknown, opts: Record<string, unknown>) => {
    lib.calls.push(opts);
    if (lib.throw) throw lib.throw;
    return lib.result;
  }),
}));

interface ServiceRow {
  id: number;
  projectId: number;
  workspaceId: number;
}

let serviceRow: ServiceRow | null = { id: 1, projectId: 1, workspaceId: 1 };
let appRef: Awaited<ReturnType<typeof buildTestApp>> | null = null;

async function startApp() {
  const db = createFakeDb({
    findFirst: {
      services: () => serviceRow,
      // Hand user 1 an owner seat in workspace 1 so
      // `assertServiceRole(_, 'member')` passes when the
      // route narrows by serviceId.
      workspaceMembers: () => ({ id: 1, workspaceId: 1, userId: 1, role: 'owner' }),
    },
  });
  const app = await buildTestApp({ db });
  await app.register((await import('../../src/modules/logSearch.js')).logSearchRoutes);
  const port = await listen(app);
  appRef = app;
  return { app, port, db };
}

beforeEach(() => {
  lib.calls.length = 0;
  lib.throw = null;
  lib.result = {
    drain: { id: 1, name: 'main', type: 'loki' },
    lines: [],
    unsupported: false,
  };
  serviceRow = { id: 1, projectId: 1, workspaceId: 1 };
});

afterEach(async () => {
  if (appRef) await appRef.close().catch(() => undefined);
  appRef = null;
});

describe('POST /search', () => {
  it('rejects unauthenticated callers with 401', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'error' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an empty query with 400', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ query: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an over-long query with 400', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'x'.repeat(501) }),
    });
    expect(res.status).toBe(400);
  });

  it('runs the search and returns the result', async () => {
    lib.result.lines = [{ ts: '2026-01-01T00:00:00Z', service: 'web', line: 'hello' }];
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'hello' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toEqual([{ ts: '2026-01-01T00:00:00Z', service: 'web', line: 'hello' }]);
    expect(lib.calls[0]).toMatchObject({ query: 'hello', serviceId: undefined });
  });

  it('rejects a member cluster-wide query before calling Loki', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'POST',
      headers: { ...asUser({ id: 2, role: 'member' }), 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'tenant secret' }),
    });
    expect(res.status).toBe(400);
    expect(lib.calls).toEqual([]);
  });

  it('passes through serviceId / sinceMinutes / limit / drainId', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'error',
        serviceId: 1,
        sinceMinutes: 60,
        limit: 50,
        drainId: 2,
      }),
    });
    expect(res.status).toBe(200);
    const opt = lib.calls[0]!;
    expect(opt).toMatchObject({ query: 'error', serviceId: 1, limit: 50, drainId: 2 });
    expect(opt['since']).toBeInstanceOf(Date);
    // The since value should be roughly 60 minutes back.
    const since = opt['since'] as Date;
    const expected = Date.now() - 60 * 60_000;
    expect(Math.abs(since.getTime() - expected)).toBeLessThan(5_000);
  });

  it('r287: a non-operator search is restricted to drains usable for that service; an operator is not', async () => {
    serviceRow = { id: 1, projectId: 1, workspaceId: 1, ownerUserId: 1 } as typeof serviceRow;
    const { port } = await startApp();
    const asMember = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'POST',
      headers: { ...asUser({ id: 1, isOperator: false }), 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'error', serviceId: 1, drainId: 5 }),
    });
    expect(asMember.status).toBe(200);
    expect(lib.calls[0]).toMatchObject({ drainId: 5, restrictToServiceId: 1 });

    const asOperator = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'error', serviceId: 1, drainId: 5 }),
    });
    expect(asOperator.status).toBe(200);
    expect(lib.calls[1]?.['restrictToServiceId']).toBeUndefined();
  });

  it('translates "No enabled Loki drain" into a 404', async () => {
    lib.throw = new Error('No enabled Loki drain configured for this cluster');
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('re-throws other errors from the helper', async () => {
    lib.throw = new Error('loki timeout');
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'x' }),
    });
    expect(res.status).toBe(500);
  });

  it('returns 400 when the resolved drain is not Loki', async () => {
    lib.result = {
      drain: { id: 1, name: 'main', type: 'webhook' },
      lines: [],
      unsupported: true,
    };
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'x' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.message).toMatch(/does not support search/);
    expect(body.error?.message).toMatch(/webhook/);
  });

  it('returns 404 (not 500) when the narrowed serviceId is not visible to the caller', async () => {
    serviceRow = null;
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'x', serviceId: 1 }),
    });
    expect(res.status).toBe(404);
  });
});
