/**
 * RegistryBuildCache — driver coverage.
 *
 * The registry fake below is SPEC-FAITHFUL on purpose. A conformant OCI
 * registry is content-addressed: a manifest PUT/GET/HEAD answers with
 * `Docker-Content-Digest` = sha256 OF THE MANIFEST BYTES — never the layer
 * digest named inside it. An earlier revision of this fake stored the layer
 * digest on PUT and echoed it back on HEAD, fabricating state no real
 * registry can produce; that masked r021, where `lookup()` compared the
 * row's layer digest against the HEAD digest and could therefore never
 * match — the backend could never hit on real infrastructure.
 *
 * Standing rule (r016 / r019 / r021): every write→read round-trip test must
 * run against a fake that computes response state the way real
 * infrastructure does, and the round-trip itself must actually run.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@ninedeploy/db';
import { RegistryBuildCache } from '../../src/kernel/drivers/registryBuildCache.js';

const { db, client, ready } = createDb({ url: ':memory:' });
await ready;

// Exact DDL from packages/db/src/migrations/0040_cache_registry_blobs.sql.
async function resetDb(): Promise<void> {
  await client.execute('DROP TABLE IF EXISTS "cache_registry_blobs"');
  await client.execute(`CREATE TABLE "cache_registry_blobs" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"key" text NOT NULL,
	"backend" text NOT NULL,
	"repo" text NOT NULL,
	"digest" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"stored_at" integer DEFAULT (unixepoch()) NOT NULL,
	"last_hit_at" integer DEFAULT (unixepoch()) NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL
)`);
  await client.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS "cache_registry_blobs_key_idx" ON "cache_registry_blobs" ("key","backend","repo")`,
  );
  await client.execute(
    `CREATE INDEX IF NOT EXISTS "cache_registry_blobs_last_hit_idx" ON "cache_registry_blobs" ("last_hit_at")`,
  );
}

// ── spec-faithful mini-registry ────────────────────────────────────────────
interface TagEntry {
  bytes: string;
  manifestDigest: string;
}
interface RecordedCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

const tags = new Map<string, TagEntry>();
const calls: RecordedCall[] = [];

function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

async function registryFetch(input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? init.body : undefined;
  calls.push({ url, init: { method, headers: (init?.headers ?? {}) as Record<string, string>, body } });
  const tag = decodeURIComponent(url.split('/manifests/')[1] ?? '');
  if (method === 'PUT') {
    const bytes = body ?? '';
    const manifestDigest = `sha256:${sha256hex(bytes)}`;
    tags.set(tag, { bytes, manifestDigest });
    // Real registries answer a manifest PUT with the manifest's own digest.
    return new Response(null, { status: 201, headers: { 'Docker-Content-Digest': manifestDigest } });
  }
  const hit = tags.get(tag);
  if (!hit) return new Response(null, { status: 404 });
  const headers = {
    'Docker-Content-Digest': hit.manifestDigest,
    'Content-Length': String(hit.bytes.length),
    'Content-Type': 'application/vnd.oci.image.manifest.v1+json',
  };
  if (method === 'HEAD') return new Response(null, { status: 200, headers });
  if (method === 'GET') return new Response(hit.bytes, { status: 200, headers });
  return new Response(null, { status: 405 });
}

function newCache(opts: { username?: string; password?: string } = {}): RegistryBuildCache {
  return new RegistryBuildCache({
    db,
    credentials: {
      url: 'https://registry.example.com',
      repo: 'ninedeploy/test',
      username: opts.username,
      password: opts.password,
    },
    fetchImpl: registryFetch,
  });
}

beforeEach(async () => {
  tags.clear();
  calls.length = 0;
  await resetDb();
});

afterAll(async () => {
  await client.close();
});

// Production marker shape (engine/builders/buildkit.ts step 4): the marker
// carries { digest, ts } — no sizeBytes.
const LAYER_DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_LAYER_DIGEST = `sha256:${'b'.repeat(64)}`;
const KEY = `ndbuild:${'c'.repeat(24)}`;
const marker = (digest: string): Buffer =>
  Buffer.from(JSON.stringify({ digest, ts: 1_700_000_000_000 }));

describe('RegistryBuildCache', () => {
  it('exposes a stable name and starts at zero stats', async () => {
    const cache = newCache();
    expect(cache.name).toBe('registry');
    const stats = await cache.stats();
    expect(stats).toEqual({ entries: 0, totalBytes: 0, hits: 0, misses: 0, stores: 0, evictions: 0 });
  });

  it('records a miss on lookup when the registry returns 404', async () => {
    const cache = newCache();
    const ref = await cache.lookup('ndbuild:abc');
    expect(ref).toBeNull();
    const stats = await cache.stats();
    expect(stats.misses).toBe(1);
  });

  it('passes the configured credentials via the Authorization header on push', async () => {
    const cache = newCache({ username: 'alice', password: 's3cret' });
    const blob = Buffer.from(JSON.stringify({ digest: 'sha256:auth', sizeBytes: 1, ts: 0 }));
    await cache.store('ndbuild:auth', blob);
    const putCall = calls.find((c) => c.init.method === 'PUT');
    expect(putCall).toBeDefined();
    const authHeader = putCall?.init.headers?.Authorization;
    expect(authHeader).toMatch(/^Basic /);
  });

  it('skips a non-marker blob and uses a placeholder digest', async () => {
    const cache = newCache();
    const stored = await cache.store('ndbuild:xyz', Buffer.from('not a marker'));
    const hex = createHash('sha256').update(Buffer.from('not a marker')).digest('hex');
    expect(stored.digest).toBe(`sha256:${hex}`);
  });

  it('puts a manifest on the registry with the expected OCI shape', async () => {
    const cache = newCache();
    const blob = Buffer.from(JSON.stringify({ digest: 'sha256:shape', sizeBytes: 42, ts: 0 }));
    await cache.store('ndbuild:shape', blob);
    const putCall = calls.find((c) => c.init.method === 'PUT');
    expect(putCall).toBeDefined();
    expect(putCall?.init.headers?.['Content-Type']).toMatch(/application\/vnd\.oci\.image\.manifest/);
    const body = JSON.parse(putCall?.init.body ?? '{}') as { schemaVersion: number; layers?: Array<{ digest: string }> };
    expect(body.schemaVersion).toBe(2);
    expect(body.layers?.[0]?.digest).toBe('sha256:shape');
  });

  it('maps a key with non-tag-safe characters to a valid OCI tag', async () => {
    const cache = newCache();
    const blob = Buffer.from(JSON.stringify({ digest: 'sha256:tag', sizeBytes: 1, ts: 0 }));
    await cache.store('ndbuild:abc/123', blob);
    // The registry path should contain a tag without `/`.
    const putCall = calls.find((c) => c.init.method === 'PUT');
    expect(putCall?.url).toMatch(/\/manifests\//);
    const tag = putCall?.url.split('/manifests/')[1];
    expect(tag).not.toContain('/');
  });

  // ── r021 regression: the store→lookup round-trip must actually hit ─────

  it('HITS with the cached-content digest after a store on the same instance', async () => {
    const cache = newCache();
    await cache.store(KEY, marker(LAYER_DIGEST));

    const ref = await cache.lookup(KEY);
    expect(ref, 'a store must be followed by a lookup hit on a conformant registry').not.toBeNull();
    expect(ref!.digest, 'the hit must carry the CACHED CONTENT digest, not the manifest digest').toBe(
      LAYER_DIGEST,
    );
    const stats = await cache.stats();
    expect(stats.misses, 'the round-trip must not record a miss').toBe(0);
  });

  it('r186: a hit on a stored row is counted once in stats()', async () => {
    const cache = newCache();
    await cache.store(KEY, marker(LAYER_DIGEST));
    await cache.lookup(KEY);
    expect((await cache.stats()).hits).toBe(1);
  });

  it('cluster-join: registry has the tag but this instance has no row → layer digest', async () => {
    const cache = newCache();
    await cache.store(KEY, marker(LAYER_DIGEST));
    // A second instance joining the cluster has an empty local table.
    await client.execute('DELETE FROM "cache_registry_blobs"');

    const ref = await cache.lookup(KEY);
    expect(ref, 'the tag exists on the registry — lookup must not report a miss').not.toBeNull();
    expect(ref!.digest, 'the BlobRef must point at the cached content (layer digest), not the manifest digest').toBe(
      LAYER_DIGEST,
    );
  });

  it('GC: tag removed out-of-band → miss', async () => {
    const cache = newCache();
    await cache.store(KEY, marker(LAYER_DIGEST));
    tags.clear(); // registry garbage-collected every tag

    const ref = await cache.lookup(KEY);
    expect(ref, 'a garbage-collected tag must look up as a miss').toBeNull();
  });

  it('out-of-band overwrite: same tag, different layer → miss', async () => {
    const cache = newCache();
    await cache.store(KEY, marker(LAYER_DIGEST));
    // Someone else repoints the tag at different content.
    const foreign = JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: {
        mediaType: 'application/vnd.oci.empty.v1+json',
        digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        size: 2,
      },
      layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: OTHER_LAYER_DIGEST, size: 1 }],
    });
    tags.set(KEY.replace(/[^A-Za-z0-9._-]/g, '-'), { bytes: foreign, manifestDigest: `sha256:${sha256hex(foreign)}` });

    const ref = await cache.lookup(KEY);
    expect(ref, 'an overwritten tag must not surface the stale digest as a hit').toBeNull();
  });

  // r026 regression: the marker buildkit.ts actually stores can be
  // `{ digest: RepoDigests[0] }` = `"<repo>@sha256:<hex>"` (runInspectDigest
  // returns the raw string; only the digestOfString fallback is prefix-clean).
  // parseMarker rejects a non-`sha256:`-prefixed digest, so that live shape
  // lands on placeholderHash() — the branch that contained the lazy
  // require('node:crypto'). It is a documented, deterministic fallback, not
  // an error path, and must resolve (not reject) with the blob's own digest.
  it('resolves the placeholder digest for a marker whose digest lacks the sha256: prefix (r026 regression)', async () => {
    const blob = Buffer.from(
      JSON.stringify({ digest: `registry.example.com/ninedeploy/app@${LAYER_DIGEST}`, ts: 1 }),
    );
    const stored = await newCache().store('ndbuild:prefixless', blob);
    const hex = createHash('sha256').update(blob).digest('hex');
    expect(stored.digest, 'a rejected marker must fall back to the blob digest, never reject').toBe(
      `sha256:${hex}`,
    );
  });
});

// r026: same defect class as r007 (pgbouncer), r018 (oidc) and r025 (iptables
// egress) — a lazy require() in this pure-ESM package ("type": "module", runs
// as `node dist/server.js`) is a runtime ReferenceError in production while
// vitest's module runner shims `require` and keeps the suite green. The real
// fix is only provable outside vitest (leaf-compile + plain node), so the
// durable in-suite catcher guards the SOURCE.
describe('ESM purity (r026 regression)', () => {
  it('registryBuildCache.ts contains no CJS require() call', () => {
    const sourcePath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../src/kernel/drivers/registryBuildCache.ts',
    );
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/\brequire\s*\(/);
  });
});

/**
 * r034. The driver takes a credential SUPPLIER so panel-saved settings apply
 * without a restart. Unconfigured must read as a cold cache, never an error:
 * a build must not fail because its optional cache has no settings yet.
 */
