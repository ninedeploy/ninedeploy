import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { cacheRegistryBlobs, type DB } from '@ninedeploy/db';
import type { BlobRef, IBuildCache } from '../types.js';

/**
 * Registry-backed build cache — Sprint 4, Gap G-01 (PR-C).
 *
 * A `RegistryBuildCache` writes a small `BlobRef` marker to an OCI
 * registry as a single-tag manifest, and reads it back via
 * `GET /v2/<repo>/manifests/<tag>`, parsing the cached-content digest
 * out of the manifest's layers[0].digest. The blob payload itself is the
 * digest of the original layer cache, not the layer bytes — BuildKit
 * already has the bytes inside the registry from a previous
 * `--cache-to=type=registry,ref=...` invocation, so re-pushing them
 * is wasted I/O. The marker just tells the next build "the previous
 * build's image is at this tag, ask the registry for its digest".
 *
 * The driver persists (key → digest, repo) in the
 * `cache_registry_blobs` table so a kernel restart can resume without
 * re-listing the registry. A cache miss in the table is NOT a miss
 * for the cache overall — `lookup()` falls back to a `GET` against
 * the registry to confirm; if the registry has been garbage-collected
 * out-of-band, the driver records a `0` hit count and treats the key
 * as cold.
 *
 * Contract:
 *   - `lookup(key)` is non-throwing; a missing row + 404 = miss.
 *   - `store(key, blob)` is idempotent: re-storing the same digest
 *     for the same (key, repo) bumps the `hits` counter, not the
 *     row count. A different digest for the same key is treated as
 *     an overwrite (new row, old key retired).
 *   - `stats()` reports the table-aggregated counters; the per-driver
 *     plugin `aggregateStats()` (PR #15) merges them with the inline
 *     and S3 drivers.
 */
/**
 * Connection settings for a registry-backed cache. Resolved once per call
 * when supplied as a function, so an operator can save credentials in the
 * panel without restarting the kernel — the same lazy-supplier shape the
 * Cloudflare / DNSimple / Namecheap domain providers use.
 */
export interface RegistryBuildCacheCredentials {
  /** Registry base URL, e.g. `https://registry.example.com`. */
  url: string;
  /** Repository namespace, e.g. `ninedeploy/build-cache`. */
  repo?: string;
  /** Optional basic-auth credentials (encrypted in config-center). */
  username?: string;
  password?: string;
}

export type RegistryBuildCacheCredentialSupplier = () =>
  | Promise<RegistryBuildCacheCredentials | null>
  | RegistryBuildCacheCredentials
  | null;

export interface RegistryBuildCacheOptions {
  /** Drizzle DB handle. */
  db: DB;
  /**
   * Static settings, or a supplier returning `null` while the operator has
   * not configured a registry yet. An unconfigured cache is a cold cache:
   * `lookup()` misses and `store()` throws a descriptive error rather than
   * silently pretending to have cached anything.
   */
  credentials: RegistryBuildCacheCredentials | RegistryBuildCacheCredentialSupplier;
  /**
   * Custom fetch implementation. Default: global `fetch`. Tests inject a
   * stub to avoid hitting a real registry.
   */
  fetchImpl?: typeof fetch;
}

interface RegistryManifest {
  /** The cached-content pointer carried in the manifest's layers[0].digest. */
  layerDigest: string;
  sizeBytes: number;
}

const DEFAULT_NAMESPACE = 'ninedeploy/build-cache';

export class RegistryBuildCache implements IBuildCache {
  readonly name = 'registry';

  private readonly db: DB;
  private readonly credentials: RegistryBuildCacheCredentials | RegistryBuildCacheCredentialSupplier;
  private readonly fetchImpl: typeof fetch;

  private hits = 0;
  private misses = 0;
  private stores = 0;

