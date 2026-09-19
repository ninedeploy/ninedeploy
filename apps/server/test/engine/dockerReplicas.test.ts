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
