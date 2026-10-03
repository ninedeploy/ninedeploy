/**
 * G-47 image inventory + retention — module coverage.
 *
 * `modules/images.ts` exposes:
 *   GET    /housekeeping/images        (admin) — list host images
 *   POST   /housekeeping/images/prune  (admin) — run a prune
 *
 * The behavior worth pinning down:
 *  - the list route returns the image rows plus a
 *    `totalCount` and a `totalBytes` summary.
 *  - the prune route refuses the "no filter" combination
 *    (would delete every image not in use) with 400.
 *  - body validation: keepLast in 0..1000,
 *    olderThanHours in 0..8760.
 *  - the audit action switches on `dryRun` so the audit
 *    trail records what the operator actually did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asUser, buildTestApp, listen } from '../helpers.js';

const lib = vi.hoisted(() => ({
  listRows: [
    {
      id: 'sha256:abc',
      repoTags: ['nginx:latest'],
      sizeBytes: 100,
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'sha256:def',
      repoTags: ['<none>:<none>'],
      sizeBytes: 50,
      createdAt: '2026-01-02T00:00:00Z',
    },
  ] as Array<Record<string, unknown>>,
  pruneResult: { removed: [], freedBytes: 0, dryRun: false } as {
    removed: string[];
    freedBytes: number;
    dryRun: boolean;
  },
  listCalls: 0,
  pruneCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/lib/imageInventory.js', () => ({
  listImages: vi.fn(async () => {
    lib.listCalls++;
    return lib.listRows;
  }),
  pruneImages: vi.fn(async (opts: Record<string, unknown>) => {
    lib.pruneCalls.push(opts);
    return lib.pruneResult;
  }),
}));

vi.mock('../../src/lib/audit.js', () => ({
  audit: vi.fn(async () => undefined),
}));

let appRef: Awaited<ReturnType<typeof buildTestApp>> | null = null;

async function startApp() {
  const app = await buildTestApp();
  await app.register((await import('../../src/modules/images.js')).housekeepingImageRoutes);
  const port = await listen(app);
  appRef = app;
  return { app, port };
}

beforeEach(() => {
  lib.listRows = [
    {
      id: 'sha256:abc',
      repoTags: ['nginx:latest'],
      sizeBytes: 100,
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'sha256:def',
      repoTags: ['<none>:<none>'],
      sizeBytes: 50,
      createdAt: '2026-01-02T00:00:00Z',
    },
  ];
  lib.pruneResult = { removed: [], freedBytes: 0, dryRun: false };
  lib.listCalls = 0;
  lib.pruneCalls = [];
});

afterEach(async () => {
  if (appRef) await appRef.close().catch(() => undefined);
  appRef = null;
});

describe('GET /housekeeping/images', () => {
  it('rejects unauthenticated callers with 401', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/images`);
    expect(res.status).toBe(401);
  });

  it('rejects non-admin callers with 403', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/images`, {
      headers: asUser({ id: 1, role: 'member' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns rows + totalCount + totalBytes', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/images`, { headers: asUser(1) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.images).toHaveLength(2);
    expect(body.totalCount).toBe(2);
    expect(body.totalBytes).toBe(150);
    expect(lib.listCalls).toBe(1);
  });
});

describe('POST /housekeeping/images/prune', () => {
  it('rejects non-admin callers with 403', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/images/prune`, {
      method: 'POST',
      headers: { ...asUser({ id: 1, role: 'member' }), 'content-type': 'application/json' },
      body: JSON.stringify({ danglingOnly: true }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects an empty body (no filter) with 400', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/images/prune`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an out-of-range keepLast with 422', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/images/prune`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ keepLast: 9999 }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects a negative olderThanHours with 422', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/images/prune`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ olderThanHours: -1 }),
    });
    expect(res.status).toBe(422);
  });

  it('runs a prune with danglingOnly=true and returns the result', async () => {
    lib.pruneResult = { removed: ['sha256:def'], freedBytes: 50, dryRun: false };
    const { port, app } = await startApp();
    const audit = (await import('../../src/lib/audit.js')).audit as unknown as ReturnType<typeof vi.fn>;
    const res = await fetch(`http://127.0.0.1:${port}/images/prune`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ danglingOnly: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toEqual(['sha256:def']);
    expect(body.freedBytes).toBe(50);
    expect(lib.pruneCalls[0]).toEqual({ danglingOnly: true });
    expect(audit).toHaveBeenCalledWith(
      app.db,
      1,
      'images.prune',
      expect.stringMatching(/removed=1/),
    );
  });

  it('passes keepLast + olderThanHours through to the lib', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/images/prune`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ keepLast: 5, olderThanHours: 24 }),
    });
    expect(res.status).toBe(200);
    expect(lib.pruneCalls[0]).toEqual({ keepLast: 5, olderThanHours: 24 });
  });

  it('audits with images.prune_dry_run when the result is dryRun', async () => {
    lib.pruneResult = { removed: ['sha256:abc'], freedBytes: 100, dryRun: true };
    const { port, app } = await startApp();
    const audit = (await import('../../src/lib/audit.js')).audit as unknown as ReturnType<typeof vi.fn>;
    const res = await fetch(`http://127.0.0.1:${port}/images/prune`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ keepLast: 1 }),
    });
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(
      app.db,
      1,
      'images.prune_dry_run',
      expect.stringMatching(/removed=1/),
    );
  });
});
