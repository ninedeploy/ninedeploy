import { describe, expect, it, vi } from 'vitest';
import type { OidcProvider } from '@ninedeploy/db';
import { oauthProviderFingerprint, resolveOAuthIdentity } from '../../src/lib/oauthIdentity.js';
import { createFakeDb, sessionRow, userRow } from '../helpers.js';

vi.mock('../../src/lib/crypto.js', () => ({
  hashPassword: vi.fn(async () => 'hash'),
  randomToken: vi.fn(() => 'random-password'),
  sha256: (value: string) => value,
}));

const provider = { id: 2, issuerUrl: 'https://idp.example', clientId: 'client', autoEnroll: true } as OidcProvider;
const info = { sub: 'stable-subject', email: 'alice@example.com', emailVerified: true };
const fingerprint = oauthProviderFingerprint(provider);
const local = userRow({ id: 9, email: info.email, tokenVersion: 3 });
const link = { userId: 9, sessionJti: 'session-jti', tokenVersion: 3, providerFingerprint: fingerprint };

describe('external identity account boundaries', () => {
  it('never links a pre-registered local account based on email alone', async () => {
    const grant = vi.fn(() => []);
    const db = createFakeDb({ findFirst: { users: local }, insert: { oauth_identities: grant } });
    await expect(resolveOAuthIdentity(db, provider, info)).rejects.toMatchObject({ statusCode: 403, code: 'account_link_required' });
    expect(grant).not.toHaveBeenCalled();
  });

  it('uses the durable subject link on later sign-ins', async () => {
    const db = createFakeDb({ findFirst: {
      users: local,
      oauthIdentities: { id: 1, userId: 9, providerFingerprint: fingerprint },
    } });
    expect(await resolveOAuthIdentity(db, provider, { ...info, email: 'changed@example.com' })).toMatchObject({ user: { id: 9 }, created: false });
  });

  it('invalidates a prior identity namespace after provider configuration changes', async () => {
    const db = createFakeDb({ findFirst: {
      users: local,
      oauthIdentities: { id: 1, userId: 9, providerFingerprint: 'old-provider' },
    } });
    await expect(resolveOAuthIdentity(db, provider, info)).rejects.toMatchObject({ code: 'account_link_required' });
  });

  it('links only after proving the initiating live local session', async () => {
    const grant = vi.fn(() => []);
    const db = createFakeDb({
      findFirst: { users: local, sessions: sessionRow({ userId: 9, jti: 'session-jti' }) },
      insert: { oauth_identities: grant },
    });
    expect(await resolveOAuthIdentity(db, provider, info, link)).toMatchObject({ user: { id: 9 }, created: false });
    expect(grant).toHaveBeenCalledWith(expect.objectContaining({ userId: 9, providerId: 2, subject: info.sub }));
  });

  it.each([
    { session: sessionRow({ userId: 9, revokedAt: new Date() }), user: local, binding: link },
    { session: sessionRow({ userId: 9, expiresAt: new Date(0) }), user: local, binding: link },
    { session: sessionRow({ userId: 8 }), user: local, binding: link },
    { session: sessionRow({ userId: 9 }), user: userRow({ ...local, tokenVersion: 4 }), binding: link },
    { session: sessionRow({ userId: 9 }), user: local, binding: { ...link, providerFingerprint: 'changed' } },
  ])('refuses a stale or mismatched session binding %#', async ({ session, user, binding }) => {
    const grant = vi.fn(() => []);
    const db = createFakeDb({ findFirst: { users: user, sessions: session }, insert: { oauth_identities: grant } });
    await expect(resolveOAuthIdentity(db, provider, info, binding)).rejects.toMatchObject({ statusCode: 401 });
    expect(grant).not.toHaveBeenCalled();
  });

  it('cannot relink another account’s subject', async () => {
    const db = createFakeDb({ findFirst: {
      users: local,
      sessions: sessionRow({ userId: 9 }),
      oauthIdentities: { id: 1, userId: 8, providerFingerprint: fingerprint },
    } });
    await expect(resolveOAuthIdentity(db, provider, info, link)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('requires matching verified emails even in an authenticated link flow', async () => {
    const db = createFakeDb({ findFirst: { users: local, sessions: sessionRow({ userId: 9 }) } });
    await expect(resolveOAuthIdentity(db, provider, { ...info, email: 'other@example.com' }, link)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('creates the new account and subject link in one transaction', async () => {
    const grant = vi.fn(() => []);
    const db = createFakeDb({ counts: { users: [{ n: 1 }] }, insert: { users: [local], oauth_identities: grant } });
    expect(await resolveOAuthIdentity(db, provider, info)).toMatchObject({ created: true, firstUser: false });
    expect(grant).toHaveBeenCalledWith(expect.objectContaining({ userId: 9, subject: info.sub }));
  });
});
