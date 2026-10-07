import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { beginAuthentication, beginRegistration, finishAuthentication, finishRegistration } from '../../src/lib/webauthn.js';

// Mock the WebAuthn library: the routes' contract is options/verify round-trips.
const swaMocks = vi.hoisted(() => ({
  generateRegistrationOptions: vi.fn(async () => ({ challenge: 'reg-challenge' })),
  generateAuthenticationOptions: vi.fn(async () => ({ challenge: 'auth-challenge' })),
  verifyRegistrationResponse: vi.fn(async () => ({
    verified: true,
    registrationInfo: {
      credential: { id: 'cred-id', publicKey: new Uint8Array([1, 2, 3]), counter: 7, transports: ['internal'] },
    },
  })),
  verifyAuthenticationResponse: vi.fn(async () => ({
    verified: true,
    authenticationInfo: { newCounter: 8 },
  })),
}));
vi.mock('@simplewebauthn/server', () => swaMocks);
// NOTE: webauthn.ts imports config via '../config.js' (= src/config.js).
vi.mock('../../src/config.js', () => ({ config: { publicUrl: 'https://panel.example.com' } }));

const user = { id: 1, email: 'admin@example.com', name: 'Admin' };

/** Assertion fixture carrying its challenge in clientDataJSON (as browsers do). */
const authResponse = (challenge: string): unknown => ({
  id: 'cred-id',
  response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge })).toString('base64url') },
});

