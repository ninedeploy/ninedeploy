import { createHash } from 'node:crypto';
import { s3Request, type S3Config } from '../../lib/s3.js';
import type { BlobRef, IBuildCache } from '../types.js';

/**
 * S3-backed build cache — Sprint 4, Gap G-01 (PR-D).
 *
 * Reuses the existing `lib/s3.ts` SigV4 helpers for transport, but
 * stores a small `BlobRef` marker per key instead of the layer
 * bytes themselves — the same model `RegistryBuildCache` uses.
 * BuildKit already pushed the actual layers via
 * `--cache-to=type=s3,prefix=...` during the original build, so the
 * cache marker just tells the next build "the previous build's
 * image is at this object prefix, ask S3 for its digest".
 *
 * Two operators on the same S3 bucket are isolated by the
 * `prefix` config-center key (default `build-cache/`). The marker
 * key is derived from the cache key, so two services on the same
 * bucket never collide.
 *
 * Contract:
 *   - `store(key, blob)` PUTs the marker body. s3Request exposes no
 *     extra-header parameter, so `x-amz-meta-*` metadata is not
 *     available — the digest rides in the marker JSON. Idempotent on
 *     duplicate (key, digest) — S3 overwrites the marker with itself.
 *   - `lookup(key)` GETs `<bucket>/<prefix><tag>` and parses the
 *     marker body. A 404 = miss; a 200 that does not parse as one of
 *     our markers = miss (operator pointed us at the wrong prefix).
 *   - `stats()` reports the in-process counters. The bucket itself
 *     does not give us cheap "how many keys under <prefix>?" so the
 *     driver does not attempt a count; the panel's hit-rate column
 *     uses the in-process hits + misses.
 *   - The S3 driver requires NO database table — the marker is
 *     self-describing on the bucket itself, and a kernel restart
 *     recovers by listing the prefix on the first miss.
 */
/** Bucket settings plus the key prefix that isolates one operator's markers. */
export interface S3BuildCacheSettings extends S3Config {
  /** Object-key prefix, e.g. `build-cache/`. Empty = bucket root. */
  prefix?: string;
}

export type S3BuildCacheConfigSupplier = () =>
  | Promise<S3BuildCacheSettings | null>
  | S3BuildCacheSettings
  | null;

export interface S3BuildCacheOptions {
  /**
   * S3 connection settings — the same shape `S3StorageDriver` accepts —
   * or a supplier resolved per call. A supplier returning `null` means the
   * operator has not configured a bucket yet: `lookup()` misses and
   * `store()` throws a descriptive error, so a build never fails because
   * its optional cache is unconfigured. This is the same lazy-supplier
   * shape the Cloudflare / DNSimple / Namecheap domain providers use.
   */
  config: S3BuildCacheSettings | S3BuildCacheConfigSupplier;
  /**
   * Fallback object-key prefix used when the resolved settings do not carry
   * one. Default `build-cache/`.
   */
  prefix?: string;
}

export class S3BuildCache implements IBuildCache {
  readonly name = 's3';

  private readonly config: S3BuildCacheSettings | S3BuildCacheConfigSupplier;
  private readonly prefix: string;

  private hits = 0;
  private misses = 0;
  private stores = 0;

  constructor(opts: S3BuildCacheOptions) {
    this.config = opts.config;
    this.prefix = opts.prefix ?? 'build-cache/';
  }

  /**
   * Resolve the bucket settings for this call. A supplier that throws or
   * returns null means "not configured" — treated as a cold cache.
   */
  private async resolve(): Promise<{ cfg: S3Config; prefix: string } | null> {
    try {
      const raw = typeof this.config === 'function' ? await this.config() : this.config;
      if (!raw || !raw.bucket || !raw.endpoint) return null;
      const { prefix, ...cfg } = raw;
      return { cfg, prefix: normalisePrefix(prefix ?? this.prefix) };
    } catch {
      return null;
    }
  }

