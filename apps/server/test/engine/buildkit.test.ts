import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWithBuildKit, isImageRef } from '../../src/engine/builders/buildkit.js';

interface FakeCache {
  name: string;
  lookup: ReturnType<typeof vi.fn>;
  store: ReturnType<typeof vi.fn>;
  stats: ReturnType<typeof vi.fn>;
}

function newCache(): FakeCache {
  return {
    name: 'inline',
    lookup: vi.fn(),
    store: vi.fn(),
    stats: vi.fn(),
  };
}

const log: (line: string) => void = () => {};

let runMock: ReturnType<typeof vi.fn>;
let captureMock: ReturnType<typeof vi.fn>;
vi.mock('../../src/lib/exec.js', () => ({
  run: (...args: unknown[]) => runMock(...args),
  capture: (...args: unknown[]) => captureMock(...args),
  buildEnv: (extra?: Record<string, string>) => ({ ...(extra ?? {}) }),
}));

beforeEach(() => {
  runMock = vi.fn();
  captureMock = vi.fn();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('buildWithBuildKit', () => {
  // r034: the previous contract emitted `--cache-from=type=registry,ref=empty`
  // when there was nothing to pull from. `empty` is not an image reference, so
  // buildx logged a resolve error on every first build. Omitting the flag is
  // what "no cache-from" actually means to buildx.
  it('omits --cache-from entirely when no cache is registered', async () => {
    runMock.mockResolvedValue(undefined);
    const result = await buildWithBuildKit({
      workDir: '/work',
      dockerfilePath: 'Dockerfile',
      baseDir: '.',
      target: 'myimage:latest',
      serviceId: 1,
      log,
    });
    expect(result.image).toBe('myimage:latest');
    expect(result.cacheKey).toBe('');
    expect(result.cacheHit).toBe(false);
    const args = runMock.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain('--cache-from');
    expect(args).toContain('--cache-to');
    expect(args[args.indexOf('--cache-to') + 1]).toBe('type=inline');
  });

  it('marks cache hit and uses the digest when lookup returns a ref', async () => {
    runMock.mockResolvedValue(undefined);
    captureMock.mockResolvedValue('myimage@sha256:abc');
    const cache = newCache();
    (cache.lookup as ReturnType<typeof vi.fn>).mockResolvedValue({
      digest: 'sha256:abc',
      sizeBytes: 1024,
      storedAt: '2026-08-29T00:00:00.000Z',
    });
    (cache.store as ReturnType<typeof vi.fn>).mockResolvedValue({
      digest: 'sha256:def',
      sizeBytes: 8,
      storedAt: '2026-08-29T00:00:00.000Z',
    });

    const result = await buildWithBuildKit({
      workDir: '/work',
      dockerfilePath: 'Dockerfile',
      baseDir: '.',
      target: 'myimage:latest',
      serviceId: 1,
      cache,
      log,
    });

    expect(result.cacheHit).toBe(true);
    expect(result.imageDigest).toBe('myimage@sha256:abc');
    // r034: a BARE content digest is not a registry reference — buildx cannot
    // resolve `ref=sha256:<hex>` because it names no repository. The hit is
    // still recorded (and reported), the build just runs without --cache-from.
    const args = runMock.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain('--cache-from');
  });

  it('passes a repository-qualified digest through to --cache-from', async () => {
    runMock.mockResolvedValue(undefined);
    captureMock.mockResolvedValue('myimage@sha256:abc');
    const cache = newCache();
    (cache.lookup as ReturnType<typeof vi.fn>).mockResolvedValue({
      digest: 'registry.example.com/ninedeploy/build-cache@sha256:abc',
      sizeBytes: 1024,
      storedAt: '2026-08-29T00:00:00.000Z',
    });
    (cache.store as ReturnType<typeof vi.fn>).mockResolvedValue({
      digest: 'sha256:def',
      sizeBytes: 8,
      storedAt: '2026-08-29T00:00:00.000Z',
    });

    await buildWithBuildKit({
      workDir: '/work',
      dockerfilePath: 'Dockerfile',
      baseDir: '.',
      target: 'myimage:latest',
      serviceId: 1,
      cache,
      log,
    });

    const args = runMock.mock.calls[0]?.[1] as string[];
    expect(args[args.indexOf('--cache-from') + 1]).toBe(
      'type=registry,ref=registry.example.com/ninedeploy/build-cache@sha256:abc',
    );
  });

  it('publishes the real hit / miss / error observation to the event sink', async () => {
    runMock.mockResolvedValue(undefined);
    captureMock.mockResolvedValue('myimage@sha256:abc');

    const miss = newCache();
    (miss.lookup as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (miss.store as ReturnType<typeof vi.fn>).mockResolvedValue({
      digest: 'sha256:def', sizeBytes: 8, storedAt: '2026-08-29T00:00:00.000Z',
    });
    const missEvents: unknown[] = [];
    const missResult = await buildWithBuildKit({
      workDir: '/work', dockerfilePath: 'Dockerfile', baseDir: '.',
      target: 'myimage:latest', serviceId: 7, cache: miss, log,
      onCacheEvent: (e) => missEvents.push(e),
    });
    expect(missEvents).toEqual([
      { kind: 'miss', serviceId: 7, cache: miss.name, key: missResult.cacheKey },
    ]);

    const boom = newCache();
    (boom.lookup as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('registry down'));
    (boom.store as ReturnType<typeof vi.fn>).mockResolvedValue({
      digest: 'sha256:def', sizeBytes: 8, storedAt: '2026-08-29T00:00:00.000Z',
    });
    const errEvents: Array<{ kind: string; reason?: string }> = [];
    await buildWithBuildKit({
      workDir: '/work', dockerfilePath: 'Dockerfile', baseDir: '.',
      target: 'myimage:latest', serviceId: 7, cache: boom, log,
      onCacheEvent: (e) => errEvents.push(e),
    });
    expect(errEvents).toHaveLength(1);
    expect(errEvents[0]?.kind).toBe('error');
    expect(errEvents[0]?.reason).toBe('registry down');
  });

  it('keeps running the build when cache.lookup throws', async () => {
    runMock.mockResolvedValue(undefined);
    const cache = newCache();
    (cache.lookup as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    (cache.store as ReturnType<typeof vi.fn>).mockResolvedValue({
      digest: 'sha256:def',
      sizeBytes: 8,
      storedAt: '2026-08-29T00:00:00.000Z',
    });

    const result = await buildWithBuildKit({
      workDir: '/work',
      dockerfilePath: 'Dockerfile',
      baseDir: '.',
      target: 'myimage:latest',
      serviceId: 1,
      cache,
      log,
    });
    expect(result.cacheHit).toBe(false);
    expect(result.image).toBe('myimage:latest');
  });

  it('keeps the build successful when cache.store throws after a successful run', async () => {
    runMock.mockResolvedValue(undefined);
    const cache = newCache();
    (cache.lookup as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (cache.store as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'));

    const result = await buildWithBuildKit({
      workDir: '/work',
      dockerfilePath: 'Dockerfile',
      baseDir: '.',
      target: 'myimage:latest',
      serviceId: 1,
      cache,
      log,
    });
    expect(result.image).toBe('myimage:latest');
  });

  it('produces a stable cache key for identical inputs', async () => {
    runMock.mockResolvedValue(undefined);
    const cache = newCache();
    (cache.lookup as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (cache.store as ReturnType<typeof vi.fn>).mockResolvedValue({
      digest: 'sha256:def',
      sizeBytes: 8,
      storedAt: '2026-08-29T00:00:00.000Z',
    });
    await buildWithBuildKit({
      workDir: '/work',
      dockerfilePath: 'Dockerfile',
      baseDir: '.',
      target: 'a:latest',
      serviceId: 1,
      cache,
      log,
    });
    await buildWithBuildKit({
      workDir: '/work',
      dockerfilePath: 'Dockerfile',
      baseDir: '.',
      target: 'b:latest',
      serviceId: 1,
      cache,
      log,
    });
    const keys = (cache.lookup as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(keys[0]).toBe(keys[1]);
  });

  it('produces a different cache key when commit changes', async () => {
    runMock.mockResolvedValue(undefined);
    const cache = newCache();
    (cache.lookup as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (cache.store as ReturnType<typeof vi.fn>).mockResolvedValue({
      digest: 'sha256:def',
      sizeBytes: 8,
      storedAt: '2026-08-29T00:00:00.000Z',
    });
    await buildWithBuildKit({
      workDir: '/work',
      dockerfilePath: 'Dockerfile',
      baseDir: '.',
      target: 'a:latest',
      serviceId: 1,
      commitSha: 'aaa',
      cache,
      log,
    });
    await buildWithBuildKit({
      workDir: '/work',
      dockerfilePath: 'Dockerfile',
      baseDir: '.',
      target: 'a:latest',
      serviceId: 1,
      commitSha: 'bbb',
      cache,
      log,
    });
    const keys = (cache.lookup as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('propagates the buildx failure when docker buildx exits non-zero', async () => {
    runMock.mockRejectedValue(new Error('`docker buildx build` exited with code 1'));
    await expect(
      buildWithBuildKit({
        workDir: '/work',
        dockerfilePath: 'Dockerfile',
        baseDir: '.',
        target: 'myimage:latest',
        serviceId: 1,
        log,
      }),
    ).rejects.toThrow(/buildx build/);
  });
});

/**
 * r034. `--cache-from=type=registry,ref=` is resolved by buildx against a
 * registry, so it needs a NAME. Two values used to reach it that never
 * resolve: the literal `empty`, and the bare `sha256:<hex>` that
 * `docker inspect` returns for a `--load`ed image with no RepoDigests.
 */
describe('isImageRef', () => {
  it('accepts references a registry can resolve', () => {
    expect(isImageRef('nginx:1.27')).toBe(true);
    expect(isImageRef('ninedeploy/web:sha-abc')).toBe(true);
    expect(isImageRef('registry.example.com/ninedeploy/cache@sha256:abc')).toBe(true);
    expect(isImageRef('myimage@sha256:deadbeef')).toBe(true);
  });

  it('rejects a bare content digest, which names no repository', () => {
    expect(isImageRef('sha256:abc')).toBe(false);
    expect(isImageRef(`sha256:${'a'.repeat(64)}`)).toBe(false);
    expect(isImageRef('SHA256:ABC')).toBe(false);
  });

  it('is conservative about a registry-with-port reference carrying no tag', () => {
    // `registry.example.com:5000/ninedeploy/web` has a PORT, not a tag. Being
    // unsure here only costs a cache-from we skip, never a wrong argv.
    expect(isImageRef('registry.example.com:5000/ninedeploy/web')).toBe(false);
  });

  it('rejects empty, whitespace-bearing and unnamed values', () => {
    expect(isImageRef('')).toBe(false);
    expect(isImageRef('empty')).toBe(false);
    expect(isImageRef('my image:tag')).toBe(false);
    expect(isImageRef('@sha256:abc')).toBe(false);
  });
});
