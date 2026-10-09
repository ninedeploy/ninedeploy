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
