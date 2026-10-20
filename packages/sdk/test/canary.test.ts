import { describe, expect, it, vi } from 'vitest';
import {
  CANARY_DEFAULT_STEP_SECONDS,
  canaryConfig,
} from '@ninedeploy/schemas';
import { createClient, NineDeployError, type CanaryConfigInput, type CanaryStatusView, type Service, type UpdateServiceInput } from '../src/index.js';

/** 0.16.9: canary status and promote on `deploys`, and `canary` on a service. */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function client(reply: (url: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} })) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ url: path, method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const r = reply(path);
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) } as unknown as Response;
  });
  return { api: createClient({ baseUrl: 'http://api.test', fetch: fetchMock }), calls };
}

const lastOf = (calls: Call[]): Call => {
  const call = calls[calls.length - 1];
  if (!call) throw new Error('no call recorded');
  return call;
};

describe('canary routes', () => {
  it('maps status, promote and the service config onto the shipped routes', async () => {
    const { api, calls } = client();
    const on: UpdateServiceInput = { canary: { steps: [10, 50] } };
    const off: UpdateServiceInput = { canary: null };
    const cases: Array<[() => Promise<unknown>, string, string, unknown]> = [
      [() => api.deploys.canary(4), 'GET', '/v1/services/4/canary', undefined],
      [() => api.deploys.promoteCanary(4, 9), 'POST', '/v1/services/4/deploys/9/canary/promote', undefined],
      [() => api.deploys.cancel(4, 9), 'POST', '/v1/services/4/deploys/9/cancel', undefined],
      [() => api.services.update(4, on), 'PATCH', '/v1/services/4', { canary: { steps: [10, 50] } }],
      [() => api.services.update(4, off), 'PATCH', '/v1/services/4', { canary: null }],
    ];
    for (const [run, method, url, body] of cases) {
      await run();
      expect(lastOf(calls)).toEqual({ method, url, body });
    }
  });

  it('returns the live status unchanged', async () => {
    const status: CanaryStatusView = {
      active: true,
      deploymentId: 9,
      step: 1,
      steps: 2,
      weight: 10,
      stepStartedAt: '2026-10-20T10:00:00.000Z',
      stepEndsAt: '2026-10-20T10:02:00.000Z',
      measured: true,
      canary: { requests: 40, errors: 1, errorRate: 2.5, p95Ms: 120 },
      stable: { requests: 360, errors: 0, errorRate: 0, p95Ms: 90 },
      promoting: false,
    };
    const { api } = client(() => ({ status: 200, body: status }));
    await expect(api.deploys.canary(4)).resolves.toEqual(status);
  });

  it('returns active: false when no canary is running', async () => {
    const { api } = client(() => ({ status: 200, body: { active: false } }));
    await expect(api.deploys.canary(4)).resolves.toEqual({ active: false });
  });

  it('surfaces no_canary as a NineDeployError', async () => {
    const { api } = client(() => ({ status: 400, body: { error: { code: 'no_canary', message: 'No canary in progress' } } }));
    const err = (await api.deploys.promoteCanary(4, 9).catch((e: unknown) => e)) as NineDeployError;
    expect(err).toBeInstanceOf(NineDeployError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('no_canary');
  });

  it('types the service canary as the schema config, defaults filled', async () => {
    const input: CanaryConfigInput = { steps: [25] };
    const filled = canaryConfig.parse(input);
    expect(filled.stepSeconds).toBe(CANARY_DEFAULT_STEP_SECONDS);
    const { api } = client(() => ({ status: 200, body: { id: 4, canary: filled } }));
    const svc: Service = await api.services.update(4, { canary: input });
    expect(svc.canary).toEqual({ steps: [25], stepSeconds: 120, maxErrorRate: 5, maxP95Ms: null, minRequests: 20 });
  });
});
