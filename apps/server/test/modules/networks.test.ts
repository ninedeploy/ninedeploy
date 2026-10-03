import { describe, expect, it, vi } from 'vitest';
import { isValidNetworkName, networkRoutes } from '../../src/modules/networks.js';
import { asUser, buildTestApp, createFakeDb } from '../helpers.js';

// Local docker calls + inventory are mocked: the routes' contract is the argv
// they build and the audit rows they emit.
const execMocks = vi.hoisted(() => ({ run: vi.fn(async (_c: unknown, _a: unknown, _o: unknown, sink?: (l: string) => void) => { sink?.('removed'); }) }));
vi.mock('../../src/lib/exec.js', () => execMocks);
const inventoryMocks = vi.hoisted(() => ({
  listUserNetworks: vi.fn(async () => [{ name: 'net-a', driver: 'bridge' }]),
  networkMembers: vi.fn(async () => ['c-1', 'c-2']),
}));
vi.mock('../../src/lib/inventory.js', () => inventoryMocks);
const agentMocks = vi.hoisted(() => ({ agentOp: vi.fn(async () => ({ exitCode: 0, lines: [] })) }));
vi.mock('../../src/lib/agentClient.js', () => agentMocks);

function app(db = createFakeDb()) {
  return buildTestApp({ db });
}

