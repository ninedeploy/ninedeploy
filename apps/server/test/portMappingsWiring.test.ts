import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 0.16.1 wiring guard: a service's port mappings reach the real `docker run`
 * line of the local builder, force the sequential (no blue-green) redeploy a
 * host port needs, and stay off replicas. The schema, route and renderer are
 * covered in portMappings.test.ts; this asserts the mount.
 */

const execMocks = vi.hoisted(() => ({
  buildEnv: vi.fn(() => ({})),
  capture: vi.fn(async (..._args: unknown[]) => ''),
  run: vi.fn(async (..._args: unknown[]) => undefined),
  sleep: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/exec.js', () => execMocks);
vi.mock('../src/engine/proxy.js', () => ({ NETWORK: 'ninedeploy' }));
vi.mock('../src/lib/dockerPull.js', () => ({
  ensureDockerImage: vi.fn(async () => undefined),
  pullDockerImage: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/serviceBridge.js', () => ({
  ensureServiceBridge: vi.fn(async () => 'nd-svc-web'),
  connectContainerToServiceBridge: vi.fn(async () => undefined),
}));

const { dockerBuilder } = await import('../src/engine/builders/docker.js');

afterEach(() => vi.clearAllMocks());

async function deploy(extra: Record<string, unknown>, previous: { runtimeId: string } | null = null) {
  const logs: string[] = [];
  await dockerBuilder.buildAndRun(
    {
      deploymentId: 5,
      service: {
        id: 1, slug: 'game', name: 'Game', type: 'docker', status: 'idle', image: 'game/server:1', port: 27015, healthPath: '/',
        volumeMount: null, cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, replicas: 1, runtimeId: null, publishedPort: null,
        dockerSocket: false, cmd: null, runtimeOptions: null, portMappings: null, ...extra,
      },
      workDir: '/nonexistent',
      commitSha: '',
      env: { A: '1' },
      log: (line: string) => logs.push(line),
    } as never,
    previous as never,
  );
  const runs = execMocks.run.mock.calls.map((c) => c[1] as string[]).filter((a) => a[0] === 'run');
  const removed = execMocks.run.mock.calls.map((c) => c[1] as string[]).filter((a) => a[0] === 'rm');
  return { runs, removed, logs };
}

const mappings = [
  { hostIp: null, hostPort: 27015, hostPortEnd: 27030, containerPort: 27015, protocol: 'udp' },
  { hostIp: '203.0.113.7', hostPort: 8443, hostPortEnd: null, containerPort: 443, protocol: 'tcp' },
];

describe('port mappings on the docker run line', () => {
  it('publishes every mapping before the image', async () => {
    const { runs } = await deploy({ portMappings: mappings });
    const argv = runs[0]!;
    const options = argv.slice(0, argv.indexOf('game/server:1'));
    expect(options).toEqual(expect.arrayContaining(['-p', '27015-27030:27015-27030/udp']));
    expect(options[options.indexOf('203.0.113.7:8443:443/tcp') - 1]).toBe('-p');
  });

  it('stops (never removes) the previous container first: the new one cannot bind the same host ports', async () => {
    const { removed, logs } = await deploy({ portMappings: mappings }, { runtimeId: 'game-4' });
    // Stopped, so a failed candidate can hand the ports back (pipeline `revive`).
    const stopped = execMocks.run.mock.calls.map((c) => c[1] as string[]).filter((a) => a[0] === 'stop');
    expect(stopped[0]).toEqual(expect.arrayContaining(['stop', 'game-4', 'game-4-r2']));
    expect(removed.flat()).not.toContain('game-4');
    expect(logs.some((l) => l.includes('27015-27030:27015-27030/udp') && l.includes('sequential deploy'))).toBe(true);
  });

  it('replicas get none of the host ports', async () => {
    const { runs } = await deploy({ portMappings: mappings, replicas: 2 });
    expect(runs.length).toBe(2);
    expect(runs[0]).toContain('-p');
    expect(runs[1]).not.toContain('-p');
  });

  it('control: without mappings there is no -p and blue-green stays on', async () => {
    const { runs, removed } = await deploy({}, { runtimeId: 'game-4' });
    expect(runs[0]).not.toContain('-p');
    expect(removed).not.toContainEqual(['rm', '-f', 'game-4']);
  });
});

describe('port mappings on a node', () => {
  const pingLine = (version: string, list: readonly string[]) => `ND-AGENT ${JSON.stringify({ version, caps: list })}`;
  const node = (caps: readonly string[]) => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const agent = vi.fn(async (op: string, params: Record<string, unknown>) => {
      calls.push([op, params]);
      if (op === 'agent.ping') return { exitCode: 0, lines: [pingLine('0.16.1', caps)] };
      if (op === 'file.writeEnv') return { exitCode: 0, lines: ['wrote .agent-env/game-5.env'] };
      return { exitCode: 0, lines: [] };
    });
    return { agent, calls };
  };
  const input = (previous?: { runtimeId: string }) => ({
    service: { id: 1, slug: 'game', serverId: 3, port: 27015, cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, portMappings: mappings } as never,
    deploymentId: 5,
    env: { SECRET: 'x' },
    name: 'game-5',
    image: 'game/server:1',
    previous: previous as never,
    log: () => undefined,
  });

  it('an agent without docker.ports is told to update before the env-file reaches the node', async () => {
    const { runRemoteContainer } = await import('../src/engine/builders/remoteRun.js');
    const { agent, calls } = node(['stream', 'docker.runSpec', 'volume.manage']);
    await expect(runRemoteContainer(agent as never, input())).rejects.toThrow(/cannot publish port mappings .* Update the node agent to v0\.16\.1/);
    expect(calls.map(([op]) => op)).toEqual(['agent.ping']);
  });

  it('a current agent gets the mappings as docker.runSpec ports, after the previous container is retired', async () => {
    const { runRemoteContainer } = await import('../src/engine/builders/remoteRun.js');
    const { agent, calls } = node(['stream', 'docker.runSpec', 'volume.manage', 'docker.ports']);
    await runRemoteContainer(agent as never, input({ runtimeId: 'game-4' }));
    const ops = calls.map(([op]) => op);
    expect(ops.indexOf('docker.rm')).toBeLessThan(ops.indexOf('docker.runSpec'));
    expect(calls.find(([op]) => op === 'docker.rm')?.[1]).toEqual({ name: 'game-4' });
    expect(calls.find(([op]) => op === 'docker.runSpec')?.[1]).toMatchObject({
      name: 'game-5',
      ports: ['27015-27030:27015-27030/udp', '203.0.113.7:8443:443/tcp'],
    });
  });
});

describe("healthCheck 'running' (services with no port to probe)", () => {
  it('the deploy runtime carries the mode only when set', async () => {
    const runtime = async (healthCheck: unknown) =>
      dockerBuilder.buildAndRun(
        {
          deploymentId: 5,
          service: {
            id: 1, slug: 'game', name: 'Game', type: 'docker', status: 'idle', image: 'game/server:1', port: 27015, healthPath: '/',
            volumeMount: null, cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, replicas: 1, runtimeId: null, publishedPort: null,
            dockerSocket: false, cmd: null, runtimeOptions: null, portMappings: null, healthCheck,
          },
          workDir: '/nonexistent', commitSha: '', env: {}, log: () => undefined,
        } as never,
        null as never,
      );
    expect((await runtime('running')).healthCheck).toBe('running');
    expect((await runtime('http-strict')).healthCheck).toBe('http-strict');
    expect((await runtime('tcp')).healthCheck).toBe('tcp');
    expect((await runtime(null)).healthCheck).toBeUndefined();
  });

  it('passes once the container holds running with the same restart count, without probing a port', async () => {
    const { RUNNING_STABLE_SAMPLES } = await import('../src/engine/builders/docker.js');
    const samples = ['', 'created 0', 'running 0', 'restarting 1', 'running 1'];
    execMocks.capture.mockImplementation(async (_cmd: unknown, args: unknown) =>
      (args as string[])[0] === 'inspect' ? (samples.shift() ?? 'running 1') : '',
    );
    const logs: string[] = [];
    const ok = await dockerBuilder.isHealthy({ runtimeId: 'game-5', port: 27015, healthPath: '/', healthCheck: 'running' }, 60_000, 10_000, (l) => logs.push(l));
    expect(ok).toBe(true);
    const inspects = execMocks.capture.mock.calls.filter((c) => (c[1] as string[])[0] === 'inspect');
    // 'running 0' counted once, reset by the restart, then RUNNING_STABLE_SAMPLES in a row.
    expect(inspects.length).toBe(4 + RUNNING_STABLE_SAMPLES);
    expect(execMocks.run.mock.calls.some((c) => (c[1] as string[]).includes('nc'))).toBe(false);
    expect(logs[0]).toMatch(/container running \(no port probe\)/);
  });

  it('fails at once when the container exits', async () => {
    execMocks.capture.mockImplementation(async (_cmd: unknown, args: unknown) => ((args as string[])[0] === 'inspect' ? 'exited 0' : ''));
    expect(await dockerBuilder.isHealthy({ runtimeId: 'game-5', port: null, healthPath: '/', healthCheck: 'running' }, 60_000)).toBe(false);
  });

  it('fails when the deadline passes first', async () => {
    const { holdsRunning } = await import('../src/engine/builders/docker.js');
    execMocks.capture.mockImplementation(async () => 'restarting 3');
    expect(await holdsRunning('game-5', 0, () => undefined)).toBe(false);
  });
});

describe("0.16.3 healthCheck 'command'", () => {
  afterEach(() => execMocks.capture.mockReset());

  it('the deploy runtime carries the command; a mode without a command is the HTTP probe', async () => {
    const runtime = async (healthCheck: unknown, healthCommand: unknown) =>
      dockerBuilder.buildAndRun(
        {
          deploymentId: 5,
          service: {
            id: 1, slug: 'db', name: 'Db', type: 'docker', status: 'idle', image: 'postgres:17', port: 5432, healthPath: '/',
            volumeMount: null, cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, replicas: 1, runtimeId: null, publishedPort: null,
            dockerSocket: false, cmd: null, runtimeOptions: null, portMappings: null, healthCheck, healthCommand,
          },
          workDir: '/nonexistent', commitSha: '', env: {}, log: () => undefined,
        } as never,
        null as never,
      );
    expect(await runtime('command', 'pg_isready')).toMatchObject({ healthCheck: 'command', healthCommand: 'pg_isready' });
    expect((await runtime('command', null)).healthCheck).toBeUndefined();
  });

  it('runs the command with sh -c inside the container until it exits 0, logging a changed failure once', async () => {
    const execs = [new Error('no response'), new Error('no response'), new Error('rejecting connections'), ''];
    execMocks.capture.mockImplementation(async (_cmd: unknown, args: unknown) => {
      const argv = args as string[];
      if (argv[0] === 'inspect') return 'running';
      const next = execs.shift();
      if (next instanceof Error) throw next;
      return next ?? '';
    });
    const logs: string[] = [];
    const ok = await dockerBuilder.isHealthy({ runtimeId: 'db-5', port: 5432, healthPath: '/', healthCheck: 'command', healthCommand: 'pg_isready -U app' }, 60_000, 10_000, (l) => logs.push(l));
    expect(ok).toBe(true);
    const execCalls = execMocks.capture.mock.calls.filter((c) => (c[1] as string[])[0] === 'exec');
    expect(execCalls).toHaveLength(4);
    expect(execCalls[0]![1]).toEqual(['exec', 'db-5', 'sh', '-c', 'pg_isready -U app']);
    expect(logs.filter((l) => l.startsWith('Healthcheck command failed'))).toEqual([
      'Healthcheck command failed: no response',
      'Healthcheck command failed: rejecting connections',
    ]);
    expect(logs.at(-1)).toBe('Healthcheck command exited 0');
    expect(execMocks.run.mock.calls.some((c) => (c[1] as string[]).includes('nc'))).toBe(false);
  });

  it('waits for the container to run, and fails at once when it exits', async () => {
    const states = ['', 'created', 'exited'];
    execMocks.capture.mockImplementation(async (_cmd: unknown, args: unknown) => ((args as string[])[0] === 'inspect' ? (states.shift() ?? 'exited') : ''));
    expect(await dockerBuilder.isHealthy({ runtimeId: 'db-5', port: null, healthPath: '/', healthCheck: 'command', healthCommand: 'true' }, 60_000)).toBe(false);
    expect(execMocks.capture.mock.calls.some((c) => (c[1] as string[])[0] === 'exec')).toBe(false);
  });

  it('fails when the deadline passes first', async () => {
    const { commandSucceeds } = await import('../src/engine/builders/docker.js');
    execMocks.capture.mockImplementation(async () => 'running');
    expect(await commandSucceeds('db-5', 'false', 0, () => undefined)).toBe(false);
  });
});
