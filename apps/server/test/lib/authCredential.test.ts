import { describe, expect, it, vi } from 'vitest';
import { authCredentialOf, bindAuthCredential, decodeAuthCredential, encodeAuthCredential, authCredentialIsLive, type AuthCredential } from '../../src/lib/authCredential.js';
import { studioCookieValue, studioCookieValid, studioSessionValid } from '../../src/modules/studioProxy.js';
import { createHmac } from 'node:crypto';
import { config } from '../../src/config.js';

const owner = { id: 1, tokenVersion: 0, isInstanceOperator: true, deactivatedAt: null };
const session: AuthCredential = { kind: 'session', jti: 'owned-session' };
const api: AuthCredential = { kind: 'api-token', hash: 'a'.repeat(64) };
const now = 2000000000000;
const db = (sessionRow: unknown, tokenRow: unknown) => ({ query: { users: { findFirst: vi.fn(async () => owner) }, sessions: { findFirst: vi.fn(async () => sessionRow) }, apiTokens: { findFirst: vi.fn(async () => tokenRow) } } });
describe('revocable authenticated credential references', () => {
  it('keeps the reference off serialized and spread user objects', () => {
    const user = bindAuthCredential({ id: 1 }, api);
    expect(authCredentialOf(user)).toEqual(api); expect(authCredentialOf({ ...user })).toBeUndefined();
    expect(JSON.stringify(user)).toBe('{"id":1}'); expect(Object.keys(user)).toEqual(['id']);
  });
  it.each([session, api, { kind: 'legacy-access', expiresAt: 2000000600 } as const])('round-trips a bounded reference $kind', value => {
    expect(decodeAuthCredential(encodeAuthCredential(value))).toEqual(value);
  });
  it.each(['', 'invalid=', 'a'.repeat(2049), Buffer.from('{').toString('base64url'), Buffer.from('{"kind":"other"}').toString('base64url'), Buffer.from('{"kind":"api-token","hash":"short"}').toString('base64url'), Buffer.from([255,255]).toString('base64url')])('refuses malformed encoded metadata %s', value => {
    expect(decodeAuthCredential(value)).toBeNull();
  });
  it.each([null, { userId: 2, revokedAt: null, expiresAt: new Date(now + 1000) }, { userId: 1, revokedAt: new Date(now), expiresAt: new Date(now + 1000) }, { userId: 1, revokedAt: null, expiresAt: new Date(now) }])('refuses a missing, reassigned, revoked or expired parent session', async row => {
    expect(await authCredentialIsLive(db(row, null) as never, 1, session, now)).toBe(false);
  });
  it('accepts only its live owned session', async () => {
    expect(await authCredentialIsLive(db({ userId: 1, revokedAt: null, expiresAt: new Date(now + 1000) }, null) as never, 1, session, now)).toBe(true);
  });
  it.each([null, { userId: 2, expiresAt: null, scopes: ['operator'] }, { userId: 1, expiresAt: new Date(now), scopes: ['operator'] }, { userId: 1, expiresAt: null, scopes: ['read'] }])('refuses a missing, reassigned, expired or narrowed parent API key', async row => {
    expect(await authCredentialIsLive(db(null, row) as never, 1, api, now)).toBe(false);
  });
  it.each([[], ['operator']])('accepts a live operator or legacy API token', async (...scopes) => {
    expect(await authCredentialIsLive(db(null, { userId: 1, expiresAt: new Date(now + 1000), scopes }) as never, 1, api, now)).toBe(true);
  });
  it('expires legacy access-token grants at their original expiration', async () => {
    const value = { kind: 'legacy-access', expiresAt: now / 1000 } as const;
    expect(await authCredentialIsLive({} as never, 1, value, now)).toBe(false);
    expect(await authCredentialIsLive({} as never, 1, value, now - 1)).toBe(true);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try { expect(studioCookieValue(7, owner, 28800, '0', { ...value, expiresAt: now / 1000 + 60 })).toMatchObject({ maxAgeS: 60 }); } finally { clock.mockRestore(); }
  });
  it('rejects old unbound signatures and binding removal/replacement without touching parent grants', async () => {
    const expiry = Math.floor(Date.now() / 1000) + 60;
    const old = createHmac('sha256', config.jwt.secret).update('7:' + expiry + ':0:1:0').digest('hex');
    expect(studioCookieValid(7, 'nd-studio-7=' + expiry + '.1.' + old, owner)).toBe(false);
    const cookie = studioCookieValue(7, owner, 60, '0', api).value.split('.');
    const fake = db(null, { userId: 1, scopes: [], expiresAt: null });
    expect(await studioSessionValid(fake as never, 7, 'nd-studio-7=' + [cookie[0],cookie[1],cookie[3]].join('.'), '0')).toBe(false);
    cookie[2] = encodeAuthCredential({ kind: 'api-token', hash: 'b'.repeat(64) });
    expect(await studioSessionValid(fake as never, 7, 'nd-studio-7=' + cookie.join('.'), '0')).toBe(false);
    expect(fake.query.apiTokens.findFirst).not.toHaveBeenCalled();
  });
});