describe('networks module', () => {
  it('requires authentication', async () => {
    const a = await app();
    await a.register(networkRoutes);
    expect((await a.inject({ method: 'GET', url: '/' })).statusCode).toBe(401);
  });

  it('lists local networks with members', async () => {
    const a = await app();
    await a.register(networkRoutes);
    const res = await a.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      networks: [{ name: 'net-a', driver: 'bridge', members: ['c-1', 'c-2'], isManaged: false }],
      remote: null,
    });
  });

  it('returns an empty remote listing', async () => {
    const a = await app();
    await a.register(networkRoutes);
    const res = await a.inject({ method: 'GET', url: '/?serverId=3', headers: asUser() });
    expect(res.json()).toEqual({ networks: [], remote: 3 });
  });

  it('creates a network locally', async () => {
    const a = await app();
    await a.register(networkRoutes);
    const res = await a.inject({
      method: 'POST',
      url: '/',
      headers: { ...asUser(), 'x-role': 'admin' },
      payload: { name: 'net-b', driver: 'overlay' },
    });
    expect(res.statusCode).toBe(200);
    expect(execMocks.run).toHaveBeenCalledWith(
      'docker',
      ['network', 'create', '--driver', 'overlay', 'net-b'],
      {},
      expect.any(Function),
    );
  });

  it('routes creation through the agent for a remote server', async () => {
    const a = await app();
    await a.register(networkRoutes);
    const res = await a.inject({
      method: 'POST',
      url: '/',
      headers: { ...asUser(), 'x-role': 'admin' },
      payload: { name: 'net-c', driver: 'bridge', serverId: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(agentMocks.agentOp).toHaveBeenCalledWith(
      expect.anything(),
      2,
      'docker.networkCreate',
      { name: 'net-c', driver: 'bridge' },
      expect.any(Function),
    );
  });

  it('rejects an invalid network name on delete', async () => {
    const a = await app();
    await a.register(networkRoutes);
    const res = await a.inject({ method: 'DELETE', url: '/bad%20name', headers: { ...asUser(), 'x-role': 'admin' } });
    expect(res.statusCode).toBe(400);
  });

  it('deletes a network locally', async () => {
    const a = await app();
    await a.register(networkRoutes);
    const res = await a.inject({ method: 'DELETE', url: '/net-a', headers: { ...asUser(), 'x-role': 'admin' } });
    expect(res.statusCode).toBe(200);
    expect(execMocks.run).toHaveBeenCalledWith('docker', ['network', 'rm', 'net-a'], {}, expect.any(Function));
  });

  it('attaches and detaches containers', async () => {
    const a = await app();
    await a.register(networkRoutes);
    const attach = await a.inject({
      method: 'POST',
      url: '/attach',
      headers: { ...asUser(), 'x-role': 'admin' },
      payload: { network: 'net-a', container: 'c-1' },
    });
    expect(attach.statusCode).toBe(200);
    expect(execMocks.run).toHaveBeenCalledWith(
      'docker',
      ['network', 'connect', 'net-a', 'c-1'],
      {},
      expect.any(Function),
    );
    const detach = await a.inject({
      method: 'POST',
      url: '/detach',
      headers: { ...asUser(), 'x-role': 'admin' },
      payload: { network: 'net-a', container: 'c-1' },
    });
    expect(detach.statusCode).toBe(200);
    expect(execMocks.run).toHaveBeenCalledWith(
      'docker',
      ['network', 'disconnect', 'net-a', 'c-1'],
      {},
      expect.any(Function),
    );
  });

  it('deletes a network through the agent for a remote server', async () => {
    const a = await app();
    await a.register(networkRoutes);
    const res = await a.inject({ method: 'DELETE', url: '/net-a?serverId=6', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(agentMocks.agentOp).toHaveBeenCalledWith(
      expect.anything(),
      6,
      'docker.networkRm',
      { name: 'net-a' },
      expect.any(Function),
    );
  });

  it('r471: surfaces a refused remote rm as 409 WITH docker\'s reason, not a bare exit-code 400', async () => {
    // agentOp sinks docker's output lines BEFORE throwing on the non-zero
    // exit — the route collects them so "has active endpoints" reaches the
    // operator exactly like the local branch, instead of
    // "agent docker.networkRm exited with 1".
    agentMocks.agentOp.mockImplementationOnce(async (...args: unknown[]) => {
      const op = args[2] as string;
      (args[4] as (l: string) => void)?.('Error response from daemon: network net-a has active endpoints');
      throw new Error(`agent ${op} exited with 1`);
    });
    const a = await app();
    await a.register(networkRoutes);
    const res = await a.inject({ method: 'DELETE', url: '/net-a?serverId=6', headers: asUser() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('active endpoints');
  });

  it('r471: keeps an unreachable agent a 400 with the transport error', async () => {
    agentMocks.agentOp.mockRejectedValueOnce(new Error('fetch failed'));
    const a = await app();
    await a.register(networkRoutes);
    const res = await a.inject({ method: 'DELETE', url: '/net-a?serverId=6', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('fetch failed');
  });

  it('maps non-Error agent rejections to a generic message', async () => {
    agentMocks.agentOp.mockRejectedValueOnce('lost connection');
    const a = await app();
    await a.register(networkRoutes);
    const res = await a.inject({
      method: 'POST',
      url: '/attach',
      headers: asUser(),
      payload: { network: 'net-a', container: 'c-1', serverId: 8 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('agent operation failed');
  });

  it('rejects an invalid name on the members route', async () => {
    const a = await app();
    await a.register(networkRoutes);
    const res = await a.inject({ method: 'GET', url: '/bad%20name/members', headers: asUser() });
    expect(res.statusCode).toBe(400);
  });

  it('tolerates per-network member lookup failures', async () => {
    inventoryMocks.networkMembers.mockRejectedValueOnce(new Error('inspect failed'));
    const a = await app();
    await a.register(networkRoutes);
    const res = await a.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.json().networks).toEqual([{ name: 'net-a', driver: 'bridge', members: [], isManaged: false }]);
  });

  it('tolerates inventory failures while listing and surfaces docker remove errors as 409', async () => {
    inventoryMocks.listUserNetworks.mockRejectedValueOnce(new Error('docker down'));
    const a = await app();
    await a.register(networkRoutes);
    const listed = await a.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(listed.json()).toEqual({ networks: [], remote: null });
    // A real docker error (e.g. "has active endpoints") must be surfaced, not
    // swallowed — the operator needs to know *why* the remove failed.
    execMocks.run.mockRejectedValueOnce(new Error('has active endpoints'));
    const removed = await a.inject({ method: 'DELETE', url: '/net-a', headers: asUser() });
    expect(removed.statusCode).toBe(409);
    expect(removed.json().error.message).toBe('has active endpoints');
  });

  it('converts agent failures into 400s', async () => {
    agentMocks.agentOp.mockRejectedValueOnce(new Error('agent unreachable'));
    const a = await app();
    await a.register(networkRoutes);
    const res = await a.inject({
      method: 'POST',
      url: '/attach',
      headers: { ...asUser(), 'x-role': 'admin' },
      payload: { network: 'net-a', container: 'c-1', serverId: 4 },
    });
    expect(res.statusCode).toBe(400);
    agentMocks.agentOp.mockRejectedValueOnce(new Error('agent unreachable'));
    const detachRes = await a.inject({
      method: 'POST',
      url: '/detach',
      headers: { ...asUser(), 'x-role': 'admin' },
      payload: { network: 'net-a', container: 'c-1', serverId: 4 },
    });
    expect(detachRes.statusCode).toBe(400);
  });

  it('lists members for one network', async () => {
    const a = await app();
    await a.register(networkRoutes);
    const ok = await a.inject({ method: 'GET', url: '/net-a/members', headers: asUser() });
    expect(ok.json()).toEqual({ members: ['c-1', 'c-2'] });
    inventoryMocks.networkMembers.mockRejectedValueOnce(new Error('gone'));
    const err = await a.inject({ method: 'GET', url: '/net-a/members', headers: asUser() });
    expect(err.json()).toEqual({ members: [] });
  });

  it('validates docker name operands', () => {
    expect(isValidNetworkName('net-1')).toBe(true);
    expect(isValidNetworkName('-bad')).toBe(false);
  });

  it('rejects deletion of the managed ninedeploy network on the local path', async () => {
    const a = await app();
    await a.register(networkRoutes);
    const res = await a.inject({ method: 'DELETE', url: '/ninedeploy', headers: asUser() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/managed by NineDeploy/);
    expect(execMocks.run).not.toHaveBeenCalledWith('docker', ['network', 'rm', 'ninedeploy'], expect.anything(), expect.anything());
  });

  it('rejects deletion of any per-service nd-svc-* bridge (Model B managed mesh)', async () => {
    const a = await app();
    await a.register(networkRoutes);
    agentMocks.agentOp.mockClear();
    execMocks.run.mockClear();
    const res = await a.inject({ method: 'DELETE', url: '/nd-svc-my-app', headers: asUser() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/managed by NineDeploy/);
    expect(execMocks.run).not.toHaveBeenCalledWith('docker', ['network', 'rm', 'nd-svc-my-app'], expect.anything(), expect.anything());
    expect(agentMocks.agentOp).not.toHaveBeenCalled();
  });

  it('rejects deletion of the managed ninedeploy network on the remote (agent) path', async () => {
    const a = await app();
    await a.register(networkRoutes);
    agentMocks.agentOp.mockClear();
    const res = await a.inject({ method: 'DELETE', url: '/ninedeploy?serverId=3', headers: asUser() });
    expect(res.statusCode).toBe(409);
    expect(agentMocks.agentOp).not.toHaveBeenCalled();
  });

  it('rejects attaching a managed container to a user network', async () => {
    const a = await app();
    await a.register(networkRoutes);
    const res = await a.inject({
      method: 'POST',
      url: '/attach',
      headers: { ...asUser(), 'x-role': 'admin' },
      payload: { network: 'mesh', container: 'nd-svc-api-1' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/managed by NineDeploy/);
    expect(execMocks.run).not.toHaveBeenCalledWith(
      'docker', ['network', 'connect', 'mesh', 'nd-svc-api-1'], expect.anything(), expect.anything(),
    );
  });

  it('rejects detaching a managed database container from a user network', async () => {
    const a = await app();
    await a.register(networkRoutes);
    agentMocks.agentOp.mockClear();
    const res = await a.inject({
      method: 'POST',
      url: '/detach',
      headers: { ...asUser(), 'x-role': 'admin' },
      payload: { network: 'mesh', container: 'nd-db-pg-1', serverId: 5 },
    });
    expect(res.statusCode).toBe(409);
    expect(agentMocks.agentOp).not.toHaveBeenCalled();
  });

  it('rejects creating a network that shadows the managed mesh', async () => {
    const a = await app();
    await a.register(networkRoutes);
    const res = await a.inject({
      method: 'POST',
      url: '/',
      headers: { ...asUser(), 'x-role': 'admin' },
      payload: { name: 'ninedeploy', driver: 'bridge' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/reserved by NineDeploy/);
    expect(execMocks.run).not.toHaveBeenCalledWith(
      'docker', ['network', 'create', expect.anything()], expect.anything(), expect.anything(),
    );
  });

  it('still allows attaching user-owned containers to user networks', async () => {
    const a = await app();
    await a.register(networkRoutes);
    const res = await a.inject({
      method: 'POST',
      url: '/attach',
      headers: { ...asUser(), 'x-role': 'admin' },
      payload: { network: 'mesh', container: 'user-nginx-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(execMocks.run).toHaveBeenCalledWith(
      'docker', ['network', 'connect', 'mesh', 'user-nginx-1'], expect.anything(), expect.anything(),
    );
  });
});
