import { describe, expect, it, vi } from 'vitest';
import { probeInstance, revokeDesktopSession } from '../src/panelApi.js';

const ORIGIN = 'https://panel.example.com';
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('probeInstance', () => {
  it('accepts a panel health answer, degraded included', async () => {
    const fetch = vi.fn(async () => json(200, { status: 'ok', db: 'ok', version: '0.18.13', time: 'now' }));
    await expect(probeInstance(ORIGIN, fetch)).resolves.toEqual({ ok: true, version: '0.18.13' });
    expect(fetch).toHaveBeenCalledWith(`${ORIGIN}/health`, expect.objectContaining({ redirect: 'manual' }));
    const degraded = vi.fn(async () => json(503, { status: 'degraded', db: 'error', version: '0.18.13' }));
    await expect(probeInstance(ORIGIN, degraded)).resolves.toMatchObject({ ok: true });
  });

  it('refuses redirects, other services and unreachable hosts', async () => {
    const redirect = vi.fn(async () => new Response(null, { status: 301, headers: { location: 'https://elsewhere.example/' } }));
    await expect(probeInstance(ORIGIN, redirect)).resolves.toEqual({ ok: false, reason: expect.stringContaining('https://elsewhere.example/') });
    const other = vi.fn(async () => new Response('<html>hello</html>', { status: 200 }));
    await expect(probeInstance(ORIGIN, other)).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('NineDeploy panel') });
    const wrongShape = vi.fn(async () => json(200, { status: 'UP' }));
    await expect(probeInstance(ORIGIN, wrongShape)).resolves.toMatchObject({ ok: false });
    const down = vi.fn(async () => {
      throw new TypeError('getaddrinfo ENOTFOUND');
    });
    await expect(probeInstance(ORIGIN, down)).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('ENOTFOUND') });
  });
});

describe('revokeDesktopSession', () => {
  const REFRESH = ['refresh', 'kept'].join('-');
  const ACCESS = ['access', 'fresh'].join('-');

  it('revokes only the current session, found through a fresh access token', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/auth/refresh')) return json(200, { tokens: { accessToken: ACCESS, refreshToken: 'next' } });
      if (url.endsWith('/v1/auth/sessions') && !init?.method) {
        return json(200, [
          { id: 4, current: false },
          { id: 9, current: true },
        ]);
      }
      if (url.endsWith('/v1/auth/sessions/9') && init?.method === 'DELETE') return json(200, { ok: true });
      return json(404, {});
    });
    await expect(revokeDesktopSession(ORIGIN, REFRESH, fetch)).resolves.toBe(true);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ refreshToken: REFRESH });
    expect(new Headers(fetch.mock.calls[2]?.[1]?.headers).get('authorization')).toBe(`Bearer ${ACCESS}`);
    // Never the all-sessions logout.
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/v1/auth/logout'))).toBe(false);
  });

  it('reports false when the session is already gone or the panel is unreachable', async () => {
    await expect(revokeDesktopSession(ORIGIN, REFRESH, vi.fn(async () => json(401, { message: 'Invalid refresh token' })))).resolves.toBe(false);
    const noCurrent = vi.fn(async (url: string) => (url.endsWith('/refresh') ? json(200, { tokens: { accessToken: ACCESS } }) : json(200, [{ id: 1, current: false }])));
    await expect(revokeDesktopSession(ORIGIN, REFRESH, noCurrent)).resolves.toBe(false);
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(revokeDesktopSession(ORIGIN, REFRESH, offline)).resolves.toBe(false);
  });
});
