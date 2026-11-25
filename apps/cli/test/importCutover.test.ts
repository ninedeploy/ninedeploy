import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportReceipt } from '../src/commands/importApply.js';
import { type CutoverClient, canonicalIp, cutover, type DnsLookup, dnsLookup, dnsProblem, type Expected, expectedAddresses, importCutoverAction, resolveHost } from '../src/commands/importCutover.js';
import type { ImportPlan, PlanDomain } from '../src/lib/importers/plan.js';

const PANEL = 'https://panel.example';
const HERE = '203.0.113.7';

function plan(domains: PlanDomain[]): ImportPlan {
  return {
    planVersion: 1, source: { kind: 'caprover', url: 'http://src.example', version: null, scope: '' }, generatedAt: '',
    services: [{ ref: 'web', name: 'web', kind: 'image', create: { name: 'web', image: 'nginx:1' } as never, domains, env: [], volumes: [], issues: [] }],
    databases: [], notes: [],
  };
}
function receipt(serviceDone = true): ImportReceipt {
  return {
    receiptVersion: 1, panel: PANEL, source: { kind: 'caprover', url: 'http://src.example' },
    items: serviceDone ? { 'service:web': { kind: 'service', ref: 'web', name: 'web', state: 'done', id: 12, at: 't', notes: [] } } : {},
  };
}

const enoent = () => Object.assign(new Error('nf'), { code: 'ENOTFOUND' });
function fakeDns(records: Record<string, string[]>): DnsLookup {
  return {
    resolve4: vi.fn(async (h: string) => { const r = (records[h] ?? []).filter((a) => !a.includes(':')); if (!records[h]) throw enoent(); return r; }),
    resolve6: vi.fn(async (h: string) => { if (!records[h]) throw enoent(); return (records[h] ?? []).filter((a) => a.includes(':')); }),
    servers: () => ['9.9.9.9'],
  };
}

interface PanelState {
  status?: string;
  deploy?: string | null;
  domains?: Array<{ id: number; hostname: string; status: string; ssl?: boolean; path?: string; redirectWww?: boolean }>;
  dnsSettings?: { enabled: boolean; content: string | null } | 'forbidden';
  createStatus?: string;
  createFails?: boolean;
  verified?: boolean;
}
function fakePanel(st: PanelState = {}) {
  const domains = (st.domains ?? []).map((row) => ({ ...row, ssl: row.ssl ?? true, path: row.path ?? '/', redirectWww: row.redirectWww ?? false }));
  const client: CutoverClient = {
    services: { get: vi.fn(async () => ({ status: st.status ?? 'running' })) },
    deploys: { list: vi.fn(async () => (st.deploy === null ? [] : [{ id: 3, status: st.deploy ?? 'running' }, { id: 2, status: 'failed' }])) },
    domains: {
      list: vi.fn(async () => domains as never),
      create: vi.fn(async (_id, input) => {
        if (st.createFails) throw new Error('boom');
        const status = st.createStatus ?? 'active';
        const d = { id: 40 + domains.length, hostname: input.hostname, status, ssl: input.ssl ?? true, path: input.path ?? '/', redirectWww: input.redirectWww ?? false };
        domains.push(d);
        return { ...d, dnsWarning: null, verification: status === 'pending' ? { recordName: `_nd.${input.hostname}`, recordType: 'TXT', recordValue: 'TXT-SENTINEL-9' } : null } as never;
      }),
      verify: vi.fn(async (_s, id) => (st.verified
        ? { id, verified: true, verification: null, dnsWarning: null }
        : { id, verified: false, error: 'no TXT', verification: { recordName: '_nd.x', recordType: 'TXT', recordValue: 'TXT-SENTINEL-9' } }) as never),
    },
    settings: {
      dnsRecords: {
        get: vi.fn(async () => {
          if (st.dnsSettings === 'forbidden') throw Object.assign(new Error('Forbidden'), { status: 403 });
          return st.dnsSettings ?? { enabled: false, content: HERE };
        }),
      },
    },
  };
  return client;
}
const exp = (over: Partial<Expected> = {}): Expected => ({ addresses: [HERE], source: 'test', cloudflare: 'off', ...over });
const run = (p: ImportPlan, r: ImportReceipt, client: CutoverClient, dns: DnsLookup, yes = true, skip: string[] = [], e = exp()) => {
  const states: Array<string | undefined> = [];
  const save = vi.fn((x: ImportReceipt) => { states.push(Object.values(x.items).find((i) => i.kind === 'domain')?.state); });
  return { save, states, result: cutover(p, { yes, skipDnsCheck: skip }, { client, dns, expected: e, receipt: r, save, now: () => new Date('2026-11-10T00:00:00Z') }) };
};

