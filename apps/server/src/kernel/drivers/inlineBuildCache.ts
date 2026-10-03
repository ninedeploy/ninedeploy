import { createHash } from 'node:crypto';
import type { BlobRef, IBuildCache } from '../types.js';

/**
 * In-memory LRU build cache — Sprint 3, Gap G-01 (PR-A).
 *
 * This is the reference implementation of the `IBuildCache` contract.
 * It exists so the rest of the kernel can prove the cache plugin and
 * stats surface end-to-end before any network backend (registry, S3) is
 * wired up. Two operational notes:
 *
 *   • The cache lives entirely in process memory. A kernel restart drops
 *     every blob; that is by design — BuildKit's `--cache-from=type=local`
 *     behaves the same way and an operator who wants durability can
 *     register a `RegistryBuildCache` or `S3BuildCache` driver instead
 *     (Sprint 4, PR #17 / PR #18).
 *
 *   • Eviction is LRU-by-insertion. We do not track per-blob access
 *     times; a tighter LRU would re-key on every `lookup()` hit. The
 *     policy here is "if you have not been stored into, you go first",
 *     which matches the cheapest BuildKit cache contract and is easy to
 *     reason about from a unit test.
 *
 * Contract:
 *   - `lookup(key)` is non-throwing; a missing key returns `null`.
 *   - `store(key, blob)` is idempotent on duplicate keys — the digest
 *     is content-addressed, so a second `store()` for the same bytes
 *     is a no-op apart from bumping counters and the LRU order.
 *   - `stats()` reports aggregate counters that survive across multiple
 *     backends — the plugin sums them when it emits `build.cache.stats`.
 */
export interface InlineBuildCacheOptions {
  /** Hard byte budget. Once the cache holds more than this, the oldest
   *  insertion is evicted on the next `store()`. Default: 2 GiB. */
  maxBytes?: number;
  /** Optional initial clock for deterministic tests. */
  now?: () => Date;
}

interface Entry {
  ref: BlobRef;
  sizeBytes: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

export class InlineBuildCache implements IBuildCache {
  readonly name = 'inline';

  private readonly entries = new Map<string, Entry>();
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private currentBytes = 0;
  private hits = 0;
  private misses = 0;
  private stores = 0;
  private evictions = 0;

  constructor(opts: InlineBuildCacheOptions = {}) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = opts.now ?? (() => new Date());
  }

  async lookup(key: string): Promise<BlobRef | null> {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    return entry.ref;
  }

  async store(key: string, blob: Buffer | Uint8Array): Promise<BlobRef> {
    const sizeBytes = blob.byteLength;
    // Reject zero-byte blobs — the contract is "cache a layer", and a
    // layer with no bytes is almost certainly a programming error.
    if (sizeBytes === 0) {
      throw new Error('InlineBuildCache.store: refusing to cache a zero-byte blob');
    }
    // Reject blobs that exceed the budget on their own — even with an
    // empty cache we cannot fit them, and silently truncating would be
    // worse than failing loudly.
    if (sizeBytes > this.maxBytes) {
      throw new Error(
        `InlineBuildCache.store: blob is ${sizeBytes} bytes, larger than the ${this.maxBytes}-byte budget`,
      );
    }

    const digest = digestFor(blob);
    const ref: BlobRef = {
      digest,
      sizeBytes,
      storedAt: this.now().toISOString(),
    };

    // Idempotent re-store: if the key already maps to the same content,
    // just bump the counter and refresh the LRU order. A different
    // content for the same key is treated as an overwrite — the old
    // bytes are dropped and the budget is reconciled below.
    const existing = this.entries.get(key);
    if (existing) {
      this.currentBytes -= existing.sizeBytes;
      this.entries.delete(key);
    }

    this.entries.set(key, { ref, sizeBytes });
    this.currentBytes += sizeBytes;
    this.stores += 1;

    // LRU-by-insertion: `Map` preserves insertion order, so re-inserting
    // an existing key (above) and appending a new one both push the
    // entry to the back. Evict from the front until we are under the
    // budget.
    while (this.currentBytes > this.maxBytes && this.entries.size > 0) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey)!;
      this.entries.delete(oldestKey);
      this.currentBytes -= oldest.sizeBytes;
      this.evictions += 1;
    }

    return ref;
  }

  async stats(): Promise<{
    entries: number;
    totalBytes: number;
    hits: number;
    misses: number;
    stores: number;
    evictions: number;
  }> {
    return {
      entries: this.entries.size,
      totalBytes: this.currentBytes,
      hits: this.hits,
      misses: this.misses,
      stores: this.stores,
      evictions: this.evictions,
    };
  }
}

function digestFor(blob: Buffer | Uint8Array): string {
  return `sha256:${createHash('sha256').update(blob).digest('hex')}`;
}
