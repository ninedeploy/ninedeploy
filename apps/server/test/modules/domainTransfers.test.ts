/**
 * G-29 domain transfer — module coverage.
 *
 * `modules/domainTransfers.ts` exposes two plugins:
 *  - `domainTransferStartRoutes` (mounted under /domains)
 *    handles `POST /:id/transfer` — the source-side
 *    initiation. Admin on the source service is required.
 *  - `domainTransferTokenRoutes` (mounted under
 *    /domain-transfers) handles the token-keyed preview
 *    (unauthenticated), accept (authenticated, target
 *    email match), and cancel (authenticated source or
 *    operator) endpoints.
 *
 * The behavior worth pinning down:
 *  - start: 401 unauth, 404 unknown domain, 403 non-admin,
 *    400 when the lib throws (e.g. domain already in a
 *    transfer), audit log, X-Panel-Origin forwarded to the
 *    acceptUrl builder.
 *  - preview: 404 unknown token, otherwise echoes the
 *    preview payload.
 *  - accept: 422 on missing body, 400 on lib failure, audit
 *    log on success.
 *  - cancel: 400 on lib failure, audit on success, isOperator
 *    forwarded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asUser, buildTestApp, createFakeDb, listen } from '../helpers.js';

const lib = vi.hoisted(() => ({
  startCalls: [] as Array<Record<string, unknown>>,
  previewCalls: [] as string[],
  acceptCalls: [] as Array<Record<string, unknown>>,
  cancelCalls: [] as Array<{ token: string; userId: number; isOperator: boolean }>,
  startResult: {
    transferId: 10,
    acceptUrl: 'https://panel.example.com/domain-transfers/tok-1',
    expiresAt: new Date('2026-02-01T00:00:00Z'),
  },
  previewResult: {
    transferId: 10,
    hostname: 'example.com',
    sourceName: 'Alice',
    targetEmail: 'bob@example.com',
    expiresAt: new Date('2026-02-01T00:00:00Z'),
    accepted: false,
  },
  acceptResult: {
    transferId: 10,
    domainId: 1,
    serviceId: 2,
    fromServiceId: 1,
    hostname: 'example.com',
  },
  cancelResult: { transferId: 10, cancelled: true },
  startThrow: null as Error | null,
  acceptThrow: null as Error | null,
  cancelThrow: null as Error | null,
}));

vi.mock('../../src/lib/domainTransfer.js', () => ({
  startTransfer: vi.fn(async (_db: unknown, opts: Record<string, unknown>) => {
    lib.startCalls.push(opts);
    if (lib.startThrow) throw lib.startThrow;
    return lib.startResult;
  }),
  previewTransfer: vi.fn(async (_db: unknown, token: string) => {
    lib.previewCalls.push(token);
    return token === 'tok-1' ? lib.previewResult : null;
  }),
  acceptTransfer: vi.fn(async (_db: unknown, opts: Record<string, unknown>) => {
    lib.acceptCalls.push(opts);
    if (lib.acceptThrow) throw lib.acceptThrow;
    return lib.acceptResult;
  }),
  cancelTransfer: vi.fn(async (_db: unknown, token: string, userId: number, isOperator: boolean) => {
    lib.cancelCalls.push({ token, userId, isOperator });
    if (lib.cancelThrow) throw lib.cancelThrow;
    return lib.cancelResult;
  }),
}));

vi.mock('../../src/lib/audit.js', () => ({
  audit: vi.fn(async () => undefined),
}));

const proxyMock = vi.hoisted(() => ({ writeDynamicConfig: vi.fn(async () => undefined) }));
vi.mock('../../src/engine/proxy.js', () => proxyMock);

interface DomainRow {
  id: number;
  hostname: string;
  serviceId: number;
}

interface ServiceRow {
  id: number;
  name: string;
  projectId: number;
  workspaceId: number;
}

let domainRow: DomainRow | null = { id: 1, hostname: 'example.com', serviceId: 1 };
let serviceRow: ServiceRow | null = { id: 1, name: 'web', projectId: 1, workspaceId: 1 };
let appRef: Awaited<ReturnType<typeof buildTestApp>> | null = null;

async function startStartApp() {
  const db = createFakeDb({
    findFirst: {
      domains: () => domainRow,
      services: () => serviceRow,
      workspaceMembers: () => ({ id: 1, workspaceId: 1, userId: 1, role: 'owner' }),
    },
  });
  const app = await buildTestApp({ db });
  await app.register((await import('../../src/modules/domainTransfers.js')).domainTransferStartRoutes);
  const port = await listen(app);
  appRef = app;
  return { app, port, db };
}

async function startTokenApp(targetVisible = true) {
  const db = createFakeDb({
    findFirst: {
      // The accept route must authorize the target service before it invokes
      // the transfer primitive. This represents the recipient's admin seat.
      services: () => (targetVisible ? { id: 2, name: 'target', projectId: 1, workspaceId: 1 } : undefined),
      workspaceMembers: () => ({ id: 1, workspaceId: 1, userId: 1, role: 'owner' }),
    },
  });
  const app = await buildTestApp({ db });
  await app.register((await import('../../src/modules/domainTransfers.js')).domainTransferTokenRoutes);
  const port = await listen(app);
  appRef = app;
  return { app, port, db };
}

beforeEach(() => {
  lib.startCalls.length = 0;
  lib.previewCalls.length = 0;
  lib.acceptCalls.length = 0;
  lib.cancelCalls.length = 0;
  lib.startThrow = null;
  lib.acceptThrow = null;
  lib.cancelThrow = null;
  domainRow = { id: 1, hostname: 'example.com', serviceId: 1 };
  serviceRow = { id: 1, name: 'web', projectId: 1, workspaceId: 1 };
});

afterEach(async () => {
  if (appRef) await appRef.close().catch(() => undefined);
  appRef = null;
});

describe('POST /domains/:id/transfer (start)', () => {
  it('rejects unauthenticated callers with 401', async () => {
    const { port } = await startStartApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetEmail: 'bob@example.com' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a missing targetEmail with 422', async () => {
    const { port } = await startStartApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/transfer`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(422);
  });

  it('returns 404 when the domain does not exist', async () => {
    domainRow = null;
    const { port } = await startStartApp();
    const res = await fetch(`http://127.0.0.1:${port}/999/transfer`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ targetEmail: 'bob@example.com' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects non-admin callers (no service access)', async () => {
    // A user that has no admin seat on the source service must
    // not be able to start a transfer. The route is gated both
    // by `loadServiceForUser` (membership) and `assertServiceRole`
    // (admin); a non-member hits 404, a member-but-not-admin
    // hits 403. Either way the request is refused.
    const { port } = await startStartApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/transfer`, {
      method: 'POST',
      headers: { ...asUser({ id: 7, role: 'member' }), 'content-type': 'application/json' },
      body: JSON.stringify({ targetEmail: 'bob@example.com' }),
    });
    expect([403, 404]).toContain(res.status);
  });

  it('starts a transfer and returns the accept URL', async () => {
    const { port, app } = await startStartApp();
    const audit = (await import('../../src/lib/audit.js')).audit as unknown as ReturnType<typeof vi.fn>;
    const res = await fetch(`http://127.0.0.1:${port}/1/transfer`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ targetEmail: 'bob@example.com' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transferId).toBe(10);
    expect(body.acceptUrl).toMatch(/tok-1/);
    expect(lib.startCalls[0]).toMatchObject({
      domainId: 1,
      sourceUserId: 1,
      targetEmail: 'bob@example.com',
    });
    expect(audit).toHaveBeenCalledWith(
      app.db,
      1,
      'domain.transfer_start',
      expect.stringMatching(/example.com -> bob@example.com/),
    );
  });

  it('forwards the X-Panel-Origin header to the lib', async () => {
    const { port } = await startStartApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/transfer`, {
      method: 'POST',
      headers: {
        ...asUser(1),
        'content-type': 'application/json',
        'x-panel-origin': 'https://panel.acme.io/',
      },
      body: JSON.stringify({ targetEmail: 'bob@example.com' }),
    });
    expect(res.status).toBe(200);
    expect(lib.startCalls[0]?.['panelOrigin']).toBe('https://panel.acme.io');
  });

  it('surfaces a lib failure as 400', async () => {
    lib.startThrow = new Error('Domain is already in a transfer');
    const { port } = await startStartApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/transfer`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ targetEmail: 'bob@example.com' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.message).toMatch(/already in a transfer/);
  });
});

describe('GET /domain-transfers/:token (preview)', () => {
  it('returns the preview payload for a known token', async () => {
    const { port } = await startTokenApp();
    // The plugin attaches `app.authenticate` at the plugin level,
    // so the route is reachable while authenticated too (the source
    // comment says the auth gate is intentionally loose for the
    // preview, since the token is the secret).
    const res = await fetch(`http://127.0.0.1:${port}/tok-1`, { headers: asUser(1) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hostname).toBe('example.com');
    expect(body.targetEmail).toBe('bob@example.com');
    expect(lib.previewCalls[0]).toBe('tok-1');
  });

  it('returns 404 for an unknown token', async () => {
    const { port } = await startTokenApp();
    const res = await fetch(`http://127.0.0.1:${port}/unknown`, { headers: asUser(1) });
    expect(res.status).toBe(404);
  });
});

describe('POST /domain-transfers/:token/accept', () => {
  it('rejects a transfer target the recipient cannot access before invoking the transfer primitive', async () => {
    const { port } = await startTokenApp(false);
    const res = await fetch(`http://127.0.0.1:${port}/tok-1/accept`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ targetServiceId: 2 }),
    });
    expect(res.status).toBe(404);
    expect(lib.acceptCalls).toEqual([]);
  });

  it('rejects a missing body with 422', async () => {
    const { port } = await startTokenApp();
    const res = await fetch(`http://127.0.0.1:${port}/tok-1/accept`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(422);
  });

  it('rejects unauthenticated callers with 401', async () => {
    const { port } = await startTokenApp();
    const res = await fetch(`http://127.0.0.1:${port}/tok-1/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetServiceId: 2 }),
    });
    expect(res.status).toBe(401);
  });

  it('r180: re-renders the Traefik routing table once the domain changed hands', async () => {
    proxyMock.writeDynamicConfig.mockClear();
    const { port } = await startTokenApp();
    const res = await fetch(`http://127.0.0.1:${port}/tok-1/accept`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ targetServiceId: 2 }),
    });
    expect(res.status).toBe(200);
    expect(proxyMock.writeDynamicConfig).toHaveBeenCalledTimes(1);
  });

  it('accepts the transfer, audits, and returns the new service id', async () => {
    const { port, app } = await startTokenApp();
    const audit = (await import('../../src/lib/audit.js')).audit as unknown as ReturnType<typeof vi.fn>;
    const res = await fetch(`http://127.0.0.1:${port}/tok-1/accept`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ targetServiceId: 2 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      transferId: 10,
      domainId: 1,
      serviceId: 2,
      hostname: 'example.com',
    });
    expect(lib.acceptCalls[0]).toMatchObject({ token: 'tok-1', userId: 1, targetServiceId: 2 });
    expect(audit).toHaveBeenCalledWith(
      app.db,
      1,
      'domain.transfer_accept',
      expect.stringMatching(/example.com/),
    );
  });

  it('surfaces a lib failure as 400', async () => {
    lib.acceptThrow = new Error('Token expired');
    const { port } = await startTokenApp();
    const res = await fetch(`http://127.0.0.1:${port}/tok-1/accept`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ targetServiceId: 2 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /domain-transfers/:token/cancel', () => {
  it('rejects unauthenticated callers with 401', async () => {
    const { port } = await startTokenApp();
    const res = await fetch(`http://127.0.0.1:${port}/tok-1/cancel`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('cancels the transfer and audits', async () => {
    const { port, app } = await startTokenApp();
    const audit = (await import('../../src/lib/audit.js')).audit as unknown as ReturnType<typeof vi.fn>;
    const res = await fetch(`http://127.0.0.1:${port}/tok-1/cancel`, {
      method: 'POST',
      headers: { ...asUser(1) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ transferId: 10, cancelled: true });
    expect(lib.cancelCalls[0]).toEqual({ token: 'tok-1', userId: 1, isOperator: true });
    expect(audit).toHaveBeenCalledWith(app.db, 1, 'domain.transfer_cancel', '#10');
  });

  it('forwards isOperator=false for a non-operator caller', async () => {
    const { port } = await startTokenApp();
    const res = await fetch(`http://127.0.0.1:${port}/tok-1/cancel`, {
      method: 'POST',
      headers: asUser({ id: 1, role: 'member' }),
    });
    expect(res.status).toBe(200);
    expect(lib.cancelCalls[0]?.isOperator).toBe(false);
  });

  it('surfaces a lib failure as 400', async () => {
    lib.cancelThrow = new Error('Transfer already accepted');
    const { port } = await startTokenApp();
    const res = await fetch(`http://127.0.0.1:${port}/tok-1/cancel`, {
      method: 'POST',
      headers: { ...asUser(1) },
    });
    expect(res.status).toBe(400);
  });
});
