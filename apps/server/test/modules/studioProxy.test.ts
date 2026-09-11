import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { studioCookieSetHeader, studioCookieValue, studioProxyRoutes } from '../../src/modules/studioProxy.js';

let upstream: http.Server;
let upstreamPort: number;
const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];

const dbRow = { id: 3, webGuiEnabled: true, webGuiPort: -1 }; // port patched per-test
const cookieValue = () => studioCookieValue(3).value;
const cookieHeader = () => `nd-studio-3=${cookieValue()}`;

async function makeApp(row: unknown = dbRow) {
  const app = Fastify();
  app.decorate(
    'db',
    { query: { databases: { findFirst: vi.fn(async () => row) } } } as never,
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
    // The studio's own session cookie rides along; the panel's does not exist here.
    expect(seen[0].headers.cookie).toBe(cookieHeader());
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
    app.decorate('db', { query: { databases: { findFirst: vi.fn(async () => dbRow) } } } as never);
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
    const forged = `nd-studio-3=${studioCookieValue(3).value.slice(0, -2)}ff`;
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
    const header = studioCookieSetHeader(9, false);
    expect(header).toMatch(/^nd-studio-9=\d+\.[a-f0-9]{64}/);
    expect(header).toContain('Path=/v1/databases/9/studio-proxy/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Max-Age=');
  });
});
