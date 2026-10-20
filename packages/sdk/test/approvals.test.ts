import { describe, expect, it, vi } from 'vitest';
import { DEPLOYMENT_STATUSES, deployment, environment, environmentPatch } from '@ninedeploy/schemas';
import { createClient, NineDeployError } from '../src/index.js';

/** 0.16.13: deploy approvals on `deploys`, and the two lane switches on `environments`. */

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

describe('deploy approvals', () => {
  it('maps approve, reject and the lane switches onto the shipped routes', async () => {
    const { api, calls } = client();
    const cases: Array<[() => Promise<unknown>, string, string, unknown]> = [
      [() => api.deploys.approve(4, 9), 'POST', '/v1/services/4/deploys/9/approve', undefined],
      [() => api.deploys.reject(4, 9), 'POST', '/v1/services/4/deploys/9/reject', undefined],
      [() => api.deploys.approvals(), 'GET', '/v1/services/approvals', undefined],
      [() => api.environments.update(2, { protected: true }), 'PATCH', '/v1/environments/2', { protected: true }],
      [
        () => api.environments.update(2, { requireApproval: false, name: 'prod' }),
        'PATCH',
        '/v1/environments/2',
        { requireApproval: false, name: 'prod' },
      ],
    ];
    for (const [run, method, url, body] of cases) {
      await run();
      expect(lastOf(calls)).toEqual({ method, url, body });
    }
  });

  it('surfaces not_awaiting_approval as a NineDeployError', async () => {
    const { api } = client(() => ({
      status: 400,
      body: { error: { code: 'not_awaiting_approval', message: 'This deployment is not waiting for approval' } },
    }));
    const err = (await api.deploys.approve(4, 9).catch((e: unknown) => e)) as NineDeployError;
    expect(err).toBeInstanceOf(NineDeployError);
    expect(err.code).toBe('not_awaiting_approval');
  });

  it('accepts the new status and fields, and rows from older panels without them', () => {
    expect(DEPLOYMENT_STATUSES).toContain('awaiting_approval');
    const base = {
      id: 1,
      status: 'awaiting_approval',
      commitSha: null,
      message: null,
      author: null,
      trigger: 'webhook',
      startedAt: null,
      finishedAt: null,
      createdAt: '2026-10-20T10:00:00.000Z',
    };
    expect(deployment.parse(base).status).toBe('awaiting_approval');
    expect(deployment.parse({ ...base, status: 'queued', reviewedBy: 'Ada', reviewedAt: '2026-10-20T10:01:00.000Z' }).reviewedBy).toBe('Ada');
    const lane = { id: 1, workspaceId: 1, name: 'prod', slug: 'prod', serviceCount: 0, createdAt: base.createdAt, updatedAt: base.createdAt };
    expect(environment.parse(lane).protected).toBeUndefined();
    expect(environment.parse({ ...lane, protected: true, requireApproval: true }).requireApproval).toBe(true);
    expect(environmentPatch.safeParse({ name: '   ' }).success).toBe(false);
  });
});
