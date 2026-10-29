/**
 * G5.8 database tunnels (`modules/databaseTunnel.ts`): a real listening app,
 * a real WebSocket client and a TCP echo server standing in for the database.
 */
import net from 'node:net';
import { once } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { databases, projects, users, workspaceMembers, workspaces, type DB } from '@ninedeploy/db';

const authMocks = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
  return { resolveUser: vi.fn() };
});
vi.mock('../src/lib/auth.js', async (importOriginal) => ({ ...(await importOriginal<object>()), resolveUser: authMocks.resolveUser }));
const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMock);

const { databaseTunnelRoutes, tunnelDeps } = await import('../src/modules/databaseTunnel.js');
const { buildTestApp, listen, wsUrl } = await import('./helpers.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

const USERS: Record<string, { id: number; isOperator: boolean; tokenScopes: string[] | null; viaApiToken: boolean }> = {
  op: { id: 1, isOperator: true, tokenScopes: null, viaApiToken: false },
  member: { id: 2, isOperator: false, tokenScopes: null, viaApiToken: false },
  readonly: { id: 1, isOperator: true, tokenScopes: ['read'], viaApiToken: true },
  seatMember: { id: 3, isOperator: false, tokenScopes: null, viaApiToken: false },
  seatAdmin: { id: 4, isOperator: false, tokenScopes: null, viaApiToken: false },
  dbWriteToken: { id: 4, isOperator: false, tokenScopes: ['nd://scope/write/databases'], viaApiToken: true },
};

let echo: net.Server;
let echoPort: number;
const echoSockets = new Set<net.Socket>();
beforeAll(async () => {
  echo = net.createServer((s) => {
    echoSockets.add(s);
    s.on('close', () => echoSockets.delete(s));
    s.pipe(s);
  });
  echo.listen(0, '127.0.0.1');
  await once(echo, 'listening');
  echoPort = (echo.address() as net.AddressInfo).port;
});
afterAll(() => echo.close());

let db: DB;
let port: number;
beforeEach(async () => {
  db = await migratedDb();
  // Database 1 sits in workspace 1: user 3 holds a member seat there, user 4 an admin seat.
  await db.insert(users).values([1, 2, 3, 4].map((id) => ({ id, email: `u${id}@example.com`, passwordHash: 'x' })));
  await db.insert(workspaces).values({ id: 1, name: 'Acme', slug: 'acme', ownerId: 1 });
  await db.insert(workspaceMembers).values([
    { workspaceId: 1, userId: 3, role: 'member' },
    { workspaceId: 1, userId: 4, role: 'admin' },
  ] as never);
  await db.insert(projects).values({ id: 1, workspaceId: 1, name: 'Shop', slug: 'shop' });
  await db.insert(databases).values([
    { id: 1, projectId: 1, name: 'pg', slug: 'pg', engine: 'postgres', passwordEncrypted: 'v1:x', status: 'running', containerName: 'nd-db-pg', internalPort: echoPort },
    { id: 2, name: 'stopped', slug: 'stopped', engine: 'postgres', passwordEncrypted: 'v1:x', status: 'stopped', containerName: 'nd-db-s', internalPort: 5432 },
  ] as never);
  authMocks.resolveUser.mockImplementation(async (_db: unknown, token: string) => (USERS[token] ? { ...USERS[token] } : null));
  auditMock.audit.mockClear();
  tunnelDeps.resolveAddress = async () => '127.0.0.1';
  const app = await buildTestApp({ db, websocket: true });
  // The production path: fine-grained token scopes are matched against /v1/… URLs.
  await app.register(databaseTunnelRoutes, { prefix: '/v1/databases' });
  port = await listen(app);
});
afterEach(() => {
  for (const s of echoSockets) s.destroy();
  closeMigratedDb(db);
});

function open(id: number, token: string): WebSocket {
  const ws = new WebSocket(wsUrl(port, `/v1/databases/${id}/tunnel`), ['ninedeploy.tunnel.v1', `ninedeploy.bearer.${token}`]);
  ws.binaryType = 'arraybuffer';
  return ws;
}
const closed = (ws: WebSocket) =>
  new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })));

