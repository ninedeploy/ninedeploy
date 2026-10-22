import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: h.lookup }));
const { guardedFetch } = await import('../../src/lib/egressGuard.js');

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); h.lookup.mockReset(); });

describe('outbound request cancellation during DNS', () => {
  it('starts neither DNS nor HTTP when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already stopped'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(guardedFetch('https://ci.example.test/actions/runs', { signal: controller.signal })).rejects.toThrow('already stopped');
    expect(h.lookup).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('settles an aborted request before DNS answers and never fetches after cancellation', async () => {
    vi.stubEnv('NINEDEPLOY_ALLOW_PRIVATE_EGRESS', '0');
    let answer!: (value: Array<{ address: string; family: number }>) => void;
    h.lookup.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return new Response('ok');
    });
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    let outcome = 'pending';
    const request = guardedFetch('https://ci.example.test/actions/runs', { signal: controller.signal });
    const observed = request.then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
    controller.abort(new Error('CI worker stopped'));
    try {
      await vi.waitFor(() => expect(outcome, 'Aborting CI must settle even when DNS has not answered').toBe('rejected'), { timeout: 500, interval: 5 });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      answer([{ address: '93.184.216.34', family: 4 }]);
      await observed;
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('control: a resolved public hostname still fetches normally', async () => {
    vi.stubEnv('NINEDEPLOY_ALLOW_PRIVATE_EGRESS', '0');
    h.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const fetch = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetch);
    const response = await guardedFetch('https://ci.example.test/actions/runs', { signal: new AbortController().signal });
    expect(await response.text()).toBe('ok');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps ordinary DNS failures redacted when the caller supplies a signal', async () => {
    vi.stubEnv('NINEDEPLOY_ALLOW_PRIVATE_EGRESS', '0');
    h.lookup.mockRejectedValue(new Error('resolver failed'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(guardedFetch('https://ci.example.test/private-token?q=private-token', { signal: new AbortController().signal }))
      .rejects.toThrow('hostname ci.example.test could not be resolved');
    expect(fetch).not.toHaveBeenCalled();
  });
});
