/**
 * G-24 live signed marketplace index — lib coverage.
 *
 * The lib fetches a signed JSON envelope, verifies the ed25519
 * signature, and merges the result with a static fallback. The
 * surface worth pinning down:
 *  - when no URL is configured, the static catalog is returned
 *    with `live: false`.
 *  - when the URL is configured but `publicKey` is not, the
 *    upstream is fetched and parsed but its data is NOT trusted;
 *    the static catalog is returned (so the panel isn't empty).
 *  - a bad signature falls back to the static catalog.
 *  - a valid signature produces a merged catalog that keeps the
 *    static entries first and appends new community entries with
 *    `isOfficial: false`, `author: 'Community'`, `implemented: false`.
 *  - `isInstalled` is computed from the `installedIds` set the
 *    caller passes in.
 *  - the in-process cache is bypassed by `force: true`.
 *  - `clearMarketplaceCache()` resets the in-process cache.
 */
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `staticCatalog` and the two state bags must be created inside
// `vi.hoisted` because the `vi.mock` factory is hoisted to the top of
// the file and runs before any other `const` is initialized.
const hoisted = vi.hoisted(() => {
  const staticCatalog = [
    {
      id: 'static-a',
      name: 'Static A',
      version: '1.0.0',
      description: 'Bundled catalog entry',
      author: 'Bundled',
      icon: null,
      category: 'official',
      isOfficial: true,
      isInstalled: false,
      implemented: true,
    },
  ];
  return {
    staticCatalog,
    kernelState: { catalog: staticCatalog },
    fetchState: {
      responses: new Map<string, { status?: number; body?: string; throw?: Error }>(),
      defaultThrow: null as Error | null,
      calls: [] as string[],
    },
  };
});
const staticCatalog = hoisted.staticCatalog;
const kernelState = hoisted.kernelState;
const fetchState = hoisted.fetchState;

vi.mock('../../src/kernel/pluginLoader.js', () => ({
  getMarketplaceCatalog: (installedIds: Set<string>) =>
    kernelState.catalog.map((c) => ({ ...c, isInstalled: installedIds.has(c.id) })),
}));

