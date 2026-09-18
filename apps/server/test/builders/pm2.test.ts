import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pm2Builder, pm2Logs, pm2Restart, pm2Start, pm2Status, pm2Stop } from '../../src/engine/builders/pm2.js';

const h = vi.hoisted(() => {
  const pm2 = {
    connect: vi.fn((cb: (err?: Error | null) => void) => cb(null)),
    disconnect: vi.fn(),
    start: vi.fn((_opts: unknown, cb: (err?: Error | null) => void) => cb(null)),
    describe: vi.fn((_name: string, cb: (err: Error | null, desc?: unknown[]) => void) => cb(null, [])),
    delete: vi.fn((_name: string, cb: (err?: Error | null) => void) => cb(null)),
    stop: vi.fn((_name: string, cb: (err?: Error | null) => void) => cb(null)),
    restart: vi.fn((_name: string, cb: (err?: Error | null) => void) => cb(null)),
    dump: vi.fn((cb: (err?: Error | null) => void) => cb(null)),
  };
  const run = vi.fn(async () => undefined);
  const sleep = vi.fn(async () => undefined);
  return { pm2, run, sleep };
});

vi.mock('pm2', () => ({ default: h.pm2 }));
// buildEnv (the allowlisted base env) is an identity spy here so the exact-env
// expectations below stay host-independent; r233 asserts the app env goes
// through it and that PM2 is told not to merge the daemon's own.
const buildEnvSpy = vi.hoisted(() => vi.fn((extra?: Record<string, string>) => ({ ...(extra ?? {}) })));
vi.mock('../../src/lib/exec.js', () => ({ run: h.run, sleep: h.sleep, capture: vi.fn(), buildEnv: buildEnvSpy }));

beforeEach(() => {
  vi.clearAllMocks();
});

const makeCtx = (over: Record<string, unknown> = {}) => ({
  deploymentId: 2,
  service: { slug: 'api', port: 4000, healthPath: '/health' },
  buildConfig: { installCmd: 'npm ci', buildCmd: 'npm run build', startCmd: 'node dist/index.js' },
  workDir: '/work/api',
  commitSha: 'abc',
  env: { PORT: '4000' },
  log: vi.fn(),
  ...over,
});

