import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { cacheRegistryBlobs, type DB } from '@ninedeploy/db';
import type { BlobRef, IBuildCache } from '../types.js';
import { isBuildCacheRef, isContentDigest, markerPointer } from './inlineBuildCache.js';

/**
 * Registry-backed build cache — Sprint 4, Gap G-01 (PR-C).
 *
 * A `RegistryBuildCache` writes a small `BlobRef` marker to an OCI
 * registry as a single-tag manifest, and reads it back via
 * `GET /v2/<repo>/manifests/<tag>`, parsing the cached-content digest
 * out of the manifest's `io.ninedeploy.build-cache.digest` annotation (F191;
 * legacy tags: layers[0].digest). The blob payload itself is the
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
  /** The cached-content pointer carried in the manifest (annotation; legacy: layers[0].digest). */
  layerDigest: string;
  sizeBytes: number;
  /** F864: pullable `<repo>@sha256:` reference from the ref annotation, when valid. */
  ref?: string;
}

const DEFAULT_NAMESPACE = 'ninedeploy/build-cache';
/** F188: `ndbuild:` + a suffix with no `-`/`:`, so `ndbuild-<suffix>` is a valid, unambiguous tag. */
const CANONICAL_KEY = /^ndbuild:[A-Za-z0-9_.]{1,120}$/;
/** F190: per-request deadline — the same bound lib/imageWatch.ts uses for registry probes. */
const REGISTRY_TIMEOUT_MS = 10_000;
/** F191: OCI 1.1 empty descriptor — the 2-byte blob `{}`. */
const EMPTY_BLOB = '{}';
const EMPTY_MEDIA_TYPE = 'application/vnd.oci.empty.v1+json';
const EMPTY_DIGEST = 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
/** F191: manifest annotations carrying the cached-content pointer. */
const POINTER_ANNOTATION = 'io.ninedeploy.build-cache.digest';
const SIZE_ANNOTATION = 'io.ninedeploy.build-cache.size';
/** F864: the pullable image reference the cached build can be imported from. */
const REF_ANNOTATION = 'io.ninedeploy.build-cache.ref';

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
    // annotation (F191). A HEAD cannot decide this: its Docker-Content-Digest
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
      return withRef(
        { digest: manifest.layerDigest, sizeBytes: manifest.sizeBytes, storedAt: new Date().toISOString() },
        manifest.ref,
      );
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
    // F864: the ref lives in the manifest annotation (the row has no column
    // for it); the manifest was just confirmed to carry this row's digest.
    return withRef(
      { digest: row.digest, sizeBytes: row.sizeBytes, storedAt: row.storedAt.toISOString() },
      manifest.ref,
    );
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
    const pushed = await this.pushManifest(conn, tag, digest, sizeBytes, parsed?.ref);
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
      // F189: atomic upsert — a concurrent store of the same key may insert
      // between our findFirst and this insert; it must not make us reject
      // after our manifest PUT already landed.
      await this.db
        .insert(cacheRegistryBlobs)
        .values({
          key,
          backend: this.name,
          repo: conn.repo,
          digest,
          sizeBytes,
        })
        .onConflictDoUpdate({
          target: [cacheRegistryBlobs.key, cacheRegistryBlobs.backend, cacheRegistryBlobs.repo],
          set: { digest, sizeBytes, lastHitAt: new Date() },
        });
    }
    this.stores += 1;
    return withRef({ digest, sizeBytes, storedAt: new Date().toISOString() }, parsed?.ref);
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
    // OCI tags are 1-128 chars of [a-zA-Z0-9_][a-zA-Z0-9._-]*. The mapping
    // MUST be injective: lookup() trusts any marker at tagFor(key) as this
    // key's content. F188: folding every bad char to `-` and truncating at
    // 128 aliased `ndbuild:abc` with `ndbuild-abc` (keys arrive verbatim via
    // POST /build-cache/store). Canonical keys keep their `ndbuild-<suffix>`
    // tag (live caches stay warm); every other key gets `h-<sha256>`. The two
    // tag namespaces cannot overlap.
    if (CANONICAL_KEY.test(key)) return `ndbuild-${key.slice('ndbuild:'.length)}`;
    return `h-${createHash('sha256').update(key, 'utf8').digest('hex')}`;
  }

  private manifestPath(repo: string, tag: string): string {
    return `/v2/${repo}/manifests/${tag}`;
  }

  private async fetchManifest(
    conn: { baseUrl: string; repo: string; auth: string | null },
    tag: string,
  ): Promise<RegistryManifest | null> {
    try {
      // F190: the deadline also covers the body read.
      return await withDeadline(async (signal) => {
        const res = await this.fetchImpl(`${conn.baseUrl}${this.manifestPath(conn.repo, tag)}`, {
          method: 'GET',
          headers: authHeaders(conn.auth, { Accept: 'application/vnd.oci.image.manifest.v1+json' }),
          signal,
        });
        if (res.status !== 200) return null;
        const parsed = (await res.json()) as {
          annotations?: Record<string, unknown>;
          layers?: Array<{ digest?: unknown; size?: unknown }>;
        };
        // F191: the pointer lives in the manifest annotations; a tag pushed
        // by an older version (lenient registry) carried it as layers[0].
        const pointer = parsed.annotations?.[POINTER_ANNOTATION];
        if (typeof pointer === 'string') {
          if (!isContentDigest(pointer)) return null;
          const size = Number(parsed.annotations?.[SIZE_ANNOTATION]);
          const manifest: RegistryManifest = {
            layerDigest: pointer,
            sizeBytes: Number.isSafeInteger(size) && size >= 0 ? size : 0,
          };
          // F864: trust the ref only when it is a valid digest reference that
          // names this pointer; a tag pushed before F864 has none.
          const ref = parsed.annotations?.[REF_ANNOTATION];
          if (isBuildCacheRef(ref) && ref.endsWith(`@${pointer}`)) manifest.ref = ref;
          return manifest;
        }
        const layer = parsed.layers?.[0];
        if (typeof layer?.digest !== 'string' || !isContentDigest(layer.digest) || layer.digest === EMPTY_DIGEST) {
          // 200 but not one of our marker manifests — wrong repo or foreign
          // tag content; treat the key as cold rather than trust the body
          // (same rule the S3 driver applies to unparsable markers).
          return null;
        }
        return {
          layerDigest: layer.digest,
          sizeBytes: typeof layer.size === 'number' ? layer.size : 0,
        };
      });
    } catch {
      return null;
    }
  }

  private async pushManifest(
    conn: { baseUrl: string; repo: string; auth: string | null },
    tag: string,
    digest: string,
    sizeBytes: number,
    ref?: string,
  ): Promise<boolean> {
    // F191: a registry refuses a manifest whose config/layer blobs it does
    // not hold (MANIFEST_BLOB_UNKNOWN), and the pointer digest is not a blob
    // anywhere. So the marker is an OCI 1.1 empty-descriptor manifest: config
    // and the single layer are the 2-byte `{}` blob (uploaded below if
    // absent), and the cached-content pointer travels in the annotations.
    const empty = { mediaType: EMPTY_MEDIA_TYPE, digest: EMPTY_DIGEST, size: 2 };
    const body = JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: empty,
      layers: [empty],
      annotations: {
        'io.ninedeploy.build-cache': 'true',
        [POINTER_ANNOTATION]: digest,
        [SIZE_ANNOTATION]: String(sizeBytes),
        // F864: format change — the pullable reference rides next to the pointer.
        ...(ref ? { [REF_ANNOTATION]: ref } : {}),
      },
    });
    try {
      if (!(await this.ensureEmptyBlob(conn))) return false;
      const res = await withDeadline((signal) =>
        this.fetchImpl(`${conn.baseUrl}${this.manifestPath(conn.repo, tag)}`, {
          method: 'PUT',
          headers: authHeaders(conn.auth, {
            'Content-Type': 'application/vnd.oci.image.manifest.v1+json',
          }),
          body,
          signal,
        }),
      );
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }

  /** F191: make sure the repo holds the `{}` blob (monolithic POST → PUT upload). Throws on transport errors. */
  private async ensureEmptyBlob(conn: { baseUrl: string; repo: string; auth: string | null }): Promise<boolean> {
    const blobs = `${conn.baseUrl}/v2/${conn.repo}/blobs`;
    const head = await withDeadline((signal) =>
      this.fetchImpl(`${blobs}/${EMPTY_DIGEST}`, { method: 'HEAD', headers: authHeaders(conn.auth, {}), signal }),
    );
    if (head.status === 200) return true;
    const start = await withDeadline((signal) =>
      this.fetchImpl(`${blobs}/uploads/`, { method: 'POST', headers: authHeaders(conn.auth, {}), signal }),
    );
    const location = start.headers.get('location');
    if (start.status !== 202 || !location) return false;
    const target = new URL(location, `${conn.baseUrl}/`);
    target.searchParams.set('digest', EMPTY_DIGEST);
    // The Location is registry-chosen: send credentials only back to the registry's own origin.
    const auth = target.origin === new URL(conn.baseUrl).origin ? conn.auth : null;
    const put = await withDeadline((signal) =>
      this.fetchImpl(target.toString(), {
        method: 'PUT',
        headers: authHeaders(auth, { 'Content-Type': 'application/octet-stream' }),
        body: EMPTY_BLOB,
        signal,
      }),
    );
    return put.status >= 200 && put.status < 300;
  }
}

