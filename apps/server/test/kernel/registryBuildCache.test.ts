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
import { createServer, type Socket } from 'node:net';
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
/** F191: blobs the registry holds. A manifest PUT referencing any other blob is refused. */
const blobs = new Set<string>();
const EMPTY_BLOB_DIGEST = 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
/** F864: drivers accept only a full `sha256:<64 hex>` pointer; derive one per label. */
const D = (label: string): string => `sha256:${sha256hex(label)}`;

const manifestPuts = (): RecordedCall[] =>
  calls.filter((c) => c.init.method === 'PUT' && c.url.includes('/manifests/'));

async function registryFetch(input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? init.body : undefined;
  calls.push({ url, init: { method, headers: (init?.headers ?? {}) as Record<string, string>, body } });
  // Blob push flow (distribution spec): HEAD probe, POST → 202 + Location,
  // PUT <location>?digest= accepted only when the bytes hash to the digest.
  const blobPath = new URL(url).pathname.match(/\/blobs\/(uploads\/[^/]*|sha256:[0-9a-f]{64})$/);
  if (blobPath) {
    const ref = blobPath[1] ?? '';
    if (method === 'HEAD') return new Response(null, { status: blobs.has(ref) ? 200 : 404 });
    if (method === 'POST') return new Response(null, { status: 202, headers: { Location: `${url}u1` } });
    const digest = new URL(url).searchParams.get('digest') ?? '';
    if (method !== 'PUT' || digest !== `sha256:${sha256hex(body ?? '')}`) return new Response(null, { status: 400 });
    blobs.add(digest);
    return new Response(null, { status: 201 });
  }
  const tag = decodeURIComponent(url.split('/manifests/')[1] ?? '');
  if (method === 'PUT') {
    const bytes = body ?? '';
    // Real registries refuse a manifest whose config/layer blobs they do not
    // hold (MANIFEST_BLOB_UNKNOWN). The pre-F191 driver never uploaded any.
    const man = JSON.parse(bytes) as { config?: { digest?: string }; layers?: Array<{ digest?: string }> };
    const refs = [man.config?.digest, ...(man.layers ?? []).map((l) => l.digest)];
    if (refs.some((d) => typeof d !== 'string' || !blobs.has(d))) {
      return new Response('{"errors":[{"code":"MANIFEST_BLOB_UNKNOWN"}]}', { status: 400 });
    }
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
  blobs.clear();
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
const marker = (digest: string, extra: Record<string, unknown> = {}): Buffer =>
  Buffer.from(JSON.stringify({ digest, ...extra, ts: 1_700_000_000_000 }));

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
    const blob = Buffer.from(JSON.stringify({ digest: D('auth'), sizeBytes: 1, ts: 0 }));
    await cache.store('ndbuild:auth', blob);
    const putCall = manifestPuts()[0];
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
    const blob = Buffer.from(JSON.stringify({ digest: D('shape'), sizeBytes: 42, ts: 0 }));
    await cache.store('ndbuild:shape', blob);
    const putCall = manifestPuts()[0];
    expect(putCall).toBeDefined();
    expect(putCall?.init.headers?.['Content-Type']).toMatch(/application\/vnd\.oci\.image\.manifest/);
    const body = JSON.parse(putCall?.init.body ?? '{}') as {
      schemaVersion: number;
      config?: { digest: string };
      layers?: Array<{ digest: string }>;
      annotations?: Record<string, string>;
    };
    expect(body.schemaVersion).toBe(2);
    // F191: config + layer are the uploaded empty blob; the pointer rides in the annotations.
    expect(body.config?.digest).toBe(EMPTY_BLOB_DIGEST);
    expect(body.layers?.map((l) => l.digest)).toEqual([EMPTY_BLOB_DIGEST]);
    expect(body.annotations?.['io.ninedeploy.build-cache.digest']).toBe(D('shape'));
    expect(body.annotations?.['io.ninedeploy.build-cache.size']).toBe('42');
  });

  it('maps a key with non-tag-safe characters to a valid OCI tag', async () => {
    const cache = newCache();
    const blob = Buffer.from(JSON.stringify({ digest: D('tag'), sizeBytes: 1, ts: 0 }));
    await cache.store('ndbuild:abc/123', blob);
    // The registry path should contain a tag without `/`.
    const putCall = manifestPuts()[0];
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
  // F864: a RepoDigest-shaped digest is now split into digest + ref (next
  // test), so the placeholder branch is exercised with a digest that is
  // neither `sha256:` nor a valid `<repo>@sha256:` reference.
  it('resolves the placeholder digest for a marker whose digest lacks the sha256: prefix (r026 regression)', async () => {
    const blob = Buffer.from(
      JSON.stringify({ digest: `Registry.example.com/NineDeploy/App@${LAYER_DIGEST}`, ts: 1 }),
    );
    const stored = await newCache().store('ndbuild:prefixless', blob);
    const hex = createHash('sha256').update(blob).digest('hex');
    expect(stored.digest, 'a rejected marker must fall back to the blob digest, never reject').toBe(
      `sha256:${hex}`,
    );
    expect(stored.ref).toBeUndefined();
  });

  // F864: the pullable reference rides in a manifest annotation next to the
  // pointer and comes back from lookup(); an invalid one is never pushed, a
  // pre-F864 tag (no annotation) still hits but carries no ref.
  it('F864: persists the marker ref as a manifest annotation and returns it on lookup', async () => {
    const ref = `registry.example.com/ninedeploy/app@${LAYER_DIGEST}`;
    const cache = newCache();
    const stored = await cache.store(KEY, marker(LAYER_DIGEST, { ref }));
    expect(stored).toMatchObject({ digest: LAYER_DIGEST, ref });
    const put = JSON.parse(manifestPuts().at(-1)?.init.body ?? '{}') as { annotations?: Record<string, string> };
    expect(put.annotations?.['io.ninedeploy.build-cache.ref']).toBe(ref);
    expect(await cache.lookup(KEY)).toMatchObject({ digest: LAYER_DIGEST, ref });
    // Pre-F864 shape: the RepoDigest sat in `digest` — split, not hashed.
    const legacy = await cache.store(KEY, Buffer.from(JSON.stringify({ digest: ref, ts: 1 })));
    expect(legacy).toMatchObject({ digest: LAYER_DIGEST, ref });
  });

  it('F864: a manifest pointer that is only `sha256:`-prefixed reads as cold, not a hit', async () => {
    // No row for KEY: the manifest alone would be trusted as a hit (an
    // instance that joined an existing cluster), so the pointer check is all
    // that stands between a malformed tag and a "hit".
    const cache = newCache();
    blobs.add(EMPTY_BLOB_DIGEST);
    const tag = `ndbuild-${KEY.slice('ndbuild:'.length)}`;
    const empty = { mediaType: 'application/vnd.oci.empty.v1+json', digest: EMPTY_BLOB_DIGEST, size: 2 };
    for (const annotations of [
      { 'io.ninedeploy.build-cache.digest': 'sha256:abc' },
      { 'io.ninedeploy.build-cache.digest': `sha256:${'A'.repeat(64)}` },
    ]) {
      await registryFetch(`https://registry.example.com/v2/ninedeploy/test/manifests/${tag}`, {
        method: 'PUT',
        body: JSON.stringify({ schemaVersion: 2, config: empty, layers: [empty], annotations }),
      });
      expect(await cache.lookup(KEY)).toBeNull();
    }
    // Legacy tag shape (pointer as layers[0]) with a short digest: also cold.
    blobs.add('sha256:abc');
    await registryFetch(`https://registry.example.com/v2/ninedeploy/test/manifests/${tag}`, {
      method: 'PUT',
      body: JSON.stringify({ schemaVersion: 2, config: empty, layers: [{ digest: 'sha256:abc', size: 1 }] }),
    });
    expect(await cache.lookup(KEY)).toBeNull();
  });

  it('F864: drops an invalid or mismatched ref; a ref-less tag still hits without one', async () => {
    const cache = newCache();
    for (const bad of [
      `registry.example.com/ninedeploy/app@${LAYER_DIGEST},type=local,src=/`,
      `registry.example.com/ninedeploy/app@${OTHER_LAYER_DIGEST}`,
      'registry.example.com/ninedeploy/app:latest',
    ]) {
      const stored = await cache.store(KEY, marker(LAYER_DIGEST, { ref: bad }));
      expect(stored.ref, bad).toBeUndefined();
      const put = JSON.parse(manifestPuts().at(-1)?.init.body ?? '{}') as { annotations?: Record<string, string> };
      expect(put.annotations?.['io.ninedeploy.build-cache.ref'], bad).toBeUndefined();
      const hit = await cache.lookup(KEY);
      expect(hit?.digest).toBe(LAYER_DIGEST);
      expect(hit && 'ref' in hit).toBe(false);
    }
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

/**
 * F188. The key → tag mapping must be injective: lookup() trusts any marker
 * at tagFor(key) as this key's content (cluster-join branch). Folding bad
 * chars to `-` and truncating at 128 aliased distinct keys, so a never-stored
 * key read another key's digest as a HIT and storing it evicted the other.
 */
describe('RegistryBuildCache key → tag mapping (F188 regression)', () => {
  const putTags = (): string[] =>
    manifestPuts().map((c) => c.url.split('/manifests/')[1] ?? '');

  it('does not alias `ndbuild:x` with `ndbuild-x`, nor two keys sharing 128 chars', async () => {
    const cache = newCache();
    await cache.store('ndbuild:abc', marker(LAYER_DIGEST));
    expect(await cache.lookup('ndbuild-abc'), 'a never-stored key must miss').toBeNull();

    const long = 'k'.repeat(128);
    await cache.store(`${long}1`, marker(LAYER_DIGEST));
    expect(await cache.lookup(`${long}2`), 'a never-stored key must miss').toBeNull();

    await cache.store('ndbuild-abc', marker(OTHER_LAYER_DIGEST));
    expect((await cache.lookup('ndbuild:abc'))?.digest, 'storing another key must not evict this one').toBe(
      LAYER_DIGEST,
    );
  });

  it('keeps the production tag for canonical keys and emits valid tags for everything else', async () => {
    const cache = newCache();
    await cache.store(KEY, marker(LAYER_DIGEST));
    expect(putTags()[0]).toBe(KEY.replace(':', '-'));

    for (const k of ['-lead', 'ndbuild:', 'ndbuild:ü', 'x'.repeat(300), `ndbuild:${'a'.repeat(121)}`]) {
      await cache.store(k, marker(LAYER_DIGEST));
    }
    const tagsPut = putTags();
    expect(new Set(tagsPut).size).toBe(tagsPut.length);
    for (const t of tagsPut) expect(t).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/);
  });
});

/**
 * F189. store() was findFirst → insert: two concurrent first stores of one
 * key both read "no row", the second insert hit UNIQUE(key, backend, repo)
 * and store() rejected AFTER its manifest PUT landed — registry and row then
 * disagreed and the next lookup missed. Gated with a barrier, no sleeps.
 */
describe('RegistryBuildCache concurrent store (F189 regression)', () => {
  function gatedDb(parties: number): typeof db {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const realQuery = db.query.cacheRegistryBlobs;
    const query = new Proxy(db.query, {
      get(t, p, r) {
        if (p !== 'cacheRegistryBlobs') return Reflect.get(t, p, r);
        return {
          findFirst: async (...args: Parameters<typeof realQuery.findFirst>) => {
            const row = await realQuery.findFirst(...args);
            arrived += 1;
            if (arrived >= parties) release();
            await gate; // neither racer may write until both have read
            return row;
          },
        };
      },
    });
    return new Proxy(db, { get: (t, p, r) => (p === 'query' ? query : Reflect.get(t, p, r)) });
  }

  it('two first stores that both read "no row" both resolve into one hittable row', async () => {
    const racing = new RegistryBuildCache({
      db: gatedDb(2),
      credentials: { url: 'https://registry.example.com', repo: 'ninedeploy/test' },
      fetchImpl: registryFetch,
    });
    const results = await Promise.allSettled([
      racing.store(KEY, marker(LAYER_DIGEST)),
      racing.store(KEY, marker(OTHER_LAYER_DIGEST)),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await client.execute('SELECT digest FROM "cache_registry_blobs"');
    expect(rows.rows).toHaveLength(1);
    expect((await newCache().lookup(KEY))?.digest, 'row and registry must agree after the race').toBe(
      OTHER_LAYER_DIGEST,
    );
  });
});

/**
 * F191. The marker manifest referenced a config blob and a layer blob it
 * never uploaded; an enforcing registry answers MANIFEST_BLOB_UNKNOWN, so
 * store() always failed and the backend never cached. The fake above refuses
 * exactly that, like distribution's OCI manifest verifier.
 */
describe('RegistryBuildCache conformant push (F191 regression)', () => {
  it('uploads the blobs a marker references before the manifest, and the round-trip hits', async () => {
    const cache = newCache();
    await expect(cache.store(KEY, marker(LAYER_DIGEST))).resolves.toMatchObject({ digest: LAYER_DIGEST });
    const order = calls.map((c) => `${c.init.method} ${new URL(c.url).pathname.split('/').slice(-2).join('/')}`);
    expect(order.indexOf(`PUT manifests/${KEY.replace(':', '-')}`)).toBeGreaterThan(
      order.findIndex((o) => o.startsWith('PUT uploads/')),
    );
    expect((await cache.lookup(KEY))?.digest).toBe(LAYER_DIGEST);
  });

  it('still reads a legacy tag whose pointer is layers[0].digest', async () => {
    const legacy = JSON.stringify({
      schemaVersion: 2,
      config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: EMPTY_BLOB_DIGEST, size: 2 },
      layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: LAYER_DIGEST, size: 3 }],
    });
    tags.set(KEY.replace(':', '-'), { bytes: legacy, manifestDigest: `sha256:${sha256hex(legacy)}` });
    expect(await newCache().lookup(KEY)).toMatchObject({ digest: LAYER_DIGEST, sizeBytes: 3 });
  });
});

/**
 * F190. Registry calls had no deadline: a registry that accepts the
 * connection and never answers held the build's cache lookup until undici's
 * own 300 s default. Real 127.0.0.1 listener + real fetch; fake timers drive
 * the 10 s deadline; gated on the request bytes arriving, no sleeps.
 */
describe('RegistryBuildCache request deadline (F190 regression)', () => {
  it('a stalled registry reads as a miss once the deadline passes', async () => {
    const sockets: Socket[] = [];
    let seen!: () => void;
    const requestSeen = new Promise<void>((r) => {
      seen = r;
    });
    const server = createServer((sock) => {
      sockets.push(sock);
      sock.on('error', () => {});
      sock.once('data', () => seen()); // read the request, never answer
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const cache = new RegistryBuildCache({ db, credentials: { url: `http://127.0.0.1:${port}`, repo: 'nd/test' } });
      let state = 'pending';
      void cache.lookup(KEY).then((v) => {
        state = v === null ? 'miss' : 'hit';
      });
      await requestSeen;
      await vi.advanceTimersByTimeAsync(9_999);
      expect(state, 'not before the deadline').toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      // Bounded event-loop turns (not wall-clock) so a missing deadline fails fast instead of hanging.
      for (let i = 0; i < 20 && state === 'pending'; i++) await new Promise<void>((r) => setImmediate(r));
      expect(state).toBe('miss');
    } finally {
      vi.useRealTimers();
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
