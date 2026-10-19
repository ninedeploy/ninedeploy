import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

/** 0.16.8: the `monitors` and `statusPages` namespaces. */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function client(respond: (url: string) => unknown = () => ({})) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ url: path, method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const body = respond(path);
    const text = body === undefined ? '' : JSON.stringify(body);
    return { ok: true, status: 200, text: async () => text } as unknown as Response;
  });
  return { api: createClient({ baseUrl: 'http://api.test', fetch: fetchMock }), calls };
}

const lastOf = (calls: Call[]): Call => {
  const call = calls[calls.length - 1];
  if (!call) throw new Error('no call recorded');
  return call;
};

describe('monitors namespace', () => {
  it('maps every method to its route, method and body', async () => {
    const { api, calls } = client();
    const cases: Array<[() => Promise<unknown>, string, string, unknown]> = [
      [() => api.monitors.list(), 'GET', '/v1/monitors', undefined],
      [() => api.monitors.list({}), 'GET', '/v1/monitors', undefined],
      [() => api.monitors.list({ serviceId: 4 }), 'GET', '/v1/monitors?serviceId=4', undefined],
      [() => api.monitors.get(7), 'GET', '/v1/monitors/7', undefined],
      [() => api.monitors.checks(7), 'GET', '/v1/monitors/7/checks', undefined],
      [() => api.monitors.checks(7, {}), 'GET', '/v1/monitors/7/checks', undefined],
      [() => api.monitors.checks(7, { hours: 48 }), 'GET', '/v1/monitors/7/checks?hours=48', undefined],
      [
        () => api.monitors.create({ name: 'site', kind: 'http', target: 'https://example.com' }),
        'POST',
        '/v1/monitors',
        { name: 'site', kind: 'http', target: 'https://example.com' },
      ],
      [() => api.monitors.update(7, { enabled: false }), 'PATCH', '/v1/monitors/7', { enabled: false }],
      [() => api.monitors.delete(7), 'DELETE', '/v1/monitors/7', undefined],
      [() => api.monitors.checkNow(7), 'POST', '/v1/monitors/7/check', undefined],
    ];
    for (const [run, method, url, body] of cases) {
      await run();
      expect(lastOf(calls)).toEqual({ method, url, body });
    }
  });

  it('returns the check-now result unchanged', async () => {
    const result = { check: { ts: '2026-10-20T00:00:00.000Z', ok: true, responseMs: 12, statusCode: 200, error: null }, monitor: { id: 7, status: 'up' } };
    const { api } = client((url) => (url.endsWith('/check') ? result : undefined));
    await expect(api.monitors.checkNow(7)).resolves.toEqual(result);
  });
});

describe('statusPages namespace', () => {
  it('maps every method to its route, method and body', async () => {
    const { api, calls } = client();
    const cases: Array<[() => Promise<unknown>, string, string, unknown]> = [
      [() => api.statusPages.list(), 'GET', '/v1/status-pages', undefined],
      [() => api.statusPages.get(2), 'GET', '/v1/status-pages/2', undefined],
      [
        () => api.statusPages.create({ slug: 'acme', title: 'Acme', monitorIds: [7] }),
        'POST',
        '/v1/status-pages',
        { slug: 'acme', title: 'Acme', monitorIds: [7] },
      ],
      [() => api.statusPages.update(2, { published: true }), 'PATCH', '/v1/status-pages/2', { published: true }],
      [() => api.statusPages.delete(2), 'DELETE', '/v1/status-pages/2', undefined],
      [() => api.statusPages.public('acme'), 'GET', '/v1/status/acme', undefined],
      [() => api.statusPages.public('a b'), 'GET', '/v1/status/a%20b', undefined],
    ];
    for (const [run, method, url, body] of cases) {
      await run();
      expect(lastOf(calls)).toEqual({ method, url, body });
    }
  });
});
