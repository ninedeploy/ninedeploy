import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getNamecheapHosts,
  getNamecheapConfig,
  listNamecheapDomains,
  setNamecheapHosts,
  setNamecheapConfig,
} from '../../src/lib/namecheap.js';
import { createFakeDb } from '../helpers.js';

const cryptoMocks = vi.hoisted(() => ({
  encrypt: vi.fn((s: string) => `enc:${s}`),
  decrypt: vi.fn((s: string) => s.replace('enc:', '')),
}));
vi.mock('../../src/lib/crypto.js', () => cryptoMocks);

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

const creds = { apiUser: 'nc-user', apiKey: 'nc-key', clientIp: '1.2.3.4' };

const xmlResponse = (xml: string) => ({
  ok: true,
  status: 200,
  text: async () => xml,
});

const errorResponse = (status: number) => ({
  ok: false,
  status,
  text: async () => '',
});

beforeEach(() => {
  fetchMock.mockReset();
  cryptoMocks.encrypt.mockClear();
  cryptoMocks.decrypt.mockClear();
  lastKey = '';
  setValues.length = 0;
});
afterEach(() => fetchMock.mockReset());

let lastKey = '';
const setValues: Array<{ key: string; value: string }> = [];
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

function settingsDb(over: Record<string, string> = {}) {
  return createFakeDb({
    findFirst: {
      settings: () => (lastKey in over ? { key: lastKey, value: over[lastKey] } : undefined),
    },
    insert: {
      settings: (values: unknown) => {
        setValues.push(values as { key: string; value: string });
        return [values];
      },
    },
  });
}

function _callUrl() {
  const [url] = fetchMock.mock.calls[0]!;
  return url as string;
}

function callParams() {
  const [url] = fetchMock.mock.calls[0]!;
  const parsed = new URL(url as string);
  return parsed.searchParams;
}

