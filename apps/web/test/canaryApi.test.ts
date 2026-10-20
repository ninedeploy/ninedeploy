import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NineDeployError } from '@ninedeploy/sdk';
import { canaryApi, canaryKeys } from '../src/lib/canaryApi.js';
import { apiCall } from '../src/lib/apiCall.js';

/** 0.16.9 canary calls: paths, methods and the SDK's error shape. */

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

describe('canaryApi', () => {
  it('reads the canary of a service and promotes a deployment', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, '{"active":true,"deploymentId":7,"step":1,"steps":2,"weight":10}'));
    fetchMock.mockResolvedValueOnce(reply(200, '{"ok":true}'));
    expect(await canaryApi.status(3)).toEqual({ active: true, deploymentId: 7, step: 1, steps: 2, weight: 10 });
    expect(await canaryApi.promote(3, 7)).toEqual({ ok: true });
    const calls = fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit).method} ${url}`);
    expect(calls).toEqual(['GET /v1/services/3/canary', 'POST /v1/services/3/deploys/7/canary/promote']);
    expect((fetchMock.mock.calls[1]![1] as RequestInit).body).toBeUndefined();
  });

  it('carries the server message of a refused promote', async () => {
    fetchMock.mockResolvedValue(reply(400, '{"error":{"code":"no_canary","message":"That deployment has no canary in progress"}}'));
    const err = await canaryApi.promote(3, 7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NineDeployError);
    expect((err as NineDeployError).status).toBe(400);
    expect((err as NineDeployError).message).toContain('no canary in progress');
  });

  it('keys the status query per service', () => {
    expect(canaryKeys.status(3)).toEqual(['service-canary', 3]);
  });
});

describe('apiCall', () => {
  it('sends a JSON body with its content type', async () => {
    fetchMock.mockResolvedValue(reply(200, '{"id":1}'));
    expect(await apiCall('/v1/x', 'PATCH', { a: 1 })).toEqual({ id: 1 });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('answers an empty success body with an empty object', async () => {
    fetchMock.mockResolvedValue(reply(204, ''));
    expect(await apiCall('/v1/x')).toEqual({});
  });

  it('refuses a non-JSON success body', async () => {
    fetchMock.mockResolvedValue(reply(200, '<html>'));
    await expect(apiCall('/v1/x')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('names the status of a failure without a JSON body', async () => {
    fetchMock.mockResolvedValue(reply(502, 'Bad gateway'));
    await expect(apiCall('/v1/x')).rejects.toMatchObject({ status: 502, code: 'http_error', message: 'Request failed (502)' });
  });
});
