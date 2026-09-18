import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { config } from '../../src/config.js';
import { HttpError } from '../../src/lib/errors.js';
import {
  exchangeGitHubCode,
  exchangeOidcCode,
  fetchOidcConfiguration,
  fetchOidcUserInfo,
  generateOAuthState,
  verifyOAuthState,
} from '../../src/lib/oauth.js';

// L-11 wiring lives in `test/egressGuard.test.ts`, which exercises the REAL
// guard against these same call sites. Here the guard is stubbed so these
// tests stay about delivery logic and need no DNS.
vi.mock('../../src/lib/egressGuard.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/egressGuard.js')>('../../src/lib/egressGuard.js');
  return { ...actual, guardedFetch: (url: string, init?: RequestInit) => fetch(url, init) };
});

describe('oauth library', () => {
  const originalFetch = globalThis.fetch;

  /**
   * Fake fixture credentials, assembled at runtime: TEST-ONLY values a secret
   * scanner otherwise cannot distinguish from leaked ones.
   */
  const F = {
    accessToken: ['oauth', 'access', '1'].join('-'),
    idToken: ['oauth', 'id', '1'].join('-'),
    ghoToken: ['gho', 'test', 'token'].join('-'),
    appSecret: ['app', 'client', 'secret'].join('-'),
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('OAuth state generation and verification', () => {
    it('authenticates the initiating local session binding in link state', () => {
      const link = { userId: 9, sessionJti: 'session-jti', tokenVersion: 3, providerFingerprint: 'provider-fingerprint' };
      const state = generateOAuthState('google', '/settings', link);
      expect(verifyOAuthState(state)).toEqual({ slug: 'google', returnTo: '/settings', link });
      const [payload, signature] = state.split('.');
      const changed = JSON.parse(Buffer.from(payload!, 'base64url').toString());
      changed.link.userId = 1;
      expect(verifyOAuthState(`${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${signature}`)).toBeNull();
    });
    it('generates and verifies valid state', () => {
      const state = generateOAuthState('google', '/dashboard');
      const verified = verifyOAuthState(state);
      expect(verified).toEqual({ slug: 'google', returnTo: '/dashboard' });
    });

    it('defaults returnTo to / when not provided', () => {
      const state = generateOAuthState('github');
      const verified = verifyOAuthState(state);
      expect(verified).toEqual({ slug: 'github', returnTo: '/' });
    });

    it('rejects malformed or tampered state', () => {
      expect(verifyOAuthState('not-a-state')).toBeNull();
      expect(verifyOAuthState('a.b.c')).toBeNull();

      const state = generateOAuthState('okta');
      const [payload, sig] = state.split('.');
      expect(verifyOAuthState(`${payload}.invalidsig`)).toBeNull();
      expect(verifyOAuthState(`invalidbase64!.${sig}`)).toBeNull();

      // Corrupt payload that passes HMAC check but fails JSON.parse triggers catch
      const corruptPayload = 'corrupt-not-json';
      const corruptB64 = Buffer.from(corruptPayload).toString('base64url');
      const corruptSig = createHmac('sha256', config.jwt.secret).update(corruptPayload).digest('base64url');
      expect(verifyOAuthState(`${corruptB64}.${corruptSig}`)).toBeNull();
    });

    it('rejects expired state (>15 min)', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const state = generateOAuthState('google');

      // Fast forward 16 minutes
      vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60 * 1000);
      expect(verifyOAuthState(state)).toBeNull();
    });
  });

  describe('OIDC helpers', () => {
    it('requires a stable subject rather than using the email as an identity', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ email: 'alice@example.com', email_verified: true }) } as never);
      await expect(fetchOidcUserInfo('https://auth.example.com/userinfo', F.accessToken)).rejects.toThrow('stable subject');
    });
    it('fetches OIDC configuration successfully', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          authorization_endpoint: 'https://auth.example.com/oauth2/v1/authorize',
          token_endpoint: 'https://auth.example.com/oauth2/v1/token',
          userinfo_endpoint: 'https://auth.example.com/oauth2/v1/userinfo',
        }),
      } as never);

      const config = await fetchOidcConfiguration('https://auth.example.com/');
      expect(config.authorization_endpoint).toBe('https://auth.example.com/oauth2/v1/authorize');
    });

    it('throws error when OIDC configuration request fails', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        statusText: 'Not Found',
      } as never);

      await expect(fetchOidcConfiguration('https://invalid.example.com')).rejects.toThrow(
        'Failed to fetch OIDC discovery configuration',
      );
    });

    it('exchanges OIDC authorization code for tokens', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: F.accessToken, id_token: F.idToken }),
      } as never);

      const tokens = await exchangeOidcCode(
        'https://auth.example.com/token',
        'my-client-id',
        F.appSecret,
        'code_abc',
        'http://localhost/callback',
      );
      expect(tokens.access_token).toBe(F.accessToken);
    });

    it('throws when OIDC code exchange fails', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'invalid_grant',
      } as never);

      await expect(
        exchangeOidcCode(
          'https://auth.example.com/token',
          'my-client-id',
          F.appSecret,
          'bad_code',
          'http://localhost/callback',
        ),
      ).rejects.toThrow('OIDC token exchange failed (400): invalid_grant');
    });

    it('fetches OIDC userinfo with email and name', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sub: 'user_1', email: 'Alice@Example.COM', email_verified: true, name: 'Alice' }),
      } as never);

      const info = await fetchOidcUserInfo('https://auth.example.com/userinfo', F.accessToken);
      expect(info).toEqual({
        sub: 'user_1',
        email: 'alice@example.com',
        emailVerified: true,
        name: 'Alice',
      });
    });

    it('rejects when OIDC email is explicitly unverified', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sub: 'user_2', email: 'unverified@example.com', email_verified: false }),
      } as never);

      // A 403 HttpError (not a bare Error → 500): callers surface the reason.
      const err = await fetchOidcUserInfo('https://auth.example.com/userinfo', F.accessToken).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(403);
      expect((err as Error).message).toContain('not verified');
    });

    it('throws when userinfo fetch fails or lacks email', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      } as never);

      await expect(fetchOidcUserInfo('https://auth.example.com/userinfo', 'bad_token')).rejects.toThrow(
        'Failed to fetch userinfo (401)',
      );

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sub: 'user_3' }),
      } as never);

      await expect(fetchOidcUserInfo('https://auth.example.com/userinfo', 'valid_token')).rejects.toThrow(
        'OIDC userinfo did not contain an email address',
      );
    });
  });

  describe('GitHub OAuth2 helpers', () => {
    it('exchanges GitHub code and extracts direct profile email', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: F.ghoToken }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 12345, login: 'octocat', name: 'Mona Lisa', email: 'mona@github.com' }),
        } as never);

      const profile = await exchangeGitHubCode('cid', 'csec', 'code', 'http://localhost/callback');
      expect(profile).toEqual({
        sub: '12345',
        email: 'mona@github.com',
        emailVerified: true,
        name: 'Mona Lisa',
      });
    });

    it('fetches verified primary email when profile email is private', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: F.ghoToken }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 12345, login: 'octocat', name: null, email: null }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { email: 'secondary@github.com', primary: false, verified: true },
            { email: 'primary@github.com', primary: true, verified: true },
          ],
        } as never);

      const profile = await exchangeGitHubCode('cid', 'csec', 'code', 'http://localhost/callback');
      expect(profile.email).toBe('primary@github.com');
      expect(profile.name).toBe('octocat');
    });

    it('falls back to octocat@github.user when no email can be retrieved', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: F.ghoToken }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 999, login: 'privateuser', email: null }),
        } as never)
        .mockResolvedValueOnce({
          ok: false,
          statusText: 'Forbidden',
        } as never);

      const profile = await exchangeGitHubCode('cid', 'csec', 'code', 'http://localhost/callback');
      expect(profile.email).toBe('privateuser@github.user');
    });

    it('refuses userinfo without a stable subject instead of falling back to email', async () => {
      // An email-derived subject re-maps an identity whenever the address
      // changes, so a provider that omits `sub` must be refused outright.
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ email: 'nosub@example.com' }),
      } as never);

      await expect(
        fetchOidcUserInfo('https://auth.example.com/userinfo', F.accessToken),
      ).rejects.toThrow('OIDC userinfo did not contain a stable subject');
    });

    it('falls back to verified or first email when primary email not marked', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: F.ghoToken }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 12345, login: 'octocat', name: null, email: null }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { email: 'verified-only@github.com', primary: false, verified: true },
          ],
        } as never);

      const profile = await exchangeGitHubCode('cid', 'csec', 'code', 'http://localhost/callback');
      expect(profile.email).toBe('verified-only@github.com');

      // Test fallback to first email when neither primary nor verified
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: F.ghoToken }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 12345, login: 'octocat', name: null, email: null }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { email: 'unverified-first@github.com', primary: false, verified: false },
          ],
        } as never);

      const profile2 = await exchangeGitHubCode('cid', 'csec', 'code', 'http://localhost/callback');
      expect(profile2.email).toBe('unverified-first@github.com');

      // Test fallback to login@github.user when emails array is empty
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: F.ghoToken }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 12345, login: 'octocat', name: null, email: null }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [],
        } as never);

      const profile3 = await exchangeGitHubCode('cid', 'csec', 'code', 'http://localhost/callback');
      expect(profile3.email).toBe('octocat@github.user');
    });

    it('throws when GitHub token exchange fails', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        statusText: 'Bad Request',
      } as never);

      await expect(exchangeGitHubCode('cid', 'csec', 'code', 'cb')).rejects.toThrow(
        'GitHub token exchange failed: Bad Request',
      );

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: 'bad_verification_code', error_description: 'Code expired' }),
      } as never);

      await expect(exchangeGitHubCode('cid', 'csec', 'code', 'cb')).rejects.toThrow('Code expired');

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: 'generic_error' }),
      } as never);

      await expect(exchangeGitHubCode('cid', 'csec', 'code', 'cb')).rejects.toThrow('generic_error');

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as never);

      await expect(exchangeGitHubCode('cid', 'csec', 'code', 'cb')).rejects.toThrow('Missing GitHub access token');
    });

    it('throws when GitHub profile fetch fails', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: F.accessToken }),
        } as never)
        .mockResolvedValueOnce({
          ok: false,
          statusText: 'Service Unavailable',
        } as never);

      await expect(exchangeGitHubCode('cid', 'csec', 'code', 'cb')).rejects.toThrow(
        'Failed to fetch GitHub profile: Service Unavailable',
      );
    });
  });
});
