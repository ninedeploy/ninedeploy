import { expect, it, vi } from 'vitest';
vi.mock('../../apps/server/src/lib/crypto.js', () => ({ decrypt: (value: string) => value }));
import { dispatchLogBatch, dispatchLogToDrain } from '../../apps/server/src/engine/logDrainManager.js';
import { searchLogs } from '../../apps/server/src/lib/logSearch.js';
const entry = { timestamp: '2026-11-09T00:00:00Z', service: 'fixture', container: 'fixture', line: 'fixture' };
it('verifies single/batch credential priorities, content-type overrides, query auth and opaque custom names', async () => {
  let checks = 0;
  try {
    for (const target of [
      { type: 'http' as const, field: 'Authorization', expected: 'Bearer fixture' },
      { type: 'datadog' as const, field: 'DD-API-KEY', expected: 'fixture' },
      { type: 'newrelic' as const, field: 'Api-Key', expected: 'fixture' },
      { type: 'splunk' as const, field: 'Authorization', expected: 'Splunk fixture' },
      { type: 'elasticsearch' as const, field: 'Authorization', expected: 'ApiKey fixture' },
    ]) {
      for (const field of [target.field, target.field.toLowerCase(), target.field.toUpperCase()]) {
        const headers = Object.freeze({ [field]: 'REPLACED', 'X-Scope-OrgID': 'tenant' });
        const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
          const wire = new Headers(init?.headers);
          expect(wire.get(target.field)).toBe(target.expected); expect(wire.get('x-scope-orgid')).toBe('tenant');
          return new Response(JSON.stringify({ errors: false, items: [] }));
        });
        const drain = { url: 'https://fixture.invalid', type: target.type, format: 'json' as const, apiKey: 'fixture', headers };
        expect((await dispatchLogToDrain(drain, entry, fetch)).ok).toBe(true);
        expect((await dispatchLogBatch(drain, [entry], fetch)).ok).toBe(true);
        expect(headers[field]).toBe('REPLACED'); checks += 2;
      }
    }
    for (const field of ['Content-Type', 'content-type', 'CONTENT-TYPE']) {
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('content-type')).toBe('application/x-ndjson'); return new Response(null, { status: 204 });
      });
      expect((await dispatchLogToDrain({ url: 'https://fixture.invalid', type: 'http', format: 'json', headers: { [field]: 'application/x-ndjson' } }, entry, fetch)).ok).toBe(true); checks++;
    }
    const custom = JSON.parse('{"X-Opaque-Context":"opaque-context","constructor":"opaque-constructor","x-scope-orgid":"tenant"}') as Record<string, string>;
    const fetch = vi.fn(async (_url: URL, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.get('x-opaque-context')).toBe('opaque-context'); expect(headers.get('constructor')).toBe('opaque-constructor'); expect(headers.get('x-scope-orgid')).toBe('tenant');
      return new Response(JSON.stringify({ status: 'success', data: { result: [] } }));
    });
    vi.stubGlobal('fetch', fetch);
    const drain = { id: 1, name: 'fixture', enabled: true, type: 'loki', url: 'https://fixture.invalid', headersJson: JSON.stringify(custom), apiKeyEncrypted: null };
    const db = { query: { logDrains: { findMany: async () => [drain] } } } as never;
    await searchLogs(db, { query: 'fixture' }); checks++;
    expect(custom['X-Opaque-Context']).toBe('opaque-context');
    console.log(`EXPECTED: ${checks} case/priority/body/opaque-field checks preserve inputs | ACTUAL: all passed`);
    console.log('FIX VERIFIED');
  } finally { vi.unstubAllGlobals(); }
});
