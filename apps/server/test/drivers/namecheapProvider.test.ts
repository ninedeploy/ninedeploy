import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NamecheapProvider } from '../../src/kernel/drivers/namecheapProvider.js';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

const creds = { apiUser: 'nc-user', apiKey: 'nc-key', clientIp: '1.2.3.4' };

const xmlResponse = (xml: string) => ({
  ok: true,
  status: 200,
  text: async () => xml,
});

beforeEach(() => fetchMock.mockReset());
afterEach(() => fetchMock.mockReset());

const newProvider = (c: typeof creds | null) => new NamecheapProvider(async () => c);

describe('NamecheapProvider (IDomainProvider)', () => {
  it('exposes a stable, vendor-prefixed name', () => {
    expect(newProvider(creds).name).toBe('namecheap');
  });

  it('throws a descriptive error when credentials are not configured', async () => {
    const driver = newProvider(null);
    await expect(driver.listZones()).rejects.toThrow(/Namecheap credentials are not configured/);
    await expect(driver.findZoneForHost('app.example.com')).rejects.toThrow(
      /Namecheap credentials are not configured/,
    );
    await expect(
      driver.createRecord('example.com', { hostname: 'a', type: 'A', content: '1.1.1.1' }),
    ).rejects.toThrow(/Namecheap credentials are not configured/);
    await expect(driver.deleteRecord('example.com', 'r')).rejects.toThrow(
      /Namecheap credentials are not configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('listZones maps <Domain Name=…> entries to { id, name } with name as id', async () => {
    fetchMock.mockResolvedValueOnce(
      xmlResponse(
        '<ApiResponse Status="OK"><CommandResponse><DomainGetListResult>' +
          '<Domain Name="example.com" />' +
          '<Domain Name="example.net" />' +
          '</DomainGetListResult></CommandResponse></ApiResponse>',
      ),
    );
    await expect(newProvider(creds).listZones()).resolves.toEqual([
      { id: 'example.com', name: 'example.com' },
      { id: 'example.net', name: 'example.net' },
    ]);
  });

  it('findZoneForHost prefers an exact match', async () => {
    fetchMock.mockResolvedValueOnce(
      xmlResponse(
        '<ApiResponse Status="OK"><CommandResponse><DomainGetListResult>' +
          '<Domain Name="example.com" />' +
          '<Domain Name="dev.example.com" />' +
          '</DomainGetListResult></CommandResponse></ApiResponse>',
      ),
    );
    await expect(newProvider(creds).findZoneForHost('dev.example.com')).resolves.toEqual({
      id: 'dev.example.com',
      name: 'dev.example.com',
    });
  });

  it('findZoneForHost falls back to the longest suffix match', async () => {
    fetchMock.mockResolvedValueOnce(
      xmlResponse(
        '<ApiResponse Status="OK"><CommandResponse><DomainGetListResult>' +
          '<Domain Name="example.com" />' +
          '<Domain Name="dev.example.com" />' +
          '</DomainGetListResult></CommandResponse></ApiResponse>',
      ),
    );
    await expect(newProvider(creds).findZoneForHost('api.dev.example.com')).resolves.toEqual({
      id: 'dev.example.com',
      name: 'dev.example.com',
    });
  });

  it('findZoneForHost returns null when no zone matches', async () => {
    fetchMock.mockResolvedValueOnce(
      xmlResponse(
        '<ApiResponse Status="OK"><CommandResponse><DomainGetListResult>' +
          '<Domain Name="example.com" />' +
          '</DomainGetListResult></CommandResponse></ApiResponse>',
      ),
    );
    await expect(newProvider(creds).findZoneForHost('other.org')).resolves.toBeNull();
  });

  it('createRecord reads existing hosts, appends, and re-reads to discover the new HostId', async () => {
    // 1. getHosts — current list has one unrelated entry.
    fetchMock.mockResolvedValueOnce(
      xmlResponse(
        '<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult>' +
          '<hosts>' +
          '<host HostId="50" Name="api" Type="CNAME" Address="www.example.com" TTL="300" />' +
          '</hosts></DomainDNSGetHostsResult></CommandResponse></ApiResponse>',
      ),
    );
    // 2. setHosts — push the merged list (api + the new www entry).
    fetchMock.mockResolvedValueOnce(
      xmlResponse('<ApiResponse Status="OK"><CommandResponse /></ApiResponse>'),
    );
    // 3. getHosts again — read back to find the new HostId for the new entry.
    fetchMock.mockResolvedValueOnce(
      xmlResponse(
        '<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult>' +
          '<hosts>' +
          '<host HostId="50" Name="api" Type="CNAME" Address="www.example.com" TTL="300" />' +
          '<host HostId="51" Name="www" Type="A" Address="1.1.1.1" TTL="1800" />' +
          '</hosts></DomainDNSGetHostsResult></CommandResponse></ApiResponse>',
      ),
    );
    const result = await newProvider(creds).createRecord('example.com', {
      hostname: 'www',
      type: 'A',
      content: '1.1.1.1',
    });
    expect(result).toEqual({ recordId: '51', hostname: 'www', type: 'A' });

    // setHosts call (the second fetch) should have both entries.
    const setHostsUrl = fetchMock.mock.calls[1]![0] as string;
    const params = new URL(setHostsUrl).searchParams;
    expect(params.get('HostName1')).toBe('api');
    expect(params.get('HostName2')).toBe('www');
    expect(params.get('HostId1')).toBe('50');
    // The new entry has no HostId yet — Namecheap assigns it.
    expect(params.get('HostId2')).toBeNull();
  });

  it('r244: keeps MX preferences and the email type, and writes the host name relative to the zone', async () => {
    fetchMock.mockResolvedValueOnce(
      xmlResponse(
        '<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult EmailType="MX">' +
          '<hosts>' +
          '<host HostId="60" Name="@" Type="MX" Address="mx1.mail.example.net." MXPref="5" TTL="1800" />' +
          '</hosts></DomainDNSGetHostsResult></CommandResponse></ApiResponse>',
      ),
    );
    fetchMock.mockResolvedValueOnce(xmlResponse('<ApiResponse Status="OK"><CommandResponse /></ApiResponse>'));
    fetchMock.mockResolvedValueOnce(
      xmlResponse(
        '<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult EmailType="MX">' +
          '<hosts>' +
          '<host HostId="60" Name="@" Type="MX" Address="mx1.mail.example.net." MXPref="5" TTL="1800" />' +
          '<host HostId="61" Name="app" Type="A" Address="1.1.1.1" TTL="1800" />' +
          '</hosts></DomainDNSGetHostsResult></CommandResponse></ApiResponse>',
      ),
    );
    const result = await newProvider(creds).createRecord('example.com', {
      hostname: 'app.example.com',
      type: 'A',
      content: '1.1.1.1',
    });
    expect(result.recordId).toBe('61');
    const params = new URL(fetchMock.mock.calls[1]![0] as string).searchParams;
    expect(params.get('MXPref1')).toBe('5');
    expect(params.get('EmailType')).toBe('MX');
    expect(params.get('HostName2')).toBe('app');
  });

  it('createRecord de-duplicates on (name, type) so a re-add replaces the old row', async () => {
    fetchMock.mockResolvedValueOnce(
      xmlResponse(
        '<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult>' +
          '<hosts>' +
          '<host HostId="50" Name="www" Type="A" Address="1.1.1.1" TTL="1800" />' +
          '</hosts></DomainDNSGetHostsResult></CommandResponse></ApiResponse>',
      ),
    );
    fetchMock.mockResolvedValueOnce(
      xmlResponse('<ApiResponse Status="OK"><CommandResponse /></ApiResponse>'),
    );
    fetchMock.mockResolvedValueOnce(
      xmlResponse(
        '<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult>' +
          '<hosts>' +
          '<host HostId="99" Name="www" Type="A" Address="2.2.2.2" TTL="1800" />' +
          '</hosts></DomainDNSGetHostsResult></CommandResponse></ApiResponse>',
      ),
    );
    const result = await newProvider(creds).createRecord('example.com', {
      hostname: 'www',
      type: 'A',
      content: '2.2.2.2',
    });
    expect(result.recordId).toBe('99');
    // The merged list passed to setHosts should have ONE entry — the
    // old host was de-duped, not appended alongside.
    const setHostsUrl = fetchMock.mock.calls[1]![0] as string;
    const params = new URL(setHostsUrl).searchParams;
    expect(params.get('HostName1')).toBe('www');
    expect(params.get('Address1')).toBe('2.2.2.2');
    // The de-duped entry has no HostId (so Namecheap creates fresh).
    expect(params.get('HostId1')).toBeNull();
  });

  it('createRecord throws when the re-read does not return the new entry', async () => {
    fetchMock.mockResolvedValueOnce(
      xmlResponse(
        '<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult>' +
          '<hosts /></DomainDNSGetHostsResult></CommandResponse></ApiResponse>',
      ),
    );
    fetchMock.mockResolvedValueOnce(
      xmlResponse('<ApiResponse Status="OK"><CommandResponse /></ApiResponse>'),
    );
    // Re-read returns the SAME list (no new entry).
    fetchMock.mockResolvedValueOnce(
      xmlResponse(
        '<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult>' +
          '<hosts /></DomainDNSGetHostsResult></CommandResponse></ApiResponse>',
      ),
    );
    await expect(
      newProvider(creds).createRecord('example.com', {
        hostname: 'www',
        type: 'A',
        content: '1.1.1.1',
      }),
    ).rejects.toThrow(/did not return a HostId/);
  });

  it('deleteRecord fetches, filters by HostId, and pushes the reduced list', async () => {
    fetchMock.mockResolvedValueOnce(
      xmlResponse(
        '<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult>' +
          '<hosts>' +
          '<host HostId="50" Name="www" Type="A" Address="1.1.1.1" TTL="1800" />' +
          '<host HostId="51" Name="api" Type="A" Address="2.2.2.2" TTL="1800" />' +
          '</hosts></DomainDNSGetHostsResult></CommandResponse></ApiResponse>',
      ),
    );
    fetchMock.mockResolvedValueOnce(
      xmlResponse('<ApiResponse Status="OK"><CommandResponse /></ApiResponse>'),
    );
    await newProvider(creds).deleteRecord('example.com', '50');
    const setHostsUrl = fetchMock.mock.calls[1]![0] as string;
    const params = new URL(setHostsUrl).searchParams;
    expect(params.get('HostName1')).toBe('api');
    expect(params.get('HostId1')).toBe('51');
  });

  it('deleteRecord is a no-op when the HostId is not in the current list', async () => {
    fetchMock.mockResolvedValueOnce(
      xmlResponse(
        '<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult>' +
          '<hosts>' +
          '<host HostId="50" Name="www" Type="A" Address="1.1.1.1" TTL="1800" />' +
          '</hosts></DomainDNSGetHostsResult></CommandResponse></ApiResponse>',
      ),
    );
    await newProvider(creds).deleteRecord('example.com', '99');
    // Only the getHosts call; no setHosts because nothing changed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * F364 regression: `setHosts` REPLACES the zone, so two read-modify-writes of
 * the same zone that interleave overwrite each other (a lost record, or a
 * deleted one resurrected). The driver serialises mutations per zone.
 * Gated completion: the fake withholds getHosts responses until released.
 */
describe('NamecheapProvider — F364 per-zone serialisation', () => {
  const prevEgress = process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
  beforeEach(() => {
    // No DNS vetting of api.namecheap.com: the fake below is the whole API.
    process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = '1';
  });
  afterEach(() => {
    if (prevEgress === undefined) delete process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
    else process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = prevEgress;
  });

  type Row = { hostId: string; name: string; type: string; address: string };
  function fakeZone(initial: Row[]) {
    let rows = initial.map((r) => ({ ...r }));
    let nextId = 100;
    let reads = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let firstRead!: () => void;
    const firstReadSeen = new Promise<void>((r) => {
      firstRead = r;
    });
    fetchMock.mockImplementation(async (url: string) => {
      const p = new URL(url).searchParams;
      if (p.get('Command') === 'namecheap.domains.dns.getHosts') {
        const snapshot = rows.map((r) => ({ ...r }));
        reads++;
        firstRead();
        await held;
        return xmlResponse(
          '<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult>' +
            snapshot
              .map((r) => `<host HostId="${r.hostId}" Name="${r.name}" Type="${r.type}" Address="${r.address}" TTL="1800" />`)
              .join('') +
            '</DomainDNSGetHostsResult></CommandResponse></ApiResponse>',
        );
      }
      // setHosts: whole-list replace.
      const next: Row[] = [];
      for (let n = 1; p.has(`HostName${n}`); n++) {
        next.push({
          hostId: p.get(`HostId${n}`) ?? String(nextId++),
          name: p.get(`HostName${n}`)!,
          type: p.get(`RecordType${n}`)!,
          address: p.get(`Address${n}`)!,
        });
      }
      rows = next;
      return xmlResponse('<ApiResponse Status="OK"><CommandResponse /></ApiResponse>');
    });
    return {
      names: () => rows.map((r) => `${r.name}/${r.type}`).sort(),
      reads: () => reads,
      firstReadSeen,
      release,
    };
  }
  const drain = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
  };

  it('two concurrent creates for different hostnames in one zone both survive', async () => {
    const zone = fakeZone([{ hostId: '10', name: 'mail', type: 'A', address: '9.9.9.9' }]);
    const driver = newProvider(creds);
    const c1 = driver.createRecord('example.com', { hostname: 'app1.example.com', type: 'A', content: '1.1.1.1' });
    await zone.firstReadSeen;
    const c2 = driver.createRecord('example.com', { hostname: 'app2.example.com', type: 'A', content: '2.2.2.2' });
    await drain();
    // The second mutation must not read the zone while the first is mid-write.
    expect(zone.reads()).toBe(1);
    zone.release();
    await Promise.all([c1, c2]);
    expect(zone.names()).toEqual(['app1/A', 'app2/A', 'mail/A']);
  });

  it('a delete racing a create does not resurrect the deleted record', async () => {
    const zone = fakeZone([
      { hostId: '10', name: 'mail', type: 'A', address: '9.9.9.9' },
      { hostId: '11', name: 'old', type: 'A', address: '3.3.3.3' },
    ]);
    const driver = newProvider(creds);
    const del = driver.deleteRecord('example.com', '11');
    await zone.firstReadSeen;
    const add = driver.createRecord('example.com', { hostname: 'new.example.com', type: 'A', content: '4.4.4.4' });
    await drain();
    zone.release();
    await Promise.all([del, add]);
    expect(zone.names()).toEqual(['mail/A', 'new/A']);
  });
});
