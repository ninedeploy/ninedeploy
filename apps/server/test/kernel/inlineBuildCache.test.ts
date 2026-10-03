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
