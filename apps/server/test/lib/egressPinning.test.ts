/**
 * r605 — DNS rebinding: `guardedFetch` resolved the host, vetted it, and then
 * let `fetch` resolve it AGAIN. A resolver answering public first and private
 * second walked straight past the guard. These tests use the REAL global
 * fetch against a local server; the two resolution stages are faked
 * separately: the guard's check (`node:dns/promises`) answers a public
 * address, and the connect-time resolver `fetch` would use on its own
 * (`dns.lookup`, which `net` consults) answers the private one the local
 * server listens on.
 */
import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const vetting = vi.hoisted(() => ({
  lookup: vi.fn(async (_host: string, _opts?: unknown) => [{ address: '203.0.113.7', family: 4 }]),
}));
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, lookup: vetting.lookup, default: { ...actual, lookup: vetting.lookup } };
});

const { bundledAgentClass, guardedFetch, pinnedLookup } = await import('../../src/lib/egressGuard.js');

let server: http.Server;
let port: number;
const hits: Array<string | undefined> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.headers.host);
    res.end('private service');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const realLookup = dns.lookup;
let secondAnswerAsked: string[] = [];
beforeEach(() => {
  hits.length = 0;
  secondAnswerAsked = [];
  delete process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
  // The rebinding resolver's SECOND answer: the private address.
  (dns as { lookup: unknown }).lookup = (host: string, opts: unknown, cb?: unknown) => {
    const callback = (typeof opts === 'function' ? opts : cb) as (...a: unknown[]) => void;
    secondAnswerAsked.push(host);
    const all = typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all;
    process.nextTick(() => (all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4)));
  };
});
afterEach(() => {
  (dns as { lookup: unknown }).lookup = realLookup;
});

describe('r605: guardedFetch connects only to the address it vetted', () => {
  it('a resolver answering public, then private, cannot steer the connection to the private address', async () => {
    await expect(
      guardedFetch(`http://rebind.test:${port}/`, { signal: AbortSignal.timeout(1500) }),
    ).rejects.toThrow();
    // The vetted (public, unreachable here) address was dialled — never the
    // private one, and fetch never asked the resolver a second time.
    expect(hits).toEqual([]);
    expect(secondAnswerAsked).not.toContain('rebind.test');
    expect(vetting.lookup).toHaveBeenCalledWith('rebind.test', { all: true });
  });

  it('keeps the hostname for the Host header (and TLS SNI) while dialling the pinned address', async () => {
    // Build the same dispatcher guardedFetch builds, pinned to the local server
    // — through guardedFetch's own Agent lookup, so this runs on every Node the
    // panel supports (Node 26's undici 8 keeps its Agent in a different slot).
    const Agent = bundledAgentClass();
    if (!Agent) throw new Error(`no bundled undici Agent found on Node ${process.version} — pinning would be off`);
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup('pinned.test', [{ address: '127.0.0.1', family: 4 }]) } });
    const res = await fetch(`http://pinned.test:${port}/`, { dispatcher } as RequestInit);
    expect(await res.text()).toBe('private service');
    expect(hits).toEqual([`pinned.test:${port}`]);
    expect(secondAnswerAsked).toEqual([]);
    await dispatcher.close();
  });

  it('private egress allowed: no pinning, fetch resolves as before (unchanged behaviour)', async () => {
    process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = '1';
    const res = await guardedFetch(`http://rebind.test:${port}/`);
    expect(await res.text()).toBe('private service');
    expect(secondAnswerAsked).toContain('rebind.test');
  });
});

describe('pinnedLookup', () => {
  const addrs = [
    { address: '203.0.113.7', family: 4 },
    { address: '2001:db8::7', family: 6 },
  ];
  const call = (host: string, opts: unknown) =>
    new Promise<unknown[]>((resolve) => {
      (pinnedLookup('Example.COM', addrs) as unknown as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void)(
        host,
        opts,
        (...a) => resolve(a),
      );
    });

  it('answers the vetted host in both callback shapes, honouring a family filter', async () => {
    expect(await call('example.com', { all: true })).toEqual([null, addrs]);
    expect(await call('example.com', {})).toEqual([null, '203.0.113.7', 4]);
    expect(await call('example.com', { family: 6 })).toEqual([null, '2001:db8::7', 6]);
    expect(await call('example.com', { all: true, family: 4 })).toEqual([null, [addrs[0]]]);
  });

  it('refuses any other name', async () => {
    const [err] = await call('evil.example', { all: true });
    expect(err).toMatchObject({ code: 'ENOTFOUND' });
  });
});
