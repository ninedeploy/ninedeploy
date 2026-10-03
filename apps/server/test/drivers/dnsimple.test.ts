import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DnsimpleProvider } from '../../src/kernel/drivers/dnsimple.js';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

const dnsOk = (result: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: result }),
});

const dnsNoContent = { ok: true, status: 204, json: async () => undefined };

beforeEach(() => fetchMock.mockReset());
afterEach(() => fetchMock.mockReset());

const newProvider = (creds: { token: string; accountId: string } | null) =>
  new DnsimpleProvider(async () => creds);

describe('DnsimpleProvider (IDomainProvider)', () => {
  it('exposes a stable, vendor-prefixed name', () => {
    expect(newProvider({ token: 't', accountId: '1010' }).name).toBe('dnsimple');
  });

  it('throws a descriptive error when credentials are not configured', async () => {
    const driver = newProvider(null);
    await expect(driver.listZones()).rejects.toThrow(/DNSimple credentials are not configured/);
    await expect(driver.findZoneForHost('app.example.com')).rejects.toThrow(
      /DNSimple credentials are not configured/,
    );
    await expect(
      driver.createRecord('example.com', { hostname: 'a', type: 'A', content: '1.1.1.1' }),
    ).rejects.toThrow(/DNSimple credentials are not configured/);
    await expect(driver.deleteRecord('example.com', 'r')).rejects.toThrow(
      /DNSimple credentials are not configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('listZones uses the zone name as the id (DNSimple path slug)', async () => {
    fetchMock.mockResolvedValueOnce(
      dnsOk([
        { id: 1, account_id: 1010, name: 'example.com', reverse: false, secondary: false, active: true },
        { id: 2, account_id: 1010, name: 'example.net', reverse: false, secondary: false, active: true },
      ]),
    );
    await expect(newProvider({ token: 't', accountId: '1010' }).listZones()).resolves.toEqual([
      { id: 'example.com', name: 'example.com' },
      { id: 'example.net', name: 'example.net' },
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.dnsimple.com/v2/1010/zones');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer t' });
  });

  it('findZoneForHost prefers an exact match', async () => {
    fetchMock.mockResolvedValueOnce(
      dnsOk([
        { id: 1, account_id: 1010, name: 'example.com', reverse: false, secondary: false, active: true },
        { id: 2, account_id: 1010, name: 'dev.example.com', reverse: false, secondary: false, active: true },
      ]),
    );
    await expect(newProvider({ token: 't', accountId: '1010' }).findZoneForHost('dev.example.com')).resolves.toEqual({
      id: 'dev.example.com',
      name: 'dev.example.com',
    });
  });

  it('findZoneForHost falls back to the longest suffix match', async () => {
    fetchMock.mockResolvedValueOnce(
      dnsOk([
        { id: 1, account_id: 1010, name: 'example.com', reverse: false, secondary: false, active: true },
        { id: 2, account_id: 1010, name: 'dev.example.com', reverse: false, secondary: false, active: true },
      ]),
    );
    await expect(newProvider({ token: 't', accountId: '1010' }).findZoneForHost('app.dev.example.com')).resolves.toEqual({
      id: 'dev.example.com',
      name: 'dev.example.com',
    });
  });

  it('findZoneForHost returns null when no zone matches', async () => {
    fetchMock.mockResolvedValueOnce(
      dnsOk([{ id: 1, account_id: 1010, name: 'example.com', reverse: false, secondary: false, active: true }]),
    );
    await expect(newProvider({ token: 't', accountId: '1010' }).findZoneForHost('other.org')).resolves.toBeNull();
  });

  it('createRecord POSTs to /zones/{zoneId}/records and stringifies the id', async () => {
    fetchMock.mockResolvedValueOnce(dnsOk({ id: 42, zone_id: 'example.com', name: 'www', type: 'A', content: '1.1.1.1', ttl: 3600 }));
    const result = await newProvider({ token: 't', accountId: '1010' }).createRecord('example.com', {
      hostname: 'www.example.com',
      type: 'A',
      content: '1.1.1.1',
    });
    expect(result).toEqual({ recordId: '42', hostname: 'www.example.com', type: 'A' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.dnsimple.com/v2/1010/zones/example.com/records');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('deleteRecord issues a DELETE on the right URL', async () => {
    fetchMock.mockResolvedValueOnce(dnsNoContent);
    await expect(newProvider({ token: 't', accountId: '1010' }).deleteRecord('example.com', '42')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.dnsimple.com/v2/1010/zones/example.com/records/42');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('deleteRecord swallows upstream errors (best-effort)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ message: 'gone' }),
    });
    await expect(newProvider({ token: 't', accountId: '1010' }).deleteRecord('example.com', '42')).resolves.toBeUndefined();
  });

  it('reads the credentials from the supplied provider on every call', async () => {
    // The credentials supplier runs once per driver method, not once at
    // construction. That keeps a config-center rotation effective
    // without re-registering the driver.
    const calls: number[] = [];
    const provider = new DnsimpleProvider(async () => {
      calls.push(Date.now());
      return { token: 'late-token', accountId: '1010' };
    });
    fetchMock.mockResolvedValueOnce(
      dnsOk([{ id: 1, account_id: 1010, name: 'example.com', reverse: false, secondary: false, active: true }]),
    );
    await provider.listZones();
    fetchMock.mockResolvedValueOnce(dnsNoContent);
    await provider.deleteRecord('example.com', '1');
    expect(calls).toHaveLength(2);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer late-token' });
  });
});
