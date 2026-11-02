import { expect, it, vi } from 'vitest';
import { smokeNodeAutoscaleRps } from '../../../scripts/lib/smoke-node-autoscale-rps.mjs';

type Phase = 'init' | 'up' | 'lost' | 'down';
function fixture({ lostScalesDown = false, lostReadsZero = false, badTraffic = false } = {}) {
  const ids = ['a'.repeat(64), 'b'.repeat(64)], calls: string[] = [], restarts: boolean[] = [];
  let phase: Phase = 'init';
  const records = Array.from({ length: 300 }, (_, index) => ({ at: index, status: badTraffic && index === 7 ? 502 : 200, body: `old:${ids[index % 2]!.slice(0, 12)}` }));
  const inner = vi.fn((args: string[]) => {
    calls.push(args.join(' '));
    if (args[0] === 'inspect' && args[1] === 'web-10') return { out: `${ids[0]} true`, status: 0 };
    if (args[0] === 'inspect' && args[1] === 'web-10-r2') return { out: `${ids[1]} false`, status: 0 };
    if (args[0] === 'inspect' && args[1] === ids[1]) return { out: String(phase === 'up' || phase === 'lost'), status: 0 };
    if (args[0] === 'exec' && /\/rate\?gap=/.test(args.at(-1) ?? '')) return { out: 'ok', status: 0 };
    if (args[0] === 'exec' && /\/(?:finish|snapshot)/.test(args.at(-1) ?? '')) return { out: JSON.stringify(records), status: 0 };
    return { out: '', status: 0 };
  });
  const api = vi.fn(async (path: string, options?: { method?: string; body?: unknown }) => {
    if (path.endsWith('/deploys')) return { deploymentId: 10 };
    if (path.endsWith('/autoscale')) {
      if (phase === 'init') return { supportedMetrics: ['cpu', 'memory', 'rps'], replicas: 1, value: null };
      if (phase === 'up') return { replicas: 2, value: 12.5, holding: null };
      if (phase === 'lost') return { replicas: lostScalesDown ? 1 : 2, value: lostReadsZero ? 0 : null, holding: 'node autoscale evaluation failed; see server logs' };
      return { replicas: 1, value: 0.3, holding: null };
    }
    if (options?.method === 'PATCH') return options.body;
    throw new Error(`Unexpected request ${path}`);
  });
  let reads = 0;
  const report = vi.fn();
  return { calls, restarts, report, args: { api, inner, id: 1, fixtureImage: 'fixture:1', domain: { hostname: 'app.test' },
    service: async () => ({ runtimeId: ++reads === 1 ? 'web-9' : 'web-10' }),
    until: async (fn: () => Promise<unknown> | unknown) => { const value = await fn(); if (!value) throw new Error('Fixture did not reach expected state'); return value; },
    pause: async () => {}, report, cleared: async () => {}, holdMs: 20,
    success: async () => { phase = 'up'; },
    scaleSettled: async () => true,
    restartAgent: async (enabled: boolean) => { restarts.push(enabled); phase = enabled ? 'down' : 'lost'; } } };
}

it('requires 1→2 under load, a held source loss and 2→1 on verified traffic', async () => {
  const f = fixture();
  await smokeNodeAutoscaleRps(f.args);
  expect(f.restarts).toEqual([false, true]);
  expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ case: 'node-autoscale-rps', requests: 300, bothReplicasServed: true,
    sourceLoss: expect.objectContaining({ replicas: 2 }), scaleUp: { replicas: 2, rps: 12.5 }, scaleDown: { replicas: 1, rps: 0.3 } }));
  expect(f.calls.filter(call => call.includes('/rate?gap='))).toHaveLength(2);
});

it('fails when a lost source scales down', async () => {
  const f = fixture({ lostScalesDown: true });
  await expect(smokeNodeAutoscaleRps(f.args)).rejects.toThrow(/never scale down/);
  expect(f.report).not.toHaveBeenCalled();
});

it('fails when a lost source reads as zero requests', async () => {
  const f = fixture({ lostReadsZero: true });
  await expect(smokeNodeAutoscaleRps(f.args)).rejects.toThrow(/Fixture did not reach expected state/);
  expect(f.report).not.toHaveBeenCalled();
});

it('fails when even one routed request returns 502', async () => {
  const f = fixture({ badTraffic: true });
  await expect(smokeNodeAutoscaleRps(f.args)).rejects.toThrow(/all routed requests must succeed/);
  expect(f.report).not.toHaveBeenCalled();
});
