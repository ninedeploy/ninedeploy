import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudflareZoneProvider } from '../../src/kernel/drivers/cloudflareZone.js';
import { createFakeDb } from '../helpers.js';

const cryptoMocks = vi.hoisted(() => ({
  encrypt: vi.fn((s: string) => `enc:${s}`),
  decrypt: vi.fn((s: string) => s.replace('enc:', '')),
}));
vi.mock('../../src/lib/crypto.js', () => cryptoMocks);

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

const cfOk = (result: unknown) => ({
  ok: true,
  json: async () => ({ success: true, errors: [], result }),
});

beforeEach(() => {
  fetchMock.mockReset();
  cryptoMocks.encrypt.mockClear();
  cryptoMocks.decrypt.mockClear();
});

afterEach(() => fetchMock.mockReset());

const newProvider = (token: string | null) =>
  new CloudflareZoneProvider(async () => token);

describe('CloudflareZoneProvider (IDomainProvider)', () => {
  it('exposes a stable, vendor-prefixed name', () => {
    expect(newProvider('t').name).toBe('cloudflare-zone');
  });

  it('throws a descriptive error when no token is configured', async () => {
    const driver = new CloudflareZoneProvider(async () => null);
    await expect(driver.listZones()).rejects.toThrow(/Cloudflare token is not configured/);
    await expect(driver.findZoneForHost('app.example.com')).rejects.toThrow(
      /Cloudflare token is not configured/,
    );
    await expect(
      driver.createRecord('z1', { hostname: 'a', type: 'A', content: '1.1.1.1' }),
    ).rejects.toThrow(/Cloudflare token is not configured/);
    await expect(driver.deleteRecord('z1', 'r')).rejects.toThrow(
      /Cloudflare token is not configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('listZones returns every zone the token can see', async () => {
    fetchMock.mockResolvedValueOnce(
      cfOk([
        { id: 'z1', name: 'example.com' },
        { id: 'z2', name: 'example.net' },
      ]),
    );
    await expect(newProvider('t').listZones()).resolves.toEqual([
      { id: 'z1', name: 'example.com' },
      { id: 'z2', name: 'example.net' },
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/zones?per_page=50');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer t' });
  });

  it('findZoneForHost prefers an exact match', async () => {
    fetchMock.mockResolvedValueOnce(
      cfOk([
        { id: 'parent', name: 'example.com' },
        { id: 'exact', name: 'dev.example.com' },
      ]),
    );
    await expect(newProvider('t').findZoneForHost('dev.example.com')).resolves.toEqual({
      id: 'exact',
      name: 'dev.example.com',
    });
  });

  it('findZoneForHost falls back to the longest suffix match', async () => {
    fetchMock.mockResolvedValueOnce(
      cfOk([
        { id: 'parent', name: 'example.com' },
        { id: 'nested', name: 'dev.example.com' },
      ]),
    );
    await expect(newProvider('t').findZoneForHost('app.dev.example.com')).resolves.toEqual({
      id: 'nested',
      name: 'dev.example.com',
    });
  });

  it('findZoneForHost returns null when no zone matches', async () => {
    fetchMock.mockResolvedValueOnce(cfOk([{ id: 'z1', name: 'example.com' }]));
    await expect(newProvider('t').findZoneForHost('other.org')).resolves.toBeNull();
  });

  it('createRecord POSTs a full A-record payload', async () => {
    fetchMock.mockResolvedValueOnce(cfOk({ id: 'rec-1' }));
    const result = await newProvider('t').createRecord('z1', {
      hostname: 'app.example.com',
      type: 'A',
      content: '203.0.113.9',
      ttl: 1,
      proxied: true,
    });
    expect(result).toEqual({ recordId: 'rec-1', hostname: 'app.example.com', type: 'A' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/zones/z1/dns_records');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      type: 'A',
      name: 'app.example.com',
      content: '203.0.113.9',
      ttl: 1,
      proxied: true,
    });
  });

  it('createRecord defaults ttl to 1 and proxied to false', async () => {
    fetchMock.mockResolvedValueOnce(cfOk({ id: 'rec-2' }));
    await newProvider('t').createRecord('z1', {
      hostname: 'app.example.com',
      type: 'CNAME',
      content: 'target.example.net',
    });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ type: 'CNAME', ttl: 1, proxied: false });
  });

  it('createRecord propagates Cloudflare API errors', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ success: false, errors: [{ message: 'forbidden' }] }),
    });
    await expect(
      newProvider('t').createRecord('z1', {
        hostname: 'app.example.com',
        type: 'A',
        content: '1.1.1.1',
      }),
    ).rejects.toThrow(/forbidden/);
  });

  it('deleteRecord issues a DELETE on the right path', async () => {
    fetchMock.mockResolvedValueOnce(cfOk({}));
    await expect(newProvider('t').deleteRecord('z1', 'rec-1')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/zones/z1/dns_records/rec-1');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('deleteRecord swallows network failures (best-effort)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(newProvider('t').deleteRecord('z1', 'rec-1')).resolves.toBeUndefined();
  });

  it('reads the token from the supplied provider on every call', async () => {
    // The token supplier runs once per driver method, not once at
    // construction. That keeps a config-center rotation effective
    // without re-registering the driver.
    const calls: number[] = [];
    const provider = new CloudflareZoneProvider(async () => {
      calls.push(Date.now());
      return 'late-token';
    });
    fetchMock.mockResolvedValueOnce(cfOk([]));
    await provider.listZones();
    fetchMock.mockResolvedValueOnce(cfOk([]));
    await provider.listZones();
    expect(calls).toHaveLength(2);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer late-token' });
  });

  it('does not require a DB handle at construction time (createFakeDb unused but imported to mirror the rest of the suite)', () => {
    // The driver only ever reads its token from the supplied callback, so it
    // is safe to instantiate before the database is reachable. This is the
    // shape the kernel boot path uses — the token provider is a closure
    // over `fastify.db` and the DB might still be wiring up.
    expect(() => new CloudflareZoneProvider(async () => null)).not.toThrow();
    // Touch `createFakeDb` to silence unused-import linters without
    // introducing a runtime dependency in this suite.
    expect(createFakeDb).toBeTypeOf('function');
  });
});
