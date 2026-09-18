import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3BuildCache } from '../../src/kernel/drivers/s3BuildCache.js';

// r019: a faithful mini-S3 for the operations the driver actually issues.
//   PUT  — stores the body by object key. Real S3 keeps metadata headers
//          only when the CLIENT sends them; s3Request() cannot send any,
//          so driver-stored objects carry NO x-amz-meta-* headers.
//   GET  — returns the stored body or 404.
//   HEAD — mirrors the on-bucket truth: 200 with no metadata, or 404.
// The previous fake fabricated x-amz-meta-ninedeploy-* headers on HEAD —
// a state store() can never produce — which masked the fact that
// store→lookup round-trips always missed (r019).
interface MiniS3 {
  calls: Array<{ method: string; path: string }>;
  restore: () => void;
}

/** Status the fake answers PUTs with (tests flip it to simulate a denied upload). */
const miniS3 = { putStatus: 200 };

function installMiniS3(): MiniS3 {
  miniS3.putStatus = 200;
  const objects = new Map<string, Buffer>();
  const calls: Array<{ method: string; path: string }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: { method?: string; body?: unknown }) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = new URL(url.toString()).pathname;
    calls.push({ method, path });
    if (method === 'PUT') {
      const raw = (init as { body?: Uint8Array } | undefined)?.body;
      if (miniS3.putStatus !== 200) return new Response('AccessDenied', { status: miniS3.putStatus });
      objects.set(path, Buffer.from(raw ?? new Uint8Array()));
      return new Response(null, { status: 200 });
    }
    const entry = objects.get(path);
    if (!entry) return new Response(null, { status: 404 });
    if (method === 'GET') return new Response(entry, { status: 200 });
    if (method === 'HEAD') return new Response(null, { status: 200 });
    return new Response(null, { status: 405 });
  }) as never;
  return {
    calls,
    restore: () => {
      globalThis.fetch = origFetch;
    },
  };
}

let s3: MiniS3;

function newCache(prefix = 'build-cache/'): S3BuildCache {
  return new S3BuildCache({
    config: {
      endpoint: 'https://s3.example.com',
      region: 'us-east-1',
      bucket: 'test-bucket',
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
    },
    prefix,
  });
}

function baseCfg() {
  return {
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: 'test-bucket',
    accessKeyId: 'AKIA',
    secretAccessKey: 'secret',
  };
}

const markerBlob = (digest: string, sizeBytes = 4096): Buffer =>
  Buffer.from(JSON.stringify({ digest, sizeBytes, ts: 0 }));

beforeEach(() => {
  vi.clearAllMocks();
  s3 = installMiniS3();
});

afterEach(() => {
  s3.restore();
  vi.restoreAllMocks();
});

