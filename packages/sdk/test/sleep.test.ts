import { describe, expect, it, vi } from 'vitest';
import { SLEEP_AFTER_MAX, SLEEP_AFTER_MIN, updateService } from '@ninedeploy/schemas';
import { createClient, NineDeployError, type Service, type UpdateServiceInput } from '../src/index.js';

/** 0.16.11 scale to zero: `sleep` / `wake` on `services`, and `sleepAfterMinutes` / `asleepAt` on a service. */

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

describe('sleep routes', () => {
  it('maps sleep, wake and the idle setting onto the shipped routes', async () => {
    const { api, calls } = client();
    const on: UpdateServiceInput = { sleepAfterMinutes: 30 };
    const off: UpdateServiceInput = { sleepAfterMinutes: null };
    const cases: Array<[() => Promise<unknown>, string, string, unknown]> = [
      [() => api.services.sleep(4), 'POST', '/v1/services/4/sleep', undefined],
      [() => api.services.wake(4), 'POST', '/v1/services/4/wake', undefined],
      [() => api.services.update(4, on), 'PATCH', '/v1/services/4', { sleepAfterMinutes: 30 }],
      [() => api.services.update(4, off), 'PATCH', '/v1/services/4', { sleepAfterMinutes: null }],
    ];
    for (const [run, method, url, body] of cases) {
      await run();
      expect(lastOf(calls)).toEqual({ method, url, body });
    }
  });

  it('returns the answers unchanged', async () => {
    const { api } = client((url) => ({ status: 200, body: url.endsWith('/sleep') ? { ok: true, asleep: true } : { ok: true, status: 'running' } }));
    await expect(api.services.sleep(4)).resolves.toEqual({ ok: true, asleep: true });
    await expect(api.services.wake(4)).resolves.toEqual({ ok: true, status: 'running' });
  });

  it('surfaces the refusals as NineDeployErrors with their code and message', async () => {
    const replies: Record<string, { status: number; body: unknown }> = {
      '/v1/services/4/sleep': { status: 400, body: { error: { code: 'cannot_sleep', message: 'Cannot put the service to sleep: it has no routed domain' } } },
      '/v1/services/4/wake': { status: 400, body: { error: { code: 'not_asleep', message: 'The service is not asleep' } } },
      '/v1/services/5/sleep': { status: 409, body: { error: { code: 'sleep_failed', message: 'The service changed meanwhile; try again' } } },
      '/v1/services/5/wake': { status: 409, body: { error: { code: 'wake_failed', message: 'The service could not be started' } } },
    };
    const { api } = client((url) => replies[url]!);
    const fail = (p: Promise<unknown>) => p.catch((e: unknown) => e) as Promise<NineDeployError>;
    for (const [run, status, code] of [
      [() => api.services.sleep(4), 400, 'cannot_sleep'],
      [() => api.services.wake(4), 400, 'not_asleep'],
      [() => api.services.sleep(5), 409, 'sleep_failed'],
      [() => api.services.wake(5), 409, 'wake_failed'],
    ] as const) {
      const err = await fail(run());
      expect(err).toBeInstanceOf(NineDeployError);
      expect(err.status).toBe(status);
      expect(err.code).toBe(code);
    }
    expect((await fail(api.services.sleep(4))).message).toContain('it has no routed domain');
  });

  it('types the setting and the sleep time on the service, from the schemas', async () => {
    expect([SLEEP_AFTER_MIN, SLEEP_AFTER_MAX]).toEqual([5, 1440]);
    expect(updateService.safeParse({ sleepAfterMinutes: 4 }).success).toBe(false);
    expect(updateService.safeParse({ sleepAfterMinutes: 1441 }).success).toBe(false);
    expect(updateService.safeParse({ sleepAfterMinutes: null }).success).toBe(true);
    const { api } = client(() => ({ status: 200, body: { id: 4, sleepAfterMinutes: 30, asleepAt: '2026-10-20T10:00:00.000Z' } }));
    const svc: Service = await api.services.update(4, { sleepAfterMinutes: 30 });
    const minutes: number | null | undefined = svc.sleepAfterMinutes;
    const since: string | null | undefined = svc.asleepAt;
    expect([minutes, since]).toEqual([30, '2026-10-20T10:00:00.000Z']);
  });
});
