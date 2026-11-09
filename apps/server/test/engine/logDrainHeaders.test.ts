import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../src/lib/crypto.js', () => ({ decrypt: (value: string) => value }));
import { dispatchLogToDrain } from '../../src/engine/logDrainManager.js';
import { searchLogs } from '../../src/lib/logSearch.js';

const entry = { timestamp: '2026-11-09T00:00:00Z', service: 'fixture', container: 'fixture', line: 'fixture' };
afterEach(() => vi.unstubAllGlobals());

it.each(['Authorization', 'authorization', 'AuThOrIzAtIoN'])('F1048: API key replaces custom %s without duplicate wire values', async field => {
  const headers = Object.freeze({ [field]: 'Basic replaced', 'X-Scope-OrgID': 'tenant' });
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const actual = new Headers(init?.headers);
    return new Response(null, { status: actual.get('authorization') === 'Bearer fixture' && actual.get('x-scope-orgid') === 'tenant' ? 204 : 401 });
  });
  await expect(dispatchLogToDrain({ url: 'https://fixture.invalid', type: 'loki', format: 'json', apiKey: 'fixture', headers }, entry, fetch)).resolves.toMatchObject({ ok: true });
  expect(headers[field]).toBe('Basic replaced');
});

it.each(['Content-Type', 'content-type', 'CoNtEnT-TyPe'])('F1048: custom %s replaces the default content type', async field => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => new Response(null, { status: new Headers(init?.headers).get('content-type') === 'application/x-ndjson' ? 204 : 415 }));
  await expect(dispatchLogToDrain({ url: 'https://fixture.invalid', type: 'http', format: 'json', headers: { [field]: 'application/x-ndjson' } }, entry, fetch)).resolves.toMatchObject({ ok: true });
});

it.each([
  { type: 'datadog' as const, field: 'dd-api-key' },
  { type: 'newrelic' as const, field: 'api-key' },
])('F1048: $type credentials override a differently cased custom key', async input => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => new Response(null, { status: new Headers(init?.headers).get(input.field) === 'fixture' ? 204 : 401 }));
  await expect(dispatchLogToDrain({ url: 'https://fixture.invalid', type: input.type, format: 'json', apiKey: 'fixture', headers: { [input.field]: 'replaced' } }, entry, fetch)).resolves.toMatchObject({ ok: true });
});

it.each(['Authorization', 'authorization', 'AuThOrIzAtIoN'])('F1048: search applies API-key priority over %s', async field => {
  const drain = { id: 1, name: 'fixture', type: 'loki', enabled: true, url: 'https://fixture.invalid', apiKeyEncrypted: 'fixture', headersJson: JSON.stringify({ [field]: 'Basic replaced' }) };
  const db = { query: { logDrains: { findMany: async () => [drain] } } } as never;
  vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => new Headers(init.headers).get('authorization') === 'Bearer fixture'
    ? new Response(JSON.stringify({ status: 'success', data: { result: [] } })) : new Response('invalid duplicate auth', { status: 401 })));
  await expect(searchLogs(db, { query: 'fixture' })).resolves.toMatchObject({ unsupported: false });
});

it('F1048: preserves custom credentials when no API key is supplied', async () => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => new Response(null, { status: new Headers(init?.headers).get('authorization') === 'Basic fixture' ? 204 : 401 }));
  await expect(dispatchLogToDrain({ url: 'https://fixture.invalid', type: 'http', format: 'json', headers: { authorization: 'Basic fixture' } }, entry, fetch)).resolves.toMatchObject({ ok: true });
});
