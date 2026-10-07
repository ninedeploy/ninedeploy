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

    // F360: both writers (the BuildKit builder and POST /v1/build-cache/store)
    // hand us a `{ digest, ts }` marker, not layer bytes. Hand back the digest
    // the marker records — as the registry and S3 drivers do — instead of a
    // hash of the marker JSON, which names nothing and changes with `ts`.
    const pointer = markerPointerOf(blob);
    const ref: BlobRef = {
      digest: pointer?.digest ?? digestFor(blob),
      sizeBytes,
      storedAt: this.now().toISOString(),
    };
    // F864: keep the pullable image reference so the next build's lookup can
    // hand buildx a `--cache-from` it can actually import.
    if (pointer?.ref) ref.ref = pointer.ref;

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

/** The pointer a `{ digest, ref?, ts }` cache marker records, or null for any other blob. */
function markerPointerOf(blob: Buffer | Uint8Array): { digest: string; ref?: string } | null {
  // A marker is a JSON object; skip decoding layer bytes that cannot be one.
  if (blob[0] !== 0x7b /* '{' */) return null;
  try {
    const parsed = JSON.parse(Buffer.from(blob).toString('utf8')) as { digest?: unknown; ref?: unknown } | null;
    return markerPointer(parsed?.digest, parsed?.ref);
  } catch {
    return null;
  }
}

// F864: `[host[:port]/]component(/component)*@sha256:<64 hex>` — the docker
// reference grammar restricted to a digest reference. No tag, no whitespace,
// no `,` or `=` (the value is spliced into buildx's `type=registry,ref=` csv).
const BUILD_CACHE_REF =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;

/** F864: a pointer digest is exactly `sha256:<64 lowercase hex>` — never a mere prefix match. */
export function isContentDigest(value: unknown): boolean {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

/**
 * F864: true when `value` is a pullable digest reference
 * (`<repo>@sha256:<64 hex>`) that `BlobRef.ref` may carry. Shared by every
 * driver and by the BuildKit builder, which re-checks it before it reaches
 * `--cache-from`.
 */
export function isBuildCacheRef(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && BUILD_CACHE_REF.test(value);
}

/**
 * F864: normalise a marker's `digest` / `ref` fields into a `BlobRef` pointer.
 *   - `digest` `sha256:<64 hex>` → kept; `ref` kept only when it is valid AND names
 *     that same digest (an invalid or mismatched ref is dropped, never stored).
 *   - `digest` that is itself a valid `<repo>@sha256:<hex>` (the pre-F864
 *     builder stored the RepoDigest there) → split into digest + ref, instead
 *     of hashing the marker JSON into a digest that names nothing.
 *   - anything else → null (not a marker).
 */
export function markerPointer(digest: unknown, ref: unknown): { digest: string; ref?: string } | null {
  if (typeof digest !== 'string') return null;
  if (isContentDigest(digest)) {
    return isBuildCacheRef(ref) && ref.endsWith(`@${digest}`) ? { digest, ref } : { digest };
  }
  if (isBuildCacheRef(digest)) return { digest: digest.slice(digest.lastIndexOf('@') + 1), ref: digest };
  return null;
}

function digestFor(blob: Buffer | Uint8Array): string {
  return `sha256:${createHash('sha256').update(blob).digest('hex')}`;
}
