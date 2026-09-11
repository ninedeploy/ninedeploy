import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { containerExposedTcpPorts, dockerBuilder, nixpacksEnvArgs, sanitiseRuntimeLogs, writeEnvFile } from '../../src/engine/builders/docker.js';

const h = vi.hoisted(() => {
  const run = vi.fn(async (_cmd: string, _args: unknown[], _opts: unknown, sink?: (line: string) => void) => {
    sink?.('');
  });
  const sleep = vi.fn(async () => undefined);
  const capture = vi.fn(async () => 'running');
  const config: { paths: { dataDir: string } } = { paths: { dataDir: '/tmp/nd-docker-test' } };
  return { run, sleep, capture, config };
});

vi.mock('../../src/lib/exec.js', () => ({ run: h.run, sleep: h.sleep, capture: h.capture, buildEnv: () => ({}) }));
vi.mock('../../src/config.js', () => ({ config: h.config }));

// existsSync stays a passthrough to the real fs by default (env-file tests
// probe real temp files); build-selection tests override its return value.
const h2 = vi.hoisted(() => {
  let actual: typeof import('node:fs');
  const passthrough = (p: string) => actual.existsSync(p);
  const exists = vi.fn(passthrough);
  return {
    exists,
    bind: (a: typeof import('node:fs')) => {
      actual = a;
    },
    // Reset per test but always fall back to the real fs.
    reset: () => {
      exists.mockReset();
      exists.mockImplementation(passthrough);
    },
  };
});
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  h2.bind(actual);
  return { ...actual, existsSync: h2.exists };
});

const spawnMocks = vi.hoisted(() => {
  const handlers: Array<{ ev: string; cb: (code: number | null) => void }> = [];
  const stdinHandlers: Array<{ ev: string; cb: (err?: Error) => void }> = [];
  const child = {
    stdin: {
      on: vi.fn((ev: string, cb: (err?: Error) => void) => {
        if (ev === 'error') stdinHandlers.push({ ev, cb });
      }),
      write: vi.fn(),
      end: vi.fn(),
    },
    on: vi.fn((ev: string, cb: (code: number | null) => void) => {
      if (ev === 'exit') handlers.push({ ev, cb });
    }),
  };
  const spawn = vi.fn(() => child);
  return { spawn, child, handlers, stdinHandlers };
});
vi.mock('node:child_process', () => ({ spawn: spawnMocks.spawn }));

const makeCtx = (over: Record<string, unknown> = {}) => ({
  deploymentId: 3,
  service: {
    slug: 'web',
    image: null,
    port: 3000,
    cpuShares: 512,
    memLimitMb: 256,
    volumeMount: '/data',
    healthPath: '/health',
  },
  buildConfig: { baseDir: '/', dockerfilePath: 'Dockerfile' },
  workDir: '/work/web',
  commitSha: 'abcdef12345',
  env: { NODE_ENV: 'production' },
  log: vi.fn(),
  ...over,
});

/** Find the `--env-file <path>` value within a docker argv, if present. */
function envFilePath(args: unknown[]): string | undefined {
  const i = args.indexOf('--env-file');
  return i >= 0 ? (args[i + 1] as string) : undefined;
}

