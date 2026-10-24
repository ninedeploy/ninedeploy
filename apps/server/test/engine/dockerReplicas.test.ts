import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The replica-clone contract of the docker builder's image path: clones copy
 * the primary's `docker run` invocation — EXCEPT the host port publishing,
 * which only the primary may own (Docker refuses a second bind on the same
 * host port, so clones inheriting `-p` never start and scaling silently
 * collapses to one container), and except their own name/env-file. The
 * builder reports how many replicas actually started; the proxy renders that
 * achieved count, so a failed replica never lingers as a dead backend.
 */
const execMocks = vi.hoisted(() => ({
  run: vi.fn(async () => undefined),
  capture: vi.fn(async () => 'sha256:abc\n'),
}));
vi.mock('../../src/lib/exec.js', () => execMocks);

const pullMocks = vi.hoisted(() => ({
  pullDockerImage: vi.fn(async () => undefined),
  ensureDockerImage: vi.fn(async () => undefined),
}));
vi.mock('../../src/lib/dockerPull.js', () => pullMocks);

vi.mock('../../src/lib/serviceBridge.js', () => ({
  ensureServiceBridge: vi.fn(async (slug: string) => `nd-svc-${slug}`),
  connectContainerToServiceBridge: vi.fn(async () => undefined),
}));

const { dockerBuilder } = await import('../../src/engine/builders/docker.js');

const service = {
  id: 1,
  slug: 'web',
  type: 'docker',
  image: 'nginx:alpine',
  port: 80,
  publishedPort: 8080,
  replicas: 3,
  healthPath: '/',
} as never;

const ctx = (replicas: number) => ({
  deploymentId: 7,
  service: { ...service, replicas },
  workDir: '.',
  commitSha: 'abc123',
  env: { APP: 'x' },
  log: () => undefined,
});

const runArgs = () => execMocks.run.mock.calls.map((c) => (c as unknown as [string, string[]])[1]);
const runCalls = () => runArgs().filter((a) => a[0] === 'run' && a[1] === '-d');

beforeEach(() => {
  vi.clearAllMocks();
  execMocks.run.mockImplementation(async () => undefined);
  execMocks.capture.mockResolvedValue('sha256:abc\n');
});

describe('docker builder replicas', () => {
  it('marks every local candidate replica with the immutable recovery ownership labels', async () => {
    await dockerBuilder.buildAndRun(ctx(3) as never);
    expect(runCalls()).toHaveLength(3);
    for (const args of runCalls()) expect(args).toEqual(expect.arrayContaining(['ninedeploy.managed=service', 'ninedeploy.service=1', 'ninedeploy.deployment=7']));
  });
  it('clones the primary without the host port publishing and reports the achieved count', async () => {
    const runtime = await dockerBuilder.buildAndRun(ctx(3) as never);

    const calls = runCalls();
    expect(calls).toHaveLength(3);
    const [primary, r2, r3] = calls.map((a) => ({ name: a[3], args: a }));

    expect(primary.name).toBe('web-7');
    // The primary owns the published host port.
    const pIndex = primary.args.indexOf('-p');
    expect(pIndex).toBeGreaterThan(-1);
    expect(primary.args[pIndex + 1]).toBe('8080:80');

    // Replicas keep the bridge and the env, but NEVER the host port: Docker
    // refuses a second bind, so an inherited -p keeps the replica from ever
    // starting.
    for (const rep of [r2, r3]) {
      expect(rep.name).toMatch(/^web-7-r\d$/);
      expect(rep.args.includes('-p')).toBe(false);
      expect(rep.args).toContain('--network');
      // Their own env-file (the primary's is cleaned up by then).
      const envIndex = rep.args.indexOf('--env-file');
      expect(envIndex).toBeGreaterThan(-1);
    }

    expect(runtime.replicas).toBe(3);
  });

  it('reports one fewer backend when a replica fails to start', async () => {
    const started: string[] = [];
    execMocks.run.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[3] === 'web-7-r3') throw new Error('port allocation failed');
      if (args[0] === 'run' && args[1] === '-d') started.push(args[3]!);
      return undefined;
    });
    const runtime = await dockerBuilder.buildAndRun(ctx(3) as never);
    expect(runtime.replicas).toBe(2);
    // The primary and r2 actually started; r3's failure was tolerated.
    expect(started).toEqual(['web-7', 'web-7-r2']);
  });

  it('keeps replicas un-published even when the service publishes no host port', async () => {
    const runtime = await dockerBuilder.buildAndRun({
      ...ctx(2),
      service: { ...service, publishedPort: null, replicas: 2 },
    } as never);
    const calls = runCalls();
    expect(calls.every((a) => !a.includes('-p'))).toBe(true);
    expect(runtime.replicas).toBe(2);
  });
});