  constructor(opts: RegistryBuildCacheOptions) {
    this.db = opts.db;
    this.credentials = opts.credentials;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Resolve the connection settings for this call. A supplier that throws or
   * returns null/blank-url means "not configured" — every caller treats that
   * as a cold cache rather than an error, because a build must never fail
   * because its optional cache is unconfigured.
   */
  private async resolve(): Promise<{ baseUrl: string; repo: string; auth: string | null } | null> {
    let raw: RegistryBuildCacheCredentials | null;
    try {
      raw = typeof this.credentials === 'function' ? await this.credentials() : this.credentials;
    } catch {
      return null;
    }
    if (!raw || typeof raw.url !== 'string' || raw.url.trim() === '') return null;
    return {
      baseUrl: raw.url.trim().replace(/\/$/, ''),
      repo: raw.repo || DEFAULT_NAMESPACE,
      auth:
        raw.username && raw.password
          ? Buffer.from(`${raw.username}:${raw.password}`).toString('base64')
          : null,
    };
  }

  async lookup(key: string): Promise<BlobRef | null> {
    // Fetch the manifest and read the cached-content pointer out of its
    // layers[0].digest. A HEAD cannot decide this: its Docker-Content-Digest
    // is the digest OF THE MANIFEST, not of the layer the row stores, so a
    // HEAD-based comparison never matched and every store→lookup round-trip
    // missed on a real registry (r021).
    const conn = await this.resolve();
    if (!conn) {
      // Registry not configured — a cold cache, not an error.
      this.misses += 1;
      return null;
    }
    const manifest = await this.fetchManifest(conn, this.tagFor(key));
    if (!manifest) {
      this.misses += 1;
      return null;
    }

    const row = await this.db.query.cacheRegistryBlobs.findFirst({
      where: eq(cacheRegistryBlobs.key, key),
    });
    if (!row) {
      // The registry may still have the tag (e.g. an instance that
      // joined an existing cluster). The layer digest inside the manifest
      // is the cached-content pointer for this key.
      this.hits += 1;
      return {
        digest: manifest.layerDigest,
        sizeBytes: manifest.sizeBytes,
        storedAt: new Date().toISOString(),
      };
    }

    // Confirm the registry still serves what we stored; an out-of-band GC
    // or a foreign overwrite would otherwise hand back a stale digest.
    if (manifest.layerDigest !== row.digest) {
      this.misses += 1;
      return null;
    }

    // Bump the hit counter and last-hit timestamp. The plugin's
    // `aggregateStats()` reads from this table on the next call.
    await this.db
      .update(cacheRegistryBlobs)
      .set({ hits: row.hits + 1, lastHitAt: new Date() })
      .where(eq(cacheRegistryBlobs.id, row.id));
    // r186: NOT `this.hits` — this hit is already in the row's counter, and
    // stats() adds the two together, so every stored-row hit counted twice.
    // `this.hits` is only for manifest-only hits (no row to record them).
    return { digest: row.digest, sizeBytes: row.sizeBytes, storedAt: row.storedAt.toISOString() };
  }

  async store(key: string, blob: Buffer | Uint8Array): Promise<BlobRef> {
    const parsed = parseMarker(blob);
    const digest = parsed?.digest ?? `sha256:${placeholderHash(blob)}`;
    const sizeBytes = parsed?.sizeBytes ?? blob.byteLength;
    const tag = this.tagFor(key);

    const conn = await this.resolve();
    if (!conn) {
      throw new Error(
        'RegistryBuildCache.store: no registry configured — set plugin:build-cache:registry_url (and repo/credentials) first',
      );
    }

    // Push the marker to the registry as a single-tag manifest. Real
    // blob bytes are already in the registry from a previous
    // `--cache-to=type=registry` invocation; the manifest is just a
    // pointer.
    const pushed = await this.pushManifest(conn, tag, digest, sizeBytes);
    if (!pushed) {
      throw new Error(`RegistryBuildCache.store: failed to push ${tag} to ${conn.baseUrl}`);
    }

    // Upsert the (key, backend, repo) row.
    const existing = await this.db.query.cacheRegistryBlobs.findFirst({
      where: eq(cacheRegistryBlobs.key, key),
    });
    if (existing) {
      await this.db
        .update(cacheRegistryBlobs)
        .set({ digest, sizeBytes, lastHitAt: new Date() })
        .where(eq(cacheRegistryBlobs.id, existing.id));
    } else {
      await this.db.insert(cacheRegistryBlobs).values({
        key,
        backend: this.name,
        repo: conn.repo,
        digest,
        sizeBytes,
      });
    }
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
    // The driver-level counters capture in-process activity since the
    // last boot. The table carries the historical hit count.
    const rows = await this.db.select().from(cacheRegistryBlobs);
    const totalHits = rows.reduce((acc, r) => acc + r.hits, 0);
    const totalBytes = rows.reduce((acc, r) => acc + r.sizeBytes, 0);
    return {
      entries: rows.length,
      totalBytes,
      hits: totalHits + this.hits,
      misses: this.misses,
      stores: this.stores,
      evictions: 0, // GC is the registry's job, not ours
    };
  }

  private tagFor(key: string): string {
    // OCI tags are 1-128 chars of [a-zA-Z0-9_][a-zA-Z0-9._-]*. The
    // cache key is already hex with an `ndbuild:` prefix; we keep
    // `ndbuild-` and replace `:` with `-` to satisfy the tag charset.
    return key.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);
  }

