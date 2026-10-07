import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asUser, buildTestApp, createFakeDb, svcRow } from './helpers.js';

/**
 * r225: a service with `serverId` runs on a remote node, so its lifecycle,
 * logs and teardown must go through that node's agent. They used to run the
 * LOCAL docker CLI: stop "succeeded" on a missing container while the node
 * kept serving, start/restart flagged the service `error`, logs were empty,
 * and delete left the node's container running.
 */
const execMocks = vi.hoisted(() => ({
  capture: vi.fn(async () => ''),
  run: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/exec.js', () => execMocks);

/**
 * The real agentOp contract: output reaches the sink, a non-zero exit THROWS
 * unless the caller tolerates it. `docker.volumeInspect` answers 1 (no such
 * volume) unless a test says otherwise.
 */
const nodeVolume = vi.hoisted(() => ({ exists: false, createdAt: '2020-01-01T00:00:00Z' }));
const agentImpl = vi.hoisted(
  () =>
    async (_db: unknown, _serverId: number, op: string, _params: unknown, sink: (l: string) => void, opts?: { tolerateExit?: boolean }) => {
      if (op === 'docker.volumeInspect') {
        const lines = nodeVolume.exists ? ['[{', `"CreatedAt": "${nodeVolume.createdAt}",`, '"Name": "nd-svc-web-data"}]'] : ['Error: No such volume'];
        for (const l of lines) sink(l);
        const exitCode = nodeVolume.exists ? 0 : 1;
        if (exitCode !== 0 && !opts?.tolerateExit) throw new Error(`agent ${op} exited with ${exitCode}`);
        return { exitCode, lines };
      }
      sink('ok');
      return { exitCode: 0, lines: ['ok'] };
    },
);
const agent = vi.hoisted(() => ({ agentOp: vi.fn(agentImpl) }));
vi.mock('../src/lib/agentClient.js', () => agent);

vi.mock('../src/engine/proxy.js', () => ({
  writeDynamicConfig: vi.fn(async () => undefined),
  getAcmeEmail: vi.fn(async () => null),
  getStickyEnabledForService: vi.fn(async () => false),
  NETWORK: 'ninedeploy',
  TRAEFIK_CONTAINER: 'ninedeploy-traefik',
  TRAEFIK_IMAGE: 'traefik:3',
}));
vi.mock('../src/engine/logs.js', () => ({ deleteLog: vi.fn(() => true) }));

const { servicesRoutes } = await import('../src/modules/services.js');

const remote = (over: Record<string, unknown> = {}) =>
  svcRow({ id: 1, type: 'docker', runtimeId: 'web-1-17', replicas: 2, serverId: 4, status: 'running', ...over });

async function appFor(svc: Record<string, unknown>) {
  const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: svc } }) });
  await app.register(servicesRoutes);
  return app;
}

const ops = () => agent.agentOp.mock.calls.map((c) => `${c[1]} ${c[2]} ${JSON.stringify(c[3])}`);

beforeEach(() => {
  vi.clearAllMocks();
  agent.agentOp.mockImplementation(agentImpl);
  nodeVolume.exists = false;
});