describe('lib/webauthn', () => {
  it('begins a registration ceremony with exclude credentials', async () => {
    const options = await beginRegistration(user, [{ credentialId: 'existing', transports: ['internal'] }]);
    expect(JSON.parse(options).challenge).toBe('reg-challenge');
    expect(swaMocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ rpID: 'panel.example.com', userName: user.email }),
    );
  });

  it('finishes a registration and stores base64url material', async () => {
    const first = await beginRegistration(user, []);
    void first;
    const stored = await finishRegistration(user, [], { id: 'x' });
    expect(stored).toEqual({
      // F340: the library's credential.id is already base64url — stored as-is.
      credentialId: 'cred-id',
      publicKey: Buffer.from([1, 2, 3]).toString('base64url'),
      counter: 7,
      transports: ['internal'],
    });
  });

  it('rejects finishing a registration without a pending challenge', async () => {
    await expect(finishRegistration(user, [], { id: 'x' })).rejects.toThrow(/challenge/);
  });

  it('rejects registering a duplicate credential id', async () => {
    await beginRegistration(user, []);
    await expect(finishRegistration(user, [{ credentialId: 'cred-id' }], { id: 'x' })).rejects.toThrow(/already registered/);
  });

  it('propagates library verification failures', async () => {
    await beginRegistration(user, []);
    swaMocks.verifyRegistrationResponse.mockResolvedValueOnce({ verified: false, registrationInfo: undefined });
    await expect(finishRegistration(user, [], { id: 'x' })).rejects.toThrow(/verification failed/);
  });

  it('round-trips an authentication ceremony', async () => {
    const options = await beginAuthentication([{ credentialId: 'cred-id', transports: [] }]);
    expect(JSON.parse(options).challenge).toBe('auth-challenge');
    const counter = await finishAuthentication({ credentialId: 'cred-id', publicKey: 'AQID', counter: 0 }, authResponse('auth-challenge'));
    expect(counter).toBe(8);
    const call = swaMocks.verifyAuthenticationResponse.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(call.expectedRPID).toBe('panel.example.com');
    expect(call.expectedChallenge).toBe('auth-challenge');
    expect(call.expectedOrigin).toBe('https://panel.example.com');
  });

  it('rejects authentication without a pending challenge', async () => {
    await expect(finishAuthentication({ credentialId: 'c', publicKey: 'AQID', counter: 0 }, {})).rejects.toThrow(/challenge/);
  });

  it('propagates authentication verification failures', async () => {
    await beginAuthentication([]);
    swaMocks.verifyAuthenticationResponse.mockResolvedValueOnce({ verified: false, authenticationInfo: undefined });
    await expect(finishAuthentication({ credentialId: 'c', publicKey: 'AQID', counter: 0 }, authResponse('auth-challenge'))).rejects.toThrow(/verification failed/);
  });

  it('keeps concurrent login ceremonies isolated (no global challenge slot)', async () => {
    // Distinct challenges per begin — a single global slot would clobber the first.
    swaMocks.generateAuthenticationOptions
      .mockResolvedValueOnce({ challenge: 'ch-1' })
      .mockResolvedValueOnce({ challenge: 'ch-2' });
    await beginAuthentication([]);
    await beginAuthentication([]);
    // Ceremony 1 finishes with ITS challenge after ceremony 2 began.
    const counter = await finishAuthentication({ credentialId: 'c', publicKey: 'AQID', counter: 0 }, authResponse('ch-1'));
    expect(counter).toBe(8);
    const call = swaMocks.verifyAuthenticationResponse.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(call.expectedChallenge).toBe('ch-1');
    // Ceremony 2 still verifies with its own challenge afterwards.
    await expect(
      finishAuthentication({ credentialId: 'c', publicKey: 'AQID', counter: 8 }, authResponse('ch-2')),
    ).resolves.toBe(8);
  });

  it('falls back to the email as display name', async () => {
    await beginRegistration({ id: 9, email: 'x@example.com', name: null }, []);
    expect(swaMocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ userDisplayName: 'x@example.com' }),
    );
  });

  it('treats a missing transports list as empty', async () => {
    swaMocks.verifyRegistrationResponse.mockResolvedValueOnce({
      verified: true,
      registrationInfo: { credential: { id: 'x', publicKey: new Uint8Array([9]), counter: 1 } },
    });
    await beginRegistration(user, []);
    const stored = await finishRegistration(user, [], { id: 'x' });
    expect(stored.transports).toEqual([]);
  });

  it('expires stale challenges on use', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await beginRegistration(user, []);
    // Advance past the 5-minute TTL: the challenge must no longer verify.
    vi.setSystemTime(new Date('2026-01-01T00:06:00Z'));
    await expect(finishRegistration(user, [], { id: 'x' })).rejects.toThrow(/challenge/);
    vi.useRealTimers();
  });

  // F340 regression: against the REAL library (the mock above hid this), the
  // stored credentialId must be the id the browser reports at login — the login
  // route looks the row up by `response.id` with exact equality.
  it('F340: stores the credential id the browser sends at login (real library, fake ES256 authenticator)', async () => {
    const real = await vi.importActual<typeof import('@simplewebauthn/server')>('@simplewebauthn/server');
    swaMocks.generateRegistrationOptions.mockResolvedValueOnce({ challenge: 'f340-reg' });
    swaMocks.generateAuthenticationOptions.mockResolvedValueOnce({ challenge: 'f340-login' });
    swaMocks.verifyRegistrationResponse.mockImplementationOnce(real.verifyRegistrationResponse as never);
    swaMocks.verifyAuthenticationResponse.mockImplementationOnce(real.verifyAuthenticationResponse as never);

    const cbor = (v: unknown): Buffer => {
      const hd = (m: number, n: number) => (n < 24 ? Buffer.from([(m << 5) | n]) : Buffer.from([(m << 5) | 24, n]));
      if (typeof v === 'number') return v >= 0 ? hd(0, v) : hd(1, -1 - v);
      if (typeof v === 'string') return Buffer.concat([hd(3, v.length), Buffer.from(v)]);
      if (Buffer.isBuffer(v)) return Buffer.concat([hd(2, v.length), v]);
      const m = v as Map<unknown, unknown>;
      return Buffer.concat([hd(5, m.size), ...[...m].flatMap(([k, val]) => [cbor(k), cbor(val)])]);
    };
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = cbor(new Map<unknown, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
    const rawId = Buffer.from([0xfb, 0xff, 0xbf, 0xfe, 0x3e, 0x3f, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const browserId = rawId.toString('base64url'); // what navigator.credentials reports as `id`
    const rpHash = createHash('sha256').update('panel.example.com').digest();
    const clientData = (type: string, challenge: string) =>
      Buffer.from(JSON.stringify({ type, challenge, origin: 'https://panel.example.com', crossOrigin: false }));

    const regData = Buffer.concat([rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, rawId.length]), rawId, cose]);
    await beginRegistration(user, []);
    const stored = await finishRegistration(user, [], {
      id: browserId,
      rawId: browserId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientData('webauthn.create', 'f340-reg').toString('base64url'),
        attestationObject: cbor(new Map<unknown, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', regData]])).toString('base64url'),
      },
    });
    expect(stored.credentialId).toBe(browserId);

    await beginAuthentication();
    const authData = Buffer.concat([rpHash, Buffer.from([0x05, 0, 0, 0, 1])]);
    const cd = clientData('webauthn.get', 'f340-login');
    const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(cd).digest()]), privateKey);
    const assertion = {
      id: browserId,
      rawId: browserId,
      type: 'public-key',
      clientExtensionResults: {},
      response: { clientDataJSON: cd.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url') },
    };
    // The route's lookup, then the signature check against the stored row.
    expect([stored].find((row) => row.credentialId === assertion.id)).toBe(stored);
    await expect(finishAuthentication(stored, assertion)).resolves.toBe(1);
  });
});