describe('dockerBuilder.buildAndRun', () => {
  beforeEach(() => {
    h.run.mockReset();
    h.run.mockResolvedValue(undefined);
    h.capture.mockReset();
    // Default: container is running, the per-slug bridge exists, and Traefik
    // is already attached to it — so `ensureServiceBridge` short-circuits and
    // tests that count `run` calls only see the actual `docker run -d` flow.
    h.capture.mockImplementation(async (_cmd: string, args: string[]) => {
      const argv = args as string[];
      if (argv[0] === 'network' && argv[1] === 'ls') return 'nd-svc-web'; // bridge present
      if (argv[0] === 'inspect' && argv[1] === 'ninedeploy-traefik') return '{"nd-svc-web":{}}';
      return 'running';
    });
    h2.reset();
  });

  it('appends the template command after the image and mounts the docker socket when flagged', async () => {
    h.run.mockResolvedValue(undefined);
    const ctx = makeCtx({ service: { slug: 'minio', image: 'minio/minio', port: 9000, cpuShares: 0, memLimitMb: 0, volumeMount: '/data', healthPath: '/', cmd: ['server', '/data', '--console-address', ':9001'], dockerSocket: true } });

    await dockerBuilder.buildAndRun(ctx as never);

    const runArgs = h.run.mock.calls.at(-1)![1] as unknown[];
    expect(runArgs.join(' ')).toContain('-v /var/run/docker.sock:/var/run/docker.sock');
    expect(runArgs.join(' ')).toContain('minio/minio server /data --console-address :9001');
  });

  it('honors a configurable restart policy from the build config', async () => {
    const ctx = makeCtx({ service: { slug: 'web', image: 'nginx', port: 3000, cpuShares: 0, memLimitMb: 0, healthPath: '/' }, buildConfig: { restartPolicy: 'on-failure:5' } });
    await dockerBuilder.buildAndRun(ctx as never);
    const runArgs = h.run.mock.calls.at(-1)![1] as unknown[];
    expect(runArgs.join(' ')).toContain('--restart on-failure:5');
  });

  it('falls back to unless-stopped for an invalid restart policy', async () => {
    const ctx = makeCtx({ service: { slug: 'web', image: 'nginx', port: 3000, cpuShares: 0, memLimitMb: 0, healthPath: '/' }, buildConfig: { restartPolicy: 'always --privileged' } });
    await dockerBuilder.buildAndRun(ctx as never);
    const runArgs = h.run.mock.calls.at(-1)![1] as unknown[];
    expect(runArgs.join(' ')).toContain('--restart unless-stopped');
  });

  it('pulls a pre-built image and starts a container with resource/env-file flags', async () => {
    h.run.mockRejectedValueOnce(new Error('pull failed')).mockResolvedValueOnce(undefined);
    const ctx = makeCtx({ service: { slug: 'web', image: 'nginx:1.25', port: 3000, cpuShares: 512, memLimitMb: 256, volumeMount: '/data', healthPath: '/health' } });

    const runtime = await dockerBuilder.buildAndRun(ctx as never);

    const log = ctx.log;
    expect(h.run).toHaveBeenCalledWith(
      'docker',
      ['pull', 'nginx:1.25'],
      { heartbeatMs: 20_000, heartbeatLabel: 'Pulling application image nginx:1.25' },
      expect.any(Function),
    );
    // Pull failed but a local image exists → tolerated with a clear warning.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('pull failed, using local image'));
    const runArgs = h.run.mock.calls.at(-1)![1] as unknown[];
    expect(runArgs).toEqual(
      [
        'run', '-d', '--name', 'web-3', '--restart', 'unless-stopped', '--network', 'nd-svc-web',
        '--cpu-shares', '512', '--memory', '256m',
        '-v', 'nd-svc-web-data:/data',
        '--env-file', expect.any(String),
        'nginx:1.25',
      ],
    );
    // No host port is published — Traefik routes over the network and the
    // healthcheck probes the container's network IP.
    expect(runArgs).not.toContain('-p');
    expect(runtime).toEqual({ runtimeId: 'web-3', port: 3000, healthPath: '/health', imageDigest: expect.any(String) });
  });

  it('logs a pull warning when the rejection is not an Error instance', async () => {
    h.run.mockRejectedValueOnce('network down').mockResolvedValueOnce(undefined);
    const ctx = makeCtx({ service: { slug: 'web', image: 'nginx:1.25', port: 3000, cpuShares: 0, memLimitMb: 0, volumeMount: null, healthPath: '/health' } });

    const _runtime = await dockerBuilder.buildAndRun(ctx as never);

    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('pull failed, using local image nginx:1.25 (network down)'));
  });

  it('fails the deploy when the pull fails and no local image exists', async () => {
    h.run.mockRejectedValueOnce(new Error('manifest unknown'));
    // The local-image probe also fails → nothing to fall back to.
    h.capture.mockRejectedValueOnce(new Error('No such image'));
    const ctx = makeCtx({ service: { slug: 'web', image: 'nginx:1.25', port: 3000, cpuShares: 0, memLimitMb: 0, volumeMount: null, healthPath: '/' } });

    await expect(dockerBuilder.buildAndRun(ctx as never)).rejects.toThrow('manifest unknown');
  });

  it('writes env vars to a temp env-file (0600) and deletes it after start', async () => {
    const ctx = makeCtx({ env: { DATABASE_URL: 'postgres://secret@host/db', NODE_ENV: 'production' } });
    await dockerBuilder.buildAndRun(ctx as never);

    const runArgs = h.run.mock.calls.at(-1)![1] as unknown[];
    const file = envFilePath(runArgs);
    expect(file).toBeTruthy();
    expect(existsSync(file)).toBe(false); // unlinked in the finally block
    // The env-file path is the only secret-bearing arg — never the values inline.
    expect(String(runArgs)).not.toContain('secret@host');
  });

  it('passes secrets via env-file, never as -e argv', async () => {
    const apiKey = ['sk', 'super', 'secret'].join('-');
    const ctx = makeCtx({ env: { API_KEY: apiKey } });
    await dockerBuilder.buildAndRun(ctx as never);

    const runArgs = h.run.mock.calls.at(-1)![1] as unknown[];
    expect(runArgs).not.toContain('-e');
    expect(String(runArgs)).not.toContain(apiKey);
  });

  it('builds from source with default baseDir and dockerfile when buildConfig is absent', async () => {
    h2.exists.mockReturnValue(true); // repo ships a Dockerfile → auto picks docker build
    const ctx = makeCtx({ buildConfig: undefined });

    await dockerBuilder.buildAndRun(ctx as never);

    expect(h.run).toHaveBeenCalledWith(
      'docker',
      ['build', '-t', 'ninedeploy/web:abcdef1', '-f', 'Dockerfile', '.'],
      {
        cwd: '/work/web',
        env: { DOCKER_BUILDKIT: '1' },
        heartbeatMs: 20_000,
        heartbeatLabel: 'Building Docker image ninedeploy/web:abcdef1',
      },
      ctx.log,
    );
  });

  it('uses the custom baseDir/dockerfile and falls back to latest tag for an empty sha', async () => {
    h2.exists.mockReturnValue(true); // custom Dockerfile.prod exists → docker build
    const ctx = makeCtx({ commitSha: '', buildConfig: { baseDir: '/app', dockerfilePath: 'Dockerfile.prod' } });

    await dockerBuilder.buildAndRun(ctx as never);

    expect(h.run).toHaveBeenCalledWith(
      'docker',
      // `/app` is re-anchored to `app`: the command runs with cwd=workDir, and
      // a leading slash means "repo root" here — not the filesystem root, which
      // is how `path.resolve` would have read it (see lib/repoPath.ts, L-13).
      ['build', '-t', 'ninedeploy/web:latest', '-f', 'Dockerfile.prod', 'app'],
      {
        cwd: '/work/web',
        env: { DOCKER_BUILDKIT: '1' },
        heartbeatMs: 20_000,
        heartbeatLabel: 'Building Docker image ninedeploy/web:latest',
      },
      ctx.log,
    );
  });

  it('L-13: refuses a build path that climbs out of the checkout', async () => {
    h2.exists.mockReturnValue(true);
    const ctx = makeCtx({ commitSha: '', buildConfig: { baseDir: '../../etc', dockerfilePath: 'Dockerfile' } });
    await expect(dockerBuilder.buildAndRun(ctx as never)).rejects.toThrow(/outside the repository/);
  });

  it('omits port/cpu/memory/volume/env flags when unset', async () => {
    h2.exists.mockReturnValue(true); // Dockerfile build with no declared port
    const ctx = makeCtx({
      service: { slug: 'x', image: null, port: null, cpuShares: 0, memLimitMb: 0, volumeMount: null, healthPath: '/' },
      env: {},
      commitSha: 'abc',
    });

    await dockerBuilder.buildAndRun(ctx as never);

    const runArgs = h.run.mock.calls.at(-1)![1] as unknown[];
    expect(runArgs).toEqual([
      'run', '-d', '--name', 'x-3', '--restart', 'unless-stopped', '--network', 'nd-svc-x', 'ninedeploy/x:abc',
    ]);
  });

  it('encodes physical newlines so they cannot inject extra env-file keys', () => {
    const file = writeEnvFile({ PRIVATE_KEY: ['line-1', 'line-2\nINJECTED=yes'].join('\r\n') });
    expect(file).toBeTruthy();
    try {
      expect(readFileSync(file!.path, 'utf8')).toBe('PRIVATE_KEY=line-1\\nline-2\\nINJECTED=yes\n');
    } finally {
      file!.cleanup();
    }
  });

  it('writes the env file into a private per-call directory, not a guessable path', () => {
    // Regression for M-5: a predictable `${tmpdir()}/nd-env-<pid>-<ms>.env`
    // let a local user pre-plant a symlink there and have the panel (root,
    // under the systemd install) overwrite an arbitrary file.
    const a = writeEnvFile({ A: '1' })!;
    const b = writeEnvFile({ A: '1' })!;
    try {
      expect(dirname(a.path)).not.toBe(dirname(b.path));
      // mkdtemp dirs are 0700; the file itself stays 0600.
      if (process.platform !== 'win32') {
        expect(statSync(dirname(a.path)).mode & 0o777).toBe(0o700);
        expect(statSync(a.path).mode & 0o777).toBe(0o600);
      }
      a.cleanup();
      expect(existsSync(dirname(a.path))).toBe(false);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('redacts quoted structured secrets including spaces', () => {
    expect(sanitiseRuntimeLogs('{"password": "secret phrase", "token":"abc def"}')).toBe(
      '{"password": [REDACTED], "token":[REDACTED]}',
    );
  });

  it('defaults Dockerfile-less Nixpacks source apps to port 3000 and passes PORT through the env file', async () => {
    h2.exists.mockReturnValue(false);
    const ctx = makeCtx({
      service: { slug: 'next-app', image: null, port: null, cpuShares: 0, memLimitMb: 0, volumeMount: null, healthPath: '/' },
      buildConfig: { buildPack: 'auto', baseDir: '/' },
      env: {},
    });

    const runtime = await dockerBuilder.buildAndRun(ctx as never);

    const runArgs = h.run.mock.calls.at(-1)![1] as unknown[];
    expect(runArgs).toContain('--env-file');
    expect(runtime.port).toBe(3000);
    expect(ctx.log).toHaveBeenCalledWith(
      'No container port configured; using Nixpacks default 3000/tcp for runtime, healthcheck and Traefik',
    );
  });

  it('adopts the single TCP port declared by a Docker image', async () => {
    h.capture
      .mockResolvedValueOnce('{"8080/tcp":{}}')
      .mockResolvedValueOnce('sha256:image');
    const ctx = makeCtx({
      service: { slug: 'custom', image: 'example/web', port: null, cpuShares: 0, memLimitMb: 0, volumeMount: null, healthPath: '/' },
      env: {},
    });

    const runtime = await dockerBuilder.buildAndRun(ctx as never);

    expect(runtime.port).toBe(8080);
    expect(ctx.log).toHaveBeenCalledWith('Detected container port 8080/tcp from image metadata');
  });

  it('passes -p hostPort:containerPort when publishedPort is configured', async () => {
    const ctx = makeCtx({
      service: { slug: 'x', image: 'nginx', port: 80, publishedPort: 8080, cpuShares: 0, memLimitMb: 0, volumeMount: null, healthPath: '/' },
      env: {},
      commitSha: 'abc',
    });

    await dockerBuilder.buildAndRun(ctx as never);

    const runArgs = h.run.mock.calls.at(-1)![1] as unknown[];
    expect(runArgs).toContain('-p');
    expect(runArgs).toContain('8080:80');
  });

  it('maps publishedPort to itself when service.port is null', async () => {
    const ctx = makeCtx({
      service: { slug: 'x', image: 'redis:alpine', port: null, publishedPort: 6379, cpuShares: 0, memLimitMb: 0, volumeMount: null, healthPath: '/' },
      env: {},
      commitSha: 'abc',
    });

    await dockerBuilder.buildAndRun(ctx as never);

    const runArgs = h.run.mock.calls.at(-1)![1] as unknown[];
    expect(runArgs).toContain('-p');
    expect(runArgs).toContain('6379:6379');
  });

  it('retires the previous runtime BEFORE start when a host port is published', async () => {
    // Docker cannot bind the same host port twice: with blue-green the second
    // deploy would die on "port is already allocated" and the service would be
    // stuck on its first version forever. Host-port services deploy
    // sequentially — the previous container goes first.
    const ctx = makeCtx({
      deploymentId: 4,
      service: { slug: 'x', image: 'nginx', port: 80, publishedPort: 8080, cpuShares: 0, memLimitMb: 0, volumeMount: null, healthPath: '/' },
      env: {},
      commitSha: 'abc',
    });

    await dockerBuilder.buildAndRun(ctx as never, { runtimeId: 'x-3', port: 80, healthPath: '/' } as never);

    const argvs = h.run.mock.calls.map((c) => c[1] as unknown as string[]);
    const rmPrevIdx = argvs.findIndex((a) => a[0] === 'rm' && a[1] === '-f' && a[2] === 'x-3');
    const runIdx = argvs.findIndex((a) => a[0] === 'run');
    expect(rmPrevIdx).toBeGreaterThanOrEqual(0);
    expect(runIdx).toBeGreaterThan(rmPrevIdx);
    expect(argvs[runIdx]!).toContain('-p');
  });

  it('does NOT retire the previous runtime for non-host-port (Traefik-routed) services', async () => {
    // Blue-green must keep working for the normal Traefik-routed path.
    const ctx = makeCtx({
      deploymentId: 4,
      service: { slug: 'x', image: 'nginx', port: 80, publishedPort: null, cpuShares: 0, memLimitMb: 0, volumeMount: null, healthPath: '/' },
      env: {},
      commitSha: 'abc',
    });

    await dockerBuilder.buildAndRun(ctx as never, { runtimeId: 'x-3', port: 80, healthPath: '/' } as never);

    const argvs = h.run.mock.calls.map((c) => c[1] as unknown as string[]);
    expect(argvs.some((a) => a[0] === 'rm' && a[1] === '-f' && a[2] === 'x-3')).toBe(false);
  });

  it('defaults the returned healthPath to / when the service has none', async () => {
    const ctx = makeCtx({
      service: { slug: 'y', image: 'busybox', port: null, cpuShares: 0, memLimitMb: 0, volumeMount: null, healthPath: null },
      env: {},
    });

    const runtime = await dockerBuilder.buildAndRun(ctx as never);

    expect(runtime).toEqual({ runtimeId: 'y-3', port: null, healthPath: '/', imageDigest: expect.any(String) });
  });

  it('does NOT stop the previous container (blue-green: old keeps serving until healthy)', async () => {
    const ctx = makeCtx();

    await dockerBuilder.buildAndRun(ctx as never, { runtimeId: 'old-1', port: null, healthPath: '/' });

    // Only build + run are invoked — never `docker stop`/`rm` against the old container.
    const stops = h.run.mock.calls.filter((c) => (c[1] as unknown[])[1] === 'stop' || (c[1] as unknown[])[1] === 'rm');
    expect(stops).toHaveLength(0);
  });

  it('publishes no host port during blue-green (containers are probed on the network)', async () => {
    const ctx = makeCtx(); // port 3000

    await dockerBuilder.buildAndRun(
      ctx as never,
      { runtimeId: 'old-1', port: 3000, healthPath: '/' }, // previous still serving
    );

    const runArgs = h.run.mock.calls.find((c) => (c[1] as unknown[])[0] === 'run')![1] as unknown[];
    // Two versions can run side by side only because NEITHER claims a host port.
    expect(runArgs).not.toContain('-p');
    expect(String(runArgs)).not.toContain('127.0.0.1');
  });

  it('deletes the env-file even when docker run fails', async () => {
    h.run
      .mockRejectedValueOnce(new Error('pull failed'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('name conflict'));
    const ctx = makeCtx({ service: { slug: 'web', image: 'nginx:1.25', port: 3000, cpuShares: 0, memLimitMb: 0, volumeMount: null, healthPath: '/health' } });

    await expect(dockerBuilder.buildAndRun(ctx as never)).rejects.toThrow('name conflict');

    const runArgs = h.run.mock.calls.at(-1)![1] as unknown[];
    const file = envFilePath(runArgs);
    expect(file).toBeTruthy();
    expect(existsSync(file)).toBe(false);
  });

  it('tolerates a failing digest inspect (imageDigest left undefined)', async () => {
    h.capture.mockImplementation(async (_cmd: string, args: string[]) => {
      const argv = args as string[];
      if (argv[0] === 'network' && argv[1] === 'ls') return 'nd-svc-web';
      if (argv[0] === 'inspect' && argv[1] === 'ninedeploy-traefik') return '{"nd-svc-web":{}}';
      throw new Error('inspect failed');
    });
    const ctx = makeCtx({ service: { slug: 'web', image: 'nginx:1.25', port: 3000, cpuShares: 0, memLimitMb: 0, volumeMount: null, healthPath: '/health' } });

    const runtime = await dockerBuilder.buildAndRun(ctx as never);

    expect(runtime.imageDigest).toBeUndefined();
  });

  it('leaves imageDigest undefined when inspect returns an empty value', async () => {
    h.capture.mockResolvedValue('   ');
    const ctx = makeCtx({ service: { slug: 'web', image: 'nginx:1.25', port: 3000, cpuShares: 0, memLimitMb: 0, volumeMount: null, healthPath: '/health' } });

    const runtime = await dockerBuilder.buildAndRun(ctx as never);

    expect(runtime.imageDigest).toBeUndefined();
  });

  it('uses the imageDigest override (rollback pin) instead of the mutable tag', async () => {
    h.capture.mockResolvedValue('sha256:pinned');
    const ctx = makeCtx({
      service: { slug: 'web', image: 'nginx:1.25', port: 3000, cpuShares: 0, memLimitMb: 0, volumeMount: null, healthPath: '/health' },
      imageDigest: 'nginx:1.25@sha256:abc123',
    });

    await dockerBuilder.buildAndRun(ctx as never);

    // The run target is the pinned digest, not the tag.
    const runArgs = h.run.mock.calls.at(-1)![1] as unknown[];
    expect(runArgs[runArgs.length - 1]).toBe('nginx:1.25@sha256:abc123');
  });
  it('auto falls back to nixpacks when the repo has no Dockerfile', async () => {
    h2.exists.mockReturnValue(false); // Dockerfile-less repo (e.g. plain Next.js)
    const ctx = makeCtx({ buildConfig: undefined });

    await dockerBuilder.buildAndRun(ctx as never);

    const nix = h.run.mock.calls.find((c) => c[0] === 'nixpacks');
    expect(nix).toBeDefined();
    expect(nix![1]).toEqual(['build', '.', '--name', 'ninedeploy/web:abcdef1', '--env', 'NODE_ENV=production']);
    expect(nix![2]).toEqual({
      cwd: '/work/web',
      heartbeatMs: 20_000,
      heartbeatLabel: 'Building ninedeploy/web:abcdef1 with Nixpacks',
    });
    // docker build was never invoked — nixpacks produced the image itself.
    expect(h.run.mock.calls.some((c) => c[0] === 'docker' && c[1][0] === 'build')).toBe(false);
  });

  it('injects panel env into the nixpacks build so NEXT_PUBLIC_* is inlined at build time', async () => {
    h2.exists.mockReturnValue(false);
    const ctx = makeCtx({
      buildConfig: { buildPack: 'nixpacks', baseDir: '/' },
      env: { NEXT_PUBLIC_API_URL: 'https://api.example.com', DATABASE_URL: 'postgres://u:secret@db:5432/app' },
    });

    await dockerBuilder.buildAndRun(ctx as never);

    const nixArgs = h.run.mock.calls.find((c) => c[0] === 'nixpacks')![1] as unknown[];
    // Repeatable --env KEY=VALUE pairs — nixpacks has no env-file option.
    expect(nixArgs).toEqual(expect.arrayContaining([
      '--env', 'NEXT_PUBLIC_API_URL=https://api.example.com',
      '--env', 'DATABASE_URL=postgres://u:secret@db:5432/app',
    ]));
    // The deploy log announces the injection but never echoes a value.
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('Injecting 2 environment variable(s)'));
    for (const line of ctx.log.mock.calls.flat()) {
      expect(line).not.toContain('secret');
    }
  });

  it('adds no --env args to nixpacks when the service has no environment', async () => {
    h2.exists.mockReturnValue(false);
    const ctx = makeCtx({ buildConfig: { buildPack: 'nixpacks' }, env: {} });

    await dockerBuilder.buildAndRun(ctx as never);

    const nixArgs = h.run.mock.calls.find((c) => c[0] === 'nixpacks')![1] as unknown[];
    expect(nixArgs).not.toContain('--env');
  });

  it('nixpacksEnvArgs escapes newlines like the runtime env-file and survives values containing =', () => {
    expect(nixpacksEnvArgs({ MULTI: 'line-1\nline-2', B64: 'YQ==', CRLF: 'a\r\nb' })).toEqual([
      '--env', 'MULTI=line-1\\nline-2',
      '--env', 'B64=YQ==',
      '--env', 'CRLF=a\\nb',
    ]);
    expect(nixpacksEnvArgs({})).toEqual([]);
  });

  it('explicit nixpacks buildPack wins even when a Dockerfile exists', async () => {
    h2.exists.mockReturnValue(true);
    const ctx = makeCtx({ buildConfig: { buildPack: 'nixpacks', baseDir: '/' } });

    await dockerBuilder.buildAndRun(ctx as never);

    const nix = h.run.mock.calls.find((c) => c[0] === 'nixpacks');
    expect(nix).toBeDefined();
    expect(h.run.mock.calls.some((c) => c[0] === 'docker' && c[1][0] === 'build')).toBe(false);
  });

  it('passes custom install/build/start commands and baseDir to nixpacks', async () => {
    h2.exists.mockReturnValue(false);
    const ctx = makeCtx({ buildConfig: { buildPack: 'nixpacks', baseDir: '/app', installCmd: 'pnpm install --frozen-lockfile', buildCmd: 'pnpm build', startCmd: 'pnpm start' } });

    await dockerBuilder.buildAndRun(ctx as never);

    const nix = h.run.mock.calls.find((c) => c[0] === 'nixpacks');
    expect(nix![1].join(' ')).toBe(
      // baseDir '/app' is re-anchored to 'app' (repo-root convention, L-13).
      // The service env rides along as repeatable --env pairs.
      'build app --name ninedeploy/web:abcdef1 --install-cmd pnpm install --frozen-lockfile --build-cmd pnpm build --start-cmd pnpm start --env NODE_ENV=production',
    );
  });

  it('fails with an actionable installer instruction when the Nixpacks CLI is missing', async () => {
    h2.exists.mockReturnValue(false);
    h.capture.mockRejectedValueOnce(new Error('ENOENT'));
    const ctx = makeCtx({ buildConfig: { buildPack: 'nixpacks' } });

    await expect(dockerBuilder.buildAndRun(ctx as never)).rejects.toThrow(
      'Re-run the NineDeploy installer to provision the checksum-verified source build tool',
    );
    expect(h.run.mock.calls.some((c) => c[1]?.includes('ghcr.io/railwayapp/nixpacks:latest'))).toBe(false);
  });

  it('never removes the already-finalized runtime when replaying its deployment id', async () => {
    const ctx = makeCtx({ service: { slug: 'web', image: 'nginx:1.25', port: 3000, cpuShares: 0, memLimitMb: 0, volumeMount: null, healthPath: '/' } });
    await dockerBuilder.buildAndRun(ctx as never, { runtimeId: 'web-3', port: 3000, healthPath: '/' });
    expect(h.run.mock.calls.some((call) => {
      const args = call[1] as unknown[];
      return args[0] === 'rm' && args.includes('web-3');
    })).toBe(false);
  });
});

describe('dockerBuilder.isHealthy', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    h2.reset();
    h.capture.mockReset();
    // Default: container is running with a network IP.
    h.capture.mockResolvedValue('running|172.17.0.2');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when there is no port but the container is running', async () => {
    await expect(
      dockerBuilder.isHealthy({ runtimeId: 'r', port: null, healthPath: '/' }, 1000),
    ).resolves.toBe(true);
    expect(h.capture).toHaveBeenCalledWith('docker', [
      'inspect', 'r',
      '--format', '{{.State.Status}}|{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns false when the container is not running (regardless of port)', async () => {
    h.capture.mockResolvedValue('exited|172.17.0.2');
    await expect(
      dockerBuilder.isHealthy({ runtimeId: 'r', port: 3000, healthPath: '/' }, 20),
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails an exited container early and includes redacted runtime logs', async () => {
    h.capture.mockImplementation(async (_cmd: string, args: string[]) => {
      const format = args.at(-1);
      if (format === '{{.State.Status}}|{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}') return 'exited|';
      if (format === '{{json .State}}') return JSON.stringify({ Status: 'exited', ExitCode: 1, OOMKilled: false, Error: '' });
      return '';
    });
    // `docker logs` runs through `run` with a sink so BOTH streams (an app
    // crashing usually writes its reason to stderr) reach the diagnostic.
    h.run.mockImplementation(async (_cmd: string, args: string[], _opts: unknown, sink?: (line: string) => void) => {
      if (args[0] === 'logs') {
        sink?.('database password=super-secret');
        sink?.('connect ECONNREFUSED 3306');
      }
    });
    const log = vi.fn();

    await expect(
      dockerBuilder.isHealthy({ runtimeId: 'ghost-17', port: 2368, healthPath: '/' }, 60_000, 0, log),
    ).resolves.toBe(false);

    expect(log).toHaveBeenCalledWith('container ghost-17 is exited (exit 1)');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('connect ECONNREFUSED 3306'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('password=[REDACTED]'));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('super-secret'));
  });

  it('returns false when the container has no network IP (not on the network yet)', async () => {
    h.capture.mockResolvedValue('running|');
    await expect(
      dockerBuilder.isHealthy({ runtimeId: 'r', port: 3000, healthPath: '/' }, 20),
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns false when the container cannot be inspected (already removed)', async () => {
    h.capture.mockRejectedValue(new Error('No such container'));
    await expect(
      dockerBuilder.isHealthy({ runtimeId: 'gone', port: null, healthPath: '/' }, 20),
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to a sibling-container probe when direct IP probing fails (Docker Desktop)', async () => {
    // Direct fetch never succeeds (macOS-style unreachable container IP)…
    fetchMock.mockRejectedValue(new Error('unreachable'));
    // …but after the direct grace window the busybox TCP sibling probe succeeds.
    h.run.mockImplementation(async () => undefined);

    await expect(
      dockerBuilder.isHealthy({ runtimeId: 'r', port: 3000, healthPath: '/x' }, 5_000, 100),
    ).resolves.toBe(true);

    const siblingCall = h.run.mock.calls.find((c) => c[1][0] === 'exec' && c[1].includes('ninedeploy-prober'));
    expect(siblingCall).toBeDefined();
    // TCP probe by the inspected IP, not the (DNS-flaky) container name.
    expect(siblingCall![1].join(' ')).toContain('nc -w 3 172.17.0.2 3000');
  });

  it('joins the probe container to the runtime bridge before sibling probing (Model B isolation)', async () => {
    fetchMock.mockRejectedValue(new Error('unreachable'));
    h.run.mockReset();
    h.run.mockImplementation(async () => undefined);
    h.capture.mockImplementation(async (_cmd: string, args: string[]) => {
      const argv = args as string[];
      const format = argv.at(-1);
      if (argv[0] === 'inspect' && argv[1] === 'ninedeploy-prober') {
        return format === '{{json .NetworkSettings.Networks}}'
          ? '{"ninedeploy":{}}'
          : 'true|{"ninedeploy":{}}';
      }
      if (argv[0] === 'inspect' && argv[1] === 'web-3') {
        return format === '{{json .NetworkSettings.Networks}}'
          ? '{"nd-svc-web":{}}'
          : 'running|172.19.0.2';
      }
      return 'running|172.19.0.2';
    });

    await expect(
      dockerBuilder.isHealthy({ runtimeId: 'web-3', port: 8055, healthPath: '/' }, 5_000, 0, vi.fn()),
    ).resolves.toBe(true);

    // The prober sits on the shared mesh; the runtime is on its own bridge.
    // Without `network connect` the nc probe is dropped by Docker's
    // inter-bridge isolation and a healthy app never becomes "ready".
    expect(h.run.mock.calls.some((c) => {
      const a = c[1] as string[];
      return a[0] === 'network' && a[1] === 'connect' && a[2] === 'nd-svc-web' && a[3] === 'ninedeploy-prober';
    })).toBe(true);
  });

  it('skips joining networks the probe container is already on', async () => {
    fetchMock.mockRejectedValue(new Error('unreachable'));
    h.run.mockReset();
    h.run.mockImplementation(async () => undefined);
    h.capture.mockImplementation(async (_cmd: string, args: string[]) => {
      const argv = args as string[];
      const format = argv.at(-1);
      if (argv[0] === 'inspect' && argv[1] === 'ninedeploy-prober') {
        return format === '{{json .NetworkSettings.Networks}}'
          ? '{"ninedeploy":{},"nd-svc-web":{}}'
          : 'true|{"ninedeploy":{},"nd-svc-web":{}}';
      }
      if (argv[0] === 'inspect' && argv[1] === 'web-3') {
        return format === '{{json .NetworkSettings.Networks}}'
          ? '{"nd-svc-web":{}}'
          : 'running|172.19.0.2';
      }
      return 'running|172.19.0.2';
    });

    await expect(
      dockerBuilder.isHealthy({ runtimeId: 'web-3', port: 8055, healthPath: '/' }, 5_000, 0, vi.fn()),
    ).resolves.toBe(true);

    expect(h.run.mock.calls.some((c) => (c[1] as string[])[0] === 'network')).toBe(false);
  });

  it('logs the probe topology once when the sibling probe keeps failing', async () => {
    fetchMock.mockRejectedValue(new Error('unreachable'));
    h.run.mockReset();
    h.run.mockImplementation(async (_cmd: string, args: string[]) => {
      if ((args as string[])[0] === 'exec') throw new Error('nc: timeout');
    });
    const log = vi.fn();
    h.capture.mockImplementation(async (_cmd: string, args: string[]) => {
      const argv = args as string[];
      const format = argv.at(-1);
      if (argv[0] === 'inspect' && argv[1] === 'ninedeploy-prober') {
        return format === '{{json .NetworkSettings.Networks}}' ? '{"ninedeploy":{}}' : 'true|{"ninedeploy":{}}';
      }
      if (argv[0] === 'inspect' && argv[1] === 'web-3') {
        return format === '{{json .NetworkSettings.Networks}}' ? '{"nd-svc-web":{}}' : 'running|172.19.0.2';
      }
      return 'running|172.19.0.2';
    });

    await expect(
      dockerBuilder.isHealthy({ runtimeId: 'web-3', port: 8055, healthPath: '/' }, 1_500, 0, log),
    ).resolves.toBe(false);

    const topologyLines = log.mock.calls.filter((c) => String(c[0]).includes('sibling probe: container'));
    expect(topologyLines).toHaveLength(1);
    expect(String(topologyLines[0]![0])).toContain('nd-svc-web');
  });

  it('repairs an incorrect configured port from image exposed-port metadata', async () => {
    fetchMock.mockRejectedValue(new Error('unreachable'));
    h.capture.mockImplementation(async (_cmd: string, args: string[]) =>
      args[3]?.includes('.Config.ExposedPorts')
        ? '{"5678/tcp":{}}'
        : 'running|172.18.0.4');
    h.run.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.at(-1) === '80') throw new Error('connection refused');
    });
    const runtime = { runtimeId: 'n8n-1', port: 80, healthPath: '/' };
    const log = vi.fn();

    await expect(dockerBuilder.isHealthy(runtime, 1_500, 0, log)).resolves.toBe(true);

    expect(runtime.port).toBe(5678);
    expect(log).toHaveBeenCalledWith('detected healthy image port 5678/tcp; replacing incorrect configured port 80');
    expect(h.run.mock.calls.some((call) => call[1].at(-1) === '5678')).toBe(true);
  });

  it('logs the sibling probe failure reason and formats non-Error rejections', async () => {
    fetchMock.mockRejectedValue(new Error('unreachable'));
    const log = vi.fn();
    h.run.mockImplementation(async () => { throw new Error('nc: connection refused'); });
    await expect(
      dockerBuilder.isHealthy({ runtimeId: 'r', port: 3000, healthPath: '/' }, 1_000, 0, log),
    ).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('nc: connection refused'));

    // Non-Error rejections are stringified, not crashed on .message.
    h.run.mockImplementation(async () => { throw 'plain failure'; });
    await expect(
      dockerBuilder.isHealthy({ runtimeId: 'r', port: 3000, healthPath: '/' }, 500, 0, log),
    ).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('plain failure'));
  });

  it('stays unhealthy when both direct and sibling probes fail', async () => {
    fetchMock.mockRejectedValue(new Error('unreachable'));
    h.run.mockImplementation(async () => { throw new Error('nc: connection refused'); });

    await expect(
      dockerBuilder.isHealthy({ runtimeId: 'r', port: 3000, healthPath: '/' }, 1_500, 100),
    ).resolves.toBe(false);
  });

  it('returns true when the healthcheck responds below 500', async () => {
    fetchMock.mockResolvedValue({ status: 200 });

    await expect(
      dockerBuilder.isHealthy({ runtimeId: 'r', port: 3000, healthPath: '/health' }, 1000),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith('http://172.17.0.2:3000/health', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('uses "/" as the default health path', async () => {
    fetchMock.mockResolvedValue({ status: 200 });

    await dockerBuilder.isHealthy({ runtimeId: 'r', port: 3000, healthPath: '' }, 1000);

    expect(fetchMock).toHaveBeenCalledWith('http://172.17.0.2:3000/', expect.any(Object));
  });

  it('returns false when the service never becomes healthy', async () => {
    fetchMock.mockResolvedValue({ status: 503 });

    await expect(
      dockerBuilder.isHealthy({ runtimeId: 'r', port: 3000, healthPath: '/' }, 20),
    ).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalled();
    expect(h.sleep).toHaveBeenCalledWith(1000);
  });

  it('returns false when the fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));

    await expect(
      dockerBuilder.isHealthy({ runtimeId: 'r', port: 3000, healthPath: '/' }, 20),
    ).resolves.toBe(false);
  });

  it('treats a container that vanishes mid-probe as unhealthy', async () => {
    // First inspect resolves an IP (so we proceed to fetch), then it disappears.
    h.capture.mockResolvedValueOnce('running|172.17.0.2').mockResolvedValueOnce('');
    fetchMock.mockRejectedValue(new Error('refused'));

    await expect(
      dockerBuilder.isHealthy({ runtimeId: 'r', port: 3000, healthPath: '/' }, 20),
    ).resolves.toBe(false);
  });
});

describe('containerExposedTcpPorts', () => {
  it('parses, deduplicates and sorts valid TCP ports', async () => {
    h.capture.mockResolvedValue('{"8080/tcp":{},"53/udp":{},"443/tcp":{}}');
    await expect(containerExposedTcpPorts('app')).resolves.toEqual([443, 8080]);
  });

  it('returns an empty list for absent or malformed metadata', async () => {
    h.capture.mockResolvedValueOnce('null').mockResolvedValueOnce('not-json');
    await expect(containerExposedTcpPorts('app')).resolves.toEqual([]);
    await expect(containerExposedTcpPorts('app')).resolves.toEqual([]);
  });
});

describe('dockerBuilder.stop', () => {
  beforeEach(() => {
    h2.reset();
    h.run.mockReset();
    // Mirror the real exec.run default: it invokes the sink (here `swallow`).
    h.run.mockImplementation(async (_c, _a, _o, sink) => {
      sink?.('');
    });
  });

  it('stops and removes the container', async () => {
    await dockerBuilder.stop('web-3');

    expect(h.run).toHaveBeenCalledWith('docker', ['stop', '-t', '5', 'web-3'], {}, expect.any(Function));
    expect(h.run).toHaveBeenCalledWith('docker', ['rm', '-f', 'web-3'], {}, expect.any(Function));
  });

  it('uses the configured stop grace period', async () => {
    await dockerBuilder.stop('web-3', { graceSeconds: 30 });
    expect(h.run).toHaveBeenCalledWith('docker', ['stop', '-t', '30', 'web-3'], {}, expect.any(Function));
  });

  it('clamps and rejects bogus grace values', async () => {
    await dockerBuilder.stop('web-3', { graceSeconds: 9999 });
    expect(h.run).toHaveBeenCalledWith('docker', ['stop', '-t', '300', 'web-3'], {}, expect.any(Function));
    await dockerBuilder.stop('web-3', { graceSeconds: -1 });
    expect(h.run).toHaveBeenCalledWith('docker', ['stop', '-t', '5', 'web-3'], {}, expect.any(Function));
  });

  it('swallows errors from both commands', async () => {
    h.run.mockRejectedValueOnce(new Error('gone')).mockRejectedValueOnce(new Error('gone'));

    await expect(dockerBuilder.stop('web-3')).resolves.toBeUndefined();
  });
});

describe('dockerBuilder registry auth', () => {
  beforeEach(() => {
    h2.reset();
    h.run.mockReset();
    // Keep the sink invocation (mirrors the real run) so no-op log drains run.
    h.run.mockImplementation(async (_c: string, _a: unknown[], _o: unknown, sink?: (line: string) => void) => {
      sink?.('');
    });
    h.capture.mockReset();
    h.capture.mockResolvedValue('running');
    spawnMocks.spawn.mockClear();
    spawnMocks.child.stdin.write.mockClear();
    spawnMocks.handlers.length = 0;
    spawnMocks.child.on.mockImplementation((ev: string, cb: (code: number | null) => void) => {
      if (ev === 'exit') spawnMocks.handlers.push({ ev, cb });
    });
    spawnMocks.child.stdin.on.mockImplementation((ev: string, cb: (err?: Error) => void) => {
      if (ev === 'error') spawnMocks.stdinHandlers.push({ ev, cb });
    });
  });

  it('logs in and out around a private-registry pull (password via stdin)', async () => {
    // A successful login exit fires as soon as the handler registers.
    spawnMocks.child.on.mockImplementation((ev: string, cb: (code: number | null) => void) => {
      if (ev === 'exit') queueMicrotask(() => cb(0));
    });

    await dockerBuilder.buildAndRun(
      makeCtx({
        service: { slug: 'web', image: 'ghcr.io/acme/app:1', port: 3000, cpuShares: 0, memLimitMb: 0, healthPath: '/' },
        registryAuth: { username: 'u', password: 'p', server: 'ghcr.io' },
      }) as never,
    );

    // Env is isolated (same allowlist as the exec layer) so host secrets
    // never leak into the login child.
    expect(spawnMocks.spawn).toHaveBeenCalledWith('docker', ['login', '--username', 'u', '--password-stdin', 'ghcr.io'], { env: expect.any(Object) });
    // The password traveled over stdin, never argv.
    expect(spawnMocks.child.stdin.write).toHaveBeenCalledWith('p\n');
    // Logout after the pull.
    const logoutCall = h.run.mock.calls.find((c) => (c[1] as string[])[0] === 'logout');
    expect(logoutCall).toBeTruthy();
    expect((logoutCall![1] as string[])).toContain('ghcr.io');
    spawnMocks.child.on.mockImplementation((ev: string, cb: (code: number | null) => void) => {
      if (ev === 'exit') spawnMocks.handlers.push({ ev, cb });
    });
  });

  it('fails the build when docker login exits non-zero', async () => {
    spawnMocks.child.on.mockImplementation((ev: string, cb: (code: number | null) => void) => {
      if (ev === 'exit') queueMicrotask(() => cb(1));
    });
    await expect(
      dockerBuilder.buildAndRun(
        makeCtx({
          service: { slug: 'web', image: 'ghcr.io/acme/app:1', port: 3000, cpuShares: 0, memLimitMb: 0, healthPath: '/' },
          registryAuth: { username: 'u', password: 'p' },
        }) as never,
      ),
    ).rejects.toThrow('docker login failed');
    spawnMocks.child.on.mockImplementation((ev: string, cb: (code: number | null) => void) => {
      if (ev === 'exit') spawnMocks.handlers.push({ ev, cb });
    });
  });

  it('propagates spawn errors from docker login', async () => {
    spawnMocks.child.on.mockImplementation((ev: string, cb: (code: number | null) => void) => {
      if (ev === 'error') queueMicrotask(() => cb(new Error('ENOENT') as never));
    });
    await expect(
      dockerBuilder.buildAndRun(
        makeCtx({
          service: { slug: 'web', image: 'ghcr.io/acme/app:1', port: 3000, cpuShares: 0, memLimitMb: 0, healthPath: '/' },
          registryAuth: { username: 'u', password: 'p' },
        }) as never,
      ),
    ).rejects.toThrow();
    spawnMocks.child.on.mockImplementation((ev: string, cb: (code: number | null) => void) => {
      if (ev === 'exit') spawnMocks.handlers.push({ ev, cb });
    });
  });

  it('tolerates an EPIPE on the login stdin', async () => {
    spawnMocks.child.on.mockImplementation((ev: string, cb: (code: number | null) => void) => {
      if (ev === 'exit') queueMicrotask(() => cb(0));
    });
    // Fire the stdin error handler as soon as it registers (EPIPE race).
    spawnMocks.child.stdin.on.mockImplementation((ev: string, cb: (err?: Error) => void) => {
      if (ev === 'error') queueMicrotask(() => cb(new Error('EPIPE')));
    });
    await dockerBuilder.buildAndRun(
      makeCtx({
        service: { slug: 'web', image: 'ghcr.io/acme/app:1', port: 3000, cpuShares: 0, memLimitMb: 0, healthPath: '/' },
        registryAuth: { username: 'u', password: 'p' },
      }) as never,
    );
    expect(spawnMocks.child.stdin.on).toHaveBeenCalledWith('error', expect.any(Function));
    spawnMocks.child.on.mockImplementation((ev: string, cb: (code: number | null) => void) => {
      if (ev === 'exit') spawnMocks.handlers.push({ ev, cb });
    });
  });

  it('skips login entirely without registryAuth', async () => {
    await dockerBuilder.buildAndRun(
      makeCtx({ service: { slug: 'web', image: 'nginx:latest', port: 80, cpuShares: 0, memLimitMb: 0, healthPath: '/' } }) as never,
    );
    expect(spawnMocks.spawn).not.toHaveBeenCalled();
    expect(h.run.mock.calls.some((c) => (c[1] as string[])[0] === 'logout')).toBe(false);
  });
});

describe('dockerBuilder.buildAndRun — static build pack', () => {
  beforeEach(() => {
    h.run.mockReset();
    h.run.mockResolvedValue(undefined);
    h.capture.mockReset();
    h.capture.mockImplementation(async (_cmd: string, args: string[]) => {
      const argv = args as string[];
      if (argv[0] === 'network' && argv[1] === 'ls') return 'nd-svc-web';
      if (argv[0] === 'inspect' && argv[1] === 'ninedeploy-traefik') return '{"nd-svc-web":{}}';
      return 'running';
    });
  });

  it('runs the host build commands and ships the output via nginx:alpine', async () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'nd-static-builder-'));
    try {
      const dist = path.join(workDir, 'dist');
      mkdirSync(dist, { recursive: true });
      writeFileSync(path.join(dist, 'index.html'), '<html></html>');
      h2.bind(require('node:fs'));

      const ctx = makeCtx({
        service: { slug: 'web', image: null, port: 3000, repoUrl: 'https://github.com/acme/web', healthPath: '/', cpuShares: 0, memLimitMb: 0 },
        workDir,
        buildConfig: { buildPack: 'static', baseDir: '/', installCmd: 'npm ci', buildCmd: 'npm run build', outputDir: 'dist', staticSpa: true },
      });

      await dockerBuilder.buildAndRun(ctx as never);

      // Host build commands ran, in order: install then build.
      console.log('DEBUG RUN-CMDS', h.run.mock.calls.map((c) => [c[0], (c[1] as string[] | undefined)?.[0]]));
      const shCalls = h.run.mock.calls.filter((c) => c[0] === 'sh');
      expect(shCalls.map((c) => (c[1] as string[])[1])).toEqual(['npm ci', 'npm run build']);
      // The image was built from the generated per-deploy Dockerfile.
      expect(h.run.mock.calls.some((c) => (c[1] as string[]).includes('-f') && (c[1] as string[]).includes('Dockerfile.static'))).toBe(true);
      // The generated conf carries SPA fallback.
      expect(h2.exists(path.join(workDir, 'nginx-static.conf'))).toBe(true);
      expect(readFileSync(path.join(workDir, 'nginx-static.conf'), 'utf8')).toContain('/index.html');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('refuses an output dir that escapes the build context', async () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'nd-static-escape-'));
    try {
      const ctx = makeCtx({
        service: { slug: 'web', image: null, port: 3000, repoUrl: 'https://github.com/acme/web', healthPath: '/', cpuShares: 0, memLimitMb: 0 },
        workDir,
        buildConfig: { buildPack: 'static', baseDir: '/', installCmd: 'echo ok', buildCmd: 'echo skip', outputDir: '../../etc' },
      });

      await expect(dockerBuilder.buildAndRun(ctx as never)).rejects.toThrow('escapes the build context');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('fails with a clear hint when the static build command is missing', async () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'nd-static-nobuild-'));
    try {
      const ctx = makeCtx({
        service: { slug: 'web', image: null, port: 3000, repoUrl: 'https://github.com/acme/web', healthPath: '/', cpuShares: 0, memLimitMb: 0 },
        workDir,
        buildConfig: { buildPack: 'static', baseDir: '/' },
      });

      await expect(dockerBuilder.buildAndRun(ctx as never)).rejects.toThrow('requires a build command');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