describe('remote-node service lifecycle (r225)', () => {
  it('stops every replica on the node, not locally', async () => {
    const app = await appFor(remote());
    const res = await app.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(ops()).toEqual(['4 docker.stop {"name":"web-1-17"}', '4 docker.stop {"name":"web-1-17-r2"}']);
    expect(execMocks.capture).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['stop']));
  });

  it('reports an unreachable node instead of marking the service stopped', async () => {
    agent.agentOp.mockRejectedValueOnce(new Error('agent unreachable (502)'));
    const app = await appFor(remote());
    const res = await app.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    expect(res.statusCode).toBe(503);
  });

  it('starts and restarts on the node', async () => {
    const app = await appFor(remote({ replicas: 1 }));
    expect((await app.inject({ method: 'POST', url: '/1/start', headers: asUser() })).statusCode).toBe(200);
    expect(ops()).toEqual(['4 docker.start {"name":"web-1-17"}']);
    agent.agentOp.mockClear();
    expect((await app.inject({ method: 'POST', url: '/1/restart', headers: asUser() })).statusCode).toBe(200);
    expect(ops()).toEqual(['4 docker.stop {"name":"web-1-17"}', '4 docker.start {"name":"web-1-17"}']);
  });

  it('reads logs from the node', async () => {
    agent.agentOp.mockImplementationOnce(async (_d, _s, _o, _p, sink) => {
      sink('2026-09-18T10:00:00Z hello from the node');
      return { exitCode: 0, lines: [] };
    });
    const app = await appFor(remote());
    const res = await app.inject({ method: 'GET', url: '/1/logs', headers: asUser() });
    expect(res.json().lines).toContain('hello from the node');
  });

  it('removes the node containers on delete', async () => {
    const app = await appFor(remote());
    const res = await app.inject({ method: 'DELETE', url: '/1', headers: asUser() });
    expect([200, 204]).toContain(res.statusCode);
    // r662: …and the service's checkout on the node goes with them.
    expect(ops()).toEqual([
      '4 docker.rm {"name":"web-1-17"}',
      '4 docker.rm {"name":"web-1-17-r2"}',
      '4 workspace.remove {"workspace":"web"}',
    ]);
  });

  it('takes a remote compose stack down by its project on delete', async () => {
    const app = await appFor(remote({ type: 'compose', slug: 'shop', replicas: 1 }));
    await app.inject({ method: 'DELETE', url: '/1', headers: asUser() });
    expect(ops()).toEqual(['4 docker.composeDown {"project":"ndcmp-shop"}', '4 workspace.remove {"workspace":"shop"}']);
  });

  it('retires the runtime where it runs when an operator moves the service to another node', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: remote({ replicas: 1 }), servers: { id: 5 } },
        update: { services: [remote({ serverId: 5, runtimeId: null, status: 'idle' })] },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'PATCH', url: '/1', headers: asUser({ isOperator: true }), payload: { serverId: 5 } });
    expect(res.statusCode).toBe(200);
    // r662: the destination is asked about a retained volume first, and the
    // old node's checkout is removed after the runtime.
    expect(ops()).toEqual([
      '5 docker.volumeInspect {"name":"nd-svc-web-data"}',
      '4 docker.rm {"name":"web-1-17"}',
      '4 workspace.remove {"workspace":"web"}',
    ]);
  });
});

/**
 * r662: the slug-volume guard (r351/r466) only ran at CREATE. Moving a
 * service later mounted whatever `nd-svc-<slug>-data` the destination held —
 * a deleted service's data on that node — and every node kept the checkout
 * of every service ever built there.
 */