describe('pm2Builder.buildAndRun', () => {
  it('runs install/build with the service env, stops the previous process and starts the app', async () => {
    const ctx = makeCtx();
    const previous = { runtimeId: 'api-1', port: null, healthPath: '/' };

    const runtime = await pm2Builder.buildAndRun(ctx as never, previous);

    expect(h.run).toHaveBeenNthCalledWith(
      1,
      'sh',
      ['-c', 'npm ci'],
      {
        cwd: '/work/api',
        env: { PORT: '4000' },
        heartbeatMs: 20_000,
        heartbeatLabel: 'Installing application dependencies',
      },
      ctx.log,
    );
    expect(h.run).toHaveBeenNthCalledWith(
      2,
      'sh',
      ['-c', 'npm run build'],
      {
        cwd: '/work/api',
        env: { PORT: '4000' },
        heartbeatMs: 20_000,
        heartbeatLabel: 'Building application',
      },
      ctx.log,
    );
    expect(h.pm2.delete).toHaveBeenCalledWith('api-1', expect.any(Function));
    expect(h.pm2.start).toHaveBeenCalledWith(
      {
        name: 'api-2',
        script: 'node',
        args: 'dist/index.js',
        interpreter: 'none',
        cwd: '/work/api',
        autorestart: true,
        max_restarts: 10,
        env: { PORT: '4000' },
        filter_env: true,
      },
      expect.any(Function),
    );
    expect(h.pm2.connect).toHaveBeenCalledTimes(2); // stop + start each connect once
    expect(h.pm2.disconnect).toHaveBeenCalledTimes(2);
    expect(runtime).toEqual({ runtimeId: 'api-2', port: 4000, healthPath: '/health' });
  });

  it('splits a multi-token start command into script + args', async () => {
    const ctx = makeCtx({ buildConfig: { installCmd: undefined, buildCmd: undefined, startCmd: 'npm run start:prod' } });

    await pm2Builder.buildAndRun(ctx as never);

    expect(h.pm2.start).toHaveBeenCalledWith(
      expect.objectContaining({ script: 'npm', args: 'run start:prod', interpreter: 'none' }),
      expect.any(Function),
    );
  });

  it('defaults to npm start when no start command is configured', async () => {
    const ctx = makeCtx({ buildConfig: undefined });

    const runtime = await pm2Builder.buildAndRun(ctx as never);

    expect(h.run).not.toHaveBeenCalled();
    expect(h.pm2.delete).not.toHaveBeenCalled();
    expect(h.pm2.start).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'api-2', script: 'npm', args: 'start', interpreter: 'none' }),
      expect.any(Function),
    );
    expect(runtime).toEqual({ runtimeId: 'api-2', port: 4000, healthPath: '/health' });
  });

  it('sets max_memory_restart when the service has a memory limit', async () => {
    const ctx = makeCtx({
      service: { slug: 'api', port: 4000, healthPath: '/health', memLimitMb: 512 },
      buildConfig: undefined,
    });

    await pm2Builder.buildAndRun(ctx as never);

    expect(h.pm2.start).toHaveBeenCalledWith(
      expect.objectContaining({ max_memory_restart: '512M' }),
      expect.any(Function),
    );
  });

  it('omits max_memory_restart when no memory limit is set', async () => {
    const ctx = makeCtx({ buildConfig: undefined });

    await pm2Builder.buildAndRun(ctx as never);

    const startOpts = h.pm2.start.mock.calls[0]![0] as Record<string, unknown>;
    expect(startOpts.max_memory_restart).toBeUndefined();
    // r233: the app never inherits the daemon's (= the panel's) environment.
    expect(startOpts.filter_env).toBe(true);
    expect(buildEnvSpy).toHaveBeenCalledWith(startOpts.env);
  });

  it('populates env.PORT from publishedPort or port when not already defined', async () => {
    const ctx1 = makeCtx({
      service: { slug: 'api', port: null, publishedPort: 9000, healthPath: '/health' },
      env: {},
    });
    await pm2Builder.buildAndRun(ctx1 as never);
    expect(h.pm2.start).toHaveBeenCalledWith(
      expect.objectContaining({ env: { PORT: '9000' } }),
      expect.any(Function),
    );

    const ctx2 = makeCtx({
      service: { slug: 'api', port: 5000, healthPath: '/health' },
      env: {},
    });
    await pm2Builder.buildAndRun(ctx2 as never);
    expect(h.pm2.start).toHaveBeenCalledWith(
      expect.objectContaining({ env: { PORT: '5000' } }),
      expect.any(Function),
    );
  });

  it('defaults null port and healthPath in the returned runtime', async () => {
    const ctx = makeCtx({
      service: { slug: 'api', port: null, healthPath: null, memLimitMb: 0 },
      buildConfig: undefined,
    });

    const runtime = await pm2Builder.buildAndRun(ctx as never);

    expect(runtime).toEqual({ runtimeId: 'api-2', port: null, healthPath: '/' });
  });

  it('rejects when pm2.start fails but still disconnects', async () => {
    h.pm2.start.mockImplementationOnce((_opts: unknown, cb: (err?: Error | null) => void) =>
      cb(new Error('start failed')),
    );
    const ctx = makeCtx({ buildConfig: undefined });

    await expect(pm2Builder.buildAndRun(ctx as never)).rejects.toThrow('start failed');
    expect(h.pm2.disconnect).toHaveBeenCalledTimes(1);
  });

  it('rejects without disconnecting when pm2.connect fails', async () => {
    h.pm2.connect.mockImplementationOnce((cb: (err?: Error | null) => void) => cb(new Error('daemon down')));
    const ctx = makeCtx({ buildConfig: undefined });

    await expect(pm2Builder.buildAndRun(ctx as never)).rejects.toThrow('daemon down');
    expect(h.pm2.disconnect).not.toHaveBeenCalled();
  });
});