describe('docker builder candidate ownership on failure', () => {
  // F525: the proxy renders `replicaNames(id, achieved)` — the contiguous
  // -r2..-rN names. A middle replica failing must not leave the achieved
  // count pointing at the dead name while a later replica runs unrouted.
  it('stops at the achieved prefix and removes the failed replica when a middle one fails', async () => {
    const running = new Set<string>();
    execMocks.run.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'run' && args[1] === '-d') {
        if (args[3] === 'web-7-r2') throw new Error('replica start failed');
        running.add(args[3]!);
      }
      if (args[0] === 'rm') for (const n of args.slice(2)) running.delete(n);
      return undefined;
    });
    const runtime = await dockerBuilder.buildAndRun(ctx(3) as never);
    expect(runtime.replicas).toBe(1);
    expect([...running]).toEqual(['web-7']);
    expect(runArgs()).toContainEqual(['rm', '-f', 'web-7-r2']);
    expect(runCalls().some((a) => a[3] === 'web-7-r3')).toBe(false);
  });

  // F524: a failed primary start leaves the created container behind and the
  // pipeline never learns its id — the builder removes exactly that name.
  it('removes only its own candidate when the primary fails to start and rethrows', async () => {
    execMocks.run.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'run' && args[1] === '-d' && args[3] === 'web-7') throw new Error('port is already allocated');
      return undefined;
    });
    await expect(
      dockerBuilder.buildAndRun(ctx(3) as never, { runtimeId: 'web-6', port: 80, healthPath: '/' } as never),
    ).rejects.toThrow('port is already allocated');
    const all = runArgs();
    const startIdx = all.findIndex((a) => a[0] === 'run' && a[1] === '-d' && a[3] === 'web-7');
    expect(all.slice(startIdx + 1)).toEqual([['rm', '-f', 'web-7']]);
  });

  // F526: only the host-port `-p` option is stripped — the container
  // command's own `-p` (memcached -p 11212) reaches every replica.
  it('copies a container command containing -p verbatim into replicas', async () => {
    await dockerBuilder.buildAndRun({
      ...ctx(2),
      service: { ...service, image: 'memcached:1.6', replicas: 2, cmd: ['memcached', '-p', '11212'] },
    } as never);
    const [primary, replica] = runCalls();
    const tail = (a: string[]) => a.slice(a.indexOf('memcached:1.6') + 1);
    expect(tail(replica!)).toEqual(['memcached', '-p', '11212']);
    expect(tail(replica!)).toEqual(tail(primary!));
    expect(replica!.slice(0, replica!.indexOf('memcached:1.6')).includes('-p')).toBe(false);
  });
});

describe('0.16.10 autoscaled services', () => {
  const auto = { minReplicas: 1, maxReplicas: 4, metric: 'cpu', target: 50, scaleUpSeconds: 60, scaleDownSeconds: 300 };

  it('creates every container up to the maximum and keeps as many serving as before', async () => {
    const lines: string[] = [];
    const runtime = await dockerBuilder.buildAndRun({
      ...ctx(1),
      service: { ...service, publishedPort: null, replicas: 1, runtimeReplicas: 2, autoscale: auto },
      log: (l: string) => lines.push(l),
    } as never);
    expect(runCalls().map((a) => a[3])).toEqual(['web-7', 'web-7-r2', 'web-7-r3', 'web-7-r4']);
    expect(runArgs()).toContainEqual(['stop', '-t', '5', 'web-7-r3', 'web-7-r4']);
    expect(runtime.replicas).toBe(2);
    expect(lines).toContain('Autoscaling: 2 of 4 containers serve; web-7-r3, web-7-r4 are ready to start');
  });

  it('starts within the bounds: the minimum on a first deploy, never more than were created', async () => {
    const first = await dockerBuilder.buildAndRun({
      ...ctx(1),
      service: { ...service, publishedPort: null, runtimeReplicas: null, autoscale: { ...auto, minReplicas: 2 } },
    } as never);
    expect(first.replicas).toBe(2);
    vi.clearAllMocks();
    const all = await dockerBuilder.buildAndRun({
      ...ctx(1),
      service: { ...service, publishedPort: null, runtimeReplicas: 9, autoscale: { ...auto, maxReplicas: 2 } },
    } as never);
    expect(all.replicas).toBe(2);
    expect(runArgs().some((a) => a[0] === 'stop')).toBe(false);
  });

  it('keeps all of them serving when the spares cannot be stopped', async () => {
    execMocks.run.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'stop') throw new Error('daemon busy');
      return undefined;
    });
    const lines: string[] = [];
    const runtime = await dockerBuilder.buildAndRun({
      ...ctx(1),
      service: { ...service, publishedPort: null, runtimeReplicas: 1, autoscale: { ...auto, maxReplicas: 2 } },
      log: (l: string) => lines.push(l),
    } as never);
    expect(runtime.replicas).toBe(2);
    expect(lines).toContain('warning: could not stop the spare containers (daemon busy); all 2 serve for now');
  });
});
