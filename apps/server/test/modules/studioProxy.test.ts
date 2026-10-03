import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { STUDIO_EPOCH_KEY, parseStudioCookie, studioCookieSetHeader, studioCookieValid, studioCookieValue, studioProxyRoutes } from '../../src/modules/studioProxy.js';

let upstream: http.Server;
let upstreamPort: number;
const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];

const dbRow = { id: 3, webGuiEnabled: true, webGuiPort: -1 }; // port patched per-test
// r560: the operator the cookie is bound to.
const operator = { id: 7, tokenVersion: 4, isInstanceOperator: true, deactivatedAt: null as Date | null };
const cookieValue = () => studioCookieValue(3, operator).value;
const cookieHeader = () => `nd-studio-3=${cookieValue()}`;

async function makeApp(row: unknown = dbRow, settingsRow: { value: string } | null = null, userRow: unknown = operator) {
  const app = Fastify();
  app.decorate(
    'db',
    {
      query: {
        databases: { findFirst: vi.fn(async () => row) },
        settings: { findFirst: vi.fn(async () => settingsRow) },
        users: { findFirst: vi.fn(async () => userRow) },
      },
    } as never,
  );
  await app.register(studioProxyRoutes, { prefix: '/databases' });
  await app.ready();
  return app;
}

beforeEach(async () => {
  seen.length = 0;
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      console.log('UPSTREAM-DEBUG:', JSON.stringify(req.headers));
      if (req.url === '/set-cookie-test') res.setHeader('set-cookie', ['rc=1; Path=/']);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`upstream:${req.method}:${req.url}`);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
  dbRow.webGuiPort = upstreamPort;
});