describe('r662: moving and deleting remote services', () => {
  const movingApp = async (svc = remote({ replicas: 1 })) => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svc, servers: { id: 5 } },
        update: { services: [remote({ serverId: 5, runtimeId: null, status: 'idle' })] },
      }),
    });
    await app.register(servicesRoutes);
    return app;
  };

  it("refuses a move onto a node that holds a DELETED service's volume of the same slug, before retiring anything", async () => {
    nodeVolume.exists = true;
    nodeVolume.createdAt = '2020-01-01T00:00:00Z'; // older than the service row
    const app = await movingApp();
    const res = await app.inject({ method: 'PATCH', url: '/1', headers: asUser({ isOperator: true }), payload: { serverId: 5 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('slug_volume_retained');
    expect(ops()).toEqual(['5 docker.volumeInspect {"name":"nd-svc-web-data"}']);
  });

  it("allows a move back onto the node that holds the service's OWN volume (created after the row)", async () => {
    nodeVolume.exists = true;
    nodeVolume.createdAt = new Date(Date.now() + 60_000).toISOString();
    const app = await movingApp(remote({ replicas: 1, createdAt: new Date() }));
    const res = await app.inject({ method: 'PATCH', url: '/1', headers: asUser({ isOperator: true }), payload: { serverId: 5 } });
    expect(res.statusCode).toBe(200);
  });

  it('a node agent too old for workspace.remove does not fail the delete', async () => {
    agent.agentOp.mockImplementation(async (_d, _s, op, params, sink, opts) => {
      if (op === 'workspace.remove') throw new Error('agent workspace.remove failed (400): {"error":{"code":"unknown_op"}}');
      return agentImpl(_d, _s, op, params, sink, opts);
    });
    const app = await appFor(remote());
    const res = await app.inject({ method: 'DELETE', url: '/1', headers: asUser() });
    expect(res.statusCode).toBe(204);
  });

  it('removes the checkout from a node that stops being a fan-out target', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: remote({ replicas: 1, image: 'nginx:1' }), servers: { id: 5 } },
        select: { serviceTargets: [{ id: 1, serverId: 5, runtimeId: null }, { id: 2, serverId: 6, runtimeId: null }] },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'PATCH', url: '/1/targets', headers: asUser({ isOperator: true }), payload: { serverIds: [5] } });
    expect(res.statusCode).toBe(200);
    expect(ops()).toContain('6 workspace.remove {"workspace":"web"}');
    expect(ops()).not.toContain('5 workspace.remove {"workspace":"web"}');
  });

  it("tears down fan-out targets read BEFORE the row's cascade removed them", async () => {
    // Model the FK cascade: once the service row is deleted, its target rows are gone.
    let cascaded = false;
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: remote({ replicas: 1 }) },
        select: { serviceTargets: () => (cascaded ? [] : [{ serverId: 6, runtimeId: 'web-t6-17' }]) },
        delete: {
          services: () => {
            cascaded = true;
            return [];
          },
        },
      }),
    });
    await app.register(servicesRoutes);
    await app.inject({ method: 'DELETE', url: '/1', headers: asUser() });
    expect(ops()).toEqual(
      expect.arrayContaining([
        '6 docker.stop {"name":"web-t6-17"}',
        '6 docker.rm {"name":"web-t6-17"}',
        '6 workspace.remove {"workspace":"web"}',
        '4 workspace.remove {"workspace":"web"}',
      ]),
    );
  });

  // F840: fanout.ts mounts `nd-svc-<slug>-data` on every target node — adding
  // one must ask that node the same question a move does, before any change.
  it("F840: refuses a new fan-out target that holds a DELETED service's volume, before tearing anything down", async () => {
    nodeVolume.exists = true;
    nodeVolume.createdAt = '2020-01-01T00:00:00Z'; // older than the service row
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: remote({ replicas: 1, image: 'nginx:1' }), servers: { id: 5 } },
        select: { serviceTargets: [{ id: 2, serverId: 6, runtimeId: null }] },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'PATCH', url: '/1/targets', headers: asUser({ isOperator: true }), payload: { serverIds: [5] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('slug_volume_retained');
    // Node 6 (being replaced) is untouched: the probe is the only agent call.
    expect(ops()).toEqual(['5 docker.volumeInspect {"name":"nd-svc-web-data"}']);
  });

  // F842: pm2 is exempt from the guard while docker cannot answer, so a pm2
  // row may never have been checked — leaving pm2 runs it on the service's node.
  it('F842: re-checks the node volume when a pinned pm2 service switches to docker', async () => {
    nodeVolume.exists = true;
    nodeVolume.createdAt = '2020-01-01T00:00:00Z';
    const app = await appFor(remote({ type: 'pm2', runtimeId: null, replicas: 1 }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/1',
      headers: asUser({ isOperator: true }),
      payload: { type: 'docker', image: 'nginx:1', volumeMount: '/data' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('slug_volume_retained');
    expect(ops()).toEqual(['4 docker.volumeInspect {"name":"nd-svc-web-data"}']);
  });
});

/** r667: `--tail 300` bounds lines, not bytes — the local logs read is byte-capped too. */
describe('r667: local container logs are byte-bounded', () => {
  it('passes an output ceiling to the docker logs capture', async () => {
    const app = await appFor(remote({ serverId: null }));
    await app.inject({ method: 'GET', url: '/1/logs', headers: asUser() });
    expect(execMocks.capture).toHaveBeenCalledWith(
      'docker',
      ['logs', '--tail', '300', '--timestamps', 'web-1-17'],
      { maxOutputBytes: 8 * 1024 * 1024 },
    );
  });
});
