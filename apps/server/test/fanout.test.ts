import { describe, expect, it, vi, beforeEach } from 'vitest';
import { deployToTargets, listFanoutCandidates, recordFanoutResults, teardownTargets } from '../src/engine/fanout.js';
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

  it('builds the pinned commit on each target node for source releases', async () => {
    agentMocks.agentOp.mockImplementation(async (_db: unknown, _sid: number, op: string, params: Record<string, unknown>) => {
      if (op === 'docker.inspect') return { exitCode: 0, lines: ['running|10.0.0.9'] };
      if (op === 'file.writeEnv') return { exitCode: 0, lines: [`wrote .agent-env/${params.name}.env`] };
      return { exitCode: 0, lines: [] };
    });
    const db = dbWithTargets([{ serverId: 5, runtimeId: null }]);
    const log = vi.fn();
    const results = await deployToTargets(
      db as never,
      {
        service: { ...svc, image: null },
        deploymentId: 12,
        env: {},
        primaryServerId: null,
        source: {
          repoUrl: 'https://github.com/acme/web.git',
          branch: 'main',
          commitSha: 'abcdef1234567890',
          dockerfilePath: 'Dockerfile',
          baseDir: '.',
        },
      },
      log,
    );
    expect(results).toEqual([{ serverId: 5, runtimeId: 'web-t5-12', ok: true, error: undefined }]);
    const calls = agentMocks.agentOp.mock.calls.map((c) => [c[2], c[3]]);
    expect(calls).toContainEqual(['git.ensure', { workspace: 'web', url: 'https://github.com/acme/web.git', depth: '1' }]);
    expect(calls).toContainEqual(['git.checkout', { workspace: 'web', ref: 'main' }]);
    expect(calls).toContainEqual(['git.reset', { workspace: 'web', sha: 'abcdef1234567890' }]);
    // The tag pins BOTH the node and the commit — node-local and reproducible.
    expect(calls).toContainEqual(['docker.build', { workspace: 'web', tag: 'ninedeploy/web:t5-abcdef1', dockerfile: 'Dockerfile', context: '.' }]);
    // No pull: the image was built right there.
    expect(calls.some(([op]) => op === 'docker.pull')).toBe(false);
  });

  it('skips targets equal to the primary placement', async () => {
    const db = dbWithTargets([{ serverId: 9, runtimeId: null }]);
    const results = await deployToTargets(
      db as never,
      { service: svc, deploymentId: 9, image: 'nginx:1.25', env: {}, primaryServerId: 9 },
      vi.fn(),
    );
    expect(results).toEqual([]);
    expect(agentMocks.agentOp).not.toHaveBeenCalled();
  });

  it('records a per-node failure when the container exits during the state poll', async () => {
    agentMocks.agentOp.mockImplementation(async (_db: unknown, _sid: number, op: string) => {
      if (op === 'docker.inspect') return { exitCode: 0, lines: ['exited|'] };
      return { exitCode: 0, lines: [] };
    });
    const db = dbWithTargets([{ serverId: 5, runtimeId: null }]);
    const results = await deployToTargets(
      db as never,
      { service: svc, deploymentId: 10, image: 'nginx:1.25', env: {}, primaryServerId: null },
      vi.fn(),
    );
    expect(results).toEqual([{ serverId: 5, runtimeId: 'web-t5-10', ok: false, error: 'container did not reach running state' }]);
  });

  it('upserts fan-out results onto the target rows', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const inserts: Array<Record<string, unknown>> = [];
    let lookups = 0;
    const db = createFakeDb({
      select: {
        // First lookup (server 5) finds the row; the second (server 6) finds
        // none — exercising the update and insert arms respectively.
        serviceTargets: () => (lookups++ === 0 ? [{ id: 3 }] : []),
      },
      update: {
        serviceTargets: (v: Record<string, unknown>) => {
          updates.push(v);
          return [{ id: 3, ...v }];
        },
      },
      insert: {
        serviceTargets: (v: Record<string, unknown>) => {
          inserts.push(v);
          return [{ id: 9, ...v }];
        },
      },
    });
    await recordFanoutResults(db as never, 1, [
      { serverId: 5, runtimeId: 'web-t5-9', ok: true },
      { serverId: 6, runtimeId: null, ok: false, error: 'pull failed' },
    ]);
    expect(updates[0]).toMatchObject({ runtimeId: 'web-t5-9', status: 'running' });
    expect(inserts[0]).toMatchObject({ serviceId: 1, serverId: 6, status: 'error' });
  });

  it('lists fan-out candidate nodes', async () => {
    const db = createFakeDb({ select: { servers: [{ id: 5, name: 'edge-1' }] } });
    const rows = await listFanoutCandidates(db as never);
    expect(rows).toEqual([{ id: 5, name: 'edge-1' }]);
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