afterEach(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe('studio proxy', () => {
  it('relays GET requests to the loopback studio behind a valid cookie', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/databases/3/studio-proxy/', headers: { cookie: cookieHeader() } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('upstream:GET:/');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/');
    // The studio's own session cookie rides along; the panel's does not exist
    // here. Compare structurally, not byte-for-byte against a freshly minted
    // cookie — the route stamps its own expiry second, and this assertion
    // crossing a 1s boundary would flake on the timestamp+HMAC pair.
    expect(seen[0].headers.cookie).toMatch(/^nd-studio-3=\d+\.7\.[0-9a-f]{64}$/);
    expect(studioCookieValid(3, seen[0].headers.cookie, operator)).toBe(true);
    await app.close();
  });

  it('refuses requests without the studio cookie', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/databases/3/studio-proxy/' });
    expect(res.statusCode).toBe(401);
    expect(seen).toHaveLength(0);
    await app.close();
  });

  it('rejects a cookie-less request BEFORE its body is parsed (r098)', async () => {
    // The route accepts 256 MiB bodies. With the cookie check in the handler,
    // Fastify had already buffered the whole body for an unauthenticated
    // client — a memory DoS on the single-process panel.
    const preParsing = vi.fn(async () => undefined);
    const app = Fastify();
    app.addHook('preParsing', preParsing);
    app.decorate('db', { query: { databases: { findFirst: vi.fn(async () => dbRow) }, users: { findFirst: vi.fn(async () => operator) } } } as never);
    await app.register(studioProxyRoutes, { prefix: '/databases' });
    await app.ready();

    const denied = await app.inject({
      method: 'POST',
      url: '/databases/3/studio-proxy/import',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(64 * 1024, 1),
    });
    expect(denied.statusCode).toBe(401);
    expect(preParsing).not.toHaveBeenCalled();

    // Control: an authenticated request does reach body parsing.
    const allowed = await app.inject({
      method: 'POST',
      url: '/databases/3/studio-proxy/import',
      headers: { cookie: cookieHeader(), 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(16, 1),
    });
    expect(allowed.statusCode).toBe(200);
    expect(preParsing).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('refuses a cookie with a forged signature', async () => {
    const app = await makeApp();
    // Tamper DETERMINISTICALLY. The old slice(0,-2)+'ff' forged a VALID
    // cookie whenever the genuine HMAC already ended in 'ff' (1/256 per
    // mint — the expiry is stamped per second, so every run rolls the dice)
    // and the proxy rightly answered 200. Swap in a tail pair this mint's
    // real signature cannot have.
    const real = studioCookieValue(3, operator).value;
    const tail = real.slice(-2);
    const forgedTail = tail === 'ff' ? '00' : 'ff';
    const forged = `nd-studio-3=${real.slice(0, -2)}${forgedTail}`;
    const res = await app.inject({ method: 'GET', url: '/databases/3/studio-proxy/', headers: { cookie: forged } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('maps subpaths and queries onto the studio root', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/databases/3/studio-proxy/adminer.css?x=1',
      headers: { cookie: cookieHeader() },
    });
    expect(res.statusCode).toBe(200);
    expect(seen[0].url).toBe('/adminer.css?x=1');
    await app.close();
  });

  it('relays urlencoded POST bodies so Adminer logins work', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/databases/3/studio-proxy/',
      headers: { cookie: cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'auth[user]=nine&auth[password]=secret',
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toBe('auth[user]=nine&auth[password]=secret');
    await app.close();
  });

  it('scopes upstream Set-Cookie lines to this database proxy path', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/databases/3/studio-proxy/set-cookie-test',
      headers: { cookie: cookieHeader() },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(setCookie.join(';')).toContain('Path=/v1/databases/3/studio-proxy');
    await app.close();
  });

  it('404s when no studio is running for the database', async () => {
    const app = await makeApp({ id: 3, webGuiEnabled: false, webGuiPort: null });
    const res = await app.inject({
      method: 'GET',
      url: '/databases/3/studio-proxy/',
      headers: { cookie: cookieHeader() },
    });
    expect(res.statusCode).toBe(404);
    expect(seen).toHaveLength(0);
    await app.close();
  });

  it('mints a path-scoped HttpOnly cookie from the start route header helper', () => {
    const header = studioCookieSetHeader(9, operator, false);
    expect(header).toMatch(/^nd-studio-9=\d+\.7\.[a-f0-9]{64}/);
    expect(header).toContain('Path=/v1/databases/9/studio-proxy/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Max-Age=');
  });
});

// ── r441: epoch-bound studio cookies ──────────────────────────────────
describe('studio cookie epoch (r441)', () => {
  it('the settings row decides the live epoch; a bumped epoch invalidates older cookies', async () => {
    const app = await makeApp(dbRow, { value: 'epoch-2' });
    // Minted under the LIVE epoch → passes.
    const fresh = `nd-studio-3=${studioCookieValue(3, operator, 8 * 60 * 60, 'epoch-2').value}`;
    const ok = await app.inject({ method: 'GET', url: '/databases/3/studio-proxy/', headers: { cookie: fresh } });
    expect(ok.statusCode).toBe(200);
    // Minted under the PREVIOUS (default) epoch — what a password-reset bump
    // leaves behind — is refused even though its HMAC and expiry are intact.
    const stale = cookieHeader();
    const denied = await app.inject({ method: 'GET', url: '/databases/3/studio-proxy/', headers: { cookie: stale } });
    expect(denied.statusCode).toBe(401);
    await app.close();
  });

  it('studioCookieValid is epoch-sensitive at the unit level', () => {
    const header = `nd-studio-3=${studioCookieValue(3, operator, 60, 'epoch-9').value}`;
    expect(studioCookieValid(3, header, operator, Date.now(), 'epoch-9')).toBe(true);
    expect(studioCookieValid(3, header, operator, Date.now(), 'epoch-10')).toBe(false);
    // Default-epoch cookies still verify when no epoch was ever bumped.
    const legacy = `nd-studio-3=${studioCookieValue(3, operator, 60).value}`;
    expect(studioCookieValid(3, legacy, operator)).toBe(true);
  });

  it('exports the settings key the password-reset route bumps', () => {
    expect(STUDIO_EPOCH_KEY).toBe('studio.cookie_epoch');
    expect(studioCookieSetHeader(3, operator, false, 60, 'e1')).toContain('Max-Age=60');
  });
});

// ── r560: user-bound studio cookies + framing isolation ──────────────
describe('studio session is bound to the operator who opened it (r560)', () => {
  const get = (app: Awaited<ReturnType<typeof makeApp>>, cookie = cookieHeader()) =>
    app.inject({ method: 'GET', url: '/databases/3/studio-proxy/', headers: { cookie } });

  it('a logout (tokenVersion bump) ends the studio session', async () => {
    const cookie = cookieHeader();
    const app = await makeApp(dbRow, null, { ...operator, tokenVersion: operator.tokenVersion + 1 });
    const res = await get(app, cookie);
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/open the studio again/);
    expect(seen).toHaveLength(0);
    await app.close();
  });

  it('operator demotion, deactivation and deletion end the studio session', async () => {
    for (const row of [
      { ...operator, isInstanceOperator: false },
      { ...operator, deactivatedAt: new Date() },
      null, // deleted user
    ]) {
      const app = await makeApp(dbRow, null, row);
      expect((await get(app)).statusCode).toBe(401);
      await app.close();
    }
    expect(seen).toHaveLength(0);
  });

  it('a cookie cannot be re-pointed at another user', async () => {
    const [exp, , sig] = cookieValue().split('.');
    const app = await makeApp(dbRow, null, { ...operator, id: 8 });
    expect((await get(app, `nd-studio-3=${exp}.8.${sig}`)).statusCode).toBe(401);
    await app.close();
  });

  it('refuses the pre-0.10.36 unbound cookie shape', async () => {
    const [exp, , sig] = cookieValue().split('.');
    const app = await makeApp();
    expect((await get(app, `nd-studio-3=${exp}.${sig}`)).statusCode).toBe(401);
    expect(parseStudioCookie(3, `nd-studio-3=${exp}.${sig}`)).toBeNull();
    expect(parseStudioCookie(3, `nd-studio-3=${exp}.0.${sig}`)).toBeNull();
    expect(parseStudioCookie(3, `nd-studio-3=1.7.${sig}`)).toBeNull();
    expect(studioCookieValid(3, `nd-studio-3=${exp}.7.${sig}`, { id: 8, tokenVersion: 4 })).toBe(false);
    await app.close();
  });
});

