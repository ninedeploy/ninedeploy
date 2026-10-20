import { afterEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 0));
vi.mock('../../src/lib/spawnValidated.js', () => ({ spawnValidated: spawn }));
vi.mock('../../src/lib/exec.js', async (original) => ({
  ...await original<typeof import('../../src/lib/exec.js')>(),
  sleep: async (ms: number) => { vi.setSystemTime(Date.now() + ms); },
}));
const { dockerBuilder } = await import('../../src/engine/builders/docker.js');

afterEach(() => { vi.useRealTimers(); spawn.mockReset(); });

describe('local Docker readiness', () => {
  it('does not fall back to a TCP-open verdict when HTTP returns 503', async () => {
    vi.useFakeTimers();
    spawn.mockImplementation(async (_exe, args, line) => {
      if ((args as string[])[0] === 'run') (line as (s: string) => void)('HTTP/1.1 503 Unavailable');
      return 0;
    });
    expect(await dockerBuilder.isHealthy({ runtimeId: 'app-7', port: 3000, healthPath: '/ready', healthCheck: 'http-strict' }, 2000)).toBe(false);
    expect(spawn.mock.calls.filter((c) => (c[1] as string[])[0] === 'run')).toHaveLength(2);
  });

  it('accepts a successful HTTP response and removes its helper', async () => {
    vi.useFakeTimers();
    spawn.mockImplementation(async (_exe, args, line) => {
      if ((args as string[])[0] === 'run') (line as (s: string) => void)('HTTP/1.1 200 OK');
      return 0;
    });
    expect(await dockerBuilder.isHealthy({ runtimeId: 'app-7', port: 3000, healthPath: '/ready', healthCheck: 'http-strict' }, 2000)).toBe(true);
    expect(spawn.mock.calls.at(-1)?.[1]).toEqual(['rm', '-f', expect.stringMatching(/^nd-probe-/)]);
  });

  it('cannot prove readiness without a configured container port', async () => {
    expect(await dockerBuilder.isHealthy({ runtimeId: 'app-7', port: null, healthPath: '/', healthCheck: 'tcp' })).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});
