import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createDb, runMigrations, type DB } from '@ninedeploy/db';
import { describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import { authRoutes } from '../../src/modules/auth.js';
import { asUser, buildTestApp } from '../helpers.js';

/**
 * D2/F989 regression: passkeys registered before F340 hold a double-encoded
 * credential id (base64url(utf8(id))). Login falls back to that form when the
 * canonical id misses and, once the assertion verifies, rewrites the row —
 * conditionally on the old value. Remove together with the fallback.
 *
 * REAL in-memory SQLite (the rewrite is a conditional UPDATE a fake db would
 * ignore), the real routes and the REAL @simplewebauthn/server against a small
 * ES256 authenticator below. lib/webauthn is wrapped only to count fallback
 * lookups and to park a login after verification on a deferred (no sleeps).
 */
const hooks = vi.hoisted(() => ({ legacyCalls: 0, parked: [] as Array<() => Promise<void>> }));
vi.mock('../../src/lib/webauthn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/webauthn.js')>();
  return {
    ...actual,
    legacyCredentialId: (id: string) => {
      hooks.legacyCalls++;
      return actual.legacyCredentialId(id);
    },
    finishAuthentication: async (...args: Parameters<typeof actual.finishAuthentication>) => {
      const n = await actual.finishAuthentication(...args);
      await hooks.parked.shift()?.();
      return n;
    },
  };
});
const { beginRegistration, finishRegistration } = await import('../../src/lib/webauthn.js');

const url = new URL(config.publicUrl);
const ORIGIN = url.origin;
const RPID = url.hostname;
const b64u = (b: Buffer) => b.toString('base64url');
const preF340 = (canonical: string) => Buffer.from(canonical).toString('base64url');

/** Minimal "none"-attestation ES256 authenticator (CBOR for small ints/maps only). */
function authenticator(rawId: Buffer = randomBytes(16)) {
  const cbor = (v: unknown): Buffer => {
    const hd = (m: number, n: number) =>
      n < 24 ? Buffer.from([(m << 5) | n]) : n < 256 ? Buffer.from([(m << 5) | 24, n]) : Buffer.from([(m << 5) | 25, n >> 8, n & 255]);
    if (typeof v === 'number') return v >= 0 ? hd(0, v) : hd(1, -1 - v);
    if (typeof v === 'string') return Buffer.concat([hd(3, Buffer.byteLength(v)), Buffer.from(v)]);
    if (Buffer.isBuffer(v)) return Buffer.concat([hd(2, v.length), v]);
    const m = v as Map<unknown, unknown>;
    return Buffer.concat([hd(5, m.size), ...[...m].flatMap(([k, val]) => [cbor(k), cbor(val)])]);
  };
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = cbor(new Map<unknown, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
  const rpHash = createHash('sha256').update(RPID).digest();
  const clientData = (type: string, challenge: string) => Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));
  const id = b64u(rawId);
  return {
    id,
    register: (challenge: string) => {
      const authData = Buffer.concat([rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, rawId.length]), rawId, cose]);
      const att = cbor(new Map<unknown, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(clientData('webauthn.create', challenge)), attestationObject: b64u(att) } };
    },
    assert: (challenge: string, counter: number) => {
      const c = Buffer.alloc(4);
      c.writeUInt32BE(counter);
      const authData = Buffer.concat([rpHash, Buffer.from([0x05]), c]);
      const cd = clientData('webauthn.get', challenge);
      const sig = sign('sha256', Buffer.concat([authData, createHash('sha256').update(cd).digest()]), privateKey);
      return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(sig) } };
    },
  };
}
type Authenticator = ReturnType<typeof authenticator>;

