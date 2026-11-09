import { expect, it, vi } from 'vitest';
vi.mock('../../apps/server/src/lib/crypto.js', () => ({ decrypt: (value: string) => value }));
import { searchLogs } from '../../apps/server/src/lib/logSearch.js';
it('verifies configured auth, priority, null headers, upstream refusal and service-bound drain rejection', async () => {
  const cases = [
    { key: 'fixture', headers: null, auth: 'Bearer fixture', tenant: null },
    { key: 'Bearer fixture', headers: { 'X-Scope-OrgID': 'tenant' }, auth: 'Bearer fixture', tenant: 'tenant' },
    { key: null, headers: { Authorization: 'Basic fixture', 'X-Scope-OrgID': 'tenant' }, auth: 'Basic fixture', tenant: 'tenant' },
    { key: 'fixture', headers: { Authorization: 'Basic replaced', 'X-Scope-OrgID': 'tenant' }, auth: 'Bearer fixture', tenant: 'tenant' },
    { key: null, headers: {}, auth: null, tenant: null },
    { key: 'fixture', headers: null, auth: 'Bearer fixture', tenant: null },
  ];
  let checked = 0;
  try {
    for (const input of cases) {
      for (const restricted of [false, true]) {
        const drain = { id: 1, name: 'fixture', type: 'loki', enabled: true, serviceId: null, url: 'https://fixture.invalid/loki/api/v1/push', apiKeyEncrypted: input.key, headersJson: JSON.stringify(input.headers) };
        const db = { query: { logDrains: { findMany: async () => [drain], findFirst: async () => drain }, services: { findFirst: async () => ({ id: 7, slug: 'fixture' }) } } } as never;
        const fetch = vi.fn(async (_url: URL, init: RequestInit) => {
          const headers = new Headers(init.headers);
          expect(headers.get('authorization')).toBe(input.auth); expect(headers.get('x-scope-orgid')).toBe(input.tenant);
          return new Response(JSON.stringify({ status: 'success', data: { result: [] } }));
        });
        vi.stubGlobal('fetch', fetch);
        await expect(searchLogs(db, { query: 'fixture', ...(restricted ? { serviceId: 7, restrictToServiceId: 7 } : {}) })).resolves.toMatchObject({ unsupported: false });
        expect(fetch).toHaveBeenCalledOnce(); checked++;
      }
    }
    const foreign = { id: 2, name: 'foreign', type: 'loki', enabled: true, serviceId: 8, url: 'https://fixture.invalid', apiKeyEncrypted: 'foreign-fixture', headersJson: '{"X-Scope-OrgID":"foreign"}' };
    const db = { query: { logDrains: { findFirst: async () => foreign } } } as never;
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(searchLogs(db, { query: 'fixture', drainId: 2, serviceId: 7, restrictToServiceId: 7 })).rejects.toThrow('No enabled Loki drain');
    expect(fetch).not.toHaveBeenCalled();
    foreign.serviceId = 7;
    (db as any).query.services = { findFirst: async () => ({ id: 7, slug: 'fixture' }) };
    fetch.mockResolvedValue(new Response('refused', { status: 401 }));
    await expect(searchLogs(db, { query: 'fixture', drainId: 2, serviceId: 7, restrictToServiceId: 7 })).rejects.toThrow('Loki query failed: 401');
    console.log(`EXPECTED: ${checked} auth/scope controls, foreign drain rejected before fetch, upstream401 propagated | ACTUAL: all passed`);
    console.log('FIX VERIFIED');
  } finally { vi.unstubAllGlobals(); }
});
