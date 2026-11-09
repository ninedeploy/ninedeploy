import { expect, it, vi } from 'vitest';
vi.mock('../../apps/server/src/lib/crypto.js', () => ({ decrypt: (value: string) => value }));
import { searchLogs } from '../../apps/server/src/lib/logSearch.js';
it('verifies preserved proxy paths/origin/auth and unchanged legacy fallback/query clearing', async () => {
  let checked = 0;
  try {
    const cases: Array<{ input: string; path: string }> = [];
    for (const origin of ['https://fixture.invalid', 'http://fixture.invalid:4500']) {
      for (const prefix of ['', '/gateway/team-a', '/tenant%20a', '/encoded%2Fsegment', '//other.invalid', '/push-proxy']) {
        for (const slash of ['', '/']) cases.push({ input: `${origin}${prefix}/loki/api/v1/push${slash}?ingestOption=fixture#fragment`, path: `${prefix}/loki/api/v1/query_range` });
      }
      cases.push({ input: `${origin}/nonstandard-ingest?ingestOption=fixture#fragment`, path: '/loki/api/v1/query_range' });
      cases.push({ input: origin, path: '/loki/api/v1/query_range' });
    }
    for (const input of cases) {
      const drain = { id: 1, name: 'fixture', type: 'loki', enabled: true, url: input.input, apiKeyEncrypted: 'Bearer fixture', headersJson: '{"X-Scope-OrgID":"fixture-tenant"}' };
      const db = { query: { logDrains: { findMany: async () => [drain] } } } as never;
      const fetch = vi.fn(async (url: URL, init: RequestInit) => {
        const actual = new URL(url);
        expect(actual.origin).toBe(new URL(input.input).origin); expect(actual.pathname).toBe(input.path);
        expect(actual.hash).toBe(''); expect(actual.searchParams.has('ingestOption')).toBe(false);
        expect(actual.searchParams.get('query')).toBe('{job="ninedeploy"} |= "fixture"');
        const headers = new Headers(init.headers); expect(headers.get('authorization')).toBe('Bearer fixture'); expect(headers.get('x-scope-orgid')).toBe('fixture-tenant');
        return new Response(JSON.stringify({ status: 'success', data: { result: [] } }));
      });
      vi.stubGlobal('fetch', fetch);
      await expect(searchLogs(db, { query: 'fixture' })).resolves.toMatchObject({ unsupported: false });
      expect(fetch).toHaveBeenCalledOnce(); checked++;
    }
    console.log(`EXPECTED: ${checked} prefix/origin/trailing/encoded/auth/fallback cases | ACTUAL: all passed`);
    console.log('FIX VERIFIED');
  } finally { vi.unstubAllGlobals(); }
});
