import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import { once } from 'node:events';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { StudioRelayChannel, type StudioRelaySocket } from '../../src/lib/studioRelayChannel.js';
import { bridgeStudioHttp } from '../../src/lib/studioRelayHttp.js';
import { deriveFrameKey } from '../../src/lib/agentFrameCipher.js';
import { STUDIO_RELAY_HKDF_INFO, type StudioRelayRequest } from '../../src/lib/studioRelayProtocol.js';

const servers: Server[] = [], apps: FastifyInstance[] = [], sockets: Array<{ terminate(): void }> = [], clients: WebSocket[] = [], channels: StudioRelayChannel[] = [];
afterEach(async () => {
  for (const channel of channels.splice(0)) channel.abort();
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const client of clients.splice(0)) client.close();
  for (const app of apps.splice(0)) await app.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
async function listen(handler?: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler); servers.push(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Expected private test port');
  return { server, address: '127.0.0.1', port: address.port };
}
const adapter = (socket: StudioRelaySocket): StudioRelaySocket => ({
  get bufferedAmount() { return socket.bufferedAmount; },
  send: bytes => socket.send(bytes), close: (code, reason) => socket.close(code, reason),
});
async function connect(target: { address: string; port: number }, spec: StudioRelayRequest) {
  const transport = Fastify(); apps.push(transport);
  await transport.register(websocket, { options: { maxPayload: 256 * 1024 } });
  const secret = randomBytes(32).toString('hex'), key = deriveFrameKey(secret, randomBytes(32), STUDIO_RELAY_HKDF_INFO);
  const packets: Buffer[] = [];
  let agent!: StudioRelayChannel, bridge!: Promise<void>;
  const accepted = new Promise<void>(resolve => transport.get('/relay', { websocket: true }, socket => {
    sockets.push(socket);
    agent = new StudioRelayChannel('agent', key, adapter(socket), { expectedIncomingBytes: spec.bodyBytes, onAuthenticated: () => {
      bridge = bridgeStudioHttp(agent, target, spec); void bridge.catch(() => undefined); return bridge;
    } });
    channels.push(agent);
    socket.on('message', (data, binary) => { if (!binary) agent.abort(); else agent.receive(Buffer.from(data as Buffer)); });
    socket.on('close', () => agent.socketClosed()); socket.on('error', () => agent.abort());
    resolve();
  }));
  await transport.listen({ host: '127.0.0.1', port: 0 });
  const address = transport.server.address(); if (!address || typeof address === 'string') throw Error('Expected private relay port');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/relay`); socket.binaryType = 'arraybuffer'; clients.push(socket);
  const opened = new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', reject, { once: true }); });
  await Promise.all([opened, accepted]);
  const panel = new StudioRelayChannel('panel', key, adapter(socket), { expectedOutgoingBytes: spec.bodyBytes }); channels.push(panel);
  socket.addEventListener('message', ({ data }) => { if (typeof data === 'string') panel.abort(); else { const bytes = Buffer.from(data as ArrayBuffer); packets.push(bytes); panel.receive(bytes); } });
  socket.addEventListener('close', () => panel.socketClosed()); socket.addEventListener('error', () => panel.abort());
  panel.start(); await agent.ready;
  return { panel, agent, packets, bridge: () => bridge };
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('actual HTTP over an encrypted Studio WebSocket relay', () => {
  it('preserves multipart bytes, duplicate cookies, query path and a binary HTTP response', async () => {
    const request = Buffer.concat([Buffer.from('--owned\r\nContent-Disposition: form-data; name="file"; filename="db.sql"\r\n\r\n'), randomBytes(1024 * 1024 + 9), Buffer.from('\r\n--owned--\r\n')]);
    const response = randomBytes(2 * 1024 * 1024 + 17);
    let got: Buffer | undefined, receivedPath: string | undefined, receivedHeaders: IncomingMessage['headers'] | undefined;
    const target = await listen((req, res) => { void (async () => {
      got = await buffer(req); receivedPath = req.url; receivedHeaders = req.headers;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': response.length, 'set-cookie': ['adminer_sid=one', 'adminer_key=two'] }); res.end(response);
    })().catch(() => res.destroy()); });
    const { panel, agent, packets, bridge } = await connect(target, { method: 'POST', path: '/?pgsql=nd-db-owned&db=app', bodyBytes: request.length, headers: [
      ['content-type', 'multipart/form-data; boundary=owned'], ['authorization', 'Bearer panel-private'], ['cookie', 'nd-studio-7=panel-private; adminer_sid=upstream-cookie'],
    ] });
    const result = buffer(panel.readable); panel.writable.end(request);
    const head = await panel.head;
    await Promise.all([panel.done, agent.done, bridge()]);
    expect(got?.equals(request)).toBe(true); expect((await result).equals(response)).toBe(true);
    expect(receivedPath).toBe('/?pgsql=nd-db-owned&db=app');
    expect(receivedHeaders?.authorization).toBeUndefined(); expect(receivedHeaders?.cookie).toBe('adminer_sid=upstream-cookie');
    expect(receivedHeaders?.['content-type']).toBe('multipart/form-data; boundary=owned');
    expect(head.headers.filter(([name]) => name.toLowerCase() === 'set-cookie')).toEqual([['set-cookie', 'adminer_sid=one'], ['set-cookie', 'adminer_key=two']]);
    expect((await panel.done).received.sha256).toBe(hash(response));
    expect(packets.some(bytes => bytes.includes(response.subarray(0, 32)))).toBe(false);
  });
  it('returns redirects without following them', async () => {
    let destinationHit = false;
    const destination = await listen((_req, res) => { destinationHit = true; res.end('outside'); });
    const target = await listen((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${destination.port}/outside` }); res.end(); });
    const { panel, agent, bridge } = await connect(target, { method: 'GET', path: '/', headers: [], bodyBytes: 0 });
    panel.readable.resume(); panel.writable.end();
    expect((await panel.head).status).toBe(302);
    await Promise.all([panel.done, agent.done, bridge()]); expect(destinationHit).toBe(false);
  });
  it('sends no HTTP headers or body when the connected container identity cannot be reconfirmed', async () => {
    let receivedRequest = false;
    const target = await listen((_req, res) => { receivedRequest = true; res.end('wrong target'); });
    const confirmed = { ...target, verify: async () => { throw new Error('container identity changed'); } };
    const { panel, agent, bridge } = await connect(confirmed, { method: 'POST', path: '/', headers: [], bodyBytes: 7 });
    panel.readable.resume(); panel.writable.end('private');
    await expect(panel.done).rejects.toThrow();
    await Promise.allSettled([agent.done, bridge()]);
    expect(receivedRequest).toBe(false);
  });
  it('waits for the connected identity check before releasing a private request', async () => {
    let markChecking!: () => void, allow!: () => void, received = false;
    const checking = new Promise<void>(resolve => { markChecking = resolve; }), approved = new Promise<void>(resolve => { allow = resolve; });
    const target = await listen((req, res) => { received = true; void buffer(req).then(() => res.end('ok')); });
    const confirmed = { ...target, verify: async () => { markChecking(); await approved; } };
    const { panel, agent, bridge } = await connect(confirmed, { method: 'POST', path: '/', headers: [], bodyBytes: 7 });
    const result = buffer(panel.readable); panel.writable.end('private');
    await checking; expect(received).toBe(false); allow();
    await Promise.all([panel.done, agent.done, bridge()]);
    expect((await result).toString()).toBe('ok'); expect(received).toBe(true);
  });
  it('fails a truncated upstream response after its HTTP headers instead of accepting a partial download', async () => {
    const target = await listen((_req, res) => { res.writeHead(200, { 'content-length': '1000' }); res.write('partial'); res.socket?.destroySoon(); });
    const { panel, agent, bridge } = await connect(target, { method: 'GET', path: '/', headers: [], bodyBytes: 0 });
    panel.readable.resume(); panel.writable.end();
    await expect(panel.done).rejects.toThrow(); await expect(agent.done).rejects.toThrow(); await expect(bridge()).rejects.toThrow('upstream unreachable');
  });
  it('closes the actual upstream socket when the browser abandons a response', async () => {
    let closeResolve!: () => void;
    const closed = new Promise<void>(resolve => { closeResolve = resolve; });
    const target = await listen((_req, res) => { res.writeHead(200); res.write('initial'); res.on('close', closeResolve); });
    const { panel, agent, bridge } = await connect(target, { method: 'GET', path: '/', headers: [], bodyBytes: 0 });
    panel.writable.end(); await panel.head; panel.abort();
    await Promise.allSettled([panel.done, agent.done, bridge()]); await closed;
  });
});
