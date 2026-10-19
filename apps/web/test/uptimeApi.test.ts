import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NineDeployError } from '@ninedeploy/sdk';
import { uptimeApi, uptimeKeys } from '../src/lib/uptimeApi.js';

/** 0.16.8 uptime calls: paths, methods, bodies and the SDK's error shape. */

vi.mock('../src/lib/api.js', () => ({
  authedFetch: (url: string, init?: RequestInit) => fetch(url, init),
}));

function reply(status: number, body: string) {
  return { ok: status >= 200 && status < 300, status, text: async () => body } as Response;
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('uptimeApi', () => {
  it('calls every monitor route', async () => {
    fetchMock.mockResolvedValue(reply(200, '[]'));
    await uptimeApi.monitors.list();
    await uptimeApi.monitors.list(4);
    await uptimeApi.monitors.get(1);
    await uptimeApi.monitors.checks(1);
    await uptimeApi.monitors.checks(1, 168);
    await uptimeApi.monitors.create({ name: 'a', kind: 'http', target: 'https://a.test' });
    await uptimeApi.monitors.update(1, { enabled: false });
    await uptimeApi.monitors.remove(1);
    await uptimeApi.monitors.check(1);
    const calls = fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit).method} ${url}`);
    expect(calls).toEqual([
      'GET /v1/monitors',
      'GET /v1/monitors?serviceId=4',
      'GET /v1/monitors/1',
      'GET /v1/monitors/1/checks?hours=24',
      'GET /v1/monitors/1/checks?hours=168',
      'POST /v1/monitors',
      'PATCH /v1/monitors/1',
      'DELETE /v1/monitors/1',
      'POST /v1/monitors/1/check',
    ]);
    const create = fetchMock.mock.calls[5]![1] as RequestInit;
    expect(create.body).toBe(JSON.stringify({ name: 'a', kind: 'http', target: 'https://a.test' }));
    expect(create.headers).toEqual({ 'Content-Type': 'application/json' });
    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBeUndefined();
  });

  it('calls every status page route', async () => {
    fetchMock.mockResolvedValue(reply(200, '{"id":1}'));
    expect(await uptimeApi.statusPages.get(1)).toEqual({ id: 1 });
    await uptimeApi.statusPages.list();
    await uptimeApi.statusPages.create({ slug: 'a', title: 'A' });
    await uptimeApi.statusPages.update(1, { published: true });
    await uptimeApi.statusPages.remove(1);
    const calls = fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit).method} ${url}`);
    expect(calls).toEqual(['GET /v1/status-pages/1', 'GET /v1/status-pages', 'POST /v1/status-pages', 'PATCH /v1/status-pages/1', 'DELETE /v1/status-pages/1']);
  });

  it("throws the server's message on a refusal", async () => {
    fetchMock.mockResolvedValueOnce(reply(400, JSON.stringify({ error: { code: 'invalid', message: 'a TCP target is host:port' } })));
    const err = await uptimeApi.monitors.create({ name: 'a', kind: 'tcp', target: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NineDeployError);
    expect((err as NineDeployError).message).toBe('a TCP target is host:port');
    expect((err as NineDeployError).status).toBe(400);
  });

  it('reports a failure without a JSON body by its status', async () => {
    fetchMock.mockResolvedValueOnce(reply(502, '<html>bad gateway</html>'));
    await expect(uptimeApi.monitors.list()).rejects.toThrow('Request failed (502)');
  });

  it('resolves an empty success body to {} and refuses a non-JSON one', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, ''));
    expect(await uptimeApi.monitors.remove(1)).toEqual({});
    fetchMock.mockResolvedValueOnce(reply(200, '<html>'));
    await expect(uptimeApi.monitors.list()).rejects.toThrow(/non-JSON/);
  });

  it('keys every monitor listing under one prefix', () => {
    expect(uptimeKeys.monitorList()).toEqual(['monitors', 'all']);
    expect(uptimeKeys.monitorList(3)).toEqual(['monitors', 'service', 3]);
    expect(uptimeKeys.monitorList(3)[0]).toBe(uptimeKeys.monitors[0]);
    expect(uptimeKeys.checks(1, 24)).toEqual(['monitor-checks', 1, 24]);
  });
});
