import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, databases, servers, users, apiTokens, sessions, eq, type Database } from '@ninedeploy/db';
const h = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn(), refusal: vi.fn(), decrypt: vi.fn(), dataDir: '' }));
vi.mock('../../src/config.js', async original => {
  const source = await original<typeof import('../../src/config.js')>();
  return { config: { ...source.config, paths: { ...source.config.paths, get dataDir() { return h.dataDir; } } } };
});
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: h.agent, agentTransportSealed: h.sealed }));
vi.mock('../../src/lib/agentCapabilities.js', () => ({ capabilityRefusal: h.refusal, nodeLabel: async () => '"owned" (#7)' }));
vi.mock('../../src/lib/crypto.js', async original => ({ ...await original<typeof import('../../src/lib/crypto.js')>(), decrypt: h.decrypt }));
import { nodeStudioState, storedNodeStudio, startNodeStudioForDatabase, stopNodeStudioForDatabase, assertNodeStudioSupport, openNodeStudioRelay } from '../../src/lib/nodeStudio.js';
import { withNodeDatabaseLifecycle } from '../../src/lib/nodeDatabaseLifecycle.js';
import Fastify from 'fastify';
import authPlugin from '../../src/plugins/auth.js';
import { signAccessToken } from '../../src/lib/jwt.js';
import { studioProxyRoutes } from '../../src/modules/studioProxy.js';
import { databasesRoutes } from '../../src/modules/databases.js';
import { asUser, buildTestApp } from '../helpers.js';
import { StudioRelayChannel } from '../../src/lib/studioRelayChannel.js';
import { deriveFrameKey } from '../../src/lib/agentFrameCipher.js';
import { sha256 } from '../../src/lib/crypto.js';
import { STUDIO_RELAY_HKDF_INFO } from '../../src/lib/studioRelayProtocol.js';
const identity = { databaseId: 7, slug: 'orders', engine: 'postgres' as const, containerId: 'd'.repeat(64), databaseContainerId: 'a'.repeat(64), networkId: 'b'.repeat(64), imageId: 'sha256:' + 'c'.repeat(64), nonce: '11111111-1111-4111-8111-111111111111' };
const receipt = (value: unknown, exitCode = 0) => ({ exitCode, lines: ['ND-STUDIO ' + JSON.stringify(value)] });
let connection: ReturnType<typeof createDb>;
const row = async () => (await connection.db.query.databases.findFirst({ where: eq(databases.id, 7) }))!;
const change = async (value: Partial<Database>) => { await connection.db.update(databases).set(value).where(eq(databases.id, 7)); };
let sockets: FakeSocket[] = [], peer: StudioRelayChannel | undefined;
class FakeSocket extends EventTarget {
  binaryType = ''; readyState = 0; bufferedAmount = 0;
  send = vi.fn((bytes: Buffer) => { peer?.receive(bytes); });
  close = vi.fn(() => { this.readyState = 3; });
  constructor(readonly url: string, readonly protocols: string[]) { super(); sockets.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  receive(bytes: Buffer) { this.dispatchEvent(new MessageEvent('message', { data: bytes })); }
}
beforeEach(async () => {
  h.dataDir = mkdtempSync(path.join(tmpdir(), 'nd-panel-studio-'));
  connection = createDb({ url: 'file::memory:' }); await connection.ready; await runMigrations(connection.db);
  await connection.db.insert(users).values({ id: 1, email: 'studio@example.test', passwordHash: 'owned-fixture', isInstanceOperator: true });
  await connection.db.insert(servers).values({ id: 7, name: 'owned', host: '::1', port: 4600, tokenEncrypted: 'encrypted-node' });
  await connection.db.insert(databases).values({ id: 7, name: 'Orders', slug: 'orders', engine: 'postgres', status: 'running', passwordEncrypted: 'encrypted-password', serverId: 7, nodeContainerName: 'nd-db-orders' });
  h.sealed.mockReset().mockResolvedValue(true); h.refusal.mockReset().mockResolvedValue(null);
  h.decrypt.mockReset().mockImplementation(value => value === 'encrypted-node' ? 'node-token' : 'fixture/@:password');
  h.agent.mockReset().mockImplementation(async (_db, _server, op) => { if (op === 'db.studio.open') throw Error('agent refused Studio opening'); return receipt(op === 'db.studio.start' ? identity : op === 'db.studio.stop' ? { stopped: identity.containerId } : { stopped: null }); });
  sockets = []; peer = undefined; vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(async () => { peer?.abort(); connection.client!.close(); vi.unstubAllGlobals(); vi.useRealTimers(); await rm(h.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
describe('panel node Studio lifecycle and durable receipts', () => {
  it('stores preparation before remote IO and enables access only after a strict ready receipt', async () => {
    h.agent.mockImplementationOnce(async (_db, node, op, params, _sink, options) => {
      const current = await row();
      expect(current.webGuiEnabled).toBe(false); expect(current.webGuiPort).toBeNull();
      expect(storedNodeStudio(current)).toMatchObject({ phase: 'preparing', databaseId: 7, slug: 'orders' });
      expect(node).toBe(7); expect(op).toBe('db.studio.start'); expect(params).toEqual({ databaseId: 7, slug: 'orders', engine: 'postgres' });
      expect(options.signal).toBeUndefined(); return receipt(identity);
    });
    expect(await startNodeStudioForDatabase(connection.db, 7)).toEqual(identity);
    expect(storedNodeStudio(await row())).toEqual({ phase: 'ready', identity });
    expect((await row()).webGuiEnabled).toBe(true); expect((await row()).webGuiPort).toBeNull();
    expect(h.decrypt).not.toHaveBeenCalled();
  });
  it('passes KV credentials only after fresh sealed capability admission', async () => {
    await change({ engine: 'redis' }); h.agent.mockResolvedValue(receipt({ ...identity, engine: 'redis' }));
    await startNodeStudioForDatabase(connection.db, 7);
    expect(h.agent.mock.calls[0]![3]).toEqual({ databaseId: 7, slug: 'orders', engine: 'redis', password: 'fixture/@:password' });
    expect((await row()).nodeStudioIdentity).not.toContain('password');
  });
  it.each([{ status: 403, code: 'node_feature_disabled', message: 'Owner disabled' }, { status: 422, code: 'node_agent_outdated', message: 'Update agent' }])('preserves refusal $code without writing or decrypting credentials', async refusal => {
    await change({ engine: 'redis' }); h.refusal.mockResolvedValue(refusal);
    await expect(startNodeStudioForDatabase(connection.db, 7)).rejects.toMatchObject({ statusCode: refusal.status, code: refusal.code });
    expect(h.agent).not.toHaveBeenCalled(); expect(h.decrypt).not.toHaveBeenCalled(); expect((await row()).nodeStudioIdentity).toBeNull();
  });
  it('negotiates both required capabilities with the recorded node', async () => {
    await assertNodeStudioSupport(connection.db, 7);
    expect(h.refusal).toHaveBeenCalledWith(expect.any(Function), '"owned" (#7)', true, expect.objectContaining({ cap: ['db.manage','db.studio'], sealedRequired: true, persist: { db: connection.db, serverId: 7 } }));
  });
  it.each(['mongo', 'clickhouse', 'meilisearch', 'rabbitmq'] as const)('refuses unsupported %s without node IO', async engine => {
    await change({ engine }); await expect(startNodeStudioForDatabase(connection.db, 7)).rejects.toMatchObject({ statusCode: 422 }); expect(h.agent).not.toHaveBeenCalled();
  });
  it('refuses a pending receipt whose previous helper belongs to another database', async () => {
    await change({ webGuiEnabled: true, nodeStudioIdentity: JSON.stringify({ phase: 'preparing', databaseId: 7, slug: 'orders', engine: 'postgres', attemptId: identity.nonce, previous: { ...identity, databaseId: 8, slug: 'other' } }) });
    await expect(startNodeStudioForDatabase(connection.db, 7)).rejects.toMatchObject({ statusCode: 409 }); expect(h.agent).not.toHaveBeenCalled();
  });
  it('never falls back to a local database or a missing row', async () => {
    await expect(startNodeStudioForDatabase(connection.db, 8)).rejects.toMatchObject({ statusCode: 404 });
    await change({ serverId: null }); await expect(startNodeStudioForDatabase(connection.db, 7)).rejects.toMatchObject({ statusCode: 409 }); expect(h.agent).not.toHaveBeenCalled();
  });
  it.each(['invalid-json', 'wrong-resource', 'wrong-engine'])('refuses stored %s metadata before remote mutation', async kind => {
    await change({ nodeStudioIdentity: kind === 'invalid-json' ? '{' : JSON.stringify({ phase: 'ready', identity: { ...identity, ...(kind === 'wrong-resource' ? { slug: 'other' } : { engine: 'redis' }) } }) });
    await expect(startNodeStudioForDatabase(connection.db, 7)).rejects.toMatchObject({ statusCode: 409 }); expect(h.agent).not.toHaveBeenCalled();
  });
  it.each([{ exitCode: 0, lines: [] }, { exitCode: 0, lines: ['other'] }, { exitCode: 0, lines: ['ND-STUDIO invalid'] }, receipt({ ...identity, slug: 'other' }), receipt({ ...identity, unexpected: true }), receipt({ error: { status: 200, code: 'bad', message: 'bad' } }, 1)])('keeps a preparation receipt after an unconfirmed remote reply', async reply => {
    h.agent.mockResolvedValue(reply);
    await expect(startNodeStudioForDatabase(connection.db, 7)).rejects.toMatchObject({ statusCode: 502 });
    expect(storedNodeStudio(await row())?.phase).toBe('preparing'); expect((await row()).webGuiEnabled).toBe(false);
  });
  it('retains lost-reply state, redacts transport details, and recovers it with a confirmed clear', async () => {
    h.agent.mockRejectedValueOnce(Error('private transport detail'));
    await expect(startNodeStudioForDatabase(connection.db, 7)).rejects.toMatchObject({ statusCode: 502, message: 'The node Web Studio operation could not be confirmed' });
    expect(storedNodeStudio(await row())?.phase).toBe('preparing');
    await stopNodeStudioForDatabase(connection.db, 7); expect((await row()).nodeStudioIdentity).toBeNull();
    expect(h.agent.mock.calls.map(call => call[2])).toEqual(['db.studio.start', 'db.studio.clear']);
  });
  it('does not overwrite a retargeted database when a previous node preparation finishes late', async () => {
    await connection.db.insert(servers).values({ id: 8, name: 'other', host: 'node-other', tokenEncrypted: 'other-node' });
    h.agent.mockImplementationOnce(async () => { await change({ serverId: 8, nodeStudioIdentity: null, webGuiEnabled: false }); return receipt(identity); });
    await expect(startNodeStudioForDatabase(connection.db, 7)).rejects.toMatchObject({ statusCode: 409 });
    expect(await row()).toMatchObject({ serverId: 8, nodeStudioIdentity: null, webGuiEnabled: false });
    expect(h.agent.mock.calls.map(call => [call[1],call[2]])).toEqual([[7,'db.studio.start'],[7,'db.studio.stop']]);
  });
  it('preserves a typed refusal without opening access', async () => {
    h.agent.mockResolvedValue(receipt({ error: { status: 409, code: 'node_studio_identity_changed', message: 'Reopen the Studio' } }, 1));
    await expect(startNodeStudioForDatabase(connection.db, 7)).rejects.toMatchObject({ statusCode: 409, code: 'node_studio_identity_changed' });
    expect((await row()).webGuiEnabled).toBe(false);
  });
  it('keeps exclusion after browser cancellation until remote completion and confirmed candidate cleanup', async () => {
    const abort = new AbortController(); let finish!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    h.agent.mockImplementationOnce(async () => { entered(); await new Promise<void>(resolve => { finish = resolve; }); return receipt(identity); });
    const starting = startNodeStudioForDatabase(connection.db, 7, abort.signal); void starting.catch(() => undefined); await started; abort.abort();
    await expect(stopNodeStudioForDatabase(connection.db, 7)).rejects.toMatchObject({ statusCode: 409, code: 'node_database_busy' });
    finish(); await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.agent.mock.calls.map(call => call[2])).toEqual(['db.studio.start','db.studio.stop']); expect((await row()).webGuiEnabled).toBe(false);
  });
  it('does not start anything for a request already cancelled', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(startNodeStudioForDatabase(connection.db, 7, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.agent).not.toHaveBeenCalled(); expect((await row()).nodeStudioIdentity).toBeNull();
  });
  it('passes the previously recorded ID on retry and keeps the same live helper after cancellation', async () => {
    await change({ nodeStudioIdentity: JSON.stringify({ phase: 'ready', identity }), webGuiEnabled: true });
    const abort = new AbortController(); h.agent.mockImplementationOnce(async (_db, _node, _op, params) => { expect(params.previous).toEqual(identity); abort.abort(); return receipt(identity); });
    await expect(startNodeStudioForDatabase(connection.db, 7, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.agent).toHaveBeenCalledTimes(1); expect(storedNodeStudio(await row())).toEqual({ phase: 'ready', identity }); expect((await row()).webGuiEnabled).toBe(true);
  });
  it('leaves the preparing receipt and disables access when candidate cleanup cannot be confirmed', async () => {
    const abort = new AbortController(); h.agent.mockImplementationOnce(async () => { abort.abort(); return receipt(identity); }).mockResolvedValueOnce(receipt({ stopped: 'wrong' }));
    await expect(startNodeStudioForDatabase(connection.db, 7, abort.signal)).rejects.toMatchObject({ statusCode: 502 });
    expect(storedNodeStudio(await row())?.phase).toBe('preparing'); expect((await row()).webGuiEnabled).toBe(false);
  });
  it.each(['short', 'e'.repeat(64)])('disables access and retains the receipt after a mismatched clear reply %s', async stopped => {
    await change({ nodeStudioIdentity: JSON.stringify({ phase: 'ready', identity }), webGuiEnabled: true });
    h.agent.mockImplementationOnce(async () => { expect((await row()).webGuiEnabled).toBe(false); return receipt({ stopped }); });
    await expect(stopNodeStudioForDatabase(connection.db, 7)).rejects.toMatchObject({ statusCode: 502 }); expect(storedNodeStudio(await row())?.phase).toBe('ready');
    await stopNodeStudioForDatabase(connection.db, 7); expect((await row()).nodeStudioIdentity).toBeNull();
  });
  it('reports recoverable public lifecycle state without exposing or trusting malformed metadata', async () => {
    expect(nodeStudioState(await row())).toBeNull();
    await change({ nodeStudioIdentity: JSON.stringify({ phase:'ready',identity }), webGuiEnabled:true });expect(nodeStudioState(await row())).toBe('ready');
    await change({ webGuiEnabled:false });expect(nodeStudioState(await row())).toBe('cleanup_pending');
    await change({ nodeStudioIdentity:'{' });expect(nodeStudioState(await row())).toBe('cleanup_pending');
    await change({ serverId:null });expect(nodeStudioState(await row())).toBeNull();
  });
  it('skips an inactive never-created Studio, including when its node is unavailable', async () => {
    h.refusal.mockRejectedValue(Error('offline')); await stopNodeStudioForDatabase(connection.db, 7); expect(h.agent).not.toHaveBeenCalled(); expect(h.refusal).not.toHaveBeenCalled();
  });
  it('honors a surrounding database lifecycle mutation without reentering it', async () => {
    await withNodeDatabaseLifecycle(7, async () => { await expect(startNodeStudioForDatabase(connection.db, 7)).rejects.toMatchObject({ statusCode: 409 }); });
    expect(h.agent).not.toHaveBeenCalled();
  });
});
describe('panel node Studio relay admission', () => {
  const request = { method: 'GET' as const, path: '/', headers: [] as Array<[string,string]>, bodyBytes: 0 };
  const reserve = () => h.agent.mockResolvedValue(receipt({ channel: '1'.repeat(32), salt: Buffer.alloc(32, 7).toString('base64') }));
  beforeEach(async () => { await change({ nodeStudioIdentity: JSON.stringify({ phase: 'ready', identity }), webGuiEnabled: true }); reserve(); });
  it('requires an enabled, recorded Studio before node IO', async () => {
    await change({ webGuiEnabled: false }); await expect(openNodeStudioRelay(connection.db, await row(), request)).rejects.toMatchObject({ statusCode: 404 });
    expect(h.agent).not.toHaveBeenCalled(); expect(sockets).toHaveLength(0);
  });
  it('sanitizes panel credentials and targets only the recorded node using a distinct encrypted channel', async () => {
    const relay = await openNodeStudioRelay(connection.db, await row(), { ...request, headers: [['authorization','Bearer private'],['cookie','nd-studio-7=private; adminer=valid'],['accept','text/html']] });
    expect(h.agent.mock.calls[0]![3].request.headers).toEqual([['cookie','adminer=valid'],['accept','text/html']]);
    expect(h.refusal).not.toHaveBeenCalled();
    const socket = sockets[0]!; expect(socket.url).toBe('ws://[::1]:4600/agent/studio'); expect(socket.protocols).toEqual(['ninedeploy.agent-studio.' + '1'.repeat(32)]); expect(socket.send).not.toHaveBeenCalled();
    peer = new StudioRelayChannel('agent', deriveFrameKey(sha256('node-token'), Buffer.alloc(32,7), STUDIO_RELAY_HKDF_INFO), { bufferedAmount: 0, send: bytes => socket.receive(bytes), close: () => undefined });
    socket.open(); await peer.ready; peer.sendHead({ status: 200, headers: [['content-type','text/plain']] });
    expect(await relay.head).toMatchObject({ status: 200 }); relay.abort(); await expect(relay.done).rejects.toThrow();
  });
  it.each([receipt({ channel: 'short', salt: 'x' }), receipt({ channel: '1'.repeat(32), salt: 'short' }), receipt({ channel: '1'.repeat(32), salt: Buffer.alloc(32).toString('base64'), host: 'other' })])('refuses malformed channel receipts without connecting', async value => {
    h.agent.mockResolvedValue(value); await expect(openNodeStudioRelay(connection.db, await row(), request)).rejects.toMatchObject({ statusCode: 502 }); expect(sockets).toHaveLength(0);
  });
  it('does not create a socket when its encrypted node credential cannot be opened', async () => {
    h.decrypt.mockImplementation(() => { throw Error('invalid encrypted token'); });
    await expect(openNodeStudioRelay(connection.db, await row(), request)).rejects.toThrow(); expect(sockets).toHaveLength(0);
  });
});

describe('node Studio API and database lifecycle integration', () => {
  async function app() { const value = await buildTestApp({ db: connection.db }); await value.register(databasesRoutes, { prefix: '/v1/databases' }); return value; }
  it('returns a private node Studio URL with no host port, and does not expose its identity receipt', async () => {
    const server = await app();
    const res = await server.inject({ method: 'POST', url: '/v1/databases/7/studio', headers: asUser(), payload: {} });
    expect(res.statusCode).toBe(200); expect(res.json()).toMatchObject({ ok: true, port: null, serverId: 7, url: '/v1/databases/7/studio-proxy/?pgsql=nd-db-orders&username=nine&db=app' });
    expect(res.headers['set-cookie']).toContain('nd-studio-7=');
    const detail = await server.inject({ method: 'GET', url: '/v1/databases/7', headers: asUser() });
    expect(detail.statusCode).toBe(200); expect(detail.json()).toMatchObject({ serverId: 7, webGuiPort: null, webGuiEnabled: true }); expect(detail.json()).not.toHaveProperty('nodeStudioIdentity');
    await server.close();
  });
  it('refuses an explicit host port for node Studios before node IO', async () => {
    const server = await app(); const res = await server.inject({ method: 'POST', url: '/v1/databases/7/studio', headers: asUser(), payload: { port: 18077 } });
    expect(res.statusCode).toBe(400); expect(h.agent).not.toHaveBeenCalled(); await server.close();
  });
  it('requires an authenticated operator before preparing or stopping a Studio', async () => {
    const server = await app();
    for (const method of ['POST','DELETE'] as const) {
      expect((await server.inject({ method, url: '/v1/databases/7/studio', headers: asUser({ isOperator: false }) })).statusCode).toBe(403);
      expect((await server.inject({ method, url: '/v1/databases/7/studio' })).statusCode).toBe(401);
    }
    expect(h.agent).not.toHaveBeenCalled(); await server.close();
  });
  it('does not clear the browser cookie or claim success when remote stop is unconfirmed', async () => {
    await change({ nodeStudioIdentity: JSON.stringify({ phase: 'ready', identity }), webGuiEnabled: true });
    h.agent.mockResolvedValueOnce(receipt({ stopped: 'short' })); const server = await app();
    const res = await server.inject({ method: 'DELETE', url: '/v1/databases/7/studio', headers: asUser() });
    expect(res.statusCode).toBe(502); expect(res.headers['set-cookie']).toBeUndefined(); expect(storedNodeStudio(await row())?.phase).toBe('ready');
    const retry = await server.inject({ method: 'DELETE', url: '/v1/databases/7/studio', headers: asUser() }); expect(retry.statusCode).toBe(200); expect(retry.headers['set-cookie']).toContain('Max-Age=0'); await server.close();
  });
  it('excludes stop, restart, start, limits and delete while a Studio start is outstanding', async () => {
    const server = await app(); let finish!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    h.agent.mockImplementationOnce(async () => { entered(); await new Promise<void>(resolve => { finish = resolve; }); return receipt(identity); });
    const preparing = server.inject({ method: 'POST', url: '/v1/databases/7/studio', headers: asUser(), payload: {} }).then(value => value); await started;
    try {
      for (const [method, suffix, payload] of [['POST','/stop',{}],['POST','/restart',{}],['POST','/start',{}],['PATCH','/limits',{ memLimitMb: 512 }],['DELETE','',undefined]] as const) {
        const res = await server.inject({ method, url: '/v1/databases/7' + suffix, headers: asUser(), payload }); expect([suffix,res.statusCode,res.json().error?.code]).toEqual([suffix,409,'node_database_busy']);
      }
    } finally { finish(); }
    expect((await preparing).statusCode).toBe(200); expect(h.agent).toHaveBeenCalledTimes(1); await server.close();
  });
  it.each([['POST','/stop',{}],['POST','/restart',{}],['POST','/start',{}],['PATCH','/limits',{ memLimitMb: 512 }]] as const)('keeps the database unchanged when %s %s cannot confirm Studio cleanup', async (method, suffix, payload) => {
    await change({ nodeStudioIdentity: JSON.stringify({ phase: 'ready', identity }), webGuiEnabled: true }); h.agent.mockResolvedValueOnce(receipt({ stopped: 'short' }));
    const before = await row(), server = await app();
    const res = await server.inject({ method, url: '/v1/databases/7' + suffix, headers: asUser(), payload });
    expect(res.statusCode).toBe(502); expect(h.agent.mock.calls.map(call => call[2])).toEqual(['db.studio.clear']);
    expect(await row()).toMatchObject({ status: before.status, memLimitMb: before.memLimitMb }); await server.close();
  });
  it('clears and confirms the Studio before stopping its database', async () => {
    await change({ nodeStudioIdentity: JSON.stringify({ phase: 'ready', identity }), webGuiEnabled: true }); const server = await app();
    const res = await server.inject({ method: 'POST', url: '/v1/databases/7/stop', headers: asUser() });
    expect(res.statusCode).toBe(200); expect(h.agent.mock.calls.map(call => call[2])).toEqual(['db.studio.clear','docker.rm']);
    expect(h.agent.mock.calls[0]![3]).toEqual({databaseId:7,slug:'orders',engine:'postgres',previous:identity});
    expect(await row()).toMatchObject({ status: 'stopped', webGuiEnabled: false, nodeStudioIdentity: null }); await server.close();
  });
  it('retains the database after unconfirmed helper removal; explicit force reports the orphan', async () => {
    await change({ nodeStudioIdentity: JSON.stringify({ phase: 'preparing', databaseId: 7, slug: 'orders', engine: 'postgres', attemptId: identity.nonce }) });
    h.agent.mockImplementation(async (_db,_node,op) => op === 'db.studio.clear' ? receipt({ stopped: 'short' }) : receipt({}));
    const server = await app();
    const denied = await server.inject({ method: 'DELETE', url: '/v1/databases/7', headers: asUser() }); expect(denied.statusCode).toBe(502); expect(await row()).toBeDefined();
    expect(h.agent.mock.calls.map(call => call[2])).toEqual(['db.studio.clear']);
    const forced = await server.inject({ method: 'DELETE', url: '/v1/databases/7?force=true', headers: asUser() });
    expect(forced.statusCode).toBe(200); expect(forced.json().note).toContain('nd-node-studio-7'); expect(await row()).toBeUndefined(); await server.close();
  });
});

describe('Studio grant follows its authenticated parent credential', () => {
  async function app() {
    const value = Fastify(); value.decorate('db', connection.db); await value.register(authPlugin); await value.register(databasesRoutes, { prefix: '/v1/databases' }); await value.register(studioProxyRoutes, { prefix: '/v1/databases' }); return value;
  }
  async function mint(server: Awaited<ReturnType<typeof app>>, token: string) {
    h.refusal.mockResolvedValue(null);
    const response = await server.inject({ method: 'POST', url: '/v1/databases/7/studio', headers: { authorization: 'Bearer ' + token }, payload: {} });
    expect(response.statusCode).toBe(200);
    h.refusal.mockResolvedValue({ status: 403, code: 'node_feature_disabled', message: 'Owner disabled Studio' });
    return String(response.headers['set-cookie']).split(';')[0]!;
  }
  const proxy = (server: Awaited<ReturnType<typeof app>>, cookie: string) => server.inject({ method: 'GET', url: '/v1/databases/7/studio-proxy/', headers: { cookie } });
  it.each([{scopes:[]}, {scopes:['operator']}])('ends only the Studio grant of a deleted API token with scopes $scopes', async ({scopes}) => {
    const token = 'opaque-parent-one', other = 'opaque-parent-two';
    await connection.db.insert(apiTokens).values([{ userId: 1, name: 'one', hash: sha256(token), scopes }, { userId: 1, name: 'two', hash: sha256(other), scopes }]);
    const server = await app();
    try {
      const cookie = await mint(server, token), otherCookie = await mint(server, other);
      expect(cookie).not.toContain(token); expect((await proxy(server, cookie)).statusCode).toBe(403);
      await connection.db.delete(apiTokens).where(eq(apiTokens.hash, sha256(token)));
      expect((await server.inject({ method: 'POST', url: '/v1/databases/7/studio', headers: { authorization: 'Bearer ' + token } })).statusCode).toBe(401);
      expect((await proxy(server, cookie)).statusCode).toBe(401);
      expect((await proxy(server, otherCookie)).statusCode).toBe(403);
    } finally { await server.close(); }
  });
  it('ends a Studio grant when its parent API token loses operator scope', async () => {
    const token = 'opaque-parent-scope'; await connection.db.insert(apiTokens).values({ userId: 1, name: 'scope', hash: sha256(token), scopes: ['operator'] });
    const server = await app();
    try { const cookie = await mint(server, token); await connection.db.update(apiTokens).set({ scopes: ['read'] }).where(eq(apiTokens.hash, sha256(token))); expect((await proxy(server, cookie)).statusCode).toBe(401); }
    finally { await server.close(); }
  });
  it('ends only the Studio grant of the individually revoked login session', async () => {
    const jti = 'owned-login-one', other = 'owned-login-two';
    await connection.db.insert(sessions).values([{ userId: 1, jti, expiresAt: new Date(Date.now() + 3600000) }, { userId: 1, jti: other, expiresAt: new Date(Date.now() + 3600000) }]);
    const token = await signAccessToken(1, 0, jti), otherToken = await signAccessToken(1, 0, other), server = await app();
    try {
      const cookie = await mint(server, token), otherCookie = await mint(server, otherToken);
      expect((await proxy(server, cookie)).statusCode).toBe(403);
      await connection.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.jti, jti));
      expect((await proxy(server, cookie)).statusCode).toBe(401); expect((await proxy(server, otherCookie)).statusCode).toBe(403);
    } finally { await server.close(); }
  });
});
