import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NineDeployError } from '@ninedeploy/sdk';
import { autoscaleApi, autoscaleKeys } from '../src/lib/autoscaleApi.js';

/** 0.16.10 autoscale status: path, method and the SDK's error shape. */

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

describe('autoscaleApi', () => {
  it('reads the autoscale status of a service', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, '{"enabled":false,"replicas":1}'));
    expect(await autoscaleApi.status(3)).toEqual({ enabled: false, replicas: 1 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(`${(init as RequestInit).method} ${url}`).toBe('GET /v1/services/3/autoscale');
    expect((init as RequestInit).body).toBeUndefined();
  });

  it("carries the server's message of a refused read", async () => {
    fetchMock.mockResolvedValue(reply(404, '{"error":{"code":"not_found","message":"Service not found"}}'));
    const err = await autoscaleApi.status(3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NineDeployError);
    expect((err as NineDeployError).status).toBe(404);
    expect((err as NineDeployError).message).toBe('Service not found');
  });

  it('keys the status query per service', () => {
    expect(autoscaleKeys.status(3)).toEqual(['service-autoscale', 3]);
  });
});
