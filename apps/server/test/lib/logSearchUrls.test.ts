import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../src/lib/crypto.js', () => ({ decrypt: (value: string) => value }));
import { searchLogs } from '../../src/lib/logSearch.js';

afterEach(() => vi.unstubAllGlobals());

it.each([
  { input: 'https://fixture.invalid', expected: '/loki/api/v1/query_range' },
  { input: 'https://fixture.invalid/loki/api/v1/push', expected: '/loki/api/v1/query_range' },
  { input: 'https://fixture.invalid/gateway/team-a/loki/api/v1/push', expected: '/gateway/team-a/loki/api/v1/query_range' },
  { input: 'https://fixture.invalid/tenant%20a/loki/api/v1/push', expected: '/tenant%20a/loki/api/v1/query_range' },
  { input: 'https://fixture.invalid//gateway/loki/api/v1/push', expected: '//gateway/loki/api/v1/query_range' },
  { input: 'https://fixture.invalid/gateway/loki/api/v1/push/?ingestOption=fixture#fragment', expected: '/gateway/loki/api/v1/query_range' },
  { input: 'https://fixture.invalid/nonstandard-ingest?ingestOption=fixture#fragment', expected: '/loki/api/v1/query_range' },
])('F1049: derives query URL from $input', async input => {
  const drain = { id: 1, name: 'fixture', type: 'loki', enabled: true, url: input.input, apiKeyEncrypted: null, headersJson: null };
  const db = { query: { logDrains: { findMany: async () => [drain] } } } as never;
  const fetch = vi.fn(async (url: URL) => {
    const actual = new URL(url);
    if (actual.origin !== new URL(input.input).origin || actual.pathname !== input.expected) return new Response('wrong query endpoint', { status: 404 });
    expect(actual.hash).toBe(''); expect(actual.searchParams.has('ingestOption')).toBe(false);
    expect(actual.searchParams.get('query')).toBe('{job="ninedeploy"} |= "fixture"');
    return new Response(JSON.stringify({ status: 'success', data: { result: [] } }));
  });
  vi.stubGlobal('fetch', fetch);
  await expect(searchLogs(db, { query: 'fixture' })).resolves.toMatchObject({ unsupported: false });
  expect(fetch).toHaveBeenCalledOnce();
});
