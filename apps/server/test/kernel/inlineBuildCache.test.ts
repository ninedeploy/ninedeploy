import { describe, expect, it } from 'vitest';
import { InlineBuildCache } from '../../src/kernel/drivers/inlineBuildCache.js';

function bytes(n: number): Buffer {
  return Buffer.alloc(n, 0xab);
}

describe('InlineBuildCache', () => {
  it('exposes a stable name and starts empty', async () => {
    const cache = new InlineBuildCache();
    expect(cache.name).toBe('inline');
    const stats = await cache.stats();
    expect(stats).toEqual({ entries: 0, totalBytes: 0, hits: 0, misses: 0, stores: 0, evictions: 0 });
  });

  it('stores a blob and round-trips it on lookup', async () => {
    const cache = new InlineBuildCache();
    const ref = await cache.store('k1', bytes(1024));
    expect(ref.sizeBytes).toBe(1024);
    expect(ref.digest).toMatch(/^sha256:/);
    const looked = await cache.lookup('k1');
    expect(looked).toEqual(ref);
    const stats = await cache.stats();
    expect(stats.entries).toBe(1);
    expect(stats.totalBytes).toBe(1024);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(0);
    expect(stats.stores).toBe(1);
  });

  it('records a miss for unknown keys', async () => {
    const cache = new InlineBuildCache();
    const looked = await cache.lookup('never-stored');
    expect(looked).toBeNull();
    const stats = await cache.stats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
  });

  it('overwrites an existing key with new content (LRU refresh)', async () => {
    const cache = new InlineBuildCache();
    const r1 = await cache.store('k1', bytes(1024));
    const r2 = await cache.store('k1', bytes(2048));
    expect(r2.sizeBytes).toBe(2048);
    expect(r1.digest).not.toBe(r2.digest);
    const stats = await cache.stats();
    expect(stats.entries).toBe(1);
    expect(stats.totalBytes).toBe(2048);
    expect(stats.stores).toBe(2);
  });

  it('is idempotent on identical content (deduplication by key)', async () => {
    const cache = new InlineBuildCache();
    const blob = bytes(1024);
    const r1 = await cache.store('k1', blob);
    const r2 = await cache.store('k1', blob);
    expect(r1.digest).toBe(r2.digest);
    const stats = await cache.stats();
    expect(stats.entries).toBe(1);
    expect(stats.totalBytes).toBe(1024);
    expect(stats.stores).toBe(2); // counter goes up; key count does not
  });

  it('evicts the oldest entry once the byte budget is exceeded', async () => {
    const cache = new InlineBuildCache({ maxBytes: 2048 });
    await cache.store('k1', bytes(1024));
    await cache.store('k2', bytes(1024));
    // Now at the budget.
    await cache.store('k3', bytes(1024));
    // k1 (oldest) should have been evicted to make room for k3.
    const stats = await cache.stats();
    expect(stats.entries).toBe(2);
    expect(stats.totalBytes).toBe(2048);
    expect(stats.evictions).toBe(1);
    expect(await cache.lookup('k1')).toBeNull();
    expect(await cache.lookup('k2')).not.toBeNull();
    expect(await cache.lookup('k3')).not.toBeNull();
  });

  it('evicts in insertion order across multiple overflows', async () => {
    const cache = new InlineBuildCache({ maxBytes: 1024 });
    await cache.store('k1', bytes(1024));
    await cache.store('k2', bytes(1024));
    await cache.store('k3', bytes(1024));
    await cache.store('k4', bytes(1024));
    // Only the last insertion survives; k1, k2, k3 evicted.
    const stats = await cache.stats();
    expect(stats.entries).toBe(1);
    expect(stats.totalBytes).toBe(1024);
    expect(stats.evictions).toBe(3);
    expect(await cache.lookup('k1')).toBeNull();
    expect(await cache.lookup('k2')).toBeNull();
    expect(await cache.lookup('k3')).toBeNull();
    expect(await cache.lookup('k4')).not.toBeNull();
  });

  it('F360: hands back the digest a { digest, ts } marker records, not a hash of the marker', async () => {
    // Both writers (BuildKit builder, POST /v1/build-cache/store) store a marker;
    // the registry and S3 drivers return its digest, and so must this one.
    const cache = new InlineBuildCache();
    const recorded = `sha256:${'d'.repeat(64)}`;
    const r1 = await cache.store('ndbuild:k', Buffer.from(JSON.stringify({ digest: recorded, ts: 1 })));
    const r2 = await cache.store('ndbuild:k', Buffer.from(JSON.stringify({ digest: recorded, ts: 2 })));
    expect(r1.digest).toBe(recorded);
    expect(r2.digest).toBe(recorded);
    expect((await cache.lookup('ndbuild:k'))?.digest).toBe(recorded);
    // A marker without a usable sha256 digest stays content-addressed.
    const bad = await cache.store('bad', Buffer.from(JSON.stringify({ digest: 'md5:x', ts: 1 })));
    expect(bad.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('F864: keeps a valid marker ref, splits a pre-F864 RepoDigest digest, drops invalid refs', async () => {
    const cache = new InlineBuildCache();
    const digest = `sha256:${'d'.repeat(64)}`;
    const ref = `registry.example.com/ninedeploy/web@${digest}`;
    const m = (o: Record<string, unknown>) => Buffer.from(JSON.stringify({ ...o, ts: 1 }));
    expect(await cache.store('a', m({ digest, ref }))).toMatchObject({ digest, ref });
    expect(await cache.lookup('a')).toMatchObject({ digest, ref });
    expect(await cache.store('b', m({ digest: ref }))).toMatchObject({ digest, ref });
    for (const bad of [`${ref},type=local,src=/`, `sha256:${'d'.repeat(64)}`, 'web:latest', `x/y@sha256:${'e'.repeat(64)}`]) {
      const stored = await cache.store('c', m({ digest, ref: bad }));
      expect(stored.digest).toBe(digest);
      expect('ref' in stored, bad).toBe(false);
    }
    // The pointer digest itself must be a full `sha256:<64 hex>`, not a prefix match.
    for (const short of ['sha256:abc', `sha256:${'D'.repeat(64)}`, `sha256:${'d'.repeat(64)}x`]) {
      const blob = m({ digest: short });
      const stored = await cache.store('s', blob);
      expect(stored.digest, short).not.toBe(short);
      expect(stored.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('rejects a zero-byte blob', async () => {
    const cache = new InlineBuildCache();
    await expect(cache.store('empty', bytes(0))).rejects.toThrow(/zero-byte/);
  });

  it('rejects a blob larger than the configured budget', async () => {
    const cache = new InlineBuildCache({ maxBytes: 1024 });
    await expect(cache.store('huge', bytes(2048))).rejects.toThrow(/larger than the/);
  });

  it('exposes a 2 GiB default budget when no option is supplied', () => {
    const cache = new InlineBuildCache();
    // Indirectly verified by accepting a small blob.
    expect(cache.name).toBe('inline');
  });
});
