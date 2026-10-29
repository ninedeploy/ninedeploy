/**
 * G5.8 service tunnels (`modules/serviceTunnel.ts`): a real listening app, a
 * real WebSocket client and a TCP echo server standing in for the container.
 */
import net from 'node:net';
import { once } from 'node:events';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { serviceProjects, serviceWorkspaces, projects, services, users, workspaceMembers, workspaces, type DB } from '@ninedeploy/db';

const authMocks = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
  return { resolveUser: vi.fn() };
});
vi.mock('../src/lib/auth.js', async (importOriginal) => ({ ...(await importOriginal<object>()), resolveUser: authMocks.resolveUser }));
const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMock);

const { serviceTunnelRoutes, serviceTunnelDeps } = await import('../src/modules/serviceTunnel.js');
const { buildTestApp, listen, wsUrl } = await import('./helpers.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

const USERS: Record<string, { id: number; isOperator: boolean; tokenScopes: string[] | null; viaApiToken: boolean }> = {
  op: { id: 1, isOperator: true, tokenScopes: null, viaApiToken: false },
  seatMember: { id: 3, isOperator: false, tokenScopes: null, viaApiToken: false },
  seatAdmin: { id: 4, isOperator: false, tokenScopes: null, viaApiToken: false },
  readonly: { id: 1, isOperator: true, tokenScopes: ['read'], viaApiToken: true },
  dbWriteOnly: { id: 4, isOperator: false, tokenScopes: ['nd://scope/write/databases'], viaApiToken: true },
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
const resolved: string[] = [];
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(users).values([1, 3, 4].map((id) => ({ id, email: `u${id}@example.com`, passwordHash: 'x' })));
  await db.insert(workspaces).values({ id: 1, name: 'Acme', slug: 'acme', ownerId: 1 });
  await db.insert(workspaceMembers).values([
    { workspaceId: 1, userId: 3, role: 'member' },
    { workspaceId: 1, userId: 4, role: 'admin' },
  ] as never);
  await db.insert(projects).values({ id: 1, workspaceId: 1, name: 'Shop', slug: 'shop' });
  await db.insert(services).values([
    { id: 5, name: 'api', slug: 'api', type: 'docker', branch: 'main', ownerUserId: 1, image: 'x', status: 'running', runtimeId: 'nd-svc-api', runtimeReplicas: 2, port: echoPort },
    { id: 6, name: 'idle', slug: 'idle', type: 'docker', branch: 'main', ownerUserId: 1, image: 'x', status: 'stopped', port: 80 },
    { id: 7, name: 'stack', slug: 'stack', type: 'compose', branch: 'main', ownerUserId: 1, status: 'running', runtimeId: 'ndcmp-stack', port: 80 },
  ] as never);
  await db.insert(serviceProjects).values([5, 6, 7].map((serviceId) => ({ serviceId, projectId: 1 })) as never);
  // Seats reach a service through its workspace tag.
  await db.insert(serviceWorkspaces).values([5, 6, 7].map((serviceId) => ({ serviceId, workspaceId: 1 })) as never);
  authMocks.resolveUser.mockImplementation(async (_db: unknown, token: string) => (USERS[token] ? { ...USERS[token] } : null));
  auditMock.audit.mockClear();
  resolved.length = 0;
  serviceTunnelDeps.resolveAddress = async (name: string) => {
    resolved.push(name);
    return '127.0.0.1';
  };
  const app = await buildTestApp({ db, websocket: true });
  await app.register(serviceTunnelRoutes, { prefix: '/v1/services' });
  port = await listen(app);
});
afterEach(() => {
  for (const s of echoSockets) s.destroy();
  closeMigratedDb(db);
});

function open(path: string, token: string): WebSocket {
  const ws = new WebSocket(wsUrl(port, path), ['ninedeploy.tunnel.v1', `ninedeploy.bearer.${token}`]);
  ws.binaryType = 'arraybuffer';
  return ws;
}
const closed = (ws: WebSocket) =>
  new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })));
const opened = (ws: WebSocket) => new Promise<void>((r) => (ws.readyState === WebSocket.OPEN ? r() : ws.addEventListener('open', () => r())));