describe('RegistryBuildCache lazy configuration', () => {
  it('misses without dialling out while the supplier returns null', async () => {
    const fetchImpl = vi.fn();
    const cache = new RegistryBuildCache({ db, credentials: () => null, fetchImpl: fetchImpl as never });
    await expect(cache.lookup('ndbuild:a')).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(cache.store('ndbuild:a', Buffer.from('{}'))).rejects.toThrow(/no registry configured/);
  });

  it('treats a blank url and a throwing supplier alike — unconfigured', async () => {
    const fetchImpl = vi.fn();
    const blank = new RegistryBuildCache({ db, credentials: { url: '   ' }, fetchImpl: fetchImpl as never });
    await expect(blank.lookup('ndbuild:a')).resolves.toBeNull();

    const boom = new RegistryBuildCache({
      db,
      credentials: () => {
        throw new Error('config centre down');
      },
      fetchImpl: fetchImpl as never,
    });
    await expect(boom.lookup('ndbuild:a')).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('defaults the repository namespace and trims a trailing slash off the url', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const cache = new RegistryBuildCache({
      db,
      credentials: async () => ({ url: 'https://registry.example.com/' }),
      fetchImpl: fetchImpl as never,
    });
    await expect(cache.lookup('ndbuild:a')).resolves.toBeNull();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://registry.example.com/v2/ninedeploy/build-cache/manifests/ndbuild-a',
    );
  });
});
