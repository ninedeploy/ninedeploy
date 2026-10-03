import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClient } from '../src/client.js';

const h = vi.hoisted(() => ({
  createClient: vi.fn(),
  loadConfig: vi.fn(),
}));

vi.mock('@ninedeploy/sdk', () => ({ createClient: h.createClient }));
vi.mock('../src/config.js', () => ({ loadConfig: h.loadConfig, saveConfig: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  h.createClient.mockImplementation(
    (opts: { baseUrl: string; getToken: () => string | undefined }) => ({
      baseUrl: opts.baseUrl,
      getToken: opts.getToken,
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('r193: 401 refresh scope', () => {
  const run = async (url: string) => {
    h.loadConfig.mockReturnValue({ baseUrl: 'http://srv', token: 'old', refreshToken: 'rt' });
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string) => {
      calls.push(input);
      if (input.endsWith('/v1/auth/refresh')) {
        return new Response(JSON.stringify({ tokens: { accessToken: 'new', refreshToken: 'rt2' } }), { status: 200 });
      }
      return new Response('{}', { status: calls.filter((c) => c === input).length === 1 ? 401 : 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    getClient();
    const opts = h.createClient.mock.calls.at(-1)![0] as { fetch: (i: string, init?: RequestInit) => Promise<Response> };
    const res = await opts.fetch(url, {});
    vi.unstubAllGlobals();
    return { status: res.status, refreshed: calls.some((c) => c.endsWith('/v1/auth/refresh')) };
  };

  it('refreshes on authenticated /auth/ endpoints', async () => {
    for (const path of ['/v1/auth/me', '/v1/auth/tokens', '/v1/auth/sessions', '/v1/auth/oidc/providers', '/v1/auth/oidc/github/link']) {
      expect(await run(`http://srv${path}`)).toEqual({ status: 200, refreshed: true });
    }
  });

  it('never refreshes credential-exchange endpoints', async () => {
    for (const path of ['/v1/auth/login', '/v1/auth/register', '/v1/auth/logout', '/v1/setup/status', '/v1/auth/passkey/login/verify']) {
      expect((await run(`http://srv${path}`)).refreshed).toBe(false);
    }
  });
});

describe('getClient', () => {
  it('builds a client from the saved config', () => {
    h.loadConfig.mockReturnValue({ baseUrl: 'http://srv:3000', token: 'abc' });

    const client = getClient();

    expect(h.loadConfig).toHaveBeenCalledOnce();
    expect(h.createClient).toHaveBeenCalledOnce();
    const opts = h.createClient.mock.calls[0]?.[0];
    expect(opts?.baseUrl).toBe('http://srv:3000');
    expect(opts?.getToken()).toBe('abc');
    expect(client).toBeDefined();
  });

  it('allows a config without a token', () => {
    h.loadConfig.mockReturnValue({ baseUrl: 'http://srv:3000' });

    getClient();

    const opts = h.createClient.mock.calls[0]?.[0];
    expect(opts?.baseUrl).toBe('http://srv:3000');
    expect(opts?.getToken()).toBeUndefined();
  });
});

describe('r550: raw-fetch helpers', () => {
  it('apiUrl keeps a sub-path prefix and strips trailing slashes', async () => {
    const { apiUrl } = await import('../src/client.js');
    expect(apiUrl('/v1/x', 'https://host/panel/')).toBe('https://host/panel/v1/x');
    expect(apiUrl('/v1/x', 'http://srv:3000')).toBe('http://srv:3000/v1/x');
    h.loadConfig.mockReturnValue({ baseUrl: 'http://cfg' });
    expect(apiUrl('/v1/y')).toBe('http://cfg/v1/y');
  });

  it('authedFetch sends no Authorization header without a stored token', async () => {
    const { authedFetch } = await import('../src/client.js');
    h.loadConfig.mockReturnValue({ baseUrl: 'http://srv' });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await authedFetch('/v1/system/export');
    vi.unstubAllGlobals();
    // No refresh token → the 401 is returned as-is, no refresh attempt.
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
  });

  it('authedFetch returns the original 401 when the refresh is refused', async () => {
    const { authedFetch } = await import('../src/client.js');
    h.loadConfig.mockReturnValue({ baseUrl: 'http://srv', token: 'old', refreshToken: 'rt' });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await authedFetch('/v1/system/export');
    vi.unstubAllGlobals();
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2); // original + refresh, no retry
  });

  it('a successful refresh with no token in the reloaded config retries without a bearer', async () => {
    const { authedFetch } = await import('../src/client.js');
    h.loadConfig
      .mockReturnValueOnce({ baseUrl: 'http://srv', token: 'old' })
      .mockReturnValueOnce({ baseUrl: 'http://srv', refreshToken: 'rt' })
      .mockReturnValue({ baseUrl: 'http://srv' });
    let n = 0;
    const fetchMock = vi.fn(async (input: string) => {
      n += 1;
      if (input.endsWith('/v1/auth/refresh')) {
        return new Response(JSON.stringify({ tokens: { accessToken: 'a', refreshToken: 'b' } }), { status: 200 });
      }
      return new Response('{}', { status: n === 1 ? 401 : 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await authedFetch('/v1/system/export');
    vi.unstubAllGlobals();
    expect(res.status).toBe(200);
  });

  it('tokenExpiresSoon reads JWT exp and ignores opaque or malformed tokens', async () => {
    const { tokenExpiresSoon } = await import('../src/client.js');
    const jwt = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
    const now = 1_000_000_000_000;
    expect(tokenExpiresSoon(undefined)).toBe(false);
    expect(tokenExpiresSoon('nd_opaque_token')).toBe(false);
    expect(tokenExpiresSoon('h.%%%.s')).toBe(false);
    expect(tokenExpiresSoon(jwt({ sub: 1 }), 60_000, now)).toBe(false);
    expect(tokenExpiresSoon(jwt({ exp: now / 1000 + 30 }), 60_000, now)).toBe(true);
    expect(tokenExpiresSoon(jwt({ exp: now / 1000 + 600 }), 60_000, now)).toBe(false);
    expect(tokenExpiresSoon(jwt({ exp: now / 1000 - 1 }))).toBe(true);
  });
});