describe('studio responses can never be framed (r560)', () => {
  it('adds frame-ancestors none + X-Frame-Options DENY, keeps the upstream CSP, strips panel-wide headers', async () => {
    upstream.removeAllListeners('request');
    upstream.on('request', (_req, res) => {
      res.setHeader('content-security-policy', "script-src 'self' 'nonce-abc'; frame-ancestors *");
      res.setHeader('x-frame-options', 'ALLOWALL');
      res.setHeader('clear-site-data', '"storage"');
      res.setHeader('service-worker-allowed', '/');
      res.setHeader('strict-transport-security', 'max-age=1');
      res.setHeader('set-cookie', ['adminer_sid=1; Domain=example.test; Path=/']);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    });
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/databases/3/studio-proxy/', headers: { cookie: cookieHeader() } });
    expect(res.statusCode).toBe(200);
    const csp = ([] as string[]).concat(res.headers['content-security-policy'] as string | string[]);
    // Upstream policy preserved (the studio keeps its own script rules)…
    expect(csp).toContain("script-src 'self' 'nonce-abc'; frame-ancestors *");
    // …plus an additional, independently enforced no-framing policy.
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['clear-site-data']).toBeUndefined();
    expect(res.headers['service-worker-allowed']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeUndefined();
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).join(';');
    expect(cookie).not.toMatch(/domain=/i);
    expect(cookie).toContain('Path=/v1/databases/3/studio-proxy');
    await app.close();
  });

  it('sets the no-framing headers even when the upstream sends no CSP', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/databases/3/studio-proxy/', headers: { cookie: cookieHeader() } });
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    await app.close();
  });
});
