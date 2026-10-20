import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NineDeployError } from '@ninedeploy/sdk';
import { sleepApi } from '../src/lib/sleepApi.js';

/** 0.16.11 scale-to-zero calls: paths, methods and the SDK's error shape. */

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

describe('sleepApi', () => {
  it('puts a service to sleep and wakes it', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, '{"ok":true,"asleep":true}'));
    fetchMock.mockResolvedValueOnce(reply(200, '{"ok":true,"status":"running"}'));
    expect(await sleepApi.sleep(3)).toEqual({ ok: true, asleep: true });
    expect(await sleepApi.wake(3)).toEqual({ ok: true, status: 'running' });
    const calls = fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit).method} ${url}`);
    expect(calls).toEqual(['POST /v1/services/3/sleep', 'POST /v1/services/3/wake']);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBeUndefined();
  });

  it('carries the reason of a refused sleep', async () => {
    fetchMock.mockResolvedValue(
      reply(400, '{"error":{"code":"cannot_sleep","message":"Cannot put the service to sleep: no domain routes to the service, so no request could wake it"}}'),
    );
    const err = await sleepApi.sleep(3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NineDeployError);
    expect((err as NineDeployError).status).toBe(400);
    expect((err as NineDeployError).code).toBe('cannot_sleep');
    expect((err as NineDeployError).message).toContain('no domain routes to the service');
  });
});