describe('resolveHost', () => {
  it('joins A and AAAA, and treats a missing record as none', async () => {
    expect(await resolveHost(fakeDns({ 'a.example': ['1.2.3.4', '2001:db8::1'] }), 'a.example')).toEqual(['1.2.3.4', '2001:db8::1']);
    expect(await resolveHost(fakeDns({}), 'gone.example')).toEqual([]);
  });
  it('raises a resolver failure instead of reading it as "no record"', async () => {
    const dns = fakeDns({});
    dns.resolve4 = vi.fn(async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }); });
    await expect(resolveHost(dns, 'x.example')).rejects.toThrow('timeout');
  });
});

describe('dnsProblem', () => {
  it('passes only when every A and AAAA is this panel\'s', () => {
    expect(dnsProblem([HERE], [HERE])).toBeNull();
    expect(dnsProblem([HERE, '2001:DB8:0::1'], [HERE, '2001:db8::1'])).toBeNull();
    expect(dnsProblem([], [HERE])).toBe('does not resolve');
    expect(dnsProblem([HERE, '2001:db8::5'], [HERE])).toBe('AAAA 2001:db8::5 is not this panel (expected 203.0.113.7): remove it, or pass --expect with it if it is this panel\'s');
    expect(dnsProblem([HERE, '198.51.100.1', '2001:db8::5'], [HERE])).toMatch(/^A 198\.51\.100\.1, AAAA 2001:db8::5 are not this panel .*remove them, or pass --expect with them if they are/);
    expect(dnsProblem(['198.51.100.1'], [HERE])).toBe('resolves to A 198.51.100.1, not 203.0.113.7');
  });
  it('spells an IPv6 address one way', () => {
    expect(canonicalIp('2001:DB8:0:0::1')).toBe('2001:db8::1');
    expect(canonicalIp(HERE)).toBe(HERE);
  });
});

describe('expectedAddresses', () => {
  it('prefers --expect, and still learns whether Cloudflare is on', async () => {
    const e = await expectedAddresses(fakePanel({ dnsSettings: { enabled: true, content: '198.51.100.1' } }), fakeDns({}), [HERE]);
    expect(e).toEqual({ addresses: [HERE], source: '--expect', cloudflare: 'on' });
  });
  it('falls back to Settings → DNS records, resolving a CNAME-mode hostname', async () => {
    const e = await expectedAddresses(fakePanel({ dnsSettings: { enabled: false, content: 'lb.example' } }), fakeDns({ 'lb.example': [HERE] }), []);
    expect(e).toEqual({ addresses: [HERE], source: 'Settings → DNS records, lb.example resolved', cloudflare: 'off' });
  });
  it('refuses with no address to compare with, and says how to give one', async () => {
    await expect(expectedAddresses(fakePanel({ dnsSettings: { enabled: false, content: null } }), fakeDns({}), [])).rejects.toThrow(/Pass --expect/);
    await expect(expectedAddresses(fakePanel({ dnsSettings: 'forbidden' }), fakeDns({}), [])).rejects.toThrow(/Only an admin/);
    const e = await expectedAddresses(fakePanel({ dnsSettings: 'forbidden' }), fakeDns({}), [HERE]);
    expect(e.cloudflare).toBe('unknown');
  });
});

