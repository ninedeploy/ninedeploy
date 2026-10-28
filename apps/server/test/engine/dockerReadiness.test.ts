import { afterEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 0));
const capture = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 'running|172.20.0.2'));
vi.mock('../../src/lib/spawnValidated.js', () => ({ spawnValidated: spawn }));
vi.mock('../../src/lib/exec.js', async (original) => ({
  ...await original<typeof import('../../src/lib/exec.js')>(),
  capture,
  sleep: async (ms: number) => { vi.setSystemTime(Date.now() + ms); },
}));
const { dockerBuilder } = await import('../../src/engine/builders/docker.js');

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); spawn.mockReset(); capture.mockReset(); capture.mockResolvedValue('running|172.20.0.2'); });

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

  it('does not accept an HTTP response received after the readiness deadline', async () => {
    vi.useFakeTimers();
    spawn.mockImplementation(async (_exe, args, line) => {
      if ((args as string[])[0] === 'run') {
        vi.setSystemTime(Date.now() + 2001);
        (line as (s: string) => void)('HTTP/1.1 200 OK');
      }
      return 0;
    });
    expect(await dockerBuilder.isHealthy({ runtimeId: 'app-7', port: 3000, healthPath: '/ready', healthCheck: 'http-strict' }, 2000)).toBe(false);
    expect(spawn.mock.calls.find(call => (call[1] as string[])[0] === 'run')?.[3]).toEqual({ timeoutMs: 2000 });
  });

  it('propagates lost deployment authority after a successful probe', async () => {
    let checked = 0;
    spawn.mockImplementation(async (_exe, args, line) => {
      if ((args as string[])[0] === 'run') (line as (s: string) => void)('HTTP/1.1 200 OK');
      return 0;
    });
    await expect(dockerBuilder.isHealthy({ runtimeId: 'app-7', port: 3000, healthPath: '/ready', healthCheck: 'http-strict' }, 2000, 0, () => undefined, {
      checkpoint: async () => { if (++checked === 2) throw new Error('owner changed'); },
    })).rejects.toThrow('owner changed');
  });

  it('does not accept a default HTTP probe that completes after its deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => { vi.setSystemTime(Date.now() + 1001); return { status: 200, body: null }; }));
    expect(await dockerBuilder.isHealthy({ runtimeId: 'app-7', port: 3000, healthPath: '/ready' }, 1000, 10000)).toBe(false);
  });

  it('does not accept a default HTTP response after deployment authority changes', async () => {
    let checks = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, body: null })));
    await expect(dockerBuilder.isHealthy({ runtimeId: 'app-7', port: 3000, healthPath: '/ready' }, 5000, 10000, () => undefined, {
      checkpoint: async () => { if (++checks === 3) throw new Error('owner changed'); },
    })).rejects.toThrow('owner changed');
  });

  it('cannot prove readiness without a configured container port', async () => {
    expect(await dockerBuilder.isHealthy({ runtimeId: 'app-7', port: null, healthPath: '/', healthCheck: 'tcp' })).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});
