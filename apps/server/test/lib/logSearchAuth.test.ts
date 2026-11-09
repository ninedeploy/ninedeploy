import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../src/lib/crypto.js', () => ({ decrypt: (value: string) => value }));
import { searchLogs } from '../../src/lib/logSearch.js';

afterEach(() => vi.unstubAllGlobals());

it.each([
  { label: 'plain token control', key: 'fixture-token', headers: null, authorization: 'Bearer fixture-token', tenant: null },
  { label: 'already prefixed token', key: 'Bearer fixture-token', headers: null, authorization: 'Bearer fixture-token', tenant: null },
  { label: 'tenant header', key: 'fixture-token', headers: JSON.stringify({ 'X-Scope-OrgID': 'fixture-tenant' }), authorization: 'Bearer fixture-token', tenant: 'fixture-tenant' },
  { label: 'custom authorization', key: null, headers: JSON.stringify({ Authorization: 'Basic fixture', 'X-Scope-OrgID': 'fixture-tenant' }), authorization: 'Basic fixture', tenant: 'fixture-tenant' },
  { label: 'JSON null headers control', key: 'fixture-token', headers: 'null', authorization: 'Bearer fixture-token', tenant: null },
])('F1047: searches using configured drain auth: $label', async input => {
  const drain = { id: 1, name: 'fixture', type: 'loki', enabled: true, url: 'https://fixture.invalid/loki/api/v1/push', apiKeyEncrypted: input.key, headersJson: input.headers };
  const db = { query: { logDrains: { findMany: async () => [drain] } } } as never;
  const fetch = vi.fn(async (_url: URL, init: RequestInit) => {
    const headers = new Headers(init.headers);
    if (headers.get('authorization') !== input.authorization || headers.get('x-scope-orgid') !== input.tenant) return new Response('configured auth required', { status: 401 });
    return new Response(JSON.stringify({ status: 'success', data: { result: [{ stream: { service: 'fixture' }, values: [['1770000000000000000', 'matched']] }] } }));
  });
  vi.stubGlobal('fetch', fetch);
  await expect(searchLogs(db, { query: 'matched' })).resolves.toMatchObject({ lines: [{ line: 'matched', service: 'fixture' }] });
  expect(fetch).toHaveBeenCalledOnce();
});