describe('cutover', () => {
  it.each([
    ['a path-only claim', [{ id: 7, status: 'pending', path: '/shop' }]],
    ['a redirecting route', [{ id: 7, status: 'active', redirectWww: true }]],
    ['a shared hostname', [{ id: 7, status: 'active', path: '/shop' }, { id: 8, status: 'active', path: '/' }]],
  ] satisfies Array<[string, Array<Omit<NonNullable<PanelState['domains']>[number], 'hostname'>>]>)(
    'leaves %s for manual review during hostname cutover', async (_label, rows) => {
      const host = 'shop.example.com';
      const client = fakePanel({ domains: rows.map((row) => ({ hostname: host, ...row })) });
      const dns = fakeDns({ [host]: [HERE] });
      const r = receipt();
      const outcome = await run(plan([{ host, https: true }]), r, client, dns).result;
      expect(outcome).toMatchObject({ added: 0, waiting: 1, failed: 0 });
      expect(outcome.lines.join('\n')).toContain('existing routing requires manual review');
      expect(client.domains.verify).not.toHaveBeenCalled();
      expect(client.domains.create).not.toHaveBeenCalled();
      expect(dns.resolve4).not.toHaveBeenCalled();
      expect(r.items['domain:web:shop.example.com']?.state).toBe('skipped');
    },
  );

  it('skips a hostname assigned to multiple services or protocols and continues other hosts', async () => {
    const p = plan([
      { host: 'shared.example.com', https: true },
      { host: 'protocol.example.com', https: true },
      { host: 'PROTOCOL.EXAMPLE.COM.', https: false },
      { host: 'fresh.example.com', https: true },
    ]);
    p.services.push({
      ...p.services[0]!, ref: 'second', name: 'Second',
      domains: [{ host: ' SHARED.EXAMPLE.COM. ', https: true }, { host: 'fresh.example.com', https: false, sourceDefault: true }],
    });
    const r = receipt();
    r.items['service:second'] = { ...r.items['service:web']!, id: 13, ref: 'second', name: 'Second' };
    const client = fakePanel();
    const dns = fakeDns({ 'shared.example.com': [HERE], 'protocol.example.com': [HERE], 'fresh.example.com': [HERE] });
    const outcome = await run(p, r, client, dns).result;
    expect(outcome).toMatchObject({ added: 1, waiting: 3, failed: 0 });
    expect(client.domains.create).toHaveBeenCalledExactlyOnceWith(12, { hostname: 'fresh.example.com', ssl: true });
    expect(dns.resolve4).toHaveBeenCalledExactlyOnceWith('fresh.example.com');
    expect(r.items['domain:web:shared.example.com']?.state).toBe('skipped');
    expect(r.items['domain:web:protocol.example.com']?.state).toBe('skipped');
    expect(r.items['domain:second:shared.example.com']?.state).toBe('skipped');
  });

  it('leaves both attached and pending routes for review if their protocol differs', async () => {
    const client = fakePanel({ domains: [
      { id: 7, hostname: 'shop.example.com', status: 'active', ssl: false },
      { id: 8, hostname: 'admin.example.com', status: 'pending', ssl: true },
    ] });
    const dns = fakeDns({ 'admin.example.com': [HERE] });
    const r = receipt();
    const { result } = run(plan([{ host: 'shop.example.com', https: true }, { host: 'admin.example.com', https: false }]), r, client, dns);
    const outcome = await result;
    expect(outcome).toMatchObject({ added: 0, waiting: 2, failed: 0 });
    expect(outcome.lines.join('\n')).toContain('uses HTTP, plan requires HTTPS');
    expect(outcome.lines.join('\n')).toContain('uses HTTPS, plan requires HTTP');
    expect(client.domains.verify).not.toHaveBeenCalled();
    expect(client.domains.create).not.toHaveBeenCalled();
    expect(dns.resolve4).not.toHaveBeenCalled();
    expect(r.items['domain:web:shop.example.com']?.state).toBe('skipped');
    expect(r.items['domain:web:admin.example.com']?.state).toBe('skipped');
  });

  it('adds a host whose DNS points here, with the plan\'s https, and records it', async () => {
    const client = fakePanel();
    const r = receipt();
    const { result, states } = run(plan([{ host: 'Shop.Example.com', https: false }]), r, client, fakeDns({ 'shop.example.com': [HERE] }));
    expect((await result).added).toBe(1);
    expect(client.domains.create).toHaveBeenCalledWith(12, { hostname: 'shop.example.com', ssl: false });
    expect(r.items['domain:web:shop.example.com']).toMatchObject({ kind: 'domain', state: 'done', id: 40 });
    // pending is saved before the call, done after it
    expect(states).toEqual(['pending', 'done']);
  });

  it('never adds the source\'s own hosts, and leaves a host whose DNS points elsewhere', async () => {
    const client = fakePanel();
    const { result } = run(plan([{ host: 'app.1.2.3.4.sslip.io', https: true, sourceDefault: true }, { host: 'old.example', https: true }]), receipt(), client, fakeDns({ 'old.example': ['198.51.100.9'] }));
    const res = await result;
    expect(client.domains.create).not.toHaveBeenCalled();
    expect(res).toMatchObject({ added: 0, waiting: 1 });
    expect(res.lines.join('\n')).toMatch(/old\.example: resolves to A 198\.51\.100\.9, not 203\.0\.113\.7; fix DNS first/);
    expect(res.lines.join('\n')).not.toContain('sslip');
  });

  it('holds back a half-switched host whose leftover AAAA still names the source', async () => {
    const client = fakePanel();
    const res = await run(plan([{ host: 'shop.example.com', https: true }]), receipt(), client, fakeDns({ 'shop.example.com': [HERE, '2001:db8::5'] })).result;
    expect(client.domains.create).not.toHaveBeenCalled();
    expect(res.lines.join('\n')).toMatch(/AAAA 2001:db8::5 is not this panel/);
  });

  it('says when a --skip-dns-check host is not in the plan', async () => {
    const res = await run(plan([{ host: 'shop.example.com', https: true }]), receipt(), fakePanel(), fakeDns({ 'shop.example.com': [HERE] }), false, ['shpo.example.com']).result;
    expect(res.lines[0]).toBe('  ! --skip-dns-check shpo.example.com: no planned domain has that host');
  });

  it('waits for a running service with a successful last deploy, and never deploys', async () => {
    for (const st of [{ status: 'idle', deploy: null }, { status: 'running', deploy: 'failed' }, { status: 'error' }] as PanelState[]) {
      const client = fakePanel(st);
      const res = await run(plan([{ host: 'shop.example.com', https: true }]), receipt(), client, fakeDns({ 'shop.example.com': [HERE] })).result;
      expect(res.waiting).toBe(1);
      expect(res.lines.join('\n')).toMatch(/waits until the service runs a successful deploy/);
      expect(client.domains.create).not.toHaveBeenCalled();
    }
  });

  it('takes the panel as the truth: a domain already there is done, with no second add', async () => {
    const client = fakePanel({ domains: [{ id: 7, hostname: 'shop.example.com', status: 'active' }], status: 'stopped' });
    const r = receipt();
    const res = await run(plan([{ host: 'shop.example.com', https: true }]), r, client, fakeDns({ 'shop.example.com': [HERE] })).result;
    expect(client.domains.create).not.toHaveBeenCalled();
    expect(res.waiting).toBe(0);
    expect(r.items['domain:web:shop.example.com']).toMatchObject({ state: 'done', id: 7 });
  });

  it('reports DNS drift and lookup errors per host without changing attached routes', async () => {
    const client = fakePanel({ domains: [
      { id: 7, hostname: 'shop.example.com', status: 'active' },
      { id: 8, hostname: 'lookup.example.com', status: 'active' },
    ] });
    const p = plan(['shop.example.com', 'lookup.example.com', 'new.example.com'].map((host) => ({ host, https: true })));
    const dns = fakeDns({ 'shop.example.com': [HERE, '2001:db8::5'], 'new.example.com': [HERE] });
    const resolve4 = dns.resolve4;
    dns.resolve4 = vi.fn(async (host) => {
      if (host === 'lookup.example.com') throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
      return resolve4(host);
    });
    const r = receipt();
    const first = await run(p, r, client, dns).result;
    expect(first).toMatchObject({ added: 1, waiting: 2, failed: 0 });
    const output = first.lines.join('\n');
    expect(output).toContain('shop.example.com: attached (#7); AAAA 2001:db8::5');
    expect(output).toContain('lookup.example.com: attached (#8); DNS lookup failed');
    expect(client.domains.create).toHaveBeenCalledExactlyOnceWith(12, { hostname: 'new.example.com', ssl: true });
    expect(client.domains.verify).not.toHaveBeenCalled();
    expect(r.items['domain:web:shop.example.com']).toMatchObject({ state: 'done', id: 7 });
    const recovered = run(p, r, client, fakeDns({
      'shop.example.com': [HERE], 'lookup.example.com': [HERE], 'new.example.com': [HERE],
    }), false);
    const second = await recovered.result;
    expect(second).toMatchObject({ added: 0, waiting: 0, failed: 0 });
    expect(second.lines.join('\n')).toContain('shop.example.com: attached (#7); DNS points here');
    expect(recovered.save).not.toHaveBeenCalled();
    expect(client.domains.create).toHaveBeenCalledOnce();
  });

  it('verifies a pending domain only once its DNS passes, and prints the TXT without storing it', async () => {
    const pending = [{ id: 7, hostname: 'shop.example.com', status: 'pending' }];
    let client = fakePanel({ domains: pending });
    let res = await run(plan([{ host: 'shop.example.com', https: true }]), receipt(), client, fakeDns({ 'shop.example.com': ['198.51.100.9'] })).result;
    expect(client.domains.verify).not.toHaveBeenCalled();
    client = fakePanel({ domains: pending });
    const r = receipt();
    res = await run(plan([{ host: 'shop.example.com', https: true }]), r, client, fakeDns({ 'shop.example.com': [HERE] })).result;
    expect(client.domains.verify).toHaveBeenCalledWith(12, 7, true);
    expect(res.lines.join('\n')).toContain('publish TXT _nd.x = TXT-SENTINEL-9');
    expect(JSON.stringify(r)).not.toContain('TXT-SENTINEL-9');
    client = fakePanel({ domains: pending, verified: true });
    res = await run(plan([{ host: 'shop.example.com', https: true }]), r, client, fakeDns({ 'shop.example.com': [HERE] })).result;
    expect(res.added).toBe(1);
    expect(r.items['domain:web:shop.example.com']).toMatchObject({ state: 'done', id: 7 });
  });

  it('prints the challenge of a domain the panel created pending, and keeps it out of the receipt', async () => {
    const client = fakePanel({ createStatus: 'pending' });
    const r = receipt();
    const res = await run(plan([{ host: 'shop.example.com', https: true }]), r, client, fakeDns({ 'shop.example.com': [HERE] })).result;
    expect(res.lines.join('\n')).toContain('publish TXT _nd.shop.example.com = TXT-SENTINEL-9');
    expect(res).toMatchObject({ added: 0, waiting: 1 });
    expect(r.items['domain:web:shop.example.com']!.notes).toEqual(['ownership proof pending (TXT)']);
    expect(JSON.stringify(r)).not.toContain('TXT-SENTINEL-9');
  });

  it('allows --skip-dns-check only while the Cloudflare integration is known to be off', async () => {
    const p = plan([{ host: 'cdn.example', https: true }]);
    const dns = fakeDns({ 'cdn.example': ['104.16.0.1'] });
    for (const cloudflare of ['on', 'unknown'] as const) {
      const client = fakePanel();
      const res = await run(p, receipt(), client, dns, true, ['cdn.example'], exp({ cloudflare })).result;
      expect(client.domains.create).not.toHaveBeenCalled();
      expect(res.lines.join('\n')).toMatch(/--skip-dns-check refused/);
    }
    const client = fakePanel();
    const r = receipt();
    await run(p, r, client, dns, true, ['CDN.example'], exp({ cloudflare: 'off' })).result;
    expect(client.domains.create).toHaveBeenCalledOnce();
    expect(r.items['domain:web:cdn.example']!.notes).toEqual(['DNS check skipped (--skip-dns-check)']);
  });

  it('reports wildcards for a person, and services apply has not created', async () => {
    const client = fakePanel();
    let res = await run(plan([{ host: '*.example.com', https: true }]), receipt(), client, fakeDns({})).result;
    expect(res.lines.join('\n')).toMatch(/wildcard needs a DNS-01 certificate/);
    res = await run(plan([{ host: 'shop.example.com', https: true }]), receipt(false), client, fakeDns({})).result;
    expect(res.lines.join('\n')).toMatch(/not created yet/);
    expect(client.domains.create).not.toHaveBeenCalled();
  });

  it('reports attached wildcards for manual DNS review and honors an explicit skip without touching the route', async () => {
    const host = '*.example.com';
    const client = fakePanel({ domains: [{ id: 7, hostname: host, status: 'active' }] });
    const p = plan([{ host, https: true }]);
    const dns = fakeDns({});
    const r = receipt();
    const manual = await run(p, r, client, dns).result;
    expect(manual.waiting).toBe(1);
    expect(manual.lines.join('\n')).toContain('attached (#7); wildcard DNS needs manual review');
    const skipped = await run(p, r, client, dns, true, [host], exp({ cloudflare: 'on' })).result;
    expect(skipped.waiting).toBe(0);
    expect(skipped.lines.join('\n')).toContain('attached (#7); DNS check skipped (--skip-dns-check)');
    expect(r.items['domain:web:*.example.com']).toMatchObject({ state: 'done', id: 7 });
    expect(dns.resolve4).not.toHaveBeenCalled();
    expect(client.domains.create).not.toHaveBeenCalled();
    expect(client.domains.verify).not.toHaveBeenCalled();
  });

  it('records a failed add, and changes nothing without --yes', async () => {
    let client = fakePanel({ createFails: true });
    let r = receipt();
    let res = await run(plan([{ host: 'shop.example.com', https: true }]), r, client, fakeDns({ 'shop.example.com': [HERE] })).result;
    expect(res.failed).toBe(1);
    expect(r.items['domain:web:shop.example.com']).toMatchObject({ state: 'failed', notes: ['boom'] });
    client = fakePanel();
    r = receipt();
    const { result, save } = run(plan([{ host: 'shop.example.com', https: true }]), r, client, fakeDns({ 'shop.example.com': [HERE] }), false);
    res = await result;
    expect(res.lines.join('\n')).toMatch(/\+ shop\.example\.com: DNS points here; would add it \(https\)/);
    expect(client.domains.create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});

describe('edges', () => {
  it('builds a resolver on the server asked for', () => {
    expect(dnsLookup('9.9.9.9').servers()).toEqual(['9.9.9.9']);
    const d = dnsLookup();
    expect(typeof d.resolve4).toBe('function');
    expect(typeof d.resolve6).toBe('function');
  });
  it('passes on a settings error other than "not allowed", and on an expected name that does not resolve', async () => {
    const client = fakePanel();
    client.settings.dnsRecords.get = vi.fn(async () => { throw Object.assign(new Error('down'), { status: 502 }); });
    await expect(expectedAddresses(client, fakeDns({}), [HERE])).rejects.toThrow('down');
    await expect(expectedAddresses(fakePanel(), fakeDns({}), ['gone.example'])).rejects.toThrow('The expected address gone.example (--expect) does not resolve.');
  });
  it('checks a host listed twice once, records a failed verify and the DNS provider\'s warning', async () => {
    let client = fakePanel({ domains: [{ id: 7, hostname: 'shop.example.com', status: 'pending' }] });
    client.domains.verify = vi.fn(async () => { throw new Error('verify down'); });
    let res = await run(plan([{ host: 'shop.example.com', https: true }, { host: 'SHOP.example.com.', https: true }]), receipt(), client, fakeDns({ 'shop.example.com': [HERE] })).result;
    expect(client.domains.verify).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ failed: 1 });
    expect(res.lines.join('\n')).toContain('verify failed: verify down');
    client = fakePanel({ domains: [{ id: 7, hostname: 'shop.example.com', status: 'pending' }], verified: true });
    client.domains.verify = vi.fn(async () => ({ id: 7, verified: true, verification: null, dnsWarning: 'zone not found' }) as never);
    const r = receipt();
    await run(plan([{ host: 'shop.example.com', https: true }]), r, client, fakeDns({ 'shop.example.com': [HERE] })).result;
    expect(r.items['domain:web:shop.example.com']!.notes).toEqual(['DNS provider: zone not found']);
    client = fakePanel();
    const create = client.domains.create;
    client.domains.create = vi.fn(async (id, input) => ({ ...(await create(id, input)), dnsWarning: 'No Cloudflare zone matches' }) as never);
    const r2 = receipt();
    res = await run(plan([{ host: 'shop.example.com', https: true }]), r2, client, fakeDns({ 'shop.example.com': [HERE] })).result;
    expect(r2.items['domain:web:shop.example.com']!.notes).toEqual(['DNS provider: No Cloudflare zone matches']);
  });
});

describe('importCutoverAction', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('previews, refuses a bad resolver and a missing receipt, and says what still waits', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'nd-cutover-'));
    const planPath = path.join(dir, 'plan.json');
    writeFileSync(planPath, JSON.stringify(plan([{ host: 'shop.example.com', https: true }, { host: 'old.example', https: true }])));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakePanel({ dnsSettings: { enabled: true, content: HERE } });
    const dns = fakeDns({ 'shop.example.com': [HERE], 'old.example': ['198.51.100.9'] });
    await importCutoverAction(planPath, {}, { client, panel: PANEL, dns });
    expect(err.mock.calls.flat().join('')).toMatch(/No receipt at/);
    writeFileSync(path.join(dir, 'plan.receipt.json'), JSON.stringify(receipt()));
    await importCutoverAction(planPath, { resolver: 'dns.example' }, { client, panel: PANEL, dns });
    expect(err.mock.calls.flat().join('')).toMatch(/--resolver takes an IP address/);
    await importCutoverAction(planPath, {}, { client, panel: PANEL, dns });
    let printed = log.mock.calls.flat().join('\n');
    expect(printed).toMatch(/Cloudflare integration is on/);
    expect(printed).toMatch(/Nothing was added/);
    expect(client.domains.create).not.toHaveBeenCalled();
    await importCutoverAction(planPath, { yes: true }, { client, panel: PANEL, dns });
    printed = log.mock.calls.flat().join('\n');
    expect(printed).toMatch(/1 added, 1 waiting/);
    client.domains.list = vi.fn(async () => []);
    client.domains.create = vi.fn(async () => { throw new Error('boom'); });
    await importCutoverAction(planPath, { yes: true }, { client, panel: PANEL, dns });
    expect(err.mock.calls.flat().join('')).toMatch(/1 domain\(s\) failed/);
    writeFileSync(planPath, JSON.stringify(plan([{ host: 'x.1.2.3.4.sslip.io', https: true, sourceDefault: true }])));
    await importCutoverAction(planPath, { yes: true }, { client, panel: PANEL, dns });
    expect(log.mock.calls.flat().join('\n')).toMatch(/No domains to move/);
    log.mockRestore();
    err.mockRestore();
    process.exitCode = undefined;
  });
  it('refuses a receipt for another panel, and writes the receipt after adding', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'nd-cutover-'));
    const planPath = path.join(dir, 'plan.json');
    writeFileSync(planPath, JSON.stringify(plan([{ host: 'shop.example.com', https: true }])));
    writeFileSync(path.join(dir, 'plan.receipt.json'), JSON.stringify(receipt()));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakePanel();
    await importCutoverAction(planPath, { yes: true }, { client, panel: 'https://other.example', dns: fakeDns({}) });
    expect(err.mock.calls.flat().join('')).toMatch(/receipt is for https:\/\/panel\.example/);
    await importCutoverAction(planPath, { yes: true }, { client, panel: PANEL, dns: fakeDns({ 'shop.example.com': [HERE] }) });
    const saved = JSON.parse(readFileSync(path.join(dir, 'plan.receipt.json'), 'utf8')) as ImportReceipt;
    expect(saved.items['domain:web:shop.example.com']).toMatchObject({ state: 'done', id: 40 });
    expect(log.mock.calls.flat().join('\n')).toMatch(/Resolver: 9\.9\.9\.9/);
    log.mockRestore();
    err.mockRestore();
    process.exitCode = undefined;
  });
});