describe('pm2Builder.isHealthy', () => {
  it('returns true when a described process is online', async () => {
    h.pm2.describe.mockImplementationOnce((_name: string, cb: (err: Error | null, desc?: unknown[]) => void) =>
      cb(null, [{ pm2_env: { status: 'online' } }]),
    );

    await expect(pm2Builder.isHealthy({ runtimeId: 'api-2', port: null, healthPath: '/' }, 1000)).resolves.toBe(true);
  });

  it('returns false when no process becomes online before the deadline', async () => {
    h.pm2.describe.mockImplementation((_name: string, cb: (err: Error | null, desc?: unknown[]) => void) =>
      cb(null, [{ pm2_env: { status: 'stopped' } }]),
    );

    await expect(pm2Builder.isHealthy({ runtimeId: 'api-2', port: null, healthPath: '/' }, 30)).resolves.toBe(false);
    expect(h.sleep).toHaveBeenCalledWith(1000);
  });

  it('handles null entries in the description list', async () => {
    h.pm2.describe.mockImplementation((_name: string, cb: (err: Error | null, desc?: unknown[]) => void) =>
      cb(null, [null]),
    );

    await expect(pm2Builder.isHealthy({ runtimeId: 'api-2', port: null, healthPath: '/' }, 30)).resolves.toBe(false);
  });

  it('falls back to an empty description list when describe returns null', async () => {
    h.pm2.describe.mockImplementation((_name: string, cb: (err: Error | null, desc?: unknown[]) => void) =>
      cb(null, null),
    );

    await expect(pm2Builder.isHealthy({ runtimeId: 'api-2', port: null, healthPath: '/' }, 30)).resolves.toBe(false);
  });

  it('returns false when describe errors', async () => {
    h.pm2.describe.mockImplementation((_name: string, cb: (err: Error | null, desc?: unknown[]) => void) =>
      cb(new Error('not found')),
    );

    await expect(pm2Builder.isHealthy({ runtimeId: 'api-2', port: null, healthPath: '/' }, 30)).resolves.toBe(false);
  });
});

describe('pm2Builder.stop', () => {
  it('deletes the process', async () => {
    await expect(pm2Builder.stop('api-2')).resolves.toBeUndefined();

    expect(h.pm2.delete).toHaveBeenCalledWith('api-2', expect.any(Function));
    expect(h.pm2.connect).toHaveBeenCalledTimes(1);
    expect(h.pm2.disconnect).toHaveBeenCalledTimes(1);
  });

  it('swallows errors, including a failing connect', async () => {
    h.pm2.connect.mockImplementationOnce((cb: (err?: Error | null) => void) => cb(new Error('daemon down')));

    await expect(pm2Builder.stop('api-2')).resolves.toBeUndefined();
  });
});

