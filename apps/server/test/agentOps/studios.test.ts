import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ call: vi.fn(), request: vi.fn(), image: vi.fn() }));
vi.mock('../../src/lib/dockerTty.js', async original => ({ ...await original<typeof import('../../src/lib/dockerTty.js')>(), engineCall: h.call, dockerTransport: () => ({ kind: 'socket', socketPath: '/owned.sock' }) }));
vi.mock('../../src/lib/dockerPull.js', async original => ({ ...await original<typeof import('../../src/lib/dockerPull.js')>(), ensureDockerImage: h.image }));
vi.mock('node:http', async original => ({ ...await original<typeof import('node:http')>(), request: h.request }));
import { studioOps, attachStudioChannel, closeAllStudioChannels, studioChannelCount } from '../../src/agentOps/studios.js';
import { runRegisteredOp, advertisedCapabilities } from '../../src/agentOps/index.js';
import { deriveFrameKey, FrameSealer } from '../../src/lib/agentFrameCipher.js';
import { STUDIO_RELAY_HKDF_INFO, STUDIO_RELAY_PROTOCOL_PREFIX, STUDIO_RELAY_FRAME as F } from '../../src/lib/studioRelayProtocol.js';
import { isSealedOnlyAgentOp, agentRequestTimeoutMs } from '../../src/lib/agentClient.js';

