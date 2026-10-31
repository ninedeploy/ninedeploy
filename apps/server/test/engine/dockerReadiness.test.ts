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
  it.each(['http-strict', 'tcp'] as const)('rejects %s if native health degrades during a successful probe', async healthCheck => {
    vi.useFakeTimers();
    let probed = false;
    capture.mockImplementation(async () => `running|172.20.0.2|${probed ? 'unhealthy' : 'healthy'}`);
    spawn.mockImplementation(async (_exe, args, line) => {
      if ((args as string[])[0] === 'run') { probed = true; (line as (s: string) => void)('HTTP/1.1 200 OK'); }
      return 0;
    });
    expect(await dockerBuilder.isHealthy({ runtimeId: 'app-7', port: 3000, healthPath: '/', healthCheck }, 2000)).toBe(false);
  });

  it.each(['http-strict', 'tcp'] as const)('holds %s while native health is unhealthy despite an accepting port', async healthCheck => {
    vi.useFakeTimers();
    capture.mockResolvedValue('running|172.20.0.2|unhealthy');
    spawn.mockImplementation(async (_exe, args, line) => {
      if ((args as string[])[0] === 'run') (line as (s: string) => void)('HTTP/1.1 200 OK');
      return 0;
    });
    expect(await dockerBuilder.isHealthy({ runtimeId: 'app-7', port: 3000, healthPath: '/', healthCheck }, 2000)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a successful command completed after the readiness deadline', async () => {
    vi.useFakeTimers();
    capture.mockImplementation(async (_exe, args) => {
      if ((args as string[])[0] === 'exec') { vi.setSystemTime(Date.now() + 2001); return ''; }
      return 'running';
    });
    expect(await dockerBuilder.isHealthy({ runtimeId: 'app-7', port: 3000, healthPath: '/', healthCheck: 'command', healthCommand: 'test -f /ready' }, 2000)).toBe(false);
  });

  it('rejects the final running sample when its inspection exceeds the deadline', async () => {
    vi.useFakeTimers();
    let count = 0;
    capture.mockImplementation(async () => {
      if (++count === 10) vi.setSystemTime(Date.now() + 1001);
      return 'running 0';
    });
    expect(await dockerBuilder.isHealthy({ runtimeId: 'app-7', port: null, healthPath: '/', healthCheck: 'running' }, 10000)).toBe(false);
  });

  it('waits for native health to become healthy before accepting HTTP', async () => {
    vi.useFakeTimers();
    let inspections = 0;
    capture.mockImplementation(async (_exe, args) => {
      if ((args as string[]).at(-1) === '{{json .State}}') return JSON.stringify({ Status: 'running' });
      return `running|172.20.0.2|${++inspections === 1 ? 'starting' : 'healthy'}`;
    });
    const fetch = vi.fn(async () => ({ status: 200, body: null }));
    vi.stubGlobal('fetch', fetch);
    expect(await dockerBuilder.isHealthy({ runtimeId: 'app-7', port: 3000, healthPath: '/ready' }, 3000, 10000)).toBe(true);
    expect(inspections).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['starting', 'unhealthy'])('does not publish default HTTP readiness while native health is %s', async health => {
    vi.useFakeTimers();
    capture.mockImplementation(async (_exe, args) => {
      const format = (args as string[]).at(-1) ?? '';
      if (format === '{{json .State}}') return JSON.stringify({ Status: 'running', Health: { Status: health } });
      return `running|172.20.0.2${format.includes('.State.Health') ? `|${health}` : ''}`;
    });
    const fetch = vi.fn(async () => ({ status: 200, body: null }));
    vi.stubGlobal('fetch', fetch);
    expect(await dockerBuilder.isHealthy({ runtimeId: 'app-7', port: 3000, healthPath: '/ready' }, 2000, 10000)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

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
