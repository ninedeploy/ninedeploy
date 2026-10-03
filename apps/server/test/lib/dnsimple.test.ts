import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDnsimpleRecord,
  deleteDnsimpleRecord,
  getDnsimpleConfig,
  listDnsimpleZones,
} from '../../src/lib/dnsimple.js';
import { createFakeDb } from '../helpers.js';

const cryptoMocks = vi.hoisted(() => ({
  encrypt: vi.fn((s: string) => `enc:${s}`),
  decrypt: vi.fn((s: string) => s.replace('enc:', '')),
}));
vi.mock('../../src/lib/crypto.js', () => cryptoMocks);

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

const dnsOk = (result: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: result }),
});

const dnsNoContent = { ok: true, status: 204, json: async () => undefined };

beforeEach(() => {
  fetchMock.mockReset();
  cryptoMocks.encrypt.mockClear();
  cryptoMocks.decrypt.mockClear();
});

afterEach(() => fetchMock.mockReset());

let lastKey = '';
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (col: unknown, value: unknown) => {
      if (col && (col as { name?: string }).name === 'key') lastKey = String(value);
      return actual.eq(col, value);
    },
  };
});

function settingsDb(over: Record<string, unknown> = {}) {
  return createFakeDb({
    findFirst: {
      settings: () => (lastKey in over ? { key: lastKey, value: over[lastKey] } : undefined),
    },
  });
}

describe('lib/dnsimple', () => {
  describe('getDnsimpleConfig', () => {
    it('reads an enabled config with token + account id', async () => {
      const cfg = await getDnsimpleConfig(
        settingsDb({
          dns_records_provider: 'dnsimple',
          dns_records_token_encrypted: 'enc:t',
          dns_records_account_id: '1010',
        }),
      );
      expect(cfg).toEqual({ enabled: true, token: 't', accountId: '1010' });
    });

    it('returns enabled=false when the provider is not dnsimple', async () => {
      const cfg = await getDnsimpleConfig(
        settingsDb({ dns_records_provider: 'cloudflare', dns_records_token_encrypted: 'enc:t' }),
      );
      expect(cfg.enabled).toBe(false);
      expect(cfg.token).toBe('t');
    });

    it('returns enabled=false when the account id is missing', async () => {
      const cfg = await getDnsimpleConfig(
        settingsDb({ dns_records_provider: 'dnsimple', dns_records_token_encrypted: 'enc:t' }),
      );
      expect(cfg.enabled).toBe(false);
      expect(cfg.token).toBe('t');
      expect(cfg.accountId).toBeNull();
    });

    it('returns enabled=false and token=null when no settings are stored', async () => {
      const cfg = await getDnsimpleConfig(settingsDb());
      expect(cfg).toEqual({ enabled: false, token: null, accountId: null });
    });
  });

  describe('listDnsimpleZones', () => {
    it('maps upstream zone rows to { id, name } using the zone name as id', async () => {
      fetchMock.mockResolvedValueOnce(
        dnsOk([
          { id: 1, account_id: 1010, name: 'example.com', reverse: false, secondary: false, active: true },
          { id: 2, account_id: 1010, name: 'example.net', reverse: false, secondary: false, active: true },
        ]),
      );
      await expect(listDnsimpleZones('t', '1010')).resolves.toEqual([
        { id: 'example.com', name: 'example.com' },
        { id: 'example.net', name: 'example.net' },
      ]);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://api.dnsimple.com/v2/1010/zones');
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer t',
        Accept: 'application/json',
      });
    });

    it('surfaces a 401 with the upstream message verbatim', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ message: 'Authentication failed' }),
      });
      await expect(listDnsimpleZones('t', '1010')).rejects.toThrow(/Authentication failed/);
    });

    it('falls back to the per-field error map when no top-level message', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: async () => ({ errors: { account: ["can't be blank"] } }),
      });
      await expect(listDnsimpleZones('t', '1010')).rejects.toThrow(/can't be blank/);
    });
  });

  describe('createDnsimpleRecord', () => {
    it('strips the zone suffix from the FQDN before sending', async () => {
      fetchMock.mockResolvedValueOnce(dnsOk({ id: 42, zone_id: 'example.com', name: 'www', type: 'A', content: '1.1.1.1', ttl: 3600 }));
      const result = await createDnsimpleRecord('t', '1010', 'example.com', {
        hostname: 'www.example.com',
        type: 'A',
        content: '1.1.1.1',
        ttl: 3600,
      });
      expect(result).toEqual({ id: 42, name: 'www.example.com', type: 'A' });
      const [, init] = fetchMock.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body).toEqual({ name: 'www', type: 'A', content: '1.1.1.1', ttl: 3600 });
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://api.dnsimple.com/v2/1010/zones/example.com/records');
    });

    it('uses an empty name for apex records (host equals zone)', async () => {
      fetchMock.mockResolvedValueOnce(dnsOk({ id: 43, zone_id: 'example.com', name: '', type: 'A', content: '1.1.1.1', ttl: 3600 }));
      await createDnsimpleRecord('t', '1010', 'example.com', {
        hostname: 'example.com',
        type: 'A',
        content: '1.1.1.1',
      });
      const [, init] = fetchMock.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.name).toBe('');
    });

    it('defaults ttl to 3600 when the spec omits it', async () => {
      fetchMock.mockResolvedValueOnce(dnsOk({ id: 44, zone_id: 'example.com', name: 'www', type: 'CNAME', content: 'target.example.net', ttl: 3600 }));
      await createDnsimpleRecord('t', '1010', 'example.com', {
        hostname: 'www.example.com',
        type: 'CNAME',
        content: 'target.example.net',
      });
      const [, init] = fetchMock.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.ttl).toBe(3600);
    });

    it('keeps the full hostname when it does not end with the zone suffix (defensive)', async () => {
      // This should not happen in practice — `findZoneForHost` guarantees the
      // suffix match — but the helper must not throw if it does. The upstream
      // returns a 422 and we surface that as a regular Error.
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: async () => ({ message: 'name is invalid' }),
      });
      await expect(
        createDnsimpleRecord('t', '1010', 'example.com', {
          hostname: 'nope.other.org',
          type: 'A',
          content: '1.1.1.1',
        }),
      ).rejects.toThrow(/name is invalid/);
    });
  });

  describe('deleteDnsimpleRecord', () => {
    it('issues a DELETE on the right URL', async () => {
      fetchMock.mockResolvedValueOnce(dnsNoContent);
      await expect(deleteDnsimpleRecord('t', '1010', 'example.com', '42')).resolves.toBeUndefined();
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://api.dnsimple.com/v2/1010/zones/example.com/records/42');
      expect((init as RequestInit).method).toBe('DELETE');
    });

    it('swallows 404 (best-effort)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ message: 'not found' }),
      });
      await expect(deleteDnsimpleRecord('t', '1010', 'example.com', '42')).resolves.toBeUndefined();
    });

    it('swallows network failures (best-effort)', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network down'));
      await expect(deleteDnsimpleRecord('t', '1010', 'example.com', '42')).resolves.toBeUndefined();
    });
  });
});