  private manifestPath(repo: string, tag: string): string {
    return `/v2/${repo}/manifests/${tag}`;
  }

  private async fetchManifest(
    conn: { baseUrl: string; repo: string; auth: string | null },
    tag: string,
  ): Promise<RegistryManifest | null> {
    try {
      const res = await this.fetchImpl(`${conn.baseUrl}${this.manifestPath(conn.repo, tag)}`, {
        method: 'GET',
        headers: authHeaders(conn.auth, { Accept: 'application/vnd.oci.image.manifest.v1+json' }),
      });
      if (res.status !== 200) return null;
      const parsed = (await res.json()) as {
        layers?: Array<{ digest?: unknown; size?: unknown }>;
      };
      const layer = parsed.layers?.[0];
      if (typeof layer?.digest !== 'string' || !layer.digest.startsWith('sha256:')) {
        // 200 but not one of our marker manifests — wrong repo or foreign
        // tag content; treat the key as cold rather than trust the body
        // (same rule the S3 driver applies to unparsable markers).
        return null;
      }
      return {
        layerDigest: layer.digest,
        sizeBytes: typeof layer.size === 'number' ? layer.size : 0,
      };
    } catch {
      return null;
    }
  }

  private async pushManifest(
    conn: { baseUrl: string; repo: string; auth: string | null },
    tag: string,
    digest: string,
    sizeBytes: number,
  ): Promise<boolean> {
    // A real registry push is a two-step: blob upload (layer
    // already there) + manifest PUT. The OCI distribution spec
    // requires a JSON body that names the config + layer media
    // types; this minimal manifest is enough for the cache marker
    // case because the digest itself encodes the image identity.
    const body = JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: {
        mediaType: 'application/vnd.oci.empty.v1+json',
        digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        size: 2,
      },
      layers: [
        {
          mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
          digest,
          size: sizeBytes,
          annotations: { 'io.ninedeploy.build-cache': 'true' },
        },
      ],
    });
    try {
      const res = await this.fetchImpl(`${conn.baseUrl}${this.manifestPath(conn.repo, tag)}`, {
        method: 'PUT',
        headers: authHeaders(conn.auth, {
          'Content-Type': 'application/vnd.oci.image.manifest.v1+json',
        }),
        body,
      });
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }

}

function authHeaders(auth: string | null, extra: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (auth) headers.Authorization = `Basic ${auth}`;
  return headers;
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
  // Deterministic placeholder digest for markers that do not already
  // carry one. Mirrors the inline driver's `digestFor` algorithm.
  return createHash('sha256').update(blob).digest('hex');
}
