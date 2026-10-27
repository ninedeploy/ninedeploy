/**
 * G3.5: the Route 53, OVH, Porkbun and Hetzner DNS drivers and their
 * credential store. The provider APIs are faked at `fetch` (the egress guard
 * passes through); the settings table is an in-memory map, crypto is real.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/egressGuard.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/egressGuard.js')>('../../src/lib/egressGuard.js');
  return { ...actual, guardedFetch: (url: string, init?: RequestInit) => fetchMock(url, init) };
});

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../../src/lib/settings.js', () => ({
  getSettingString: vi.fn(async (_db: unknown, key: string, fallback: string | null) => store.get(key) ?? fallback),
  setSettingString: vi.fn(async (_db: unknown, key: string, value: string) => void store.set(key, value)),
}));

const creds = await import('../../src/lib/dnsProviderCredentials.js');
const { HetznerDnsProvider } = await import('../../src/kernel/drivers/hetznerDns.js');
const { PorkbunProvider } = await import('../../src/kernel/drivers/porkbun.js');
const { Route53Provider } = await import('../../src/kernel/drivers/route53.js');
const { OvhProvider, ovhSignature } = await import('../../src/kernel/drivers/ovh.js');
const { SETTINGS_ENCRYPTED_KEYS } = await import('../../src/lib/keyRotation.js');

const db = {} as never;
const json = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  statusText: '',
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const call = (i: number) => ({
  url: String(fetchMock.mock.calls[i]![0]),
  init: fetchMock.mock.calls[i]![1] as RequestInit & { headers: Record<string, string> },
  body: () => JSON.parse(String((fetchMock.mock.calls[i]![1] as RequestInit).body)) as Record<string, unknown>,
});

beforeEach(() => {
  vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'c'.repeat(64));
  fetchMock.mockReset();
  store.clear();
});
afterEach(() => vi.unstubAllEnvs());

describe('credential store', () => {
  it('stores encrypted, activates the provider and resolves only for it', async () => {
    const hz = { token: 'hetzner-token-0123456789' };
    await creds.setDnsCredentials(db, 'hetzner', hz);
    expect(store.get('dns_records_provider')).toBe('hetzner');
    expect(store.get(creds.CREDENTIALS_KEY)).not.toContain('hetzner-token');
    expect(await creds.getDnsCredentials(db, 'hetzner')).toEqual(hz);
    expect(await creds.getDnsCredentials(db, 'porkbun')).toBeNull();
    // Another provider took over (e.g. the Cloudflare card): stale keys never resolve.
    store.set('dns_records_provider', 'cloudflare');
    expect(await creds.getDnsCredentials(db, 'hetzner')).toBeNull();
  });

  it('shows only the non-secret fields', async () => {
    await creds.setDnsCredentials(db, 'route53', { accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 's'.repeat(40) });
    expect(await creds.describeDnsCredentials(db)).toEqual({ provider: 'route53', configured: 'route53', fields: { accessKeyId: 'AKIAABCDEFGHIJKLMNOP' } });
  });

  it('rejects malformed credentials and clears', async () => {
    await expect(creds.setDnsCredentials(db, 'porkbun', { apiKey: 'x', secretApiKey: 'y' })).rejects.toThrow();
    await creds.setDnsCredentials(db, 'porkbun', { apiKey: 'pk1_abc', secretApiKey: 'sk1_def' });
    await creds.clearDnsCredentials(db);
    expect(store.get('dns_records_provider')).toBe('');
    expect(await creds.describeDnsCredentials(db)).toEqual({ provider: null, configured: null, fields: {} });
    // Clearing never deactivates a provider that is not one of these.
    store.set('dns_records_provider', 'namecheap');
    await creds.clearDnsCredentials(db);
    expect(store.get('dns_records_provider')).toBe('namecheap');
  });

  it('ignores an undecryptable or foreign blob', async () => {
    store.set('dns_records_provider', 'hetzner');
    store.set(creds.CREDENTIALS_KEY, 'garbage');
    expect(await creds.getDnsCredentials(db, 'hetzner')).toBeNull();
    expect((await creds.describeDnsCredentials(db)).configured).toBeNull();
  });

  it('is rotated with the master key', () => {
    expect(SETTINGS_ENCRYPTED_KEYS).toContain(creds.CREDENTIALS_KEY);
  });

  it('matches zones by longest suffix and derives relative names', () => {
    const zones = [{ id: '1', name: 'example.com' }, { id: '2', name: 'dev.example.com' }];
    expect(creds.zoneForHost(zones, 'App.Dev.Example.com')?.id).toBe('2');
    expect(creds.zoneForHost(zones, 'example.com')?.id).toBe('1');
    expect(creds.zoneForHost(zones, 'example.org')).toBeNull();
    expect(creds.relativeName('a.b.example.com', 'example.com')).toBe('a.b');
    expect(creds.relativeName('example.com', 'example.com')).toBe('');
    expect(creds.quotedTxt('v="1"')).toBe('"v=\\"1\\""');
    expect(creds.ttlOrDefault(1, 60, 300)).toBe(300);
    expect(creds.ttlOrDefault(120, 60, 300)).toBe(120);
  });
});

describe('every driver without credentials', () => {
  it('fails with a pointer to the settings page and never calls out', async () => {
    const none = async () => null;
    for (const d of [new HetznerDnsProvider(none), new PorkbunProvider(none), new Route53Provider(none), new OvhProvider(none)]) {
      await expect(d.listZones()).rejects.toThrow(/Settings → Integrations → DNS records/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Hetzner DNS', () => {
  const d = new HetznerDnsProvider(async () => ({ token: 'tok' }));

  it('pages zones and picks the most specific', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ zones: [{ id: 1, name: 'example.com' }], meta: { pagination: { next_page: 2 } } }))
      .mockResolvedValueOnce(json({ zones: [{ id: 2, name: 'dev.example.com' }], meta: { pagination: { next_page: null } } }));
    expect(await d.findZoneForHost('a.dev.example.com')).toEqual({ id: '2', name: 'dev.example.com' });
    expect(call(0).url).toBe('https://api.hetzner.cloud/v1/zones?per_page=100&page=1');
    expect(call(0).init.headers['Authorization']).toBe('Bearer tok');
    expect(call(1).url).toContain('page=2');
  });

  it('creates an RRSet keyed name/type and deletes it, tolerating 404', async () => {
    fetchMock.mockResolvedValueOnce(json({ zone: { name: 'example.com' } })).mockResolvedValueOnce(json({ rrset: {} }, 201));
    expect(await d.createRecord('7', { hostname: 'app.example.com', type: 'CNAME', content: 'lb.example.net', ttl: 1 })).toEqual({
      recordId: 'app/CNAME',
      hostname: 'app.example.com',
      type: 'CNAME',
    });
    expect(call(1).url).toBe('https://api.hetzner.cloud/v1/zones/7/rrsets');
    expect(call(1).body()).toEqual({ name: 'app', type: 'CNAME', ttl: 300, records: [{ value: 'lb.example.net.' }] });

    fetchMock.mockResolvedValueOnce(json({ zone: { name: 'example.com' } })).mockResolvedValueOnce(json({ rrset: {} }, 201));
    expect((await d.createRecord('7', { hostname: 'example.com', type: 'A', content: '1.2.3.4' })).recordId).toBe('@/A');

    fetchMock.mockResolvedValueOnce(json({ action: {} }, 201));
    await d.deleteRecord('7', 'app/CNAME');
    expect(call(4).url).toBe('https://api.hetzner.cloud/v1/zones/7/rrsets/app/CNAME');
    expect(call(4).init.method).toBe('DELETE');
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'not found' } }, 404));
    await d.deleteRecord('7', '@/A');
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'boom' } }, 500));
    await expect(d.deleteRecord('7', '@/A')).rejects.toThrow('Hetzner DNS API error: 500 boom');
  });

  it('leaves an existing RRSet alone', async () => {
    fetchMock.mockResolvedValueOnce(json({ zone: { name: 'example.com' } })).mockResolvedValueOnce(json({ error: { message: 'uniqueness_error' } }, 409));
    await expect(d.createRecord('7', { hostname: 'app.example.com', type: 'A', content: '1.2.3.4' })).rejects.toThrow(/already has a A record for app\.example\.com/);
  });
});

describe('Porkbun', () => {
  const d = new PorkbunProvider(async () => ({ apiKey: 'pk1_a', secretApiKey: 'sk1_b' }));

  it('lists domains, creates with a 600s floor and deletes', async () => {
    fetchMock.mockResolvedValueOnce(json({ status: 'SUCCESS', domains: [{ domain: 'example.com' }] }));
    expect(await d.listZones()).toEqual([{ id: 'example.com', name: 'example.com' }]);
    expect(call(0).url).toBe('https://api.porkbun.com/api/json/v3/domain/listAll');
    expect(call(0).body()).toEqual({ apikey: 'pk1_a', secretapikey: 'sk1_b', start: '0' });

    // An MX record at the name is no clash for an A record.
    fetchMock.mockResolvedValueOnce(json({ status: 'SUCCESS', records: [{ name: 'www.example.com', type: 'MX' }, { name: 'example.com', type: 'A' }] }));
    fetchMock.mockResolvedValueOnce(json({ status: 'SUCCESS', id: 106926659 }));
    expect(await d.createRecord('example.com', { hostname: 'www.example.com', type: 'A', content: '1.2.3.4', ttl: 1 })).toMatchObject({ recordId: '106926659' });
    expect(call(1).url).toBe('https://api.porkbun.com/api/json/v3/dns/retrieve/example.com');
    expect(call(2).url).toBe('https://api.porkbun.com/api/json/v3/dns/create/example.com');
    expect(call(2).body()).toMatchObject({ name: 'www', type: 'A', content: '1.2.3.4', ttl: '600' });

    fetchMock.mockResolvedValueOnce(json({ status: 'SUCCESS' }));
    await d.deleteRecord('example.com', '106926659');
    expect(call(3).url).toBe('https://api.porkbun.com/api/json/v3/dns/delete/example.com/106926659');
    fetchMock.mockResolvedValueOnce(json({ status: 'ERROR', message: 'Invalid record ID.' }, 400));
    await d.deleteRecord('example.com', '1');
  });

  it('never adds a record next to an existing one of the same type or a CNAME', async () => {
    for (const [existing, type] of [['A', 'A'], ['CNAME', 'A'], ['A', 'CNAME']] as const) {
      fetchMock.mockResolvedValueOnce(json({ status: 'SUCCESS', records: [{ name: 'WWW.example.com', type: existing }] }));
      await expect(d.createRecord('example.com', { hostname: 'www.example.com', type, content: type === 'A' ? '1.2.3.4' : 'lb.example.net' })).rejects.toThrow(
        `Porkbun already has a ${existing} record for www.example.com; it was left unchanged`,
      );
    }
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('/dns/create/'))).toBe(true);
  });

  it('surfaces a refusal', async () => {
    fetchMock.mockResolvedValueOnce(json({ status: 'ERROR', message: 'Domain is not opted in to API access.' }));
    await expect(d.createRecord('example.com', { hostname: 'example.com', type: 'A', content: '1.2.3.4' })).rejects.toThrow(
      'Porkbun API error: Domain is not opted in to API access.',
    );
    fetchMock.mockResolvedValueOnce(json({ status: 'ERROR', message: 'Invalid API key.' }, 403));
    await expect(d.deleteRecord('example.com', '1')).rejects.toThrow(/Invalid API key/);
  });
});

describe('Route 53', () => {
  const d = new Route53Provider(async () => ({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' }));
  const zonesXml = (zones: string, more = '') =>
    `<?xml version="1.0"?><ListHostedZonesResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><HostedZones>${zones}</HostedZones>${more}</ListHostedZonesResponse>`;
  const zone = (id: string, name: string, priv = false) =>
    `<HostedZone><Id>/hostedzone/${id}</Id><Name>${name}.</Name><Config><PrivateZone>${priv}</PrivateZone></Config></HostedZone>`;

  it('pages public hosted zones with SigV4 and skips private ones', async () => {
    fetchMock
      .mockResolvedValueOnce(json(zonesXml(zone('Z1', 'example.com') + zone('Z2', 'internal.example.com', true), '<IsTruncated>true</IsTruncated><NextMarker>Z3</NextMarker>')))
      .mockResolvedValueOnce(json(zonesXml(zone('Z3', 'example.org'), '<IsTruncated>false</IsTruncated>')));
    expect(await d.listZones()).toEqual([{ id: 'Z1', name: 'example.com' }, { id: 'Z3', name: 'example.org' }]);
    expect(call(0).url).toBe('https://route53.amazonaws.com/2013-04-01/hostedzone?maxitems=100');
    expect(call(0).init.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/route53\/aws4_request/);
    expect(call(0).init.headers).not.toHaveProperty('host');
    expect(call(1).url).toContain('marker=Z3');
  });

  it('creates with a change batch and deletes by replaying the same record', async () => {
    fetchMock.mockResolvedValueOnce(json('<ChangeResourceRecordSetsResponse/>'));
    const { recordId } = await d.createRecord('Z1', { hostname: 'App.example.com', type: 'A', content: '1.2.3.4', ttl: 1 });
    const sent = String(call(0).init.body);
    expect(call(0).url).toBe('https://route53.amazonaws.com/2013-04-01/hostedzone/Z1/rrset');
    expect(sent).toContain('<Action>CREATE</Action>');
    expect(sent).toContain('<Name>app.example.com.</Name><Type>A</Type><TTL>300</TTL>');
    expect(sent).toContain('<Value>1.2.3.4</Value>');

    fetchMock.mockResolvedValueOnce(json('<ChangeResourceRecordSetsResponse/>'));
    await d.deleteRecord('Z1', recordId);
    expect(String(call(1).init.body)).toBe(sent.replace('<Action>CREATE</Action>', '<Action>DELETE</Action>'));

    fetchMock.mockResolvedValueOnce(
      json('<ErrorResponse><Error><Code>InvalidChangeBatch</Code><Message>Tried to delete resource record set [name=\'app.example.com.\', type=\'A\'] but it was not found</Message></Error></ErrorResponse>', 400),
    );
    await d.deleteRecord('Z1', recordId);
    await d.deleteRecord('Z1', 'not-a-ref');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('escapes values and reports API errors', async () => {
    fetchMock.mockResolvedValueOnce(json('<ChangeResourceRecordSetsResponse/>'));
    await d.createRecord('Z1', { hostname: 'x.example.com', type: 'TXT', content: 'a<b' });
    expect(String(call(0).init.body)).toContain('<Value>&quot;a&lt;b&quot;</Value>');
    fetchMock.mockResolvedValueOnce(
      json('<ErrorResponse><Error><Code>InvalidChangeBatch</Code><Message>[Tried to create resource record set [name=\'x.example.com.\', type=\'A\'] but it already exists]</Message></Error></ErrorResponse>', 400),
    );
    await expect(d.createRecord('Z1', { hostname: 'x.example.com', type: 'A', content: '1.2.3.4' })).rejects.toThrow(/already has a A record/);
    fetchMock.mockResolvedValueOnce(json('<ErrorResponse><Error><Code>AccessDenied</Code><Message>not authorized</Message></Error></ErrorResponse>', 403));
    await expect(d.listZones()).rejects.toThrow('Route 53 API error: 403 AccessDenied: not authorized');
  });
});

describe('OVH', () => {
  const c = { endpoint: 'ovh-eu' as const, applicationKey: 'appkey', applicationSecret: 'appsecret', consumerKey: 'ckey' };
  const d = new OvhProvider(async () => c);

  it('signs with the server clock and refreshes the zone after each change', async () => {
    const serverTime = 1_800_000_000;
    fetchMock
      .mockResolvedValueOnce(json(String(serverTime)))
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({ id: 5 }))
      .mockResolvedValueOnce(json(''));
    expect(await d.createRecord('example.com', { hostname: 'api.example.com', type: 'CNAME', content: 'lb.example.net' })).toMatchObject({ recordId: '5' });
    expect(call(0).url).toBe('https://eu.api.ovh.com/1.0/auth/time');
    // A CNAME clashes with any record at the name: one unfiltered lookup.
    expect(call(1).url).toBe('https://eu.api.ovh.com/1.0/domain/zone/example.com/record?subDomain=api');
    const post = call(2);
    expect(post.url).toBe('https://eu.api.ovh.com/1.0/domain/zone/example.com/record');
    expect(post.body()).toEqual({ fieldType: 'CNAME', subDomain: 'api', target: 'lb.example.net.', ttl: 0 });
    const ts = Number(post.init.headers['X-Ovh-Timestamp']);
    expect(Math.abs(ts - serverTime)).toBeLessThanOrEqual(1);
    const expected = `$1$${createHash('sha1').update(`appsecret+ckey+POST+${post.url}+${String(post.init.body)}+${ts}`).digest('hex')}`;
    expect(post.init.headers['X-Ovh-Signature']).toBe(expected);
    expect(ovhSignature(c, 'POST', post.url, String(post.init.body), ts)).toBe(expected);
    expect(call(3).url).toBe('https://eu.api.ovh.com/1.0/domain/zone/example.com/refresh');

    // The clock offset is reused; a missing record is fine and needs no refresh.
    fetchMock.mockResolvedValueOnce(json({ message: 'not found' }, 404));
    await d.deleteRecord('example.com', '5');
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(call(4).init.method).toBe('DELETE');

    fetchMock.mockResolvedValueOnce(json('')).mockResolvedValueOnce(json(''));
    await d.deleteRecord('example.com', '6');
    expect(call(6).url).toContain('/refresh');

    fetchMock.mockResolvedValueOnce(json(['example.com', 'example.org']));
    expect(await d.listZones()).toEqual([{ id: 'example.com', name: 'example.com' }, { id: 'example.org', name: 'example.org' }]);
    fetchMock.mockResolvedValueOnce(json({ message: 'This call has not been granted' }, 403));
    await expect(d.listZones()).rejects.toThrow('OVH API error: 403 This call has not been granted');
  });
});

describe('OVH next to existing records', () => {
  const d = new OvhProvider(async () => ({ endpoint: 'ovh-eu', applicationKey: 'appkey', applicationSecret: 'appsecret', consumerKey: 'ckey' }));

  it('refuses an A record where an A or CNAME already sits, comparing the subDomain exactly', async () => {
    // The clock offset is still cached from the suite above.
    fetchMock
      .mockResolvedValueOnce(json([11]))
      .mockResolvedValueOnce(json([12]))
      .mockResolvedValueOnce(json({ subDomain: 'www', fieldType: 'A' }))
      .mockResolvedValueOnce(json({ subDomain: '', fieldType: 'CNAME' }));
    await expect(d.createRecord('example.com', { hostname: 'example.com', type: 'A', content: '1.2.3.4' })).rejects.toThrow(
      'OVH already has a CNAME record for example.com; it was left unchanged',
    );
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://eu.api.ovh.com/1.0/domain/zone/example.com/record?fieldType=A&subDomain=');
    expect(String(fetchMock.mock.calls[1]![0])).toBe('https://eu.api.ovh.com/1.0/domain/zone/example.com/record?fieldType=CNAME&subDomain=');
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit).method === 'POST')).toBe(false);
  });

  it('creates when the only matches belong to other names', async () => {
    fetchMock
      .mockResolvedValueOnce(json([11]))
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({ subDomain: 'www', fieldType: 'A' }))
      .mockResolvedValueOnce(json({ id: 9 }))
      .mockResolvedValueOnce(json(''));
    expect((await d.createRecord('example.com', { hostname: 'example.com', type: 'A', content: '1.2.3.4' })).recordId).toBe('9');
  });
});

describe('the Cloudflare card next to these providers', () => {
  it('saving it switched off keeps another active provider', async () => {
    const { setDnsRecordsConfig } = await import('../../src/lib/cloudflare.js');
    store.set('dns_records_provider', 'route53');
    await setDnsRecordsConfig(db, { enabled: false, content: null });
    expect(store.get('dns_records_provider')).toBe('route53');
    await setDnsRecordsConfig(db, { enabled: true, content: null });
    expect(store.get('dns_records_provider')).toBe('cloudflare');
    await setDnsRecordsConfig(db, { enabled: false, content: null });
    expect(store.get('dns_records_provider')).toBe('');
  });
});