describe('service tunnels', () => {
  it('refuses the active Swarm runtime after switching the configured orchestrator back to Docker', async () => {
    await db.update(services).set({ runtimeId: 'nd-api_web', orchestrator: null }).where(eq(services.id, 5));
    const ws = open('/v1/services/5/tunnel', 'op');
    const outcome = await Promise.race([
      closed(ws),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ]);
    if (outcome === 'timeout') ws.close();
    expect(outcome).toEqual({ code: 1008, reason: 'tunnels reach docker services (not Swarm, compose or PM2)' });
    expect(resolved).toEqual([]);
  });

  it('carries bytes to the service port of the chosen replica and audits open and close', async () => {
    const ws = open('/v1/services/5/tunnel?replica=2', 'seatAdmin');
    await opened(ws);
    const reply = new Promise<Buffer>((r) => ws.addEventListener('message', (e) => r(Buffer.from(e.data as ArrayBuffer))));
    ws.send(Buffer.from('GET / HTTP/1.0\r\n\r\n'));
    expect((await reply).toString()).toBe('GET / HTTP/1.0\r\n\r\n');
    expect(resolved).toEqual(['nd-svc-api-r2']);
    const end = closed(ws);
    ws.close(1000);
    await end;
    await vi.waitFor(() =>
      expect(auditMock.audit).toHaveBeenCalledWith(expect.anything(), 4, 'service.tunnel.close', `api:${echoPort}`, expect.objectContaining({ serviceId: 5, bytesIn: 18, bytesOut: 18 })),
    );
  });

  it('refuses members, read-only and database-only tokens, stopped and compose services, bad ports and replicas', async () => {
    const cases: Array<[string, string, string]> = [
      ['/v1/services/5/tunnel', 'seatMember', 'not found or not allowed'],
      ['/v1/services/5/tunnel', 'readonly', 'unauthorized'],
      ['/v1/services/5/tunnel', 'dbWriteOnly', 'unauthorized'],
      ['/v1/services/6/tunnel', 'op', 'the service is not running'],
      ['/v1/services/7/tunnel', 'op', 'tunnels reach docker services (not Swarm, compose or PM2)'],
      ['/v1/services/5/tunnel?port=70000', 'op', 'name the container port with ?port='],
      ['/v1/services/5/tunnel?replica=3', 'op', 'the service runs 2 replica(s)'],
    ];
    for (const [path, token, reason] of cases) {
      expect(await closed(open(path, token)), `${token} ${path}`).toEqual({ code: 1008, reason });
    }
    expect(echoSockets.size).toBe(0);
  });

  it('reaches a service on a node through its agent, and shows why when the node cannot', async () => {
    const { sql } = await import('drizzle-orm');
    await db.run(sql`PRAGMA foreign_keys = OFF`);
    await db.update(services).set({ serverId: 9, runtimeReplicas: 1 } as never).where(eq(services.id, 5));
    const openNode = serviceTunnelDeps.openNode;
    const calls: unknown[] = [];
    serviceTunnelDeps.openNode = async (_db, serverId, target) => {
      calls.push({ serverId, ...target });
      return net.connect({ host: '127.0.0.1', port: echoPort });
    };
    try {
      const ws = open('/v1/services/5/tunnel', 'op');
      await opened(ws);
      const reply = new Promise<Buffer>((r) => ws.addEventListener('message', (e) => r(Buffer.from(e.data as ArrayBuffer))));
      ws.send(Buffer.from('ping'));
      expect((await reply).toString()).toBe('ping');
      expect(calls).toEqual([{ serverId: 9, container: 'nd-svc-api', port: echoPort }]);
      expect(resolved).toEqual([]);
      const end = closed(ws);
      ws.close(1000);
      await end;

      serviceTunnelDeps.openNode = async () => Promise.reject(new Error('update the node agent to v0.18.7 to open tunnels to node services'));
      expect(await closed(open('/v1/services/5/tunnel', 'op'))).toEqual({ code: 1008, reason: 'update the node agent to v0.18.7 to open tunnels to node services' });
    } finally {
      serviceTunnelDeps.openNode = openNode;
    }
  });

  it('keeps the bytes a client sends before a slow target is connected', async () => {
    const { sql } = await import('drizzle-orm');
    await db.run(sql`PRAGMA foreign_keys = OFF`);
    await db.update(services).set({ serverId: 9, runtimeReplicas: 1 } as never).where(eq(services.id, 5));
    const openNode = serviceTunnelDeps.openNode;
    serviceTunnelDeps.openNode = async () => {
      // A node channel takes a moment to open; the client has already spoken by then.
      await new Promise((r) => setTimeout(r, 400));
      return net.connect({ host: '127.0.0.1', port: echoPort });
    };
    try {
      const ws = open('/v1/services/5/tunnel', 'op');
      const reply = new Promise<Buffer>((r) => ws.addEventListener('message', (e) => r(Buffer.from(e.data as ArrayBuffer))));
      await opened(ws);
      ws.send(Buffer.from('early'));
      const got = await Promise.race([reply, new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
      expect(got?.toString()).toBe('early');
      const end = closed(ws);
      ws.close(1000);
      await end;
    } finally {
      serviceTunnelDeps.openNode = openNode;
    }
  });
});
