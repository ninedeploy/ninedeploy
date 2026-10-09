import { describe, expect, it, vi, beforeEach } from 'vitest';
import { deployToTargets as deployToTargetsNow, listFanoutCandidates, pullableReleaseRef, recordFanoutResults, teardownTargets } from '../src/engine/fanout.js';
import { createFakeDb } from './helpers.js';

const agentMocks = vi.hoisted(() => ({ agentOp: vi.fn() }));
vi.mock('../src/lib/agentClient.js', () => ({ agentOp: agentMocks.agentOp, agentTransportSealed: async () => true }));

/** r660: what a current agent answers to the sealed agent.ping. */
const PING_CURRENT = { exitCode: 0, lines: ['ND-AGENT {"version":"0.10.42","caps":["build-path-guard","workspace.remove"]}'] };
const execMocks = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../src/lib/exec.js', () => execMocks);
// The egress gate resolves DNS; tests never touch the network (r099, r353).
const egressMocks = vi.hoisted(() => ({ assertCloneTargetAllowed: vi.fn(async (_url: string) => undefined) }));
vi.mock('../src/lib/gitEgress.js', () => egressMocks);

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

/** F117: the target state check polls (stable samples, 2 s apart) — every call here runs on fake time. */
async function deployToTargets(...args: Parameters<typeof deployToTargetsNow>) {
  vi.useFakeTimers();
  try {
    let done = false;
    const run = deployToTargetsNow(...args).finally(() => {
      done = true;
    });
    run.catch(() => undefined);
    for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(500);
    return await run;
  } finally {
    vi.useRealTimers();
  }
}