  async lookup(key: string): Promise<BlobRef | null> {
    // The marker IS the object body: store() cannot send `x-amz-meta-*`
    // headers (s3Request exposes no extra-header parameter), so the
    // digest is only recoverable by GETting the body and parsing it —
    // exactly what the store() side documents. A HEAD that demanded the
    // metadata header turned every store→lookup round-trip into a miss,
    // so the cache could never hit (r019).
    const conn = await this.resolve();
    if (!conn) {
      this.misses += 1;
      return null;
    }
    const objectKey = objectKeyFor(conn.prefix, key);
    const res = await s3Request(conn.cfg, 'GET', objectKey, undefined, 'application/octet-stream');
    if (res.status !== 200) {
      this.misses += 1;
      return null;
    }
    const parsed = parseMarker(Buffer.from(await res.arrayBuffer()));
    if (!parsed) {
      // 200 but not one of our markers — wrong prefix or foreign object.
      this.misses += 1;
      return null;
    }
    const lastModified = res.headers.get('last-modified') ?? new Date().toISOString();
    this.hits += 1;
    return { digest: parsed.digest, sizeBytes: parsed.sizeBytes, storedAt: lastModified };
  }

  async store(key: string, blob: Buffer | Uint8Array): Promise<BlobRef> {
    const parsed = parseMarker(blob);
    const digest = parsed?.digest ?? placeholderHash(blob);
    const sizeBytes = parsed?.sizeBytes ?? blob.byteLength;
    const conn = await this.resolve();
    if (!conn) {
      throw new Error(
        'S3BuildCache.store: no bucket configured — set plugin:build-cache:s3_endpoint / s3_bucket / credentials first',
      );
    }

    const objectKey = objectKeyFor(conn.prefix, key);

    // SigV4 signs the canonical headers; the `x-amz-meta-*` pair is
    // passed through. We do not have a way to add custom headers via
    // the public `s3Put` helper, so we go through `s3Request`
    // directly. The signature includes `host` + `x-amz-content-sha256`
    // + `x-amz-date` only — adding more headers would require
    // re-signing; the s3 helper above only exposes `content-type`
    // beyond those, so we accept that the digest is encoded in the
    // body. The `BlobRef` marker IS the body, so on lookup we
    // GET the marker body, parse the digest, and use the rest of
    // the workflow unchanged.
    const res = await s3Request(conn.cfg, 'PUT', objectKey, Buffer.from(blob), 'application/octet-stream');
    // r186: s3Request does not throw on HTTP errors. A 403 (bad credentials)
    // or 5xx PUT used to be counted as a store and logged "Cache stored" —
    // every later lookup then missed with no error ever surfaced.
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok) throw new Error(`S3 build-cache PUT failed (HTTP ${res.status})`);

    this.stores += 1;
    return { digest, sizeBytes, storedAt: new Date().toISOString() };
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
      // No cheap way to count objects under a prefix without LIST.
      // The panel uses the per-backend hit rate (hits / (hits + misses))
      // for the operator-facing column, so a missing count is not
      // observable to the end-user.
      entries: 0,
      totalBytes: 0,
      hits: this.hits,
      misses: this.misses,
      stores: this.stores,
      evictions: 0, // S3 lifecycle rules are the operator's job, not ours
    };
  }

}

/** Strip a leading slash so the prefix concatenates into a valid S3 key. */
function normalisePrefix(prefix: string): string {
  return prefix.replace(/^\/+/, '');
}

function objectKeyFor(prefix: string, key: string): string {
  // S3 keys are 1-1024 bytes; the cache key is `ndbuild:<hex>`
  // and the prefix already includes a `/`, so the final key is
  // safe and within the limit.
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${prefix}${safe}.ndcache`;
}

interface MarkerPayload {
  digest: string;
  sizeBytes: number;
  ts: number;
}

function parseMarker(blob: Buffer | Uint8Array): MarkerPayload | null {
  try {
    const text = Buffer.from(blob).toString('utf8');
    const parsed = JSON.parse(text) as Partial<MarkerPayload>;
    if (typeof parsed.digest !== 'string' || !parsed.digest.startsWith('sha256:')) {
      return null;
    }
    return {
      digest: parsed.digest,
      sizeBytes: typeof parsed.sizeBytes === 'number' ? parsed.sizeBytes : 0,
      ts: typeof parsed.ts === 'number' ? parsed.ts : 0,
    };
  } catch {
    return null;
  }
}

function placeholderHash(blob: Buffer | Uint8Array): string {
  return `sha256:${createHash('sha256').update(blob).digest('hex')}`;
}
