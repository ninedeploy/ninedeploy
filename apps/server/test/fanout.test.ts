import { describe, expect, it, vi, beforeEach } from 'vitest';
import { deployToTargets, teardownTargets } from '../src/engine/fanout.js';
import { createFakeDb } from './helpers.js';

const agentMocks = vi.hoisted(() => ({ agentOp: vi.fn() }));
vi.mock('../src/lib/agentClient.js', () => ({ agentOp: agentMocks.agentOp }));

const svc = {
  id: 1,
  slug: 'web',
  type: 'docker',
  image: 'nginx:1.25',
  port: 3000,
  healthPath: '/',
  cpuShares: 0,
  cpuLimitMilli: 0,
  memLimitMb: 0,
  volumeMount: null,
  publishedPort: null,
};

function dbWithTargets(rows: Array<{ serverId: number; runtimeId: string | null }>) {
  return createFakeDb({ select: { serviceTargets: rows } });
}

describe('multi-server fan-out (phase 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentMocks.agentOp.mockResolvedValue({ exitCode: 0, lines: [] });
  });

  it('pushes the release to each extra node: login, pull, run, health', async () => {
    agentMocks.agentOp.mockImplementation(async (_db: unknown, _serverId: number, op: string, params: Record<string, unknown>) => {
      if (op === 'docker.inspect') return { exitCode: 0, lines: ['running|10.0.0.9'] };
      if (op === 'file.writeEnv') return { exitCode: 0, lines: [`wrote .agent-env/${params.name}.env`] };
      return { exitCode: 0, lines: [] };
    });
    const db = dbWithTargets([{ serverId: 5, runtimeId: null }]);
    const log = vi.fn();
    const results = await deployToTargets(
      db as never,
      { service: svc, deploymentId: 9, image: 'nginx:1.25@sha256:abc', env: { KEY: 'v' }, primaryServerId: null },
      log,
    );
    expect(results).toEqual([{ serverId: 5, runtimeId: 'web-t5-9', ok: true, error: undefined }]);
    const ops = agentMocks.agentOp.mock.calls.map((c) => c[2]);
    // No registryAuth in this context — the login op is skipped.
    expect(ops).toEqual(['docker.pull', 'file.writeEnv', 'docker.runEnv', 'file.deleteEnv', 'docker.inspect']);
    const run = agentMocks.agentOp.mock.calls.find((c) => c[2] === 'docker.runEnv')![3] as Record<string, unknown>;
    expect(run).toMatchObject({ name: 'web-t5-9', image: 'nginx:1.25@sha256:abc' });
  });

  it('keeps the primary serving when a target node fails', async () => {
    agentMocks.agentOp.mockRejectedValue(new Error('node unreachable'));
    const db = dbWithTargets([{ serverId: 6, runtimeId: 'web-t6-8' }]);
    const log = vi.fn();
    const results = await deployToTargets(
      db as never,
      { service: svc, deploymentId: 9, image: 'nginx:1.25', env: {}, primaryServerId: null },
      log,
    );
    expect(results).toEqual([{ serverId: 6, runtimeId: 'web-t6-8', ok: false, error: 'node unreachable' }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('the primary release is unaffected'));
  });

  it('retires the previous target generation before starting the new one', async () => {
    agentMocks.agentOp.mockResolvedValue({ exitCode: 0, lines: ['running|10.0.0.9'] });
    const db = dbWithTargets([{ serverId: 5, runtimeId: 'web-t5-8' }]);
    await deployToTargets(db as never, { service: svc, deploymentId: 9, image: 'nginx:1.25', env: {}, primaryServerId: null }, vi.fn());
    const ops = agentMocks.agentOp.mock.calls.map((c) => [c[2], c[3]]);
    expect(ops).toContainEqual(['docker.stop', { name: 'web-t5-8' }]);
    expect(ops).toContainEqual(['docker.rm', { name: 'web-t5-8' }]);
  });

  it('teardown removes every target container and the rows', async () => {
    agentMocks.agentOp.mockResolvedValue({ exitCode: 0, lines: [] });
    const db = dbWithTargets([
      { serverId: 5, runtimeId: 'web-t5-8' },
      { serverId: 6, runtimeId: null },
    ]);
    const log = vi.fn();
    await teardownTargets(db as never, 1, log);
    const ops = agentMocks.agentOp.mock.calls.map((c) => [c[2], c[3]]);
    expect(ops).toContainEqual(['docker.stop', { name: 'web-t5-8' }]);
    expect(ops).toContainEqual(['docker.rm', { name: 'web-t5-8' }]);
  });
});
