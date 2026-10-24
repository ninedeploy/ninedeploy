import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn(), refusal: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: h.agent, agentTransportSealed: h.sealed }));
vi.mock('../../src/lib/agentCapabilities.js', () => ({ capabilityRefusal: h.refusal, nodeLabel: async () => '#7' }));
import { studioCookieValue, studioProxyRoutes } from '../../src/modules/studioProxy.js';
import { StudioRelayChannel } from '../../src/lib/studioRelayChannel.js';
import { bridgeStudioHttp } from '../../src/lib/studioRelayHttp.js';
import { deriveFrameKey } from '../../src/lib/agentFrameCipher.js';
import { encrypt, sha256 } from '../../src/lib/crypto.js';
import { STUDIO_RELAY_HKDF_INFO, STUDIO_RELAY_PROTOCOL_PREFIX, type StudioRelayRequest } from '../../src/lib/studioRelayProtocol.js';
const identity = { databaseId: 7, slug: 'orders', engine: 'postgres' as const, containerId: 'd'.repeat(64), databaseContainerId: 'a'.repeat(64), networkId: 'b'.repeat(64), imageId: 'sha256:' + 'c'.repeat(64), nonce: '11111111-1111-4111-8111-111111111111' };
const user = { id: 1, isInstanceOperator: true, tokenVersion: 0, deactivatedAt: null };
const cookie = () => 'nd-studio-7=' + studioCookieValue(7, user).value;
let panel: FastifyInstance, agent: FastifyInstance, upstream: http.Server, canary: http.Server;
let row: Record<string, unknown>, node: Record<string, unknown>;
let upstreamPort: number, canaryHits: number, streamClosed: boolean;
const parsed = vi.fn();
const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }> = [];
const channels = new Set<StudioRelayChannel>();
const leases = new Map<string, { salt: Buffer; request: StudioRelayRequest }>();
const listenHttp = async (server: http.Server) => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return (server.address() as AddressInfo).port; };
beforeEach(async () => {
  seen.length = 0; leases.clear(); canaryHits = 0; streamClosed = false;
  h.sealed.mockReset().mockResolvedValue(true); h.refusal.mockReset().mockResolvedValue(null); h.agent.mockReset();
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = Buffer.concat(chunks); seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      if (req.url === '/slow') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.write(Buffer.alloc(1024, 1));
        res.once('close', () => { streamClosed = true; }); return;
      }
      if (req.url === '/headers') {
        res.setHeader('set-cookie', ['adminer=first; Domain=foreign.test; Path=/', 'other=second; Path = /; Path=/wide']);
        res.setHeader('clear-site-data', '"*"'); res.setHeader('service-worker-allowed', '/'); res.setHeader('strict-transport-security', 'max-age=10'); res.setHeader('x-frame-options', 'ALLOWALL');
        res.setHeader('content-security-policy', "default-src 'none'");
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(body.length ? body : Buffer.from(req.url!));
    });
  }); upstreamPort = await listenHttp(upstream);
  canary = http.createServer((_req,res) => { canaryHits++; res.end('wrong panel host'); }); const canaryPort = await listenHttp(canary);
  agent = Fastify(); await agent.register(websocket);
  agent.get('/agent/studio', { websocket: true }, (socket, req) => {
    const protocol = String(req.headers['sec-websocket-protocol'] ?? ''), id = protocol.slice(STUDIO_RELAY_PROTOCOL_PREFIX.length), lease = leases.get(id);
    if (!lease) { socket.close(); return; } leases.delete(id);
    const channel = new StudioRelayChannel('agent', deriveFrameKey(sha256('owned-node-token'), lease.salt, STUDIO_RELAY_HKDF_INFO), {
      get bufferedAmount() { return socket.bufferedAmount; }, send: bytes => socket.send(bytes), close: (code, reason) => socket.close(code, reason),
    }, { expectedIncomingBytes: lease.request.bodyBytes, onAuthenticated: async () => {
      await bridgeStudioHttp(channel, { address: '127.0.0.1', port: upstreamPort, verify: async () => undefined }, lease.request);
    } });
    channels.add(channel); socket.on('message', (bytes, binary) => { if (!binary || !Buffer.isBuffer(bytes)) channel.abort(); else channel.receive(bytes); }); socket.on('close', () => channel.socketClosed()); socket.on('error', () => channel.abort());
    void channel.done.then(() => channels.delete(channel), () => channels.delete(channel));
  }); await agent.listen({ port: 0, host: '127.0.0.1' });
  node = { id: 7, host: '127.0.0.1', port: (agent.server.address() as AddressInfo).port, tokenEncrypted: encrypt('owned-node-token') };
  row = { id: 7, slug: 'orders', engine: 'postgres', serverId: 7, webGuiEnabled: true, webGuiPort: canaryPort, nodeStudioIdentity: JSON.stringify({ phase: 'ready', identity }) };
  h.agent.mockImplementation(async (_db,id,op,params) => {
    expect(id).toBe(7); expect(op).toBe('db.studio.open');
    const channel = randomBytes(16).toString('hex'), salt = randomBytes(32); leases.set(channel, { salt, request: params.request });
    return { exitCode: 0, lines: ['ND-STUDIO ' + JSON.stringify({ channel, salt: salt.toString('base64') })] };
  });
  // Node 22 fetch may preconnect after abort; close only fixture-owned idle sockets.
  // Upstream cancellation is asserted before teardown begins.
  parsed.mockReset(); panel = Fastify({ forceCloseConnections: true }); panel.addHook('preParsing', async () => { parsed(); }); panel.decorate('db', { query: { databases: { findFirst: async () => row }, servers: { findFirst: async () => node }, users: { findFirst: async () => user }, settings: { findFirst: async () => null } } } as never);
  await panel.register(studioProxyRoutes, { prefix: '/v1/databases' }); await panel.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  for (const channel of channels) channel.abort(); channels.clear();
  upstream.closeAllConnections(); canary.closeAllConnections();
  await Promise.all([panel.close(), agent.close(), new Promise<void>(resolve => upstream.close(() => resolve())), new Promise<void>(resolve => canary.close(() => resolve()))]);
});
describe('node Studio proxy through real WebSocket and HTTP transports', () => {
  it('relays the recorded node Studio, strips the SQL prefix, and preserves query strings', async () => {
    const res = await panel.inject({ method: 'GET', url: '/v1/databases/7/studio-proxy/?pgsql=nd-db-orders&db=app', headers: { cookie: cookie() } });
    expect(res.statusCode).toBe(200); expect(res.body).toBe('/?pgsql=nd-db-orders&db=app'); expect(canaryHits).toBe(0); expect(seen).toHaveLength(1);
  });
  it('preserves the configured Redis Commander URL prefix and query', async () => {
    row.engine = 'redis'; row.nodeStudioIdentity = JSON.stringify({ phase: 'ready', identity: { ...identity, engine: 'redis' } });
    const res = await panel.inject({ method: 'GET', url: '/v1/databases/7/studio-proxy/apiv2/keys?pattern=a%2Fb', headers: { cookie: cookie() } });
    expect(res.statusCode).toBe(200); expect(seen[0]!.url).toBe('/v1/databases/7/studio-proxy/apiv2/keys?pattern=a%2Fb'); expect(canaryHits).toBe(0);
  });
  it.each(['application/octet-stream','multipart/form-data; boundary=owned-boundary'])('preserves exact bytes and backpressure for %s', async contentType => {
    const payload = Buffer.concat([Buffer.from('--owned-boundary\r\nContent-Disposition: form-data; name="sql"\r\n\r\n'), randomBytes(2 * 1024 * 1024 + 1), Buffer.from('\r\n--owned-boundary--\r\n')]);
    const res = await panel.inject({ method: 'POST', url: '/v1/databases/7/studio-proxy/import', headers: { cookie: cookie(), 'content-type': contentType, authorization: 'Bearer panel-private', 'x-forwarded-for': '203.0.113.1', 'proxy-authorization': 'private' }, payload });
    expect(res.statusCode).toBe(200); expect(res.rawPayload.equals(payload)).toBe(true); expect(seen[0]!.body.equals(payload)).toBe(true); expect(seen[0]!.headers['content-type']).toBe(contentType); expect(seen[0]!.headers.authorization).toBeUndefined(); expect(seen[0]!.headers['proxy-authorization']).toBeUndefined(); expect(seen[0]!.headers['x-forwarded-for']).toBeUndefined(); expect(seen[0]!.headers.cookie).toBeUndefined(); expect(canaryHits).toBe(0);
  });
  it('keeps Studio cookies while removing every panel Studio grant from upstream metadata', async () => {
    const res = await panel.inject({ method: 'GET', url: '/v1/databases/7/studio-proxy/', headers: { cookie: cookie() + '; nd-studio-8=other-grant; adminer=valid' } });
    expect(res.statusCode).toBe(200); expect(seen[0]!.headers.cookie).toBe('adminer=valid');
  });
  it('scopes duplicate upstream cookies and enforces the same framing and origin policy as local Studio', async () => {
    const res = await panel.inject({ method: 'GET', url: '/v1/databases/7/studio-proxy/headers', headers: { cookie: cookie() } });
    expect(res.statusCode).toBe(200); const cookies = res.headers['set-cookie']; expect(cookies).toEqual(['adminer=first; Path=/v1/databases/7/studio-proxy','other=second; Path=/v1/databases/7/studio-proxy']);
    expect(res.headers['x-frame-options']).toBe('DENY'); expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'"); expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    for (const name of ['clear-site-data','service-worker-allowed','strict-transport-security']) expect(res.headers[name]).toBeUndefined();
  });
  it('refuses authentication before parsing an upload or contacting a node', async () => {
    const res = await panel.inject({ method: 'POST', url: '/v1/databases/7/studio-proxy/import', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(1024) });
    expect(res.statusCode).toBe(401); expect(parsed).not.toHaveBeenCalled(); expect(h.agent).not.toHaveBeenCalled(); expect(seen).toHaveLength(0); expect(canaryHits).toBe(0);
  });
  it.each(['off','outdated','missing-receipt','inactive'])('refuses %s without falling back to a cached panel-host port', async kind => {
    if (kind === 'off') h.refusal.mockResolvedValue({ status: 403, code: 'node_feature_disabled', message: 'Owner disabled' });
    if (kind === 'off' || kind === 'outdated') h.agent.mockRejectedValue(Error('agent refused Studio opening'));
    if (kind === 'outdated') h.refusal.mockResolvedValue({ status: 422, code: 'node_agent_outdated', message: 'Update agent' });
    if (kind === 'missing-receipt') row.nodeStudioIdentity = null;
    if (kind === 'inactive') row.webGuiEnabled = false;
    const res = await panel.inject({ method: 'GET', url: '/v1/databases/7/studio-proxy/', headers: { cookie: cookie() } });
    expect(res.statusCode).toBe(kind === 'off' ? 403 : kind === 'outdated' ? 422 : 404); expect(canaryHits).toBe(0); expect(seen).toHaveLength(0); expect(h.agent).toHaveBeenCalledTimes(kind === 'off' || kind === 'outdated' ? 1 : 0);
  });
  it('returns an upstream error rather than an internal error when a reserved socket cannot attach',async()=>{
    h.agent.mockResolvedValue({exitCode:0,lines:['ND-STUDIO '+JSON.stringify({channel:'f'.repeat(32),salt:Buffer.alloc(32).toString('base64')})]});
    const res=await panel.inject({method:'GET',url:'/v1/databases/7/studio-proxy/',headers:{cookie:cookie()}});
    expect(res.statusCode).toBe(502);expect(canaryHits).toBe(0);expect(seen).toHaveLength(0);
  });
  it('closes the real upstream request when the browser cancels a streamed response', async () => {
    const controller = new AbortController(), port = (panel.server.address() as AddressInfo).port;
    const res = await fetch('http://127.0.0.1:' + port + '/v1/databases/7/studio-proxy/slow', { headers: { cookie: cookie() }, signal: controller.signal });
    expect(res.status).toBe(200); await res.body!.getReader().read(); controller.abort();
    await vi.waitFor(() => { expect(streamClosed).toBe(true); expect(channels.size).toBe(0); }); expect(canaryHits).toBe(0);
  });
});
