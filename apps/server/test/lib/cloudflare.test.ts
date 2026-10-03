import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDnsRecord,
  deleteDnsRecord,
  detectPublicIp,
  findZoneId,
  getDnsRecordsConfig,
  listCloudflareZones,
  setDnsRecordsConfig,
  testCloudflareToken,
} from '../../src/lib/cloudflare.js';
import { createFakeDb } from '../helpers.js';

const cryptoMocks = vi.hoisted(() => ({
  encrypt: vi.fn((s: string) => `enc:${s}`),
  decrypt: vi.fn((s: string) => s.replace('enc:', '')),
}));
vi.mock('../../src/lib/crypto.js', () => cryptoMocks);

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

afterEach(() => fetchMock.mockReset());

const cfOk = (result: unknown) => ({ ok: true, json: async () => ({ success: true, errors: [], result }) });

// Settings lookup: map the requested key to a value via the eq() spy.
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

describe('lib/cloudflare', () => {
  it('reads an enabled config', async () => {
    const cfg = await getDnsRecordsConfig(
      settingsDb({ dns_records_provider: 'cloudflare', dns_records_token_encrypted: 'enc:t', dns_records_content: '1.2.3.4' }),
    );
    expect(cfg).toEqual({ enabled: true, token: 't', content: '1.2.3.4' });
  });

  it('reads a disabled config', async () => {
    const cfg = await getDnsRecordsConfig(settingsDb());
    expect(cfg.enabled).toBe(false);
    expect(cfg.token).toBeNull();
  });

  it('writes a config (token encrypted, empty clears)', async () => {
    const db = settingsDb();
    await setDnsRecordsConfig(db, { enabled: true, token: 'tok', content: 'example.com' });
    expect(cryptoMocks.encrypt).toHaveBeenCalledWith('tok');
    // An empty token skips encryption entirely (means "no token").
    cryptoMocks.encrypt.mockClear();
    await setDnsRecordsConfig(db, { enabled: false, token: '', content: null });
    expect(cryptoMocks.encrypt).not.toHaveBeenCalled();
    // No token key at all: the stored token is left untouched.
    await setDnsRecordsConfig(db, { enabled: true, content: '1.1.1.1' });
  });

  it('verifies a token', async () => {
    fetchMock.mockResolvedValueOnce(cfOk({ status: 'active' }));
    await expect(testCloudflareToken('t')).resolves.toBe('active');
  });

  it('finds a zone by exact or suffix match', async () => {
    fetchMock.mockResolvedValueOnce(cfOk([{ id: 'z1', name: 'example.com' }]));
    await expect(findZoneId('t', 'app.example.com')).resolves.toBe('z1');
    fetchMock.mockResolvedValueOnce(cfOk([{ id: 'z1', name: 'example.com' }]));
    await expect(findZoneId('t', 'other.org')).resolves.toBeNull();
  });

  it('prefers an exact zone match over any suffix match', async () => {
    fetchMock.mockResolvedValueOnce(cfOk([
      { id: 'parent', name: 'example.com' },
      { id: 'exact', name: 'dev.example.com' },
    ]));
    await expect(findZoneId('t', 'dev.example.com')).resolves.toBe('exact');
  });

  it('resolves nested hostnames into the most specific (longest) zone', async () => {
    fetchMock.mockResolvedValueOnce(cfOk([
      { id: 'parent', name: 'example.com' },
      { id: 'nested', name: 'dev.example.com' },
    ]));
    await expect(findZoneId('t', 'app.dev.example.com')).resolves.toBe('nested');
  });

  it('creates an A record for IP content', async () => {
    fetchMock.mockResolvedValueOnce(cfOk([{ id: 'z1', name: 'example.com' }]));
    fetchMock.mockResolvedValueOnce(cfOk({ id: 'rec-1' }));
    await expect(createDnsRecord('t', 'app.example.com', '203.0.113.9')).resolves.toBe('rec-1');
    const init = fetchMock.mock.calls[1]![1] as { method: string; body: string };
    expect(init.method).toBe('POST');
    expect(init.body).toContain('"type":"A"');
  });

  it('creates a CNAME record for hostname content', async () => {
    fetchMock.mockResolvedValueOnce(cfOk([{ id: 'z1', name: 'example.com' }]));
    fetchMock.mockResolvedValueOnce(cfOk({ id: 'rec-2' }));
    await expect(createDnsRecord('t', 'app.example.com', 'target.example.net')).resolves.toBe('rec-2');
    const init = fetchMock.mock.calls[1]![1] as { body: string };
    expect(init.body).toContain('"type":"CNAME"');
  });

  it('throws when no zone matches on create', async () => {
    fetchMock.mockResolvedValueOnce(cfOk([]));
    await expect(createDnsRecord('t', 'nope.org', '1.1.1.1')).rejects.toThrow(/No Cloudflare zone/);
  });

  it('surfaces API errors', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ success: false, errors: [{ message: 'forbidden' }] }) });
    await expect(testCloudflareToken('t')).rejects.toThrow(/forbidden/);
    // HTTP ok but success=false without error details falls back to the status.
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: false, errors: [] }) });
    await expect(testCloudflareToken('t')).rejects.toThrow(/Cloudflare API error: 200/);
  });

  it('deletes a record (best-effort)', async () => {
    fetchMock.mockResolvedValueOnce(cfOk([{ id: 'z1', name: 'example.com' }]));
    fetchMock.mockResolvedValueOnce(cfOk({ id: '' }));
    await expect(deleteDnsRecord('t', 'app.example.com', 'rec-1')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'DELETE' });
  });

  it('swallows network failures during deletion', async () => {
    fetchMock.mockResolvedValueOnce(cfOk([{ id: 'z1', name: 'example.com' }]));
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(deleteDnsRecord('t', 'app.example.com', 'rec-1')).resolves.toBeUndefined();
  });

  it('skips deletion when the zone cannot be derived', async () => {
    fetchMock.mockResolvedValueOnce(cfOk([]));
    await expect(deleteDnsRecord('t', 'gone.org', 'rec')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('detects the public IP', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ip: '198.51.100.7' }) });
    await expect(detectPublicIp()).resolves.toBe('198.51.100.7');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await expect(detectPublicIp()).rejects.toThrow(/Could not detect/);
  });

  it('lists every zone the token can see', async () => {
    fetchMock.mockResolvedValueOnce(
      cfOk([
        { id: 'z1', name: 'example.com' },
        { id: 'z2', name: 'example.net' },
      ]),
    );
    await expect(listCloudflareZones('t')).resolves.toEqual([
      { id: 'z1', name: 'example.com' },
      { id: 'z2', name: 'example.net' },
    ]);
    // The first call (and only call) must target /zones with the bearer.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/zones?per_page=50');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer t' });
  });

  it('surfaces API errors from listCloudflareZones', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ success: false, errors: [{ message: 'bad token' }] }),
    });
    await expect(listCloudflareZones('t')).rejects.toThrow(/bad token/);
  });
});