/**
 * F190: every registry request gets a deadline; a registry that accepts and
 * then stalls must read as a miss / failed push, not hold the build. A plain
 * timer + AbortController (not AbortSignal.timeout) so tests can drive it
 * with fake timers.
 */
async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(
    () => ac.abort(new Error(`registry request timed out after ${REGISTRY_TIMEOUT_MS} ms`)),
    REGISTRY_TIMEOUT_MS,
  );
  try {
    return await run(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** F864: attach `ref` to a BlobRef only when present (the field stays absent otherwise). */
function withRef(blob: BlobRef, ref: string | undefined): BlobRef {
  return ref ? { ...blob, ref } : blob;
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
  /** F864: pullable `<repo>@sha256:` reference, when the marker carried a valid one. */
  ref?: string;
}

function parseMarker(blob: Buffer | Uint8Array): MarkerPayload | null {
  try {
    const text = Buffer.from(blob).toString('utf8');
    const parsed = JSON.parse(text) as Partial<MarkerPayload>;
    // F864: `markerPointer` keeps the `sha256:` rule for `digest`, adds the
    // validated `ref`, and splits a pre-F864 `<repo>@sha256:` digest field.
    const pointer = markerPointer(parsed.digest, parsed.ref);
    if (!pointer) return null;
    return {
      ...pointer,
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