describe('pm2 lifecycle helpers', () => {
  it('persists the process list after every lifecycle change (boot resurrect dump)', async () => {
    await pm2Stop('api-1');
    expect(h.pm2.dump).toHaveBeenCalledTimes(1);

    await pm2Start('api-1');
    expect(h.pm2.dump).toHaveBeenCalledTimes(2);

    await pm2Restart('api-1');
    expect(h.pm2.dump).toHaveBeenCalledTimes(3);
  });

  it('a failing dump never fails the lifecycle operation', async () => {
    h.pm2.dump.mockImplementationOnce(() => {
      throw new Error('dump unavailable');
    });

    await expect(pm2Stop('api-1')).resolves.toBeUndefined();
    expect(h.pm2.stop).toHaveBeenCalledWith('api-1', expect.any(Function));
  });

  it('serializes process-global PM2 connection sessions', async () => {
    let finishRestart!: () => void;
    h.pm2.restart.mockImplementationOnce((_name: string, cb: (err?: Error | null) => void) => {
      finishRestart = () => cb(null);
    });

    const first = pm2Restart('api-1');
    const second = pm2Stop('api-2');
    await vi.waitFor(() => expect(h.pm2.restart).toHaveBeenCalledOnce());
    expect(h.pm2.stop).not.toHaveBeenCalled();
    expect(h.pm2.connect).toHaveBeenCalledTimes(1);

    finishRestart();
    await first;
    await second;
    expect(h.pm2.disconnect).toHaveBeenCalledTimes(2);
    expect(h.pm2.connect).toHaveBeenCalledTimes(2);
  });

  it('pm2Stop stops the process but keeps it registered', async () => {
    await expect(pm2Stop('api-1')).resolves.toBeUndefined();

    expect(h.pm2.stop).toHaveBeenCalledWith('api-1', expect.any(Function));
    expect(h.pm2.connect).toHaveBeenCalledTimes(1);
    expect(h.pm2.disconnect).toHaveBeenCalledTimes(1);
  });

  describe('pm2Status', () => {
    const withProc = (status: string) => [
      { name: 'api-1', pm2_env: { status } },
    ];

    it('reports online when the process is running', async () => {
      h.pm2.describe.mockImplementationOnce(
        (_n: string, cb: (err: Error | null, desc?: unknown[]) => void) => cb(null, withProc('online')),
      );
      await expect(pm2Status('api-1')).resolves.toBe('online');
    });

    it('reports stopped when the process exists but is not online', async () => {
      h.pm2.describe.mockImplementationOnce(
        (_n: string, cb: (err: Error | null, desc?: unknown[]) => void) => cb(null, withProc('stopped')),
      );
      await expect(pm2Status('api-1')).resolves.toBe('stopped');
    });

    it('reports gone when the daemon does not know the process', async () => {
      h.pm2.describe.mockImplementationOnce(
        (_n: string, cb: (err: Error | null, desc?: unknown[]) => void) => cb(null, []),
      );
      await expect(pm2Status('api-1')).resolves.toBe('gone');
    });

    it('reports gone when the daemon cannot be reached', async () => {
      h.pm2.connect.mockImplementationOnce((cb: (err?: Error | null) => void) => cb(new Error('daemon down')));
      await expect(pm2Status('api-1')).resolves.toBe('gone');
    });
  });

  it('pm2Stop rejects when the daemon errors', async () => {
    h.pm2.stop.mockImplementationOnce((_n: string, cb: (err?: Error | null) => void) =>
      cb(new Error('daemon down')));

    await expect(pm2Stop('api-1')).rejects.toThrow('daemon down');
    expect(h.pm2.disconnect).toHaveBeenCalledTimes(1);
  });

  it('pm2Start resumes an existing process via restart', async () => {
    await expect(pm2Start('api-1')).resolves.toBeUndefined();
    expect(h.pm2.restart).toHaveBeenCalledWith('api-1', expect.any(Function));
  });

  it('pm2Start rejects when the process was deleted', async () => {
    h.pm2.restart.mockImplementationOnce((_n: string, cb: (err?: Error | null) => void) =>
      cb(new Error('process not found')));

    await expect(pm2Start('api-1')).rejects.toThrow('process not found');
  });

  it('pm2Restart restarts an existing process', async () => {
    await expect(pm2Restart('api-1')).resolves.toBeUndefined();
    expect(h.pm2.restart).toHaveBeenCalledWith('api-1', expect.any(Function));
  });

  it('pm2Restart rejects when the daemon errors', async () => {
    h.pm2.restart.mockImplementationOnce((_n: string, cb: (err?: Error | null) => void) =>
      cb(new Error('daemon down')));

    await expect(pm2Restart('api-1')).rejects.toThrow('daemon down');
  });

  it('pm2Logs tails the last 300 lines of the out+err log files', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-pm2-'));
    const out = path.join(dir, 'out.log');
    const err = path.join(dir, 'err.log');
    writeFileSync(out, `${Array.from({ length: 320 }, (_, i) => `out-${i}`).join('\n')}\n`);
    // No trailing newline — exercises the branch that skips the blank-line trim.
    writeFileSync(err, 'boom');
    h.pm2.describe.mockImplementationOnce((_n: string, cb: (err: Error | null, desc?: unknown[]) => void) =>
      cb(null, [{ name: 'api-1', pm2_env: { pm_out_log_path: out, pm_err_log_path: err } }]));
    try {
      const logs = await pm2Logs('api-1');
      expect(logs).toContain('out-20'); // the first 20 lines were trimmed
      expect(logs).not.toContain('out-0');
      expect(logs).toContain('boom');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pm2Logs returns empty when the process has no log paths', async () => {
    h.pm2.describe.mockImplementationOnce((_n: string, cb: (err: Error | null, desc?: unknown[]) => void) =>
      cb(null, [{ name: 'other' }]));

    await expect(pm2Logs('api-1')).resolves.toBe('');
  });

  it('pm2Logs returns empty when the log files are missing', async () => {
    h.pm2.describe.mockImplementationOnce((_n: string, cb: (err: Error | null, desc?: unknown[]) => void) =>
      cb(null, [{ name: 'api-1', pm2_env: { pm_out_log_path: '/nonexistent/out.log' } }]));

    await expect(pm2Logs('api-1')).resolves.toBe('');
  });

  it('pm2Logs rejects when describe errors', async () => {
    h.pm2.describe.mockImplementationOnce((_n: string, cb: (err: Error | null, desc?: unknown[]) => void) =>
      cb(new Error('not found'), null));

    await expect(pm2Logs('api-1')).rejects.toThrow('not found');
  });

  it('pm2Logs falls back to an empty description list when describe returns null', async () => {
    h.pm2.describe.mockImplementationOnce((_n: string, cb: (err: Error | null, desc?: unknown[]) => void) =>
      cb(null, null));

    await expect(pm2Logs('api-1')).resolves.toBe('');
  });
});