describe('database tunnels', () => {
  it('carries bytes both ways, large payloads included, and audits open and close', async () => {
    const ws = open(1, 'op');
    await new Promise<void>((r) => (ws.readyState === WebSocket.OPEN ? r() : ws.addEventListener('open', () => r())));
    expect(ws.protocol).toBe('ninedeploy.tunnel.v1'); // the credential is never echoed

    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    big.write('start');
    let received = 0;
    const chunks: Buffer[] = [];
    const done = new Promise<void>((resolve) =>
      ws.addEventListener('message', (e) => {
        const b = Buffer.from(e.data as ArrayBuffer);
        chunks.push(b);
        received += b.length;
        if (received >= big.length) resolve();
      }),
    );
    for (let at = 0; at < big.length; at += 64 * 1024) ws.send(big.subarray(at, at + 64 * 1024));
    await done;
    expect(Buffer.concat(chunks).equals(big)).toBe(true);

    const end = closed(ws);
    ws.close(1000);
    await end;
    await vi.waitFor(() =>
      expect(auditMock.audit).toHaveBeenCalledWith(expect.anything(), 1, 'database.tunnel.close', 'pg', expect.objectContaining({ bytesIn: big.length, bytesOut: big.length })),
    );
    expect(auditMock.audit).toHaveBeenCalledWith(expect.anything(), 1, 'database.tunnel.open', 'pg', { databaseId: 1, engine: 'postgres', serverId: null }, expect.anything());
  });

  it('closes when the database closes the connection', async () => {
    const ws = open(1, 'op');
    await new Promise<void>((r) => ws.addEventListener('open', () => r()));
    await vi.waitFor(() => expect(echoSockets.size).toBe(1));
    const end = closed(ws);
    for (const s of echoSockets) s.end();
    expect((await end).code).toBe(1000);
  });

  it.each([
    ['an unknown token', 1, 'nobody', 'unauthorized'],
    ['a read-only token', 1, 'readonly', 'unauthorized'],
    ['a member without a seat', 1, 'member', 'not found or not allowed'],
    ['a member seat (credentials need admin)', 1, 'seatMember', 'not found or not allowed'],
    ['a stopped database', 2, 'op', 'the database is not running'],
    ['an unknown database', 99, 'op', 'not found or not allowed'],
  ])('refuses %s', async (_what, id, token, reason) => {
    const ws = open(id, token);
    const r = await closed(ws);
    expect(r).toEqual({ code: 1008, reason });
    expect(echoSockets.size).toBe(0);
  });

  it.each([
    ['an admin seat', 'seatAdmin'],
    ['a token scoped to write databases', 'dbWriteToken'],
  ])('opens for %s', async (_what, token) => {
    const ws = open(1, token);
    await new Promise<void>((r, j) => {
      ws.addEventListener('open', () => r());
      ws.addEventListener('close', (e) => j(new Error(`closed ${e.code} ${e.reason}`)));
    });
    let closedWith = '';
    ws.addEventListener('close', (e) => (closedWith = `${e.code} ${e.reason}`));
    await vi.waitFor(() => expect({ echo: echoSockets.size, closedWith }).toEqual({ echo: 1, closedWith: '' }));
    ws.close(1000);
  });

  it('holds the per-user cap when many tunnels open at once (security review)', async () => {
    const { MAX_TUNNELS_PER_USER } = await import('../src/modules/databaseTunnel.js');
    // A slow address lookup: every open passes the cap check before any finishes it.
    tunnelDeps.resolveAddress = async () => {
      await new Promise((r) => setTimeout(r, 200));
      return '127.0.0.1';
    };
    const sockets = Array.from({ length: MAX_TUNNELS_PER_USER + 2 }, () => open(1, 'op'));
    const refusals = sockets.map((ws) => closed(ws));
    await vi.waitFor(() => expect(echoSockets.size).toBe(MAX_TUNNELS_PER_USER), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300)); // let the refusals arrive
    const refused = (await Promise.all(sockets.map((ws, i) => (ws.readyState === WebSocket.CLOSED ? refusals[i] : null)))).filter(Boolean);
    expect(refused).toHaveLength(2);
    expect(refused[0]).toEqual({ code: 1008, reason: `at most ${MAX_TUNNELS_PER_USER} tunnels at once` });
    for (const ws of sockets) ws.close(1000);
    await Promise.all(refusals);
  });

  it('reaches a database on a node through its agent, and shows why when the node cannot', async () => {
    const { servers } = await import('@ninedeploy/db');
    await db.insert(servers).values({ id: 3, name: 'n', host: '203.0.113.1', port: 4600, tokenEncrypted: 'x', status: 'online' });
    const { eq } = await import('drizzle-orm');
    await db.update(databases).set({ serverId: 3 }).where(eq(databases.id, 1));
    const openNode = tunnelDeps.openNode;
    const calls: unknown[] = [];
    tunnelDeps.openNode = async (_db, serverId, target) => {
      calls.push({ serverId, ...target });
      return net.connect({ host: '127.0.0.1', port: echoPort });
    };
    const resolve = vi.fn(async () => '127.0.0.1');
    tunnelDeps.resolveAddress = resolve;
    try {
      const ws = open(1, 'op');
      await new Promise<void>((r) => ws.addEventListener('open', () => r()));
      const reply = new Promise<Buffer>((r) => ws.addEventListener('message', (e) => r(Buffer.from(e.data as ArrayBuffer))));
      ws.send(Buffer.from('SELECT 1'));
      expect((await reply).toString()).toBe('SELECT 1');
      expect(calls).toEqual([{ serverId: 3, container: 'nd-db-pg', port: echoPort, kind: 'database' }]);
      expect(resolve).not.toHaveBeenCalled();
      const end = closed(ws);
      ws.close(1000);
      await end;

      tunnelDeps.openNode = async () => Promise.reject(new Error('update the node agent to v0.18.7'));
      expect(await closed(open(1, 'op'))).toEqual({ code: 1008, reason: 'update the node agent to v0.18.7' });
    } finally {
      tunnelDeps.openNode = openNode;
    }
  });
});
