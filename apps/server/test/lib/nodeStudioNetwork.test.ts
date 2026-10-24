import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ hostname: vi.fn() }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), hostname: h.hostname }));
import { ensureNodeStudioNetwork, releaseNodeStudioNetwork } from '../../src/lib/nodeStudioNetwork.js';

const SELF = 'a'.repeat(64), NET = 'b'.repeat(64), BRIDGE = 'c'.repeat(64), HOST = SELF.slice(0, 12);
const resource = { databaseId: 7, slug: 'orders', networkId: NET };
const reply = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });
let self: any, version: unknown, connectMode: string, disconnectMode: string, network: any;
const verify = vi.fn(), call = vi.fn();
beforeEach(() => {
  vi.stubEnv('NINEDEPLOY_AGENT', '1'); h.hostname.mockReturnValue(HOST); verify.mockReset().mockResolvedValue(undefined);
  version = '1.48'; connectMode = ''; disconnectMode = '';
  self = { Id: SELF, State: { Running: true }, Config: { Hostname: HOST, Env: ['NINEDEPLOY_AGENT=1'] }, HostConfig: { NetworkMode: 'bridge' },
    NetworkSettings: { Networks: { bridge: { NetworkID: BRIDGE, GwPriority: 0 } } } };
  network = { Id: NET, Name: 'nd-dbnet-orders', Driver: 'bridge', Scope: 'local' };
  call.mockReset().mockImplementation(async (method: string, path: string, body?: any) => {
    if (method === 'GET' && path.startsWith('/containers/')) return reply(self);
    if (path === '/version') return reply({ ApiVersion: version });
    if (method === 'GET' && path === '/networks/nd-dbnet-orders') return network ? reply(network) : reply({}, 404);
    if (path === `/networks/${NET}/connect`) {
      expect(body.Container).toBe(SELF);
      if (connectMode !== 'refused') self.NetworkSettings.Networks['nd-dbnet-orders'] = { NetworkID: NET, ...body.EndpointConfig };
      if (connectMode === 'wrong-priority') self.NetworkSettings.Networks['nd-dbnet-orders'].GwPriority = 0;
      if (connectMode === 'lost' || connectMode === 'refused') throw Error('connect reply unavailable');
      return reply({});
    }
    if (path === `/networks/${NET}/disconnect`) {
      expect(body).toEqual({ Container: SELF, Force: false });
      if (disconnectMode !== 'refused') delete self.NetworkSettings.Networks['nd-dbnet-orders'];
      if (disconnectMode) throw Error('disconnect reply unavailable');
      return reply({});
    }
    throw Error('Unexpected Docker boundary: ' + method + ' ' + path);
  });
});
afterEach(() => vi.unstubAllEnvs());
const join = () => ensureNodeStudioNetwork(call, resource, verify);
const endpoint = () => self.NetworkSettings.Networks['nd-dbnet-orders'];
const mutations = () => call.mock.calls.filter(args => args[0] === 'POST');

