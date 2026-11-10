import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportReceipt } from '../src/commands/importApply.js';
import { type CutoverClient, cutover, type DnsLookup, type Expected, expectedAddresses, importCutoverAction, resolveHost } from '../src/commands/importCutover.js';
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
  domains?: Array<{ id: number; hostname: string; status: string }>;
  dnsSettings?: { enabled: boolean; content: string | null } | 'forbidden';
  createStatus?: string;
  createFails?: boolean;
  verified?: boolean;
}
function fakePanel(st: PanelState = {}) {
  const domains = [...(st.domains ?? [])];
  const client: CutoverClient = {
    services: { get: vi.fn(async () => ({ status: st.status ?? 'running' })) },
    deploys: { list: vi.fn(async () => (st.deploy === null ? [] : [{ id: 3, status: st.deploy ?? 'running' }, { id: 2, status: 'failed' }])) },
    domains: {
      list: vi.fn(async () => domains as never),
      create: vi.fn(async (_id, input) => {
        if (st.createFails) throw new Error('boom');
        const status = st.createStatus ?? 'active';
        const d = { id: 40 + domains.length, hostname: input.hostname, status };
        domains.push(d);
        return { ...d, dnsWarning: null, verification: status === 'pending' ? { recordName: `_nd.${input.hostname}`, recordType: 'TXT', recordValue: 'proof' } : null } as never;
      }),
      verify: vi.fn(async (_s, id) => (st.verified
        ? { id, verified: true, verification: null, dnsWarning: null }
        : { id, verified: false, error: 'no TXT', verification: { recordName: '_nd.x', recordType: 'TXT', recordValue: 'proof' } }) as never),
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
    expect(res.lines.join('\n')).toMatch(/old\.example: resolves to 198\.51\.100\.9, not 203\.0\.113\.7; switch DNS first/);
    expect(res.lines.join('\n')).not.toContain('sslip');
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
    const res = await run(plan([{ host: 'shop.example.com', https: true }]), r, client, fakeDns({})).result;
    expect(client.domains.create).not.toHaveBeenCalled();
    expect(res.waiting).toBe(0);
    expect(r.items['domain:web:shop.example.com']).toMatchObject({ state: 'done', id: 7 });
  });

  it('verifies a pending domain only once its DNS passes, and prints the TXT without storing it', async () => {
    const pending = [{ id: 7, hostname: 'shop.example.com', status: 'pending' }];
    let client = fakePanel({ domains: pending });
    let res = await run(plan([{ host: 'shop.example.com', https: true }]), receipt(), client, fakeDns({ 'shop.example.com': ['198.51.100.9'] })).result;
    expect(client.domains.verify).not.toHaveBeenCalled();
    client = fakePanel({ domains: pending });
    const r = receipt();
    res = await run(plan([{ host: 'shop.example.com', https: true }]), r, client, fakeDns({ 'shop.example.com': [HERE] })).result;
    expect(client.domains.verify).toHaveBeenCalledWith(12, 7);
    expect(res.lines.join('\n')).toContain('publish TXT _nd.x = proof');
    expect(JSON.stringify(r)).not.toContain('proof');
    client = fakePanel({ domains: pending, verified: true });
    res = await run(plan([{ host: 'shop.example.com', https: true }]), r, client, fakeDns({ 'shop.example.com': [HERE] })).result;
    expect(res.added).toBe(1);
    expect(r.items['domain:web:shop.example.com']).toMatchObject({ state: 'done', id: 7 });
  });

  it('prints the challenge of a domain the panel created pending, and keeps it out of the receipt', async () => {
    const client = fakePanel({ createStatus: 'pending' });
    const r = receipt();
    const res = await run(plan([{ host: 'shop.example.com', https: true }]), r, client, fakeDns({ 'shop.example.com': [HERE] })).result;
    expect(res.lines.join('\n')).toContain('publish TXT _nd.shop.example.com = proof');
    expect(r.items['domain:web:shop.example.com']!.notes).toEqual(['ownership proof pending (TXT)']);
    expect(JSON.stringify(r)).not.toContain('proof"');
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

describe('importCutoverAction', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
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