describe('multi-server fan-out (phase 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentMocks.agentOp.mockResolvedValue({ exitCode: 0, lines: [] });
  });

  it('pushes the release to each extra node: login, pull, run, health', async () => {
    agentMocks.agentOp.mockImplementation(async (_db: unknown, _serverId: number, op: string, params: Record<string, unknown>) => {
      if (op === 'docker.inspect') return { exitCode: 0, lines: ['running|none|0|0'] };
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
    // F117: three consecutive stable samples before the node counts as serving.
    expect(ops).toEqual(['docker.pull', 'file.writeEnv', 'docker.runEnv', 'file.deleteEnv', 'docker.inspect', 'docker.inspect', 'docker.inspect']);
    const run = agentMocks.agentOp.mock.calls.find((c) => c[2] === 'docker.runEnv')![3] as Record<string, unknown>;
    expect(run).toMatchObject({ name: 'web-t5-9', image: 'nginx:1.25@sha256:abc' });
  });

  it('r267: sends multi-line env values escaped, as the local builder writes them', async () => {
    agentMocks.agentOp.mockImplementation(async (_db: unknown, _serverId: number, op: string) =>
      op === 'docker.inspect' ? { exitCode: 0, lines: ['running|none|0|0'] } : { exitCode: 0, lines: [] },
    );
    const db = dbWithTargets([{ serverId: 5, runtimeId: null }]);
    await deployToTargets(
      db as never,
      { service: svc, deploymentId: 9, image: 'nginx:1.25', env: { PEM: 'a\nb\r\nc' }, primaryServerId: null },
      vi.fn(),
    );
    const write = agentMocks.agentOp.mock.calls.find((c) => c[2] === 'file.writeEnv')![3] as { env: Record<string, string> };
    // The agent refuses a physical newline; the node used to fail the target.
    expect(write.env).toEqual({ PEM: 'a\\nb\\nc' });
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

  it('r226: retires the previous target generation only AFTER the new one runs', async () => {
    agentMocks.agentOp.mockResolvedValue({ exitCode: 0, lines: ['running|none|0|0'] });
    const db = dbWithTargets([{ serverId: 5, runtimeId: 'web-t5-8' }]);
    await deployToTargets(db as never, { service: svc, deploymentId: 9, image: 'nginx:1.25', env: {}, primaryServerId: null }, vi.fn());
    const ops = agentMocks.agentOp.mock.calls.map((c) => `${c[2]} ${(c[3] as { name?: string }).name ?? ''}`.trim());
    expect(ops.indexOf('docker.runEnv web-t5-9')).toBeLessThan(ops.indexOf('docker.stop web-t5-8'));
    expect(ops).toContain('docker.rm web-t5-8');
  });

  it('r226: keeps the proven container when the new generation fails its state check', async () => {
    agentMocks.agentOp.mockImplementation(async (_db: unknown, _sid: number, op: string) => {
      if (op === 'docker.inspect') return { exitCode: 0, lines: ['exited|'] };
      return { exitCode: 0, lines: [] };
    });
    const db = dbWithTargets([{ serverId: 5, runtimeId: 'web-t5-8' }]);
    const results = await deployToTargets(db as never, { service: svc, deploymentId: 9, image: 'nginx:1.25', env: {}, primaryServerId: null }, vi.fn());
    expect(results).toEqual([{ serverId: 5, runtimeId: 'web-t5-8', ok: false, error: 'container did not reach running state' }]);
    const removed = agentMocks.agentOp.mock.calls.filter((c) => c[2] === 'docker.rm').map((c) => (c[3] as { name: string }).name);
    expect(removed).toEqual(['web-t5-9']);
  });

  it('r226: a host-port publish still retires the old container first', async () => {
    agentMocks.agentOp.mockResolvedValue({ exitCode: 0, lines: ['running|none|0|0'] });
    const db = dbWithTargets([{ serverId: 5, runtimeId: 'web-t5-8' }]);
    await deployToTargets(db as never, { service: { ...svc, publishedPort: 8080 }, deploymentId: 9, image: 'nginx:1.25', env: {}, primaryServerId: null }, vi.fn());
    const ops = agentMocks.agentOp.mock.calls.map((c) => `${c[2]} ${(c[3] as { name?: string }).name ?? ''}`.trim());
    expect(ops.indexOf('docker.rm web-t5-8')).toBeLessThan(ops.indexOf('docker.runEnv web-t5-9'));
  });

  // F116: `docker run -d` failing after create left a Created container that
  // no row tracked — the result keeps the OLD runtime, so nothing removed it.
  it('F116: removes the Created container of a failed target start, never the tracked one', async () => {
    agentMocks.agentOp.mockImplementation(async (_db: unknown, _sid: number, op: string) => {
      if (op === 'docker.runEnv') throw new Error('agent docker.runEnv exited with 125: port is already allocated');
      return { exitCode: 0, lines: [] };
    });
    const db = dbWithTargets([{ serverId: 5, runtimeId: 'web-t5-8' }]);
    const results = await deployToTargets(db as never, { service: svc, deploymentId: 9, image: 'nginx:1.25', env: {}, primaryServerId: null }, vi.fn());
    expect(results).toEqual([{ serverId: 5, runtimeId: 'web-t5-8', ok: false, error: 'agent docker.runEnv exited with 125: port is already allocated' }]);
    const removed = agentMocks.agentOp.mock.calls.filter((c) => c[2] === 'docker.rm').map((c) => (c[3] as { name: string }).name);
    expect(removed).toEqual(['web-t5-9']);

    // A re-run of the same deployment whose row already tracks that name.
    agentMocks.agentOp.mockClear();
    await deployToTargets(dbWithTargets([{ serverId: 5, runtimeId: 'web-t5-9' }]) as never, { service: svc, deploymentId: 9, image: 'nginx:1.25', env: {}, primaryServerId: null }, vi.fn());
    expect(agentMocks.agentOp.mock.calls.some((c) => c[2] === 'docker.rm')).toBe(false);
  });

  // F117: the first `running` sample was the verdict — a crash-looping
  // container (running between crashes) retired the proven generation.
  it('F117: a crash-looping target container is refused and the proven one keeps serving', async () => {
    const samples = ['running|none|0|0', 'restarting|none|0|1', 'running|none|0|1', 'restarting|none|0|2', 'running|none|0|3'];
    agentMocks.agentOp.mockImplementation(async (_db: unknown, _sid: number, op: string, params: Record<string, unknown>) => {
      if (op === 'docker.inspect') {
        expect(params).toMatchObject({ name: 'web-t5-9', format: 'health' });
        return { exitCode: 0, lines: [samples.shift() ?? 'running|none|0|9'] };
      }
      return { exitCode: 0, lines: [] };
    });
    const results = await deployToTargets(dbWithTargets([{ serverId: 5, runtimeId: 'web-t5-8' }]) as never, { service: svc, deploymentId: 9, image: 'nginx:1.25', env: {}, primaryServerId: null }, vi.fn());
    expect(results).toEqual([{ serverId: 5, runtimeId: 'web-t5-8', ok: false, error: 'container did not reach running state' }]);
    const touched = agentMocks.agentOp.mock.calls.filter((c) => c[2] === 'docker.stop' || c[2] === 'docker.rm').map((c) => `${c[2]} ${(c[3] as { name: string }).name}`);
    expect(touched).toEqual(['docker.stop web-t5-9', 'docker.rm web-t5-9']);

    // A stable run: the proven container is retired only after the third good sample.
    agentMocks.agentOp.mockClear();
    agentMocks.agentOp.mockImplementation(async (_db: unknown, _sid: number, op: string) => ({ exitCode: 0, lines: op === 'docker.inspect' ? ['running|none|0|0'] : [] }));
    const ok = await deployToTargets(dbWithTargets([{ serverId: 5, runtimeId: 'web-t5-8' }]) as never, { service: svc, deploymentId: 9, image: 'nginx:1.25', env: {}, primaryServerId: null }, vi.fn());
    expect(ok[0]).toMatchObject({ runtimeId: 'web-t5-9', ok: true });
    const ops = agentMocks.agentOp.mock.calls.map((c) => `${c[2]} ${(c[3] as { name?: string }).name ?? ''}`.trim());
    expect(ops.filter((o) => o === 'docker.inspect web-t5-9')).toHaveLength(3);
    expect(ops.indexOf('docker.stop web-t5-8')).toBeGreaterThan(ops.lastIndexOf('docker.inspect web-t5-9'));
  });

  it('r226: turns a local image ID into a reference a node can pull', async () => {
    const id = `sha256:${'a'.repeat(64)}`;
    execMocks.capture.mockResolvedValueOnce('mirror.local/nginx@sha256:111 nginx@sha256:222 ');
    expect(await pullableReleaseRef('nginx:1.25', id)).toBe('nginx@sha256:222');
    execMocks.capture.mockRejectedValueOnce(new Error('no such image'));
    expect(await pullableReleaseRef('nginx:1.25', id)).toBe('nginx:1.25');
    // Already pullable (a remote primary reports the ref it ran): unchanged.
    expect(await pullableReleaseRef('nginx:1.25', 'nginx:1.25@sha256:abc')).toBe('nginx:1.25@sha256:abc');
    expect(await pullableReleaseRef('nginx:1.25', undefined)).toBe('nginx:1.25');
  });

  it('builds the pinned commit on each target node for source releases', async () => {
    agentMocks.agentOp.mockImplementation(async (_db: unknown, _sid: number, op: string, params: Record<string, unknown>) => {
      if (op === 'agent.ping') return PING_CURRENT;
      if (op === 'docker.inspect') return { exitCode: 0, lines: ['running|none|0|0'] };
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

  it('r353: a source release clears the clone egress gate before any node clones it', async () => {
    egressMocks.assertCloneTargetAllowed.mockRejectedValueOnce(new Error('Refusing to send an outbound request'));
    const db = dbWithTargets([{ serverId: 5, runtimeId: null }]);
    const results = await deployToTargets(
      db as never,
      {
        service: { ...svc, image: null },
        deploymentId: 13,
        env: {},
        primaryServerId: null,
        source: {
          repoUrl: 'http://169.254.169.254/latest.git',
          branch: 'main',
          commitSha: 'abcdef1234567890',
          dockerfilePath: 'Dockerfile',
          baseDir: '.',
        },
      },
      vi.fn(),
    );
    expect(egressMocks.assertCloneTargetAllowed).toHaveBeenCalledWith('http://169.254.169.254/latest.git');
    expect(results).toEqual([expect.objectContaining({ serverId: 5, ok: false })]);
    // Refused before the node was asked to dial anything.
    expect(agentMocks.agentOp.mock.calls.some((c) => c[2] === 'git.ensure')).toBe(false);
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

  it('updates existing rows and RETIRES the container of a row deleted mid-fan-out (r403)', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const inserts: Array<Record<string, unknown>> = [];
    let lookups = 0;
    agentMocks.agentOp.mockResolvedValue({ exitCode: 0, lines: [] });
    const db = createFakeDb({
      select: {
        // First lookup (server 5) finds the row; the second (server 6) finds
        // none — the operator removed that target WHILE the fan-out loop was
        // running. Re-inserting would resurrect the deleted row and leave an
        // untracked container on the node.
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
      { serverId: 6, runtimeId: 'web-t6-9', ok: true },
    ]);
    expect(updates[0]).toMatchObject({ runtimeId: 'web-t5-9', status: 'running' });
    expect(inserts).toHaveLength(0);
    // The orphaned node container is retired best-effort instead.
    const ops = agentMocks.agentOp.mock.calls.map((c) => [c[2], c[3]]);
    expect(ops).toContainEqual(['docker.stop', { name: 'web-t6-9' }]);
    expect(ops).toContainEqual(['docker.rm', { name: 'web-t6-9' }]);
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

  // r526: the login ran AFTER the source build, so `docker build` pulled a
  // private base image anonymously and every target failed.
  it('r526: logs into the registry BEFORE a target builds from source, and out after', async () => {
    agentMocks.agentOp.mockImplementation(async (_db: unknown, _serverId: number, op: string) =>
      op === 'agent.ping' ? PING_CURRENT : op === 'docker.inspect' ? { exitCode: 0, lines: ['running|none|0|0'] } : { exitCode: 0, lines: [] },
    );
    const db = dbWithTargets([{ serverId: 5, runtimeId: null }]);
    await deployToTargets(
      db as never,
      {
        service: { ...svc, image: null },
        deploymentId: 9,
        env: {},
        registryAuth: { username: 'u', password: 'p', server: 'ghcr.io' },
        primaryServerId: null,
        source: { repoUrl: 'https://github.com/acme/app.git', branch: null, commitSha: 'abcdef123', dockerfilePath: 'Dockerfile', baseDir: '.' },
      },
      vi.fn(),
    );
    const ops = agentMocks.agentOp.mock.calls.map((c) => c[2] as string);
    expect(ops.indexOf('docker.login')).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf('docker.login')).toBeLessThan(ops.indexOf('docker.build'));
    expect(ops.indexOf('docker.logout')).toBeGreaterThan(ops.indexOf('docker.build'));
    // A source build never pulls the release.
    expect(ops).not.toContain('docker.pull');
  });

  it('r592: a rejected login on a SOURCE build warns and builds anonymously instead of failing the target', async () => {
    agentMocks.agentOp.mockImplementation(async (_db: unknown, _serverId: number, op: string) => {
      if (op === 'docker.login') throw new Error('agent docker.login exited with 1');
      if (op === 'agent.ping') return PING_CURRENT;
      return op === 'docker.inspect' ? { exitCode: 0, lines: ['running|none|0|0'] } : { exitCode: 0, lines: [] };
    });
    const db = dbWithTargets([{ serverId: 5, runtimeId: null }]);
    const log = vi.fn();
    const results = await deployToTargets(
      db as never,
      {
        service: { ...svc, image: null },
        deploymentId: 9,
        env: {},
        registryAuth: { username: 'u', password: 'p', server: 'ghcr.io' },
        primaryServerId: null,
        source: { repoUrl: 'https://github.com/acme/app.git', branch: null, commitSha: 'abcdef123', dockerfilePath: 'Dockerfile', baseDir: '.' },
      },
      log,
    );
    expect(results[0]).toMatchObject({ serverId: 5, ok: true });
    expect(agentMocks.agentOp.mock.calls.map((c) => c[2])).toContain('docker.build');
    expect(log.mock.calls.some((c) => String(c[0]).includes('registry login to ghcr.io failed'))).toBe(true);
  });

  it('r592: a rejected login on an IMAGE release still fails that target (unchanged)', async () => {
    agentMocks.agentOp.mockImplementation(async (_db: unknown, _serverId: number, op: string) => {
      if (op === 'docker.login') throw new Error('agent docker.login exited with 1');
      return { exitCode: 0, lines: [] };
    });
    const db = dbWithTargets([{ serverId: 5, runtimeId: null }]);
    const results = await deployToTargets(
      db as never,
      { service: svc, deploymentId: 9, image: 'ghcr.io/acme/app:1', env: {}, registryAuth: { username: 'u', password: 'p', server: 'ghcr.io' }, primaryServerId: null },
      vi.fn(),
    );
    expect(results[0]).toMatchObject({ serverId: 5, ok: false });
    expect(agentMocks.agentOp.mock.calls.map((c) => c[2])).not.toContain('docker.pull');
  });
});

// ── 0.16 T4 build placement ──
describe('0.16 T4: fan-out runs what the primary runs (D1) and ships what it built (D2, design §6.5)', () => {
  const CAPS_ALL = 'ND-AGENT {"version":"0.15.2","caps":["build-path-guard","workspace.remove","git.credential","terminal","terminal.host","stream","docker.runSpec","volume.manage","image.manage"]}';
  const CAPS_015 = 'ND-AGENT {"version":"0.15.1","caps":["build-path-guard","workspace.remove","git.credential","terminal","terminal.host"]}';
  const answer = (caps: string) =>
    agentMocks.agentOp.mockImplementation(async (_db: unknown, _sid: number, op: string, params: Record<string, unknown>) => {
      if (op === 'agent.ping') return { exitCode: 0, lines: [caps] };
      if (op === 'docker.inspect') return { exitCode: 0, lines: ['running|none|0|0'] };
      if (op === 'docker.volumeInspect') throw new Error('agent docker.volumeInspect exited with 1');
      if (op === 'file.writeEnv') return { exitCode: 0, lines: [`wrote .agent-env/${String(params.name)}.env`] };
      return { exitCode: 0, lines: [] };
    });
  beforeEach(() => vi.clearAllMocks());
  const ops = () => agentMocks.agentOp.mock.calls.map((c) => c[2] as string);

  it('D1: a command and an attachment reach the target through docker.runSpec (volume created first), never dropped', async () => {
    answer(CAPS_ALL);
    const db = dbWithTargets([{ serverId: 5, runtimeId: null }]);
    const results = await deployToTargets(
      db as never,
      {
        service: { ...svc, image: 'minio/minio:latest', cmd: ['server', '/data'] },
        volumeAttachments: [{ volumeName: 'nd-svc-web-cache', containerPath: '/cache', readOnly: true }],
        deploymentId: 9,
        image: 'minio/minio:latest',
        env: {},
        primaryServerId: null,
      },
      vi.fn(),
    );
    expect(results).toEqual([{ serverId: 5, runtimeId: 'web-t5-9', ok: true, error: undefined }]);
    expect(ops()).not.toContain('docker.runEnv');
    expect(ops().indexOf('docker.volumeCreate')).toBeLessThan(ops().indexOf('docker.runSpec'));
    const spec = agentMocks.agentOp.mock.calls.find((c) => c[2] === 'docker.runSpec')![3] as Record<string, unknown>;
    expect(spec).toMatchObject({ name: 'web-t5-9', image: 'minio/minio:latest', cmd: ['server', '/data'], volumes: [{ name: 'nd-svc-web-cache', mount: '/cache', readOnly: true }] });
  });

  it('D1: an agent without docker.runSpec is refused before anything is sent; the target is recorded failed', async () => {
    answer(CAPS_015);
    const db = dbWithTargets([{ serverId: 5, runtimeId: 'web-t5-8' }]);
    const results = await deployToTargets(
      db as never,
      { service: { ...svc, dockerSocket: true }, deploymentId: 9, image: 'nginx:1.25', env: {}, primaryServerId: null },
      vi.fn(),
    );
    expect(results).toEqual([{ serverId: 5, runtimeId: 'web-t5-8', ok: false, error: expect.stringMatching(/cannot run a service with volume attachments, a command or the Docker socket/) }]);
    expect(ops()).toEqual(['agent.ping']);
  });

  it('a shipped release: the target receives it through `prebuilt.ship` — no pull, no clone, no build — and runs it', async () => {
    answer(CAPS_ALL);
    const db = dbWithTargets([{ serverId: 5, runtimeId: null }, { serverId: 6, runtimeId: null }]);
    const ship = vi.fn(async (t: { serverId: number }) => {
      if (t.serverId === 6) throw new Error('The agent on node #6 (version 0.15.1) cannot receive an image. Update the node agent to v0.15.2 or newer');
      return { tag: 'ninedeploy/web:abc1234-b9', imageId: `sha256:${'a'.repeat(64)}` };
    });
    const results = await deployToTargets(
      db as never,
      { service: { ...svc, image: null }, deploymentId: 9, env: {}, primaryServerId: null, prebuilt: { ship } },
      vi.fn(),
    );
    expect(results[0]).toEqual({ serverId: 5, runtimeId: 'web-t5-9', ok: true, error: undefined });
    expect(results[1]).toMatchObject({ serverId: 6, ok: false, error: expect.stringMatching(/cannot receive an image/) });
    expect(ops().filter((op) => op === 'docker.pull' || op === 'docker.build' || op.startsWith('git.'))).toEqual([]);
    expect(agentMocks.agentOp.mock.calls.find((c) => c[1] === 5 && c[2] === 'docker.runEnv')![3]).toMatchObject({ image: 'ninedeploy/web:abc1234-b9' });
  });
});
// ── end 0.16 T4 ──