describe('containerized agent private Studio access', () => {
  it('connects only its immutable container ID with a lower gateway priority, then reuses the endpoint', async () => {
    await Promise.all([join(), join()]);
    expect(endpoint()).toEqual({ NetworkID: NET, Aliases: ['nd-studio-agent-db-7'], GwPriority: -1 });
    expect(mutations()).toHaveLength(1); expect(self.NetworkSettings.Networks.bridge.GwPriority).toBe(0);
    await releaseNodeStudioNetwork(call, resource); expect(endpoint()).toBeUndefined();
    expect(self.NetworkSettings.Networks.bridge.NetworkID).toBe(BRIDGE);
  });
  it('keeps custom negative gateway priorities ahead of the new connection', async () => {
    self.NetworkSettings.Networks.bridge.GwPriority = -9;
    await join(); expect(endpoint().GwPriority).toBe(-10);
  });
  it('treats omitted old endpoint priorities as zero', async () => {
    delete self.NetworkSettings.Networks.bridge.GwPriority;
    await join(); expect(endpoint().GwPriority).toBe(-1);
  });
  it.each(['off', 'hostname', 'missing', 'different-id', 'different-hostname', 'different-role', 'stopped', 'host', 'malformed'])('does not mutate another/native process in the %s control', async mode => {
    if (mode === 'off') vi.stubEnv('NINEDEPLOY_AGENT', '');
    if (mode === 'hostname') h.hostname.mockReturnValue('native-server');
    if (mode === 'missing') call.mockImplementation(async () => reply({}, 404));
    if (mode === 'different-id') self.Id = 'd'.repeat(64);
    if (mode === 'different-hostname') self.Config.Hostname = 'elsewhere';
    if (mode === 'different-role') self.Config.Env = ['NINEDEPLOY_AGENT=0'];
    if (mode === 'stopped') self.State.Running = false;
    if (mode === 'host') self.HostConfig.NetworkMode = 'host';
    if (mode === 'malformed') delete self.Config;
    await join(); await releaseNodeStudioNetwork(call, resource); expect(mutations()).toEqual([]);
    if (mode === 'off' || mode === 'hostname') expect(call).not.toHaveBeenCalled();
  });
  it('preserves a pre-existing manual network connection without claiming it', async () => {
    self.NetworkSettings.Networks['nd-dbnet-orders'] = { NetworkID: NET, Aliases: ['owner-manual'] };
    await join(); await releaseNodeStudioNetwork(call, resource);
    expect(endpoint().Aliases).toEqual(['owner-manual']); expect(mutations()).toEqual([]);
  });
  it.each(['1.47', 'invalid', undefined])('refuses API %s before changing routes', async apiVersion => {
    version = apiVersion;
    await expect(join()).rejects.toMatchObject({ statusCode: 422, code: 'node_studio_network_api' });
    expect(mutations()).toEqual([]);
  });
  it('refuses an unrepresentable lower priority before mutation', async () => {
    self.NetworkSettings.Networks.bridge.GwPriority = -2147483648;
    await expect(join()).rejects.toMatchObject({ code: 'node_studio_network_unconfirmed' }); expect(mutations()).toEqual([]);
  });
  it('accepts a lost connect reply only after confirming ownership and route priority', async () => {
    connectMode = 'lost'; await join(); expect(endpoint().Aliases).toContain('nd-studio-agent-db-7');
  });
  it.each(['refused', 'wrong-priority'])('rejects an unconfirmed %s connect', async mode => {
    connectMode = mode; await expect(join()).rejects.toMatchObject({ statusCode: 502, code: 'node_studio_network_unconfirmed' });
  });
  it('refuses a changed self ID at confirmation', async () => {
    const boundary = call.getMockImplementation()!;
    call.mockImplementation(async (...args) => { const result = await boundary(...args); if (args[1]?.endsWith('/connect')) self.Id = 'd'.repeat(64); return result; });
    await expect(join()).rejects.toMatchObject({ code: 'node_studio_network_unconfirmed' });
  });
  it('waits for helper verification inside the resource queue and never joins a removed helper', async () => {
    verify.mockRejectedValue(Error('helper gone'));
    await expect(join()).rejects.toThrow('helper gone'); expect(call).not.toHaveBeenCalled();
  });
  it('removes a stale owned endpoint by validated resource name after the helper is already gone', async () => {
    await join(); await releaseNodeStudioNetwork(call, { databaseId: 7, slug: 'orders' }); expect(endpoint()).toBeUndefined();
    await releaseNodeStudioNetwork(call, resource); expect(mutations()).toHaveLength(2);
  });
  it('accepts an already removed network during resource-only cleanup', async () => {
    network = null; await releaseNodeStudioNetwork(call, { databaseId: 7, slug: 'orders' }); expect(mutations()).toEqual([]);
  });
  it.each(['Name', 'Driver', 'Scope'])('never disconnects a resource-only lookup with mismatched %s', async field => {
    await join(); network[field] = 'foreign';
    await expect(releaseNodeStudioNetwork(call, { databaseId: 7, slug: 'orders' })).rejects.toThrow();
    expect(endpoint()).toBeDefined(); expect(mutations()).toHaveLength(1);
  });
  it('confirms removal after a lost disconnect reply', async () => {
    await join(); disconnectMode = 'lost'; await releaseNodeStudioNetwork(call, resource); expect(endpoint()).toBeUndefined();
  });
  it('reports an unconfirmed disconnect for retry and preserves the original bridge', async () => {
    await join(); disconnectMode = 'refused';
    await expect(releaseNodeStudioNetwork(call, resource)).rejects.toMatchObject({ statusCode: 502 });
    expect(endpoint()).toBeDefined(); expect(self.NetworkSettings.Networks.bridge.NetworkID).toBe(BRIDGE);
    disconnectMode = ''; await releaseNodeStudioNetwork(call, resource); expect(endpoint()).toBeUndefined();
  });
});
