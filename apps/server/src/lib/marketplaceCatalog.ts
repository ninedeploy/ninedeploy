/**
 * `ninedeploy plugins marketplace` — G-24 live signed
 * marketplace index.
 *
 * The static `MARKETPLACE_CATALOG` in `kernel/pluginLoader.ts`
 * is a code-time list — the panel could not discover new
 * plugins without a server release. This module fetches
 * a signed JSON index from a configured upstream URL
 * (`NINEDEPLOY_MARKETPLACE_URL`), verifies the ed25519
 * signature, and merges the result with the static
 * fallback so the panel never returns an empty list.
 *
 * Signature format: the response is a JSON envelope
 *
 *   { "entries": [...], "signature": "<base64>", "key_id": "ed25519:<short>" }
 *
 * The signature is over the canonical JSON of
 * `entries` (sorted keys, no whitespace). The public
 * key is supplied at deploy time as
 * `NINEDEPLOY_MARKETPLACE_PUBLIC_KEY` (base64-encoded
 * 32 bytes). When the env var is absent the module
 * skips verification and serves the static catalog
 * (a one-line dev affordance — production should
 * always set the key).
 *
 * The fetch is cached in-process for 5 minutes; the
 * `?refresh=true` route query / `refresh` SDK call
 * bypasses the cache.
 */
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { getMarketplaceCatalog } from '../kernel/pluginLoader.js';
import type { MarketplacePluginItem } from '@ninedeploy/schemas';
import { guardedFetch } from './egressGuard.js';

export interface MarketplaceCatalogResult {
  /** Items merged with the static catalog; the live entries
   *  take precedence (by id+version). */
  catalog: MarketplacePluginItem[];
  /** True when the live signed index was reached and
   *  verified. False when the upstream was unreachable
   *  and the static catalog was served. */
  live: boolean;
  /** The key id of the verifying key, when known. */
  keyId: string | null;
  /** When the cache was last refreshed. */
  fetchedAt: number;
}

interface SignedIndex {
  entries: SignedEntry[];
  signature: string;
  key_id: string;
}

interface SignedEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  category: string;
  homepage?: string;
  image?: string;
  // Plugins from the live index are not yet installable
  // in this build (the loader refuses `npm` / `git` /
  // `local` sources); the `source` field is informational.
  source?: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { result: MarketplaceCatalogResult; at: number } | null = null;

export function clearMarketplaceCache(): void {
  cache = null;
}

/**
 * Fetch the live signed index, verify it, and merge
 * with the static fallback. The `installedIds` set is
 * passed through so the panel's `isInstalled` badge
 * reflects the same data shape the in-code catalog
 * returns.
 */
export async function loadMarketplaceCatalog(
  installedIds: Set<string>,
  opts: { force?: boolean; url?: string; publicKey?: string } = {},
): Promise<MarketplaceCatalogResult> {
  const url = opts.url ?? process.env['NINEDEPLOY_MARKETPLACE_URL'];
  const publicKey = opts.publicKey ?? process.env['NINEDEPLOY_MARKETPLACE_PUBLIC_KEY'];

  if (!opts.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.result;
  }

  const fallback = baseResult(getMarketplaceCatalog(installedIds));

  if (!url) {
    // No upstream configured — return the static catalog
    // and mark the result as non-live.
    cache = { result: fallback, at: Date.now() };
    return cache.result;
  }

  let raw: string;
  try {
    const res = await guardedFetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      cache = { result: fallback, at: Date.now() };
      return cache.result;
    }
    raw = await res.text();
  } catch {
    cache = { result: fallback, at: Date.now() };
    return cache.result;
  }

  let parsed: SignedIndex;
  try {
    parsed = JSON.parse(raw) as SignedIndex;
  } catch {
    cache = { result: fallback, at: Date.now() };
    return cache.result;
  }

  if (!publicKey) {
    // Production with no key is a misconfiguration;
    // refuse to serve the live data rather than trust
    // an unverified blob. The fallback catalog is still
    // returned so the panel isn't empty.
    return fallback;
  }

  if (!verifyIndex(parsed, publicKey)) {
    return fallback;
  }

  // Merge: live entries are appended after the static
  // catalog entries (the static catalog stays as the
  // installable-surface baseline). The live entries are
  // marked `implemented: false` because nothing in this
  // build can actually load them yet — the `author`
  // defaults to 'Community' and `isOfficial: false` so
  // the panel renders them in a separate section.
  const staticById = new Map(fallback.catalog.map((c) => [c.id, c]));
  const merged: MarketplacePluginItem[] = [...fallback.catalog];
  for (const e of parsed.entries) {
    if (staticById.has(e.id)) continue; // never override an installable catalog entry
    merged.push({
      id: e.id,
      name: e.name,
      version: e.version,
      description: e.description,
      author: 'Community',
      icon: e.image,
      category: e.category,
      isOfficial: false,
      isInstalled: installedIds.has(e.id),
      implemented: false,
    });
  }
  const result: MarketplaceCatalogResult = {
    catalog: merged,
    live: true,
    keyId: parsed.key_id ?? null,
    fetchedAt: Date.now(),
  };
  cache = { result, at: Date.now() };
  return result;
}

// ── helpers ────────────────────────────────────────────────────────────────

function baseResult(catalog: MarketplacePluginItem[]): MarketplaceCatalogResult {
  return {
    catalog,
    live: false,
    keyId: null,
    fetchedAt: Date.now(),
  };
}

function verifyIndex(parsed: unknown, publicKeyBase64: string): boolean {
  if (!isSignedIndex(parsed)) return false;
  const key = decodeKey(publicKeyBase64);
  if (!key) return false;
  // The signature is over the canonical JSON of `entries`.
  const payload = canonicalize(parsed.entries);
  return edVerify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(parsed.signature, 'base64'));
}

function isSignedIndex(value: unknown): value is SignedIndex {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v['entries'])) return false;
  if (typeof v['signature'] !== 'string') return false;
  if (typeof v['key_id'] !== 'string') return false;
  return true;
}

function decodeKey(publicKeyBase64: string): ReturnType<typeof createPublicKey> | null {
  try {
    const raw = Buffer.from(publicKeyBase64, 'base64');
    if (raw.length !== 32) return null;
    // The env var carries the raw 32-byte Ed25519 public key
    // (NOT a 44-byte DER-encoded SPKI envelope). Node's
    // `createPublicKey` cannot read a raw 32-byte seed
    // directly, and the `{ format: 'der', type: 'spki' }` form
    // rejects the raw key with `Failed to read asymmetric key`.
    // The JWK form is the supported way to import a raw OKP
    // public key: `kty: 'OKP'`, `crv: 'Ed25519'`, and the
    // base64url-encoded `x` coordinate.
    const x = raw.toString('base64url');
    return createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x },
      format: 'jwk',
    });
  } catch {
    return null;
  }
}

/**
 * Canonical JSON for signature verification: sort
 * object keys recursively and emit without whitespace.
 * The reference signer is expected to use the same
 * routine (a 6-line loop).
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}
