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
    for (const path of ['/v1/auth/me', '/v1/auth/tokens', '/v1/auth/sessions', '/v1/auth/oidc/providers']) {
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