describe('lib/namecheap', () => {
  describe('getNamecheapConfig / setNamecheapConfig', () => {
    it('returns null when any of the three settings is missing', async () => {
      const db = settingsDb();
      await expect(getNamecheapConfig(db)).resolves.toBeNull();
    });

    it('returns the credentials when all three are set and the key decrypts', async () => {
      const db = settingsDb({
        namecheap_api_user: 'nc-user',
        namecheap_api_key_encrypted: 'enc:nc-key',
        namecheap_client_ip: '1.2.3.4',
      });
      const cfg = await getNamecheapConfig(db);
      expect(cfg).toEqual(creds);
    });

    it('returns null when the encrypted key fails to decrypt', async () => {
      cryptoMocks.decrypt.mockImplementationOnce(() => {
        throw new Error('bad key');
      });
      const db = settingsDb({
        namecheap_api_user: 'nc-user',
        namecheap_api_key_encrypted: 'enc:corrupt',
        namecheap_client_ip: '1.2.3.4',
      });
      await expect(getNamecheapConfig(db)).resolves.toBeNull();
    });

    it('setNamecheapConfig encrypts the key and persists the rest as-is', async () => {
      const db = settingsDb();
      await setNamecheapConfig(db, creds);
      expect(cryptoMocks.encrypt).toHaveBeenCalledWith('nc-key');
      const byKey = Object.fromEntries(setValues.map((v) => [v.key, v.value]));
      expect(byKey['namecheap_api_user']).toBe('nc-user');
      expect(byKey['namecheap_client_ip']).toBe('1.2.3.4');
      expect(byKey['namecheap_api_key_encrypted']).toBe('enc:nc-key');
    });

    it('setNamecheapConfig rejects empty values', async () => {
      const db = settingsDb();
      await expect(setNamecheapConfig(db, { apiUser: '', apiKey: 'k', clientIp: '1.2.3.4' })).rejects.toThrow(/required/);
    });
  });

  describe('listNamecheapDomains', () => {
    it('parses the CommandResponse/DomainGetListResult and maps <Domain Name=…> to { id, name }', async () => {
      fetchMock.mockResolvedValueOnce(
        xmlResponse(
          '<?xml version="1.0"?>' +
            '<ApiResponse Status="OK">' +
            '<CommandResponse Type="namecheap.domains.getList">' +
            '<DomainGetListResult>' +
            '<Domain Name="example.com" />' +
            '<Domain Name="example.net" />' +
            '</DomainGetListResult></CommandResponse></ApiResponse>',
        ),
      );
      await expect(listNamecheapDomains(creds)).resolves.toEqual([
        { id: 'example.com', name: 'example.com' },
        { id: 'example.net', name: 'example.net' },
      ]);
      const params = callParams();
      expect(params.get('Command')).toBe('namecheap.domains.getList');
      expect(params.get('ApiUser')).toBe('nc-user');
      expect(params.get('ApiKey')).toBe('nc-key');
      expect(params.get('ClientIp')).toBe('1.2.3.4');
    });

    it('returns an empty list when CommandResponse is missing', async () => {
      fetchMock.mockResolvedValueOnce(
        xmlResponse('<ApiResponse Status="OK"><Errors /></ApiResponse>'),
      );
      await expect(listNamecheapDomains(creds)).resolves.toEqual([]);
    });

    it('surfaces API Status=ERROR with the upstream Error message', async () => {
      fetchMock.mockResolvedValueOnce(
        xmlResponse(
          '<ApiResponse Status="ERROR">' +
            '<Errors><Error Number="2011166">API Key is invalid</Error></Errors>' +
            '</ApiResponse>',
        ),
      );
      await expect(listNamecheapDomains(creds)).rejects.toThrow(/2011166.*API Key is invalid/);
    });

    it('surfaces a 500 HTTP status', async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(500));
      await expect(listNamecheapDomains(creds)).rejects.toThrow(/HTTP 500/);
    });

    it('surfaces malformed XML as a descriptive error', async () => {
      fetchMock.mockResolvedValueOnce(xmlResponse('not xml at all'));
      await expect(listNamecheapDomains(creds)).rejects.toThrow(/malformed XML/);
    });
  });

  describe('getNamecheapHosts', () => {
    it('returns an array of { hostId, name, type, address, ttl } from <host>', async () => {
      fetchMock.mockResolvedValueOnce(
        xmlResponse(
          '<ApiResponse Status="OK">' +
            '<CommandResponse><DomainDNSGetHostsResult>' +
            '<hosts>' +
            '<host HostId="10" Name="www" Type="A" Address="1.1.1.1" TTL="1800" />' +
            '<host HostId="11" Name="@" Type="A" Address="2.2.2.2" TTL="60" />' +
            '</hosts></DomainDNSGetHostsResult></CommandResponse></ApiResponse>',
        ),
      );
      await expect(getNamecheapHosts(creds, 'example.com')).resolves.toEqual([
        { hostId: '10', name: 'www', type: 'A', address: '1.1.1.1', ttl: '1800' },
        { hostId: '11', name: '@', type: 'A', address: '2.2.2.2', ttl: '60' },
      ]);
      const params = callParams();
      expect(params.get('SLD')).toBe('example');
      expect(params.get('TLD')).toBe('com');
    });

    it('returns [] when the response has no host children', async () => {
      fetchMock.mockResolvedValueOnce(
        xmlResponse(
          '<ApiResponse Status="OK">' +
            '<CommandResponse><DomainDNSGetHostsResult><hosts /></DomainDNSGetHostsResult></CommandResponse></ApiResponse>',
        ),
      );
      await expect(getNamecheapHosts(creds, 'example.com')).resolves.toEqual([]);
    });
  });

  describe('setNamecheapHosts', () => {
    it('numbers the HostName/RecordType/Address/TTL keys starting at 1', async () => {
      fetchMock.mockResolvedValueOnce(
        xmlResponse(
          '<ApiResponse Status="OK">' +
            '<CommandResponse Type="namecheap.domains.dns.setHosts">' +
            '<DomainDNSSetHostsResult Domain="example.com" IsSuccess="true" />' +
            '</CommandResponse></ApiResponse>',
        ),
      );
      await setNamecheapHosts(creds, 'example.com', [
        { name: 'www', type: 'A', address: '1.1.1.1', ttl: '1800' },
        { name: 'api', type: 'CNAME', address: 'www.example.com', ttl: '300' },
      ]);
      const params = callParams();
      expect(params.get('HostName1')).toBe('www');
      expect(params.get('RecordType1')).toBe('A');
      expect(params.get('Address1')).toBe('1.1.1.1');
      expect(params.get('TTL1')).toBe('1800');
      expect(params.get('HostName2')).toBe('api');
      expect(params.get('RecordType2')).toBe('CNAME');
      expect(params.get('Address2')).toBe('www.example.com');
      expect(params.get('TTL2')).toBe('300');
    });

    it('includes HostIdN when the host already has one (replacement case)', async () => {
      fetchMock.mockResolvedValueOnce(
        xmlResponse('<ApiResponse Status="OK"><CommandResponse /></ApiResponse>'),
      );
      await setNamecheapHosts(creds, 'example.com', [
        { hostId: '42', name: 'www', type: 'A', address: '1.1.1.1', ttl: '1800' },
      ]);
      const params = callParams();
      expect(params.get('HostId1')).toBe('42');
    });
  });
});
