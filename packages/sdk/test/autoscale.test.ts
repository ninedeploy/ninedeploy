import { describe, expect, it, vi } from 'vitest';
import { autoscaleConfig } from '@ninedeploy/schemas';
import {
  createClient,
  NineDeployError,
  type AutoscaleConfigInput,
  type AutoscaleStatusView,
  type Service,
  type UpdateServiceInput,
} from '../src/index.js';

/** 0.16.10: autoscaling status on `services`, and `autoscale` on a service. */

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

describe('autoscale routes', () => {
  it('maps the status and the service config onto the shipped routes', async () => {
    const { api, calls } = client();
    const on: UpdateServiceInput = { autoscale: { maxReplicas: 4, target: 70 } };
    const off: UpdateServiceInput = { autoscale: null };
    const cases: Array<[() => Promise<unknown>, string, string, unknown]> = [
      [() => api.services.autoscale(4), 'GET', '/v1/services/4/autoscale', undefined],
      [() => api.services.update(4, on), 'PATCH', '/v1/services/4', { autoscale: { maxReplicas: 4, target: 70 } }],
      [() => api.services.update(4, off), 'PATCH', '/v1/services/4', { autoscale: null }],
    ];
    for (const [run, method, url, body] of cases) {
      await run();
      expect(lastOf(calls)).toEqual({ method, url, body });
    }
  });

  it('returns the live status unchanged', async () => {
    const status: AutoscaleStatusView = {
      enabled: true,
      replicas: 2,
      minReplicas: 1,
      maxReplicas: 4,
      metric: 'cpu',
      target: 70,
      value: 91.5,
      desired: 3,
      holding: null,
      lastEvent: { at: '2026-10-20T10:00:00.000Z', from: 1, to: 2, reason: 'cpu 88% > target 70%' },
    };
    const { api } = client(() => ({ status: 200, body: status }));
    await expect(api.services.autoscale(4)).resolves.toEqual(status);
  });

  it('returns enabled: false with the replicas when autoscaling is off', async () => {
    const { api } = client(() => ({ status: 200, body: { enabled: false, replicas: 1 } }));
    await expect(api.services.autoscale(4)).resolves.toEqual({ enabled: false, replicas: 1 });
  });

  it('surfaces a refusal for a non-docker service as a NineDeployError', async () => {
    const { api } = client(() => ({ status: 400, body: { error: { code: 'bad_request', message: 'Autoscaling is for docker services' } } }));
    const err = (await api.services.update(4, { autoscale: { maxReplicas: 3, target: 50 } }).catch((e: unknown) => e)) as NineDeployError;
    expect(err).toBeInstanceOf(NineDeployError);
    expect(err.status).toBe(400);
  });

  it('types the service autoscale as the schema config, defaults filled', async () => {
    const input: AutoscaleConfigInput = { maxReplicas: 4, target: 70 };
    const filled = autoscaleConfig.parse(input);
    const { api } = client(() => ({ status: 200, body: { id: 4, autoscale: filled } }));
    const svc: Service = await api.services.update(4, { autoscale: input });
    expect(svc.autoscale).toEqual({ minReplicas: 1, maxReplicas: 4, metric: 'cpu', target: 70, scaleUpSeconds: 60, scaleDownSeconds: 300 });
  });
});
