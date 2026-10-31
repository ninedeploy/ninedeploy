import { describe, expect, it, vi } from 'vitest';
import { AGENT_SWARM_MANAGER_VAR, createClient, NineDeployError, type ManagedDatabase, type ServerListEntry, type ServiceDetail } from '../src/index.js';

/**
 * 0.16 T8 surfaces: the multi-node routes shipped in 0.15.2-0.15.4 (build
 * placement, image transfers, node volumes, Swarm) as SDK methods, and the
 * additive response fields as types.
 */

interface Call {
  url: string;
  method: string;
  body: unknown;
  timed: boolean;
}

function client(reply: (url: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} })) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: { method?: string; body?: unknown; signal?: unknown }) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({
      url: path,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      timed: init.signal !== undefined,
    });
    const r = reply(path);
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) } as unknown as Response;
  });
  return { api: createClient({ baseUrl: 'http://api.test', fetch: fetchMock }), calls };
}

describe('0.16 T8 route mapping', () => {
  it('maps every volume file action to the selected node namespace with a helper-sized timeout', async () => {
    const { api, calls } = client(), options = { serverId: 7 };
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await api.volumes.listFiles('nd-svc-same', 'a b', options);
      await api.volumes.readFile('nd-svc-same', 'a b/file', options);
      await api.volumes.writeFile('nd-svc-same', { path: 'file', contentBase64: 'eA==' }, options);
      await api.volumes.mkdir('nd-svc-same', { path: 'dir' }, options);
      await api.volumes.deleteFile('nd-svc-same', 'dir/file', options);
      expect(calls.map(c=>`${c.method} ${c.url}`)).toEqual([
        'GET /v1/servers/7/volumes/nd-svc-same/files?path=a%20b',
        'GET /v1/servers/7/volumes/nd-svc-same/files/content?path=a%20b%2Ffile',
        'PUT /v1/servers/7/volumes/nd-svc-same/files',
        'POST /v1/servers/7/volumes/nd-svc-same/files/dir',
        'DELETE /v1/servers/7/volumes/nd-svc-same/files?path=dir%2Ffile',
      ]);
      expect(timeout.mock.calls.map(([ms])=>ms)).toEqual([150000,150000,150000,150000,150000]);
    } finally { timeout.mockRestore(); }
  });
  it('never retries a node volume file operation against a same-named local volume on an older panel', async () => {
    const { api, calls } = client(()=>({status:404,body:{error:{code:'not_found',message:'Unknown route'}}}));
    await expect(api.volumes.readFile('nd-svc-same','file',{serverId:7})).rejects.toMatchObject({status:404});
    expect(calls.map(c=>c.url)).toEqual(['/v1/servers/7/volumes/nd-svc-same/files/content?path=file']);
  });
  it.each([0,-1,NaN,1.5,Number.MAX_SAFE_INTEGER+1])('refuses invalid volume node id %s before HTTP', serverId => {
    const { api, calls } = client();
    expect(()=>api.volumes.listFiles('nd-svc-same','',{serverId})).toThrow('Invalid volume node id'); expect(calls).toEqual([]);
  });
  it('maps explicit node tools to a separate namespace and never retries on the local URI', async () => {
    const { api, calls } = client(); const options = { serverId: 7 };
    await api.containers.inspect('same-name', options); await api.containers.compose('same-name', options);
    await api.containers.listFiles('same-name', '/tmp/a b', options); await api.containers.readFile('same-name', '/tmp/file', options);
    await api.containers.writeFile('same-name', { path: '/tmp/file', contentBase64: 'eA==' }, options);
    await api.containers.mkdir('same-name', { path: '/tmp/dir' }, options); await api.containers.deleteFile('same-name', '/tmp/file', options);
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'GET /v1/servers/7/containers/same-name/inspect', 'GET /v1/servers/7/containers/same-name/compose',
      'GET /v1/servers/7/containers/same-name/files?path=%2Ftmp%2Fa%20b', 'GET /v1/servers/7/containers/same-name/files/content?path=%2Ftmp%2Ffile',
      'PUT /v1/servers/7/containers/same-name/files', 'POST /v1/servers/7/containers/same-name/files/dir', 'DELETE /v1/servers/7/containers/same-name/files?path=%2Ftmp%2Ffile',
    ]);
    const old = client(() => ({ status: 404, body: { error: { code: 'not_found', message: 'Old panel' } } }));
    await expect(old.api.containers.inspect('same-name', options)).rejects.toBeInstanceOf(NineDeployError);
    expect(old.calls).toHaveLength(1); expect(old.calls[0]?.url).toContain('/servers/7/containers/');
  });
  it.each([0, -1, 1.5, Number.NaN])('refuses invalid node id %s before any HTTP request', id => {
    const { api, calls } = client(); expect(() => api.containers.inspect('same-name', { serverId: id })).toThrow('Invalid container node id'); expect(calls).toHaveLength(0);
  });
  it('reads and retries Swarm recovery without shortening its native readiness deadline', async () => {
    const entry = { id: 1, deploymentId: 9, phase: 'retained', interrupted: true, reason: 'Native spec changed', busy: false, attempts: 1, nextAttemptAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z' };
    const { api, calls } = client(() => ({ status: 200, body: { entry, recovered: 0, held: 1 } }));
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      expect(await api.services.swarmRecovery(4)).toEqual(entry);
      expect(await api.services.retrySwarmRecovery(4)).toEqual({ entry, recovered: 0, held: 1 });
      expect(calls.map(({ url, method }) => ({ url, method }))).toEqual([{ method: 'GET', url: '/v1/services/4/swarm/recovery' }, { method: 'POST', url: '/v1/services/4/swarm/recovery' }]);
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([30_000, 600_000]);
    } finally { timeout.mockRestore(); }
  });
  it('reads and retries primary runtime recovery without shortening the readiness deadline', async () => {
    const entry = { id: 1, serverId: null, deploymentId: 9, phase: 'routing', reason: 'Routing not confirmed', busy: false, previousRuntimeId: 'web-8', candidateRuntimeId: 'web-9', desiredRuntimeId: 'web-9', interrupted: true, attempts: 1, nextAttemptAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-22T23:00:00Z' };
    const { api, calls } = client(() => ({ status: 200, body: { entry, recovered: 0, held: 1 } }));
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      expect(await api.services.runtimeRecovery(4)).toEqual(entry);
      expect(await api.services.retryRuntimeRecovery(4)).toEqual({ entry, recovered: 0, held: 1 });
      expect(calls.map(({ url, method }) => ({ url, method }))).toEqual([{ method: 'GET', url: '/v1/services/4/runtime-recovery' }, { method: 'POST', url: '/v1/services/4/runtime-recovery' }]);
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([30_000, 600_000]);
    } finally { timeout.mockRestore(); }
  });
  it('reads node preparation status through the service-scoped route', async () => {
    const entries = [{ deploymentId: 9, serverId: 4, phase: 'prepared', deploymentStatus: 'failed' }];
    const { api, calls } = client(() => ({ status: 200, body: { entries } }));
    expect(await api.services.nodePreparations(4)).toEqual(entries);
    expect(calls.map(({ url, method }) => ({ url, method }))).toEqual([{ method: 'GET', url: '/v1/services/4/node-preparations' }]);
  });
  it('reads and retries durable fan-out recovery through the service target routes', async () => {
    const entry = { id: 1, serverId: 5, deploymentId: 9, phase: 'retained', reason: 'Routing not confirmed', busy: false, previousRuntimeId: 'web-8', candidateRuntimeId: 'web-9', attempts: 1, nextAttemptAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-22T23:00:00Z' };
    const { api, calls } = client(() => ({ status: 200, body: { entries: [entry], recovered: 0, held: 1 } }));
    expect(await api.fanout.recovery(4)).toEqual([entry]);
    expect(await api.fanout.retryRecovery(4)).toEqual({ entries: [entry], recovered: 0, held: 1 });
    expect(calls.map(({ url, method }) => ({ url, method }))).toEqual([
      { method: 'GET', url: '/v1/services/4/targets/recovery' },
      { method: 'POST', url: '/v1/services/4/targets/recovery' },
    ]);
  });
  it('allows readiness, routing and retirement to complete beyond the normal HTTP timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const { api } = client(() => ({ status: 200, body: { entries: [], recovered: 0, held: 0 } }));
      await api.fanout.recovery(4); await api.fanout.retryRecovery(4);
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([30_000, 600_000]);
    } finally { timeout.mockRestore(); }
  });
  it('maps placement, transfers, volumes, server roles and Swarm onto the shipped routes', async () => {
    const { api, calls } = client();
    const cases: Array<[() => Promise<unknown>, string, string, unknown]> = [
      [() => api.services.placement.get(4), 'GET', '/v1/services/4/placement', undefined],
      [
        () => api.services.placement.set(4, { buildOn: 'server', buildServerId: 2, orchestrator: null }),
        'PUT',
        '/v1/services/4/placement',
        { buildOn: 'server', buildServerId: 2, orchestrator: null },
      ],
      [() => api.services.imageTransfers(4), 'GET', '/v1/services/4/image-transfers', undefined],
      [() => api.services.imageTransfers(4, { limit: 50 }), 'GET', '/v1/services/4/image-transfers?limit=50', undefined],
      [() => api.services.swarm(4), 'GET', '/v1/services/4/swarm', undefined],
      [() => api.deploys.imageTransfers(9), 'GET', '/v1/deployments/9/image-transfers', undefined],
      [() => api.volumes.list(), 'GET', '/v1/volumes', undefined],
      [() => api.volumes.list({}), 'GET', '/v1/volumes', undefined],
      [() => api.volumes.list({ serverId: 2 }), 'GET', '/v1/volumes?serverId=2', undefined],
      [() => api.volumes.create({ name: 'nd-svc-web-data' }), 'POST', '/v1/volumes', { name: 'nd-svc-web-data' }],
      [() => api.volumes.create({ name: 'nd-svc-web-data', serverId: 2 }), 'POST', '/v1/volumes', { name: 'nd-svc-web-data', serverId: 2 }],
      [() => api.volumes.remove('nd-svc-web-data'), 'DELETE', '/v1/volumes/nd-svc-web-data', undefined],
      [() => api.volumes.remove('nd-svc-web-data', {}), 'DELETE', '/v1/volumes/nd-svc-web-data', undefined],
      [() => api.volumes.remove('nd-svc-web-data', { serverId: 2 }), 'DELETE', '/v1/volumes/nd-svc-web-data?serverId=2', undefined],
      [() => api.databases.create({ name: 'db', engine: 'postgres', serverId: 2 }), 'POST', '/v1/databases', { name: 'db', engine: 'postgres', serverId: 2 }],
      [() => api.sources.update(3, { allowOnNodes: true, password: 'pw' }), 'PATCH', '/v1/sources/3', { allowOnNodes: true, password: 'pw' }],
      [() => api.servers.update(2, { isBuildServer: true, buildConcurrency: 3 }), 'PATCH', '/v1/servers/2', { isBuildServer: true, buildConcurrency: 3 }],
      [() => api.servers.swarmJoin(2), 'POST', '/v1/servers/2/swarm/join', undefined],
      [() => api.servers.swarmLeave(2), 'POST', '/v1/servers/2/swarm/leave', undefined],
      [() => api.swarm.get(), 'GET', '/v1/swarm', undefined],
      [() => api.swarm.init({ advertiseAddr: '10.0.0.1', password: 'pw' }), 'POST', '/v1/swarm/init', { advertiseAddr: '10.0.0.1', password: 'pw' }],
      [() => api.swarm.settings({ enabled: true, password: 'pw' }), 'PUT', '/v1/swarm/settings', { enabled: true, password: 'pw' }],
      [() => api.swarm.settings({ enabled: false }), 'PUT', '/v1/swarm/settings', { enabled: false }],
    ];
    for (const [call, method, url, body] of cases) {
      calls.length = 0;
      await call();
      expect(
        calls.map(({ timed: _timed, ...c }) => c),
        `${method} ${url}`,
      ).toEqual([{ method, url, body }]);
    }
  });

  it('reads the additive response fields (server, database, service detail)', async () => {
    const server: ServerListEntry = {
      id: 2,
      name: 'edge-1',
      host: '10.0.0.5',
      port: 4600,
      status: 'online',
      lastSeenAt: null,
      agent: { version: '0.15.4', capabilities: ['swarm'], checkedAt: null },
      features: { nixpacks: true, railpack: true, privateClones: true, volumes: true, databases: true, imageTransfer: true, swarm: true },
      isBuildServer: true,
      buildConcurrency: 2,
      databases: 1,
      swarmNodeId: 'abc',
      swarmRole: 'worker',
    };
    const database = { id: 1, serverId: 2, serverName: 'edge-1', reachable: true } as ManagedDatabase;
    const service = { id: 4, placement: { buildOn: null, buildServerId: null, pushRegistrySourceId: null, pushRepository: null, orchestrator: 'swarm' } } as ServiceDetail;
    const { api } = client((url) => ({ status: 200, body: url === '/v1/servers' ? [server] : url === '/v1/databases' ? [database] : service }));
    expect((await api.servers.list())[0]).toMatchObject({ swarmNodeId: 'abc', features: { swarm: true } });
    expect((await api.databases.list())[0]).toMatchObject({ serverId: 2, reachable: true });
    expect((await api.services.get(4)).placement?.orchestrator).toBe('swarm');
  });

  it('gives the long Swarm calls a wider timeout than the default', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const { api, calls } = client();
      await api.swarm.get();
      await api.servers.swarmJoin(2);
      await api.servers.swarmLeave(2);
      await api.swarm.init({ advertiseAddr: '10.0.0.1' });
      expect(calls.every((c) => c.timed)).toBe(true);
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([30_000, 600_000, 600_000, 600_000]);
    } finally {
      timeout.mockRestore();
    }
  });

  it('surfaces the multi-node refusal codes as typed errors', async () => {
    const { api } = client(() => ({
      status: 422,
      body: { error: { code: 'node_swarm_not_enabled', message: `Set ${AGENT_SWARM_MANAGER_VAR}=10.0.0.1:2377` } },
    }));
    const err = (await api.servers.swarmJoin(2).catch((e: unknown) => e)) as NineDeployError;
    expect(err).toBeInstanceOf(NineDeployError);
    expect(err.status).toBe(422);
    expect(err.code).toBe('node_swarm_not_enabled');
    expect(err.message).toContain('NINEDEPLOY_AGENT_SWARM_MANAGER=');
  });
});
