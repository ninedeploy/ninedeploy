import { expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

it('routes the migration plan operations with their intended payloads', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const api = createClient({ baseUrl: 'https://panel.test', getToken: () => 'fixture-token', fetch });
  const createEmpty = { name: 'app-db', engine: 'postgres' };
  const cutover = { hostname: 'app.example.com' };
  const cases: Array<[() => Promise<unknown>, string, string, unknown?]> = [
    [() => api.databases.createEmpty(createEmpty as never), 'POST', '/v1/databases/empty', createEmpty],
    [() => api.deploys.migrationReadiness(7), 'GET', '/v1/services/7/deploys/migration-readiness'],
    [() => api.domains.cutoverCheck(7, 'app.example.com'), 'GET', '/v1/services/7/domains/cutover?hostname=app.example.com'],
    [() => api.domains.cutoverCheck(7, 'a b.example.com'), 'GET', '/v1/services/7/domains/cutover?hostname=a%20b.example.com'],
    [() => api.domains.cutover(7, cutover as never), 'POST', '/v1/services/7/domains/cutover', cutover],
  ];
  for (const [invoke, method, path, body] of cases) {
    await expect(invoke()).resolves.toEqual({ ok: true });
    const [url, init] = fetch.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect([url, init.method]).toEqual([`https://panel.test${path}`, method]);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-token');
    expect(init.body === undefined ? undefined : JSON.parse(init.body as string)).toEqual(body);
  }
  expect(fetch).toHaveBeenCalledTimes(cases.length);
});
