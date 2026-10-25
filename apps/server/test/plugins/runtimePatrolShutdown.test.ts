import Fastify from 'fastify';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { createDb, runMigrations, users, servers, services, auditLog, nodeLifecycleIntents, eq } from '@ninedeploy/db';
import runtimeState from '../../src/plugins/runtimeState.js';
import { encrypt, sha256 } from '../../src/lib/crypto.js';
import { open, seal } from '../../src/lib/agentSeal.js';
import { _resetSealedSupportCache } from '../../src/lib/agentClient.js';

const token = 'owned-runtime-patrol-fixture';
const shared = sha256(token);
afterEach(() => _resetSealedSupportCache());
async function bounded<T>(promise: Promise<T>, label: string, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error(label)), ms); })]);
  } finally { clearTimeout(timer); }
}

it.each(['handshake', 'inspect', 'capabilities', 'healthy'] as const)('closes a real node patrol without false outages while the %s boundary is active', async mode => {
  const connection = createDb({ url: 'file::memory:' }); await connection.ready; await runMigrations(connection.db);
  let entered!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  let disconnected!: () => void;
  const disconnecting = new Promise<void>(resolve => { disconnected = resolve; });
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const held = new Set<ServerResponse>(), seen: string[] = [];
  const node = createServer((req, res) => {
    res.on('close', () => { if (held.has(res)) disconnected(); held.delete(res); });
    if (req.url === '/agent/ping') {
      if (mode === 'handshake') { held.add(res); entered(); return; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, sealed: true })); return;
    }
    let body = '';
    req.on('data', bytes => { body += bytes.toString(); });
    req.on('end', () => {
      const request = open<{ op: string; nonce: string }>(shared, JSON.parse(body).sealed);
      seen.push(request.op);
      if (mode === 'inspect' || (mode === 'capabilities' && request.op === 'agent.ping')) { held.add(res); entered(); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sealed: seal(shared, { nonce: request.nonce, exitCode: 0, lines: [mode === 'capabilities' ? 'exited|172.22.0.2' : 'running|172.22.0.2'] }) })); if (mode !== 'capabilities') entered();
    });
  });
  await new Promise<void>(resolve => node.listen(0, '127.0.0.1', resolve));
  const app = Fastify(); app.decorate('db', connection.db);
  let closing: Promise<void> | undefined;
  try {
    await connection.db.insert(users).values({ id: 1, email: 'patrol@example.test', passwordHash: 'fixture', isInstanceOperator: true });
    await connection.db.insert(servers).values({ id: 4, name: 'Owned loopback agent', host: '127.0.0.1', port: (node.address() as AddressInfo).port, tokenEncrypted: encrypt(token) });
    await connection.db.insert(services).values({ id: 1, ownerUserId: 1, name: 'Web', slug: 'web', type: 'docker', status: 'running', runtimeId: 'web-7', serverId: 4 });
    await app.register(runtimeState); await app.ready();
    await bounded(entering, 'Production patrol did not reach the actual HTTP fixture');
    expect(timeout).toHaveBeenCalledWith(15_000);
    closing = app.close();
    const promptly = await Promise.race([closing.then(() => true), new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 2000); void closing!.finally(() => clearTimeout(timer));
    })]);
    expect(promptly, 'Panel shutdown must cancel the pending node request instead of waiting for its network timeout').toBe(true);
    if (mode !== 'healthy') await bounded(disconnecting, 'The pending node socket was not cancelled', 2000);
    expect((await connection.db.query.services.findFirst({ where: eq(services.id, 1) }))!.status).toBe('running');
    expect(await connection.db.select().from(nodeLifecycleIntents)).toEqual([]);
    expect((await connection.db.select().from(auditLog)).filter(row => row.action.startsWith('alert.'))).toEqual([]);
    if (mode !== 'handshake') expect(seen).toEqual(mode === 'capabilities' ? ['docker.inspect', 'agent.ping'] : ['docker.inspect']);
  } finally {
    for (const response of held) response.destroy();
    node.closeAllConnections();
    await bounded(closing ?? app.close(), 'Patrol fixture cleanup did not settle');
    await new Promise<void>(resolve => node.close(() => resolve()));
    connection.client?.close();
    timeout.mockRestore();
  }
});