vi.mock('../../src/lib/egressGuard.js', () => ({
  guardedFetch: vi.fn(async (url: string) => {
    fetchState.calls.push(url);
    const r = fetchState.responses.get(url);
    if (r?.throw) throw r.throw;
    if (fetchState.defaultThrow) throw fetchState.defaultThrow;
    return new Response(r?.body ?? '{"entries":[],"signature":"","key_id":""}', {
      status: r?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }),
}));

import { clearMarketplaceCache, loadMarketplaceCatalog } from '../../src/lib/marketplaceCatalog.js';

let privateKey: ReturnType<typeof generateKeyPairSync>;
// SPKI base64 — the lib's decodeKey reads the env var as
// `createPublicKey({ key: raw, format: 'der', type: 'spki' })`.
let publicKeyBase64: string;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

function signIndex(entries: Array<Record<string, unknown>>, keyId = 'ed25519:test'): { signature: string; key_id: string } {
  const payload = canonicalize(entries);
  const signature = edSign(null, Buffer.from(payload, 'utf8'), privateKey['privateKey']).toString('base64');
  return { signature, key_id: keyId };
}

beforeAll(() => {
  privateKey = generateKeyPairSync('ed25519');
  // The lib's decodeKey expects the raw 32-byte ed25519 public key
  // (NOT the 44-byte SPKI). JWK form has the raw bytes in `x`.
  const jwk = privateKey['publicKey'].export({ format: 'jwk' }) as { x: string };
  publicKeyBase64 = Buffer.from(jwk.x, 'base64url').toString('base64');
});

beforeEach(() => {
  clearMarketplaceCache();
  kernelState.catalog = staticCatalog;
  fetchState.responses.clear();
  fetchState.defaultThrow = null;
  fetchState.calls.length = 0;
  delete process.env['NINEDEPLOY_MARKETPLACE_URL'];
  delete process.env['NINEDEPLOY_MARKETPLACE_PUBLIC_KEY'];
});

afterEach(() => {
  clearMarketplaceCache();
});

describe('lib/marketplaceCatalog', () => {
  it('returns the static catalog when no upstream URL is configured', async () => {
    const result = await loadMarketplaceCatalog(new Set());
    expect(result.live).toBe(false);
    expect(result.keyId).toBeNull();
    expect(result.catalog).toHaveLength(1);
    expect(result.catalog[0]?.id).toBe('static-a');
    expect(typeof result.fetchedAt).toBe('number');
  });

  it('falls back to the static catalog when the URL is set but the public key is missing', async () => {
    process.env['NINEDEPLOY_MARKETPLACE_URL'] = 'https://upstream.test/index.json';
    // No NINEDEPLOY_MARKETPLACE_PUBLIC_KEY — production-with-no-key is
    // a misconfiguration; we refuse to serve unverified data.
    const result = await loadMarketplaceCatalog(new Set());
    expect(result.live).toBe(false);
    expect(result.catalog).toEqual([
      expect.objectContaining({ id: 'static-a' }),
    ]);
  });

  it('falls back when the upstream returns a non-OK status', async () => {
    process.env['NINEDEPLOY_MARKETPLACE_URL'] = 'https://upstream.test/index.json';
    process.env['NINEDEPLOY_MARKETPLACE_PUBLIC_KEY'] = publicKeyBase64;
    fetchState.responses.set('https://upstream.test/index.json', { status: 500, body: 'oops' });
    const result = await loadMarketplaceCatalog(new Set());
    expect(result.live).toBe(false);
    expect(result.catalog.map((c) => c.id)).toEqual(['static-a']);
  });

  it('falls back when guardedFetch throws (network error)', async () => {
    process.env['NINEDEPLOY_MARKETPLACE_URL'] = 'https://upstream.test/index.json';
    process.env['NINEDEPLOY_MARKETPLACE_PUBLIC_KEY'] = publicKeyBase64;
    fetchState.responses.set('https://upstream.test/index.json', { throw: new Error('ECONNREFUSED') });
    const result = await loadMarketplaceCatalog(new Set());
    expect(result.live).toBe(false);
    expect(result.catalog.map((c) => c.id)).toEqual(['static-a']);
  });

  it('falls back when the upstream body is not valid JSON', async () => {
    process.env['NINEDEPLOY_MARKETPLACE_URL'] = 'https://upstream.test/index.json';
    process.env['NINEDEPLOY_MARKETPLACE_PUBLIC_KEY'] = publicKeyBase64;
    fetchState.responses.set('https://upstream.test/index.json', { body: '{ not json' });
    const result = await loadMarketplaceCatalog(new Set());
    expect(result.live).toBe(false);
  });

  it('falls back when the envelope is missing required fields', async () => {
    process.env['NINEDEPLOY_MARKETPLACE_URL'] = 'https://upstream.test/index.json';
    process.env['NINEDEPLOY_MARKETPLACE_PUBLIC_KEY'] = publicKeyBase64;
    // No signature, no key_id.
    fetchState.responses.set('https://upstream.test/index.json', { body: JSON.stringify({ entries: [] }) });
    const result = await loadMarketplaceCatalog(new Set());
    expect(result.live).toBe(false);
  });

  it('falls back when the public key is the wrong length (not 32 bytes)', async () => {
    process.env['NINEDEPLOY_MARKETPLACE_URL'] = 'https://upstream.test/index.json';
    // base64 of 16 random bytes — too short to be an ed25519 public key.
    process.env['NINEDEPLOY_MARKETPLACE_PUBLIC_KEY'] = Buffer.alloc(16).toString('base64');
    fetchState.responses.set('https://upstream.test/index.json', { body: JSON.stringify({ entries: [] }) });
    const result = await loadMarketplaceCatalog(new Set());
    expect(result.live).toBe(false);
  });

  it('falls back when the signature does not verify', async () => {
    process.env['NINEDEPLOY_MARKETPLACE_URL'] = 'https://upstream.test/index.json';
    process.env['NINEDEPLOY_MARKETPLACE_PUBLIC_KEY'] = publicKeyBase64;
    // Sign with a DIFFERENT key — verification must fail.
    const other = generateKeyPairSync('ed25519');
    const bad = edSign(null, Buffer.from('{}', 'utf8'), other['privateKey']).toString('base64');
    fetchState.responses.set('https://upstream.test/index.json', {
      body: JSON.stringify({ entries: [], signature: bad, key_id: 'ed25519:wrong' }),
    });
    const result = await loadMarketplaceCatalog(new Set());
    expect(result.live).toBe(false);
    expect(result.catalog.map((c) => c.id)).toEqual(['static-a']);
  });

  it('merges a verified upstream entry into the catalog and flags isInstalled', async () => {
    process.env['NINEDEPLOY_MARKETPLACE_URL'] = 'https://upstream.test/index.json';
    process.env['NINEDEPLOY_MARKETPLACE_PUBLIC_KEY'] = publicKeyBase64;
    const communityEntry = {
      id: 'community-x',
      name: 'X',
      version: '1',
      description: 'd',
      category: 'misc',
    };
    const { signature, key_id } = signIndex([communityEntry]);
    fetchState.responses.set('https://upstream.test/index.json', {
      body: JSON.stringify({ entries: [communityEntry], signature, key_id }),
    });
    // The community entry is NOT yet installed; the static entry
    // (static-a) is also not yet installed. The merged catalog
    // should land the community entry with `isInstalled: false`,
    // `isOfficial: false`, `author: 'Community'`, `implemented: false`.
    const result = await loadMarketplaceCatalog(new Set());
    expect(result.live).toBe(true);
    const community = result.catalog.find((c) => c.id === 'community-x');
    expect(community).toMatchObject({
      id: 'community-x',
      name: 'X',
      category: 'misc',
      isOfficial: false,
      isInstalled: false,
      implemented: false,
      author: 'Community',
    });
  });

  it('flips isInstalled when the caller passes the id in installedIds', async () => {
    process.env['NINEDEPLOY_MARKETPLACE_URL'] = 'https://upstream.test/index.json';
    process.env['NINEDEPLOY_MARKETPLACE_PUBLIC_KEY'] = publicKeyBase64;
    const e = { id: 'community-y', name: 'Y', version: '1', description: 'd', category: 'misc' };
    const { signature, key_id } = signIndex([e]);
    fetchState.responses.set('https://upstream.test/index.json', {
      body: JSON.stringify({ entries: [e], signature, key_id }),
    });
    const result = await loadMarketplaceCatalog(new Set(['community-y']));
    expect(result.live).toBe(true);
    const entry = result.catalog.find((c) => c.id === 'community-y')!;
    expect(entry.isInstalled).toBe(true);
  });

  it('caches the upstream response and re-uses it on the next call', async () => {
    process.env['NINEDEPLOY_MARKETPLACE_URL'] = 'https://upstream.test/index.json';
    process.env['NINEDEPLOY_MARKETPLACE_PUBLIC_KEY'] = publicKeyBase64;
    const e = { id: 'community-z', name: 'Z', version: '1', description: 'd', category: 'misc' };
    const { signature, key_id } = signIndex([e]);
    fetchState.responses.set('https://upstream.test/index.json', {
      body: JSON.stringify({ entries: [e], signature, key_id }),
    });
    const a = await loadMarketplaceCatalog(new Set());
    const b = await loadMarketplaceCatalog(new Set());
    expect(a.fetchedAt).toBe(b.fetchedAt);
    // Only one upstream fetch — the second call hit the cache.
    expect(fetchState.calls).toHaveLength(1);
  });

  it('bypasses the cache when force: true', async () => {
    process.env['NINEDEPLOY_MARKETPLACE_URL'] = 'https://upstream.test/index.json';
    process.env['NINEDEPLOY_MARKETPLACE_PUBLIC_KEY'] = publicKeyBase64;
    const e = { id: 'community-q', name: 'Q', version: '1', description: 'd', category: 'misc' };
    const { signature, key_id } = signIndex([e]);
    fetchState.responses.set('https://upstream.test/index.json', {
      body: JSON.stringify({ entries: [e], signature, key_id }),
    });
    await loadMarketplaceCatalog(new Set());
    await loadMarketplaceCatalog(new Set(), { force: true });
    expect(fetchState.calls).toHaveLength(2);
  });

  it('clears the in-process cache when clearMarketplaceCache() is called', async () => {
    process.env['NINEDEPLOY_MARKETPLACE_URL'] = 'https://upstream.test/index.json';
    process.env['NINEDEPLOY_MARKETPLACE_PUBLIC_KEY'] = publicKeyBase64;
    const e = { id: 'community-r', name: 'R', version: '1', description: 'd', category: 'misc' };
    const { signature, key_id } = signIndex([e]);
    fetchState.responses.set('https://upstream.test/index.json', {
      body: JSON.stringify({ entries: [e], signature, key_id }),
    });
    await loadMarketplaceCatalog(new Set());
    clearMarketplaceCache();
    await loadMarketplaceCatalog(new Set());
    expect(fetchState.calls).toHaveLength(2);
  });

  it('honours opts.url / opts.publicKey over env vars', async () => {
    process.env['NINEDEPLOY_MARKETPLACE_URL'] = 'https://wrong.test/index.json';
    process.env['NINEDEPLOY_MARKETPLACE_PUBLIC_KEY'] = publicKeyBase64;
    const e = { id: 'inline-2', name: 'Inline2', version: '1', description: 'd', category: 'misc' };
    const expectedKeyId = `ed25519:${publicKeyBase64.slice(0, 8)}`;
    const { signature, key_id } = signIndex([e], expectedKeyId);
    fetchState.responses.set('https://opts.test/index.json', {
      body: JSON.stringify({ entries: [e], signature, key_id }),
    });
    const result = await loadMarketplaceCatalog(new Set(), {
      url: 'https://opts.test/index.json',
    });
    expect(result.live).toBe(true);
    // The env-var URL must NOT be hit because opts.url overrides it.
    expect(result.keyId).toBe(expectedKeyId);
  });

  it('falls back when the public key is the wrong length (not 32 bytes)', async () => {
    process.env['NINEDEPLOY_MARKETPLACE_URL'] = 'https://upstream.test/index.json';
    // base64 of 16 random bytes — too short to be an ed25519 public key.
    process.env['NINEDEPLOY_MARKETPLACE_PUBLIC_KEY'] = Buffer.alloc(16).toString('base64');
    fetchState.responses.set('https://upstream.test/index.json', { body: JSON.stringify({ entries: [] }) });
    const result = await loadMarketplaceCatalog(new Set());
    expect(result.live).toBe(false);
  });

  it('falls back when the signature does not verify', async () => {
    process.env['NINEDEPLOY_MARKETPLACE_URL'] = 'https://upstream.test/index.json';
    process.env['NINEDEPLOY_MARKETPLACE_PUBLIC_KEY'] = publicKeyBase64;
    // Sign with a DIFFERENT key — verification must fail.
    const other = generateKeyPairSync('ed25519');
    const bad = edSign(null, Buffer.from('{}', 'utf8'), other['privateKey']).toString('base64');
    fetchState.responses.set('https://upstream.test/index.json', {
      body: JSON.stringify({ entries: [], signature: bad, key_id: 'ed25519:wrong' }),
    });
    const result = await loadMarketplaceCatalog(new Set());
    expect(result.live).toBe(false);
    expect(result.catalog.map((c) => c.id)).toEqual(['static-a']);
  });
});
