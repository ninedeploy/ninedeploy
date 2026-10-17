import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 0.16.1 wiring guard: a service's container options reach the real
 * `docker run` line of the local builder (and only when set). The schema,
 * route and renderer are covered in runtimeOptions.test.ts; this asserts the
 * mount, the half this repo has forgotten before.
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

async function runArgv(runtimeOptions: unknown): Promise<{ argv: string[]; logs: string[] }> {
  const logs: string[] = [];
  await dockerBuilder.buildAndRun(
    {
      deploymentId: 5,
      service: {
        id: 1, slug: 'web', name: 'Web', type: 'docker', status: 'idle', image: 'ollama/ollama:latest', port: 11434, healthPath: '/',
        volumeMount: null, cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, replicas: 1, runtimeId: null, publishedPort: null,
        dockerSocket: false, cmd: null, runtimeOptions,
      },
      workDir: '/nonexistent',
      commitSha: '',
      env: { A: '1' },
      log: (line: string) => logs.push(line),
    } as never,
    null,
  );
  const call = execMocks.run.mock.calls.find((c) => (c[1] as string[])[0] === 'run');
  return { argv: (call?.[1] as string[]) ?? [], logs };
}

describe('container options on the docker run line', () => {
  it('passes the flags before the image, and logs them', async () => {
    const { argv, logs } = await runArgv({ gpus: 'all', shmSizeMb: 1024, capAdd: ['IPC_LOCK'] });
    const image = argv.indexOf('ollama/ollama:latest');
    expect(image).toBeGreaterThan(0);
    const options = argv.slice(0, image);
    expect(options).toEqual(expect.arrayContaining(['--gpus', 'all', '--shm-size', '1024m', '--cap-add', 'IPC_LOCK']));
    expect(options.indexOf('--gpus')).toBe(options.indexOf('all') - 1);
    expect(logs).toContain('Container options: --gpus all --shm-size 1024m --cap-add IPC_LOCK');
  });

  it('control: a service without options gets none of these flags', async () => {
    const { argv, logs } = await runArgv(null);
    expect(argv.length).toBeGreaterThan(0);
    expect(argv).not.toEqual(expect.arrayContaining(['--gpus']));
    expect(argv.some((a) => a === '--shm-size' || a === '--init' || a === '--ulimit' || a === '--cap-add')).toBe(false);
    expect(logs.some((l) => l.startsWith('Container options'))).toBe(false);
  });
});
