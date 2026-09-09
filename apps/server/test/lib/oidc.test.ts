/**
 * Unit coverage for lib/oidc.ts verifyIdToken.
 *
 * Signs real RS256 tokens with throwaway RSA keypairs and serves the matching
 * JWKS through a stubbed fetch, so issuer/azp/kid handling is exercised the
 * way an IdP exercises it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrivateKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { generateOpaqueToken, hashState, hmacSha256, timingSafeStringEqual, verifyIdToken, type OidcConfig, type OidcDiscovery } from '../../src/lib/oidc.js';

interface TestKey {
  kid: string;
  privatePem: string;
  jwk: { kty: 'RSA'; kid: string; use: 'sig'; alg: 'RS256'; n: string; e: string };
}

function makeKey(kid: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  return {
    kid,
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    jwk: { kty: 'RSA', kid, use: 'sig', alg: 'RS256', n: jwk.n!, e: jwk.e! },
  };
}

const b64u = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

function signToken(key: TestKey, payload: Record<string, unknown>, includeKid = true): string {
  const header = { alg: 'RS256', ...(includeKid ? { kid: key.kid } : {}) };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = cryptoSign('RSA-SHA256', Buffer.from(input), createPrivateKey(key.privatePem));
  return `${input}.${b64u(sig)}`;
}

const claims = (over: Record<string, unknown> = {}) => ({
  sub: 'user-1',
  iss: 'https://idp.example.com',
  aud: 'client-id',
  exp: Math.floor(Date.now() / 1000) + 600,
  iat: Math.floor(Date.now() / 1000),
  ...over,
});

const discovery = (jwksUri: string): OidcDiscovery => ({
  authorization_endpoint: 'https://idp.example.com/auth',
  token_endpoint: 'https://idp.example.com/token',
  jwks_uri: jwksUri,
});

const config: OidcConfig = {
  issuer: 'https://idp.example.com',
  clientId: 'client-id',
  clientSecret: 'secret',
  redirectUri: 'https://panel.example.com/v1/auth/oidc/test/callback',
};

const jwksResponse = (keys: unknown) =>
  ({ ok: true, status: 200, json: async () => ({ keys }) }) as never;

// Each test gets its own jwks_uri so the module-level JWKS cache (TTL 5 min)
// never leaks entries between cases.
let uriCounter = 0;
let fetchMock: ReturnType<typeof vi.fn>;
const origFetch = globalThis.fetch;

beforeEach(() => {
  uriCounter += 1;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as never;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

describe('lib/oidc verifyIdToken', () => {
  it('verifies a well-formed token', async () => {
    const key = makeKey('k1');
    const uri = `https://idp.example.com/jwks-${uriCounter}`;
    fetchMock.mockResolvedValue(jwksResponse([key.jwk]));
    const out = await verifyIdToken(discovery(uri), config, signToken(key, claims()), '');
    expect(out.sub).toBe('user-1');
  });

  it('treats a trailing-slash issuer as equivalent to the configured one', async () => {
    const key = makeKey('k1');
    const uri = `https://idp.example.com/jwks-${uriCounter}`;
    fetchMock.mockResolvedValue(jwksResponse([key.jwk]));
    // Auth0-style providers emit `iss` WITH the trailing slash even when the
    // operator configured the URL without it (discovery already tolerates
    // both) — the claim check must not hard-fail on slash equivalence.
    const token = signToken(key, claims({ iss: 'https://idp.example.com/' }));
    await expect(verifyIdToken(discovery(uri), config, token, '')).resolves.toBeTruthy();

    const cfgSlash = { ...config, issuer: 'https://idp.example.com/' };
    const token2 = signToken(key, claims({ iss: 'https://idp.example.com' }));
    await expect(verifyIdToken(discovery(uri), cfgSlash, token2, '')).resolves.toBeTruthy();
  });

  it('rejects a multi-valued aud without a matching azp claim (OIDC Core §3.1.3.7)', async () => {
    const key = makeKey('k1');
    const uri = `https://idp.example.com/jwks-${uriCounter}`;
    fetchMock.mockResolvedValue(jwksResponse([key.jwk]));
    // A token minted for ANOTHER client that merely lists us as a secondary
    // audience must not verify.
    const noAzp = signToken(key, claims({ aud: ['other-client', 'client-id'] }));
    await expect(verifyIdToken(discovery(uri), config, noAzp, '')).rejects.toThrow(/azp/);

    const wrongAzp = signToken(key, claims({ aud: ['other-client', 'client-id'], azp: 'other-client' }));
    await expect(verifyIdToken(discovery(uri), config, wrongAzp, '')).rejects.toThrow(/azp/);

    const okAzp = signToken(key, claims({ aud: ['other-client', 'client-id'], azp: 'client-id' }));
    await expect(verifyIdToken(discovery(uri), config, okAzp, '')).resolves.toBeTruthy();
  });

  it('refreshes the JWKS once when the token kid is unknown (IdP key rotation)', async () => {
    const oldKey = makeKey('old');
    const newKey = makeKey('new');
    const uri = `https://idp.example.com/jwks-${uriCounter}`;
    // First fetch serves the pre-rotation key set; the forced refresh after
    // the unknown kid serves the rotated set.
    fetchMock
      .mockResolvedValueOnce(jwksResponse([oldKey.jwk]))
      .mockResolvedValue(jwksResponse([oldKey.jwk, newKey.jwk]));

    const token = signToken(newKey, claims());
    await expect(verifyIdToken(discovery(uri), config, token, '')).resolves.toBeTruthy();
    // Exactly one forced refresh on top of the initial fetch.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still falls back to the single JWKS key when the token omits kid', async () => {
    const key = makeKey('k1');
    const uri = `https://idp.example.com/jwks-${uriCounter}`;
    fetchMock.mockResolvedValue(jwksResponse([key.jwk]));
    const token = signToken(key, claims(), false);
    await expect(verifyIdToken(discovery(uri), config, token, '')).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when the kid stays unknown after the forced refresh', async () => {
    const key = makeKey('real');
    const ghost = makeKey('ghost'); // never published by the IdP
    const uri = `https://idp.example.com/jwks-${uriCounter}`;
    fetchMock.mockResolvedValue(jwksResponse([key.jwk]));
    const token = signToken(ghost, claims());
    await expect(verifyIdToken(discovery(uri), config, token, '')).rejects.toThrow(/kid/);
    // The refresh was attempted before giving up.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// r018 regression (the r007 defect class): this package runs as pure ESM
// (`node dist/server.js`), where `require` does not exist. verifyRs256 used
// to call `require('node:crypto')` — vitest's module runner shims require,
// so every test above stayed green while production OIDC logins died with
// `ReferenceError: require is not defined` at signature verification. The
// durable guard is source-level: no `require(` call syntax may appear in
// this module.
describe('ESM purity (r018 regression)', () => {
  it('never references CJS require — the runtime is `node dist/server.js`', async () => {
    const src = await readFile(new URL('../../src/lib/oidc.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});

describe('pure helpers (r039 coverage)', () => {
  it('generateOpaqueToken returns unpadded url-safe base64 of the requested bytes', () => {
    const token = generateOpaqueToken(32);
    // 32 bytes → 43 base64url chars with padding stripped.
    expect(token).toHaveLength(43);
    expect(token).not.toMatch(/[+/=]/);
    expect(generateOpaqueToken(16)).toHaveLength(22);
  });

  it('hashState is a deterministic sha256 hex digest', () => {
    expect(hashState('state-1')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashState('state-1')).toBe(hashState('state-1'));
    expect(hashState('state-2')).not.toBe(hashState('state-1'));
  });

  it('timingSafeStringEqual accepts equal strings and rejects unequal ones', () => {
    expect(timingSafeStringEqual('same', 'same')).toBe(true);
    expect(timingSafeStringEqual('same', 'other')).toBe(false);
  });

  it('hmacSha256 is deterministic, url-safe and key-sensitive', () => {
    expect(hmacSha256('secret', 'payload')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hmacSha256('secret', 'payload')).toBe(hmacSha256('secret', 'payload'));
    expect(hmacSha256('secret', 'payload')).not.toBe(hmacSha256('other', 'payload'));
  });
});
