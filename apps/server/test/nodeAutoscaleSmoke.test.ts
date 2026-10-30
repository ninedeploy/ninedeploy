import { expect, it, vi } from 'vitest';
import { smokeNodeAutoscale } from '../../../scripts/lib/smoke-node-autoscale.mjs';

function fixture(badTraffic = false, database = false, missingNetwork = false) {
  const ids = ['a'.repeat(64), 'b'.repeat(64)], calls: string[] = [];
  let polls = 0, running = false;
  const records = Array.from({ length: 100 }, (_, index) => ({ status: badTraffic && index === 5 ? 502 : 200,
    body: database ? JSON.stringify({ ready: true, value: 42, replica: ids[index % 2]!.slice(0, 12) }) : `old:${ids[index % 2]!.slice(0, 12)}` }));
  const inner = vi.fn((args: string[]) => {
    calls.push(args.join(' '));
    if (args[0] === 'inspect' && args[1] === 'web-10') return { out: `${ids[0]} true`, status: 0 };
    if (args[0] === 'inspect' && args[1] === 'web-10-r2') return { out: `${ids[1]} false`, status: 0 };
    if (args[0] === 'inspect' && args.at(-1)?.includes('NetworkSettings')) return { out: JSON.stringify(missingNetwork ? {} : { 'nd-dbnet-postgres': {} }), status: 0 };
    if (args[0] === 'inspect' && args[1] === ids[1]) return { out: String(running), status: 0 };
    if (args[0] === 'exec' && args.at(-1)?.includes('/ready')) return { out: JSON.stringify({ status: 200, ready: true, value: 42, replica: args[1]!.slice(0, 12) }), status: 0 };
    if (args[0] === 'exec' && /\/(?:finish|snapshot)/.test(args.at(-1) ?? '')) return { out: JSON.stringify(records), status: 0 };
    return { out: '', status: 0 };
  });
  const api = vi.fn(async (path: string, options?: { method?: string; body?: unknown }) => {
    if (path.endsWith('/deploys')) return { deploymentId: 10 };
    if (path.endsWith('/autoscale')) { running = ++polls === 1; return { replicas: running ? 2 : 1, value: running ? 30 : 10 }; }
    if (options?.method === 'PATCH') return options.body;
    throw new Error(`Unexpected request ${path}`);
  });
  let reads = 0;
  const report = vi.fn();
  return { calls, api, report, args: { api, inner, id: 1, fixtureImage: 'fixture:1', domain: { hostname: 'app.test' },
    service: async () => ({ runtimeId: ++reads === 1 ? 'web-9' : 'web-10' }),
    until: async (fn: () => Promise<unknown> | unknown) => { const value = await fn(); if (!value) throw new Error('Fixture did not reach expected state'); return value; },
    report, cleared: async () => {}, success: async () => {}, scaleSettled: async () => true,
    database: database ? { slug: 'postgres' } : undefined } };
}

it('requires stopped spare, real scale transitions and traffic from both identities', async () => {
  const f = fixture();
  await smokeNodeAutoscale(f.args);
  expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ case: 'node-autoscale-memory', requests: 100, bothReplicasServed: true }));
  expect(f.api.mock.calls.filter(call => call[1]?.method === 'PATCH')).toHaveLength(2);
  expect(f.calls.some(call => call.includes('inspect web-10-r2'))).toBe(true);
});

it('requires SQL readiness and the private database network on both replicas', async () => {
  const f = fixture(false, true);
  await smokeNodeAutoscale(f.args);
  expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ case: 'node-autoscale-memory-database', requests: 100 }));
  expect(f.calls.filter(call => call.includes('/ready'))).toHaveLength(2);
});

it('refuses scaling proof when a replica lacks its database network', async () => {
  const f = fixture(false, true, true);
  await expect(smokeNodeAutoscale(f.args)).rejects.toThrow(/database network/);
  expect(f.report).not.toHaveBeenCalled();
});

it('fails when even one routed request returns 502', async () => {
  const f = fixture(true);
  await expect(smokeNodeAutoscale(f.args)).rejects.toThrow(/all routed requests must succeed/);
  expect(f.report).not.toHaveBeenCalled();
});