const DB = 'a'.repeat(64), NET = 'b'.repeat(64), HELPER = 'd'.repeat(64), IMAGE = 'sha256:' + 'c'.repeat(64);
const identity = { databaseId: 7, slug: 'orders', engine: 'postgres' as const, containerId: HELPER, databaseContainerId: DB, networkId: NET, imageId: IMAGE, nonce: '11111111-1111-4111-8111-111111111111' };
const request = { method: 'GET', path: '/', headers: [], bodyBytes: 0 };
let helperPresent = true;
const response = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });
beforeEach(() => {
  h.call.mockReset(); h.request.mockReset(); h.image.mockReset().mockResolvedValue(undefined); helperPresent = true;
  h.request.mockImplementation((options, cb) => {
    if (options.method !== 'HEAD') throw Error('owned HTTP boundary');
    const req = new EventEmitter(), res = new EventEmitter();
    Object.assign(res, { statusCode: 200, resume: () => queueMicrotask(() => res.emit('end')) });
    Object.assign(req, { end: () => cb(res), destroy: () => req.emit('error', Error('closed')) });
    return req;
  });
  h.call.mockImplementation(async (_transport, method: string, path: string) => {
    if (method === 'GET' && path.startsWith('/images/')) return response({ Id: IMAGE });
    if (method === 'GET' && path.startsWith('/networks/')) return response({ Id: NET, Name: 'nd-dbnet-orders', Driver: 'bridge', Scope: 'local' });
    if (method === 'POST' && path === `/containers/${HELPER}/start`) return response({}, 304);
    if (method === 'DELETE' && path === `/containers/${HELPER}?force=1&v=1`) { helperPresent = false; return response({}, 204); }
    if (method !== 'GET') throw Error('Unexpected Docker test operation');
    if (path === '/containers/nd-db-orders/json') return response({ Id: DB, Name: '/nd-db-orders', State: { Running: true }, Config: { Labels: { 'ninedeploy.managed': 'database', 'ninedeploy.database.id': '7', 'ninedeploy.database.slug': 'orders' } }, NetworkSettings: { Networks: { 'nd-dbnet-orders': { NetworkID: NET, IPAddress: '172.31.0.2' } } } });
    if (!helperPresent) return response({}, 404);
    return response({ Id: HELPER, Name: '/nd-node-studio-7', Image: IMAGE, State: { Running: true }, Config: { Labels: {
      'ninedeploy.managed': 'database-studio', 'ninedeploy.database.id': '7', 'ninedeploy.database.slug': 'orders', 'ninedeploy.database.engine': 'postgres',
      'ninedeploy.studio.database.container': DB, 'ninedeploy.studio.network': NET, 'ninedeploy.studio.nonce': identity.nonce, 'ninedeploy.studio.image': IMAGE,
    } }, HostConfig: { NetworkMode: NET, PortBindings: {} }, NetworkSettings: { Networks: { 'nd-dbnet-orders': { NetworkID: NET, IPAddress: '172.31.0.7' } } } });
  });
});
afterEach(() => { closeAllStudioChannels(); vi.unstubAllEnvs(); vi.useRealTimers(); });
async function op(name: string, params: Record<string, unknown>, sealed = true) {
  const lines: string[] = [], exit = await studioOps.ops[name]!.run(params, line => lines.push(line), { sealed });
  expect(lines).toHaveLength(1); expect(lines[0]).toMatch(/^ND-STUDIO /);
  return { exit, value: JSON.parse(lines[0]!.slice('ND-STUDIO '.length)) };
}
const open = () => op('db.studio.open', { identity, request });
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; frames: Buffer[] = [];
  send(bytes: Buffer) { this.frames.push(bytes); }
  close = vi.fn((_code?: number, _reason?: string) => { this.readyState = 3; this.emit('close'); });
}
describe('sealed Studio agent operations and single-use channels', () => {
  it('starts/stops a confirmed owned helper and answers one strict identity receipt', async () => {
    expect((await op('db.studio.start', { databaseId: 7, slug: 'orders', engine: 'postgres' })).value).toEqual(identity);
    expect((await op('db.studio.stop', identity)).value).toEqual({ stopped: HELPER });
    expect(helperPresent).toBe(false);
  });
  it.each(['db.studio.start', 'db.studio.stop', 'db.studio.open', 'db.studio.clear'])('refuses %s on unsealed transport at both admission boundaries', async name => {
    expect((await op(name, {}, false)).value.error).toMatchObject({ status: 422, code: 'node_studio_unsealed' });
    await expect(runRegisteredOp(name, {}, () => undefined, { sealed: false })).rejects.toThrow('unencrypted');
    expect(isSealedOnlyAgentOp(name)).toBe(true); expect(h.call).not.toHaveBeenCalled();
  });
  it.each(['NINEDEPLOY_AGENT_DATABASES', 'NINEDEPLOY_AGENT_DATABASE_STUDIOS'])('removes support and refuses IO for owner flag %s', async variable => {
    vi.stubEnv(variable, 'off'); expect(advertisedCapabilities()).not.toContain('db.studio');
    expect((await open()).value.error.status).toBe(403); expect(h.call).not.toHaveBeenCalled();
    await expect(runRegisteredOp('db.studio.open', { identity, request }, () => undefined, { sealed: true })).rejects.toThrow('disabled');
  });
  it('validates strict and aggregate metadata before reserving anything', async () => {
    expect((await op('db.studio.open', { identity, request, host: 'caller' })).value.error.status).toBe(400);
    expect((await op('db.studio.open', { identity, request: { ...request, headers: Array.from({ length: 12 }, () => ['x-test', 'x'.repeat(8192)]) } })).value.error.status).toBe(413);
    expect(studioChannelCount()).toBe(0); expect(h.call).not.toHaveBeenCalled();
  });
  it('gives image preparation its bounded budget without extending ordinary Studio requests', () => {
    expect(agentRequestTimeoutMs('db.studio.start')).toBe(205000);
    expect(agentRequestTimeoutMs('db.studio.clear')).toBe(240000);
    expect(agentRequestTimeoutMs('db.studio.stop')).toBe(25000);
    expect(agentRequestTimeoutMs('db.studio.open')).toBe(20000);
  });
  it('clears a lost start receipt through a sealed, strict resource request', async () => {
    expect((await op('db.studio.clear', { databaseId: 7, slug: 'orders', engine: 'postgres', host: 'caller' })).value.error.status).toBe(400);
    expect(h.call).not.toHaveBeenCalled();
    expect((await op('db.studio.clear', { databaseId: 7, slug: 'orders', engine: 'postgres' })).value).toEqual({ stopped: HELPER });
    expect((await op('db.studio.clear', { databaseId: 7, slug: 'orders', engine: 'postgres' })).value).toEqual({ stopped: null });
  });
  it('bounds pending requests and expires abandoned reservations', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 16; i++) expect((await open()).exit).toBe(0);
    expect((await open()).value.error.status).toBe(429); expect(studioChannelCount()).toBe(16);
    await vi.advanceTimersByTimeAsync(30001); expect(studioChannelCount()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('requires a valid encrypted first frame before opening HTTP, then rechecks the recorded target', async () => {
    const reserved = (await open()).value, socket = new Socket(), token = randomBytes(32).toString('hex');
    attachStudioChannel(socket, STUDIO_RELAY_PROTOCOL_PREFIX + reserved.channel, token);
    expect(h.request).not.toHaveBeenCalled();
    const key = deriveFrameKey(token, Buffer.from(reserved.salt, 'base64'), STUDIO_RELAY_HKDF_INFO);
    socket.emit('message', new FrameSealer(key, 'panel').seal(F.start), true);
    await vi.waitFor(() => expect(h.request).toHaveBeenCalled());
    await vi.waitFor(() => expect(studioChannelCount()).toBe(0));
  });
  it('rejects a forged first frame without any HTTP request', async () => {
    const reserved = (await open()).value, socket = new Socket();
    attachStudioChannel(socket, STUDIO_RELAY_PROTOCOL_PREFIX + reserved.channel, randomBytes(32).toString('hex'));
    socket.emit('message', new FrameSealer(randomBytes(32), 'panel').seal(F.start), true);
    await vi.waitFor(() => expect(studioChannelCount()).toBe(0)); expect(h.request).not.toHaveBeenCalled();
  });
  it('consumes a channel only once and bounds unauthenticated attachment', async () => {
    vi.useFakeTimers(); const reserved = (await open()).value, token = randomBytes(32).toString('hex'), first = new Socket(), second = new Socket();
    attachStudioChannel(first, STUDIO_RELAY_PROTOCOL_PREFIX + reserved.channel, token);
    attachStudioChannel(second, STUDIO_RELAY_PROTOCOL_PREFIX + reserved.channel, token);
    expect(second.close).toHaveBeenCalledWith(1008, expect.any(String));
    await vi.advanceTimersByTimeAsync(10001); expect(studioChannelCount()).toBe(0); expect(h.request).not.toHaveBeenCalled();
  });
  it('rechecks owner flags between reservation and attachment and handles unknown channels', async () => {
    const reserved = (await open()).value, socket = new Socket(); vi.stubEnv('NINEDEPLOY_AGENT_DATABASE_STUDIOS', 'off');
    attachStudioChannel(socket, STUDIO_RELAY_PROTOCOL_PREFIX + reserved.channel, randomBytes(32).toString('hex'));
    expect(socket.close).toHaveBeenCalledWith(1008, expect.any(String)); expect(studioChannelCount()).toBe(0);
    const unknown = new Socket(); attachStudioChannel(unknown, 'invalid', 'unneeded'); expect(unknown.close).toHaveBeenCalledWith(1008, expect.any(String)); expect(h.request).not.toHaveBeenCalled();
  });
});
