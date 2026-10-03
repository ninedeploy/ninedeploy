import { mkdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * r355 (was r099b) — end-to-end with the REAL git binary: a checkout must
 * connect to the address the egress gate vetted, never re-resolve the name.
 *
 * `rebind.test` is a reserved TLD that never resolves. The gate's lookup is
 * mocked to answer 127.0.0.1 (treated as public here so a local server can
 * stand in for the vetted host). If git resolved the name itself — the
 * rebinding window — it would fail with "Could not resolve host" and the
 * server would see nothing. With the pin, git connects to the vetted address
 * while still sending the hostname (Host header / TLS SNI).
 */
const dns = vi.hoisted(() => ({ lookup: vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]) }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup, default: { lookup: dns.lookup } }));
vi.mock('../../src/lib/egressGuard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/egressGuard.js')>()),
  isPrivateAddress: () => false,
}));

const { checkoutCommit } = await import('../../src/lib/git.js');

const seen: string[] = [];
const server = http.createServer((req, res) => {
  seen.push(`${req.headers.host} ${req.url}`);
  res.statusCode = 404;
  res.end();
});
let port = 0;
const root = path.join(os.tmpdir(), `ninedeploy-gitpin-${process.pid}-${Date.now()}`);

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  mkdirSync(root, { recursive: true });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe('r355: git dials the vetted address (real git)', () => {
  it('connects to the pinned address for a hostname git itself could not resolve', async () => {
    const url = `http://rebind.test:${port}/team/app.git`;
    // The server answers 404, so the clone fails — what matters is WHERE git connected.
    await expect(checkoutCommit(url, 'main', undefined, path.join(root, 'clone'), () => undefined)).rejects.toThrow();
    expect(dns.lookup).toHaveBeenCalledWith('rebind.test', { all: true });
    expect(seen.some((line) => line.startsWith(`rebind.test:${port} /team/app.git/info/refs`))).toBe(true);
  });
});