async function setup() {
  const { db, client, ready } = createDb({ url: ':memory:' });
  await ready;
  await runMigrations(db);
  const sqlite = client!;
  const app = await buildTestApp({ db: db as DB });
  await app.register(authRoutes);
  const ids = async () => (await sqlite.execute('SELECT credential_id FROM webauthn_credentials ORDER BY id')).rows.map((r) => String(r.credential_id));
  const seed = async (email: string, form: 'legacy' | 'canonical', auth = authenticator()) => {
    const uid = Number((await sqlite.execute({ sql: "INSERT INTO users (email, password_hash) VALUES (?, 'x') RETURNING id", args: [email] })).rows[0]!.id);
    const user = { id: uid, email, name: null };
    const opts = JSON.parse(await beginRegistration(user, []));
    const stored = await finishRegistration(user, [], auth.register(opts.challenge));
    const storedId = form === 'legacy' ? preF340(stored.credentialId) : stored.credentialId;
    await sqlite.execute({
      sql: "INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, name) VALUES (?, ?, ?, 0, '[]', 'key')",
      args: [uid, storedId, stored.publicKey],
    });
    return { uid, user, auth, storedId };
  };
  const login = async (auth: Authenticator, counter: number, override?: string) => {
    const opts = await app.inject({ method: 'POST', url: '/passkey/login/options' });
    const response = { ...auth.assert(JSON.parse(opts.json().options).challenge, counter), ...(override ? { id: override, rawId: override } : {}) };
    const res = await app.inject({ method: 'POST', url: '/passkey/login/verify', payload: { response } });
    return { status: res.statusCode, body: res.json() };
  };
  return { app, sqlite, ids, seed, login };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('D2/F989: pre-F340 passkey credential ids (lazy migration)', () => {
  it('signs a legacy row in, rewrites it to the canonical id, and the next login takes the canonical path', async () => {
    const t = await setup();
    const { uid, auth, storedId } = await t.seed('legacy@example.com', 'legacy');
    expect(storedId).not.toBe(auth.id);
    const first = await t.login(auth, 1);
    expect(first.status).toBe(200);
    expect(first.body.user.id).toBe(uid);
    expect(await t.ids()).toEqual([auth.id]);
    const calls = hooks.legacyCalls;
    expect((await t.login(auth, 2)).status).toBe(200);
    expect(hooks.legacyCalls).toBe(calls);
  });

  it('leaves a canonical row alone and never consults the fallback', async () => {
    const t = await setup();
    const { auth } = await t.seed('canonical@example.com', 'canonical');
    const calls = hooks.legacyCalls;
    expect((await t.login(auth, 1)).status).toBe(200);
    expect(hooks.legacyCalls).toBe(calls);
    expect(await t.ids()).toEqual([auth.id]);
  });

  it('rewrites conditionally: a change made after the read survives the stale login (gated)', async () => {
    const t = await setup();
    const { auth } = await t.seed('race@example.com', 'legacy');
    const arrived = deferred();
    const release = deferred();
    hooks.parked.push(async () => {
      arrived.resolve();
      await release.promise;
    });
    const pending = t.login(auth, 1);
    await arrived.promise; // read the legacy row and verified; not yet rewritten
    await t.sqlite.execute("UPDATE webauthn_credentials SET credential_id = 'changed-concurrently'");
    release.resolve();
    expect((await pending).status).toBe(200);
    expect(await t.ids()).toEqual(['changed-concurrently']);
  });

  it('refuses an unknown id, and never migrates a legacy row on a failed verification', async () => {
    const t = await setup();
    const { auth: victim, storedId } = await t.seed('victim@example.com', 'legacy');
    const stranger = authenticator();
    const unknown = await t.login(stranger, 1);
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe('Unknown passkey');
    // Signed by the stranger's key while claiming the victim's id: found via the fallback, refused by the signature.
    expect((await t.login(stranger, 1, victim.id)).status).toBe(401);
    expect(await t.ids()).toEqual([storedId]);
  });

  it('keeps legacy rows manageable: re-enrolment refused, listed and deleted by row id', async () => {
    const t = await setup();
    const auth = authenticator(Buffer.from('00112233445566778899aabbccddeeff', 'hex'));
    const { uid, user, storedId } = await t.seed('manage@example.com', 'legacy', auth);
    const existing = [{ credentialId: storedId, transports: [] as string[] }];
    const opts = JSON.parse(await beginRegistration(user, existing));
    expect(opts.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([storedId, auth.id]);
    await expect(finishRegistration(user, existing, auth.register(opts.challenge))).rejects.toThrow(/already registered/);
    const list = await t.app.inject({ method: 'GET', url: '/passkey', headers: asUser(uid) });
    const [row] = list.json() as Array<{ id: number }>;
    expect(row).toBeDefined();
    const del = await t.app.inject({ method: 'DELETE', url: `/passkey/${row!.id}`, headers: asUser(uid) });
    expect(del.statusCode).toBe(200);
    expect(await t.ids()).toEqual([]);
  });
});
