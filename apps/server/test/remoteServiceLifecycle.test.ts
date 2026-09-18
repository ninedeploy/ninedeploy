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

const agent = vi.hoisted(() => ({
  agentOp: vi.fn(async (_db: unknown, _serverId: number, _op: string, _params: unknown, sink: (l: string) => void) => {
    sink('ok');
    return { exitCode: 0, lines: ['ok'] };
  }),
}));
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
    expect(ops()).toEqual(['4 docker.rm {"name":"web-1-17"}', '4 docker.rm {"name":"web-1-17-r2"}']);
  });

  it('takes a remote compose stack down by its project on delete', async () => {
    const app = await appFor(remote({ type: 'compose', slug: 'shop', replicas: 1 }));
    await app.inject({ method: 'DELETE', url: '/1', headers: asUser() });
    expect(ops()).toEqual(['4 docker.composeDown {"project":"ndcmp-shop"}']);
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
    expect(ops()).toEqual(['4 docker.rm {"name":"web-1-17"}']);
  });
});
