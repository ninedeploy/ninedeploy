import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PAGE_SERVER_HEALTH, pageLoader, pageReply, startPageServer, type NodeServicePages } from '../src/pageServer.js';

/** P2: the node's page server answers what the panel's /_nd routes answer on the panel host. */
const shop: NodeServicePages = {
  hosts: ['shop.example.com', '*.stores.example.com'],
  maintenance: { html: '<h1>Down</h1>', text: 'Down. Soon\n', retryAfter: 120 },
  errors: { '502': '<h1>Oops</h1>' },
};
const blog: NodeServicePages = { hosts: ['blog.example.com'], maintenance: null, errors: { '503': '<script>blog()</script>' } };
const load = (id: number) => (id === 5 ? shop : id === 6 ? blog : null);

describe('pageReply', () => {
  it('serves the maintenance page with 503 and Retry-After, as HTML to a browser and as text otherwise', () => {
    const html = pageReply({ url: '/_nd/maintenance/5/cart?x=1', host: 'shop.example.com:443', accept: 'text/html,*/*' }, load);
    expect(html).toEqual({ status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '120', 'cache-control': 'no-store' }, body: '<h1>Down</h1>' });
    const text = pageReply({ url: '/_nd/maintenance/5', host: 'eu.stores.example.com' }, load);
    expect(text).toMatchObject({ status: 503, body: 'Down. Soon\n', headers: { 'content-type': 'text/plain; charset=utf-8' } });
  });

  it('answers "back in a moment" while maintenance was just switched off and the routes catch up', () => {
    expect(pageReply({ url: '/_nd/maintenance/6/', host: 'blog.example.com' }, load)).toMatchObject({ status: 503, headers: { 'retry-after': '5' }, body: expect.stringContaining('Back in a moment') });
  });

  it('serves a custom error page with its status, and nothing for a status without one', () => {
    expect(pageReply({ url: '/_nd/errors/5/502', host: 'shop.example.com' }, load)).toMatchObject({ status: 502, body: '<h1>Oops</h1>' });
    expect(pageReply({ url: '/_nd/errors/5/504', host: 'shop.example.com' }, load).status).toBe(404);
    expect(pageReply({ url: '/_nd/errors/5/500', host: 'shop.example.com' }, load).status).toBe(404);
    expect(pageReply({ url: '/_nd/errors/5/502/x', host: 'shop.example.com' }, load).status).toBe(404);
  });

  it('never serves one service page on another service host (one server serves the whole node)', () => {
    // The blog's custom script must not run on the shop's origin, nor on a host of no service.
    expect(pageReply({ url: '/_nd/errors/6/503', host: 'shop.example.com' }, load).status).toBe(404);
    expect(pageReply({ url: '/_nd/errors/6/503', host: 'blog.example.com' }, load).status).toBe(503);
    expect(pageReply({ url: '/_nd/maintenance/5', host: 'evil.example.com' }, load).status).toBe(404);
    // A wildcard covers one label, not two.
    expect(pageReply({ url: '/_nd/maintenance/5', host: 'a.b.stores.example.com' }, load).status).toBe(404);
    expect(pageReply({ url: '/_nd/maintenance/5', host: '' }, load).status).toBe(404);
  });

  it('matches the raw path: dot segments and other prefixes reach nothing else', () => {
    // Traefik's addPrefix puts the visitor's path after the prefix: still service 5's maintenance page.
    expect(pageReply({ url: '/_nd/maintenance/5/../../errors/6/503', host: 'shop.example.com' }, load)).toMatchObject({ status: 503, body: 'Down. Soon\n' });
    expect(pageReply({ url: '/x/_nd/errors/6/503', host: 'blog.example.com' }, load).status).toBe(404);
    expect(pageReply({ url: '/_nd/maintenance/05', host: 'shop.example.com' }, load).status).toBe(404);
    expect(pageReply({ url: '/_nd/maintenance/0', host: 'shop.example.com' }, load).status).toBe(404);
    expect(pageReply({ url: '/_nd/maintenance/7', host: 'shop.example.com' }, load).status).toBe(404);
    expect(pageReply({ url: undefined, host: 'shop.example.com' }, load).status).toBe(404);
  });

  it('answers its health check for the agent, on any host', () => {
    expect(pageReply({ url: PAGE_SERVER_HEALTH }, load)).toMatchObject({ status: 200, body: 'ok\n' });
  });
});

describe('pageLoader and the server', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('reads <id>.json, sees a rewrite, and treats a missing or broken file as no pages', () => {
    dir = mkdtempSync(join(tmpdir(), 'nd-pages-'));
    const read = pageLoader(dir);
    expect(read(5)).toBeNull();
    writeFileSync(join(dir, '5.json'), JSON.stringify(shop));
    expect(read(5)).toEqual(shop);
    expect(read(5)).toEqual(shop);
    writeFileSync(join(dir, '5.json'), JSON.stringify({ ...shop, hosts: ['new.example.com'] }));
    utimesSync(join(dir, '5.json'), new Date(), new Date(Date.now() + 5000));
    expect(read(5)?.hosts).toEqual(['new.example.com']);
    writeFileSync(join(dir, '6.json'), '{not json');
    expect(read(6)).toBeNull();
    writeFileSync(join(dir, '6.json'), JSON.stringify({ hosts: [1], errors: {} }));
    utimesSync(join(dir, '6.json'), new Date(), new Date(Date.now() + 9000));
    expect(read(6)).toBeNull();
    rmSync(join(dir, '5.json'));
    expect(read(5)).toBeNull();
  });

  it('serves over HTTP, without a body for HEAD', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nd-pages-'));
    writeFileSync(join(dir, '5.json'), JSON.stringify(shop));
    const server = startPageServer(dir, 0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    // fetch() drops a Host header; Traefik sends the visitor's.
    const ask = (method: string, path: string, headers: Record<string, string>, body?: string) =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        req.end(body);
      });
    try {
      const page = await ask('GET', '/_nd/maintenance/5/', { host: 'shop.example.com', accept: 'text/html' });
      expect(page.status).toBe(503);
      expect(page.headers['retry-after']).toBe('120');
      expect(page.body).toBe('<h1>Down</h1>');
      const head = await ask('HEAD', '/_nd/errors/5/502', { host: 'shop.example.com' });
      expect(head.status).toBe(502);
      expect(head.body).toBe('');
      expect((await ask('POST', '/_nd/maintenance/5', { host: 'shop.example.com' }, 'x'.repeat(10_000))).status).toBe(503);
      expect((await ask('GET', '/_nd/errors/5/502', { host: 'other.example.com' })).status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