describe('S3BuildCache', () => {
  it('exposes a stable name and starts at zero stats', async () => {
    const cache = newCache();
    expect(cache.name).toBe('s3');
    const stats = await cache.stats();
    expect(stats).toEqual({ entries: 0, totalBytes: 0, hits: 0, misses: 0, stores: 0, evictions: 0 });
  });

  it('records a miss when the object is absent', async () => {
    const cache = newCache();
    const ref = await cache.lookup('ndbuild:abc');
    expect(ref).toBeNull();
    const stats = await cache.stats();
    expect(stats.misses).toBe(1);
  });

  // r019 regression: a store()→lookup() round-trip must HIT. lookup()
  // GETs the marker body and parses the digest — a HEAD demanding
  // x-amz-meta-* headers (which store() can never send) made every
  // round-trip miss and the cache never produced a hit.
  it('resolves the stored digest on a store→lookup round-trip (r019)', async () => {
    const cache = newCache();
    await cache.store('ndbuild:abc', markerBlob('sha256:abc'));
    const ref = await cache.lookup('ndbuild:abc');
    expect(ref).not.toBeNull();
    expect(ref?.digest).toBe('sha256:abc');
    expect(ref?.sizeBytes).toBe(4096);
    const stats = await cache.stats();
    expect(stats.hits).toBe(1);
    // The lookup went back to the same scoped object key.
    expect(s3.calls.some((c) => c.method === 'GET' && c.path.includes('/test-bucket/build-cache/'))).toBe(true);
  });

  it('records a miss when the stored body is not one of our markers (wrong prefix)', async () => {
    const cache = newCache();
    // store() writes whatever body it is given; a non-marker body under
    // the looked-up key (foreign object / wrong prefix) must read as a
    // miss, never as a bogus hit.
    await cache.store('ndbuild:foreign', Buffer.from('an object placed by something else'));
    const ref = await cache.lookup('ndbuild:foreign');
    expect(ref).toBeNull();
  });

  it('uses the configured prefix to scope object keys', async () => {
    const cache = newCache();
    await cache.store('ndbuild:abc', markerBlob('sha256:abc'));
    await cache.lookup('ndbuild:abc');
    expect(s3.calls.length).toBeGreaterThan(0);
    expect(s3.calls.every((c) => c.path.includes('/test-bucket/build-cache/'))).toBe(true);
  });

  it('isolates two operators on the same bucket via the prefix', async () => {
    const a = new S3BuildCache({ config: baseCfg(), prefix: 'team-a/' });
    const b = new S3BuildCache({ config: baseCfg(), prefix: 'team-b/' });
    await a.store('ndbuild:shared', markerBlob('sha256:aaa'));
    await b.store('ndbuild:shared', markerBlob('sha256:bbb'));
    // One shared bucket map, but the prefixes scope the object keys:
    // each operator resolves its OWN digest for the shared cache key.
    expect((await a.lookup('ndbuild:shared'))?.digest).toBe('sha256:aaa');
    expect((await b.lookup('ndbuild:shared'))?.digest).toBe('sha256:bbb');
    expect(s3.calls.some((c) => c.path.includes('/team-a/'))).toBe(true);
    expect(s3.calls.some((c) => c.path.includes('/team-b/'))).toBe(true);
  });

  it('parses a marker blob on store() and surfaces the digest', async () => {
    const cache = newCache();
    const ref = await cache.store('ndbuild:abc', markerBlob('sha256:def'));
    expect(ref.digest).toBe('sha256:def');
    expect(ref.sizeBytes).toBe(4096);
    const stats = await cache.stats();
    expect(stats.stores).toBe(1);
  });

  it('r186: a rejected PUT is an error, never counted as a store', async () => {
    const cache = newCache();
    miniS3.putStatus = 403;
    await expect(cache.store('ndbuild:abc', markerBlob('sha256:def'))).rejects.toThrow(/HTTP 403/);
    expect((await cache.stats()).stores).toBe(0);
  });

  it('falls back to a placeholder digest for non-marker blobs', async () => {
    const cache = newCache();
    const stored = await cache.store('ndbuild:abc', Buffer.from('not a marker'));
    // Default placeholder = content hash of the blob.
    expect(stored.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('aggregates in-process counters in stats()', async () => {
    const cache = newCache();
    await cache.lookup('a'); // miss (absent)
    await cache.store('b', markerBlob('sha256:x'));
    await cache.lookup('b'); // hit
    await cache.store('c', markerBlob('sha256:y'));
    await cache.lookup('c'); // hit
    await cache.store('d', markerBlob('sha256:z')); // store
    const stats = await cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.stores).toBe(3);
  });
});

/**
 * r034. The driver now accepts a SUPPLIER so an operator can save bucket
 * settings in the panel without restarting the kernel. An unconfigured
 * supplier must behave as a cold cache — a build must never fail because its
 * optional cache has no settings yet.
 */
describe('S3BuildCache lazy configuration', () => {
  it('misses without dialling out while the supplier returns null', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const cache = new S3BuildCache({ config: () => null });
    await expect(cache.lookup('ndbuild:a')).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
    await expect(cache.store('ndbuild:a', Buffer.from('{}'))).rejects.toThrow(/no bucket configured/);
    spy.mockRestore();
  });

  it('treats a throwing supplier as unconfigured rather than failing the build', async () => {
    const cache = new S3BuildCache({
      config: () => {
        throw new Error('config centre down');
      },
    });
    await expect(cache.lookup('ndbuild:a')).resolves.toBeNull();
  });

  it('takes the key prefix from the resolved settings, not only the constructor', async () => {
    s3 = installMiniS3();
    const cache = new S3BuildCache({
      config: async () => ({
        endpoint: 'https://s3.example.com',
        region: 'us-east-1',
        bucket: 'test-bucket',
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
        prefix: '/team-b/',
      }),
      prefix: 'ignored/',
    });
    await cache.store('ndbuild:abc', Buffer.from(JSON.stringify({ digest: 'sha256:abc', sizeBytes: 1 })));
    // A leading slash would produce an unreachable `//team-b/...` object key.
    expect(s3.calls.some((c) => c.path.includes('/test-bucket/team-b/'))).toBe(true);
    expect(s3.calls.every((c) => !c.path.includes('//team-b'))).toBe(true);
    s3.restore();
  });
});
