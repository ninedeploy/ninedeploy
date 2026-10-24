import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectNodeMetrics, nodeServiceStat, parseNodeContainerStats } from '../../src/lib/nodeMetrics.js';

const mocks = vi.hoisted(() => ({ agentOp: vi.fn(), alerts: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: mocks.agentOp }));
vi.mock('../../src/lib/alerting.js', () => ({ evaluateAlerts: mocks.alerts }));
afterEach(() => vi.clearAllMocks());

describe('node metric collection', () => {
  it('discards failed/stale metadata and samples when a node no longer hosts a resource', async () => {
    const cache = new Map([[8, new Map()]]), samples = new Map([[8, { sampledAt: 1, error: false }]]);
    mocks.agentOp.mockRejectedValue(Error('node offline'));
    await collectNodeMetrics({} as never, [], cache, new AbortController().signal, vi.fn(), { serverIds: [8], samples });
    expect(cache.has(8)).toBe(false); expect(samples.get(8)).toEqual({ sampledAt: null, error: true });
    await collectNodeMetrics({} as never, [], cache, new AbortController().signal, vi.fn(), { samples });
    expect(samples.size).toBe(0);
  });
  it('collects nodes hosting databases even without a service, deduplicates hosts and records sample freshness', async () => {
    const cache = new Map(), samples = new Map();
    mocks.agentOp.mockResolvedValue({ exitCode: 0, lines: ['nd-db-orders|12.5%|4MiB / 16MiB'] });
    await collectNodeMetrics({} as never, [], cache, new AbortController().signal, vi.fn(), { serverIds: [8, 8], samples });
    expect(mocks.agentOp).toHaveBeenCalledTimes(1);
    expect(mocks.agentOp.mock.calls[0]![1]).toBe(8);
    expect(cache.get(8)?.get('nd-db-orders')?.cpuPct).toBe(12.5);
    expect(samples.get(8)).toEqual({ error: false, sampledAt: expect.any(Number) });
  });
  it('rejects malformed samples and sums only a complete set of serving replicas', () => {
    const parsed = parseNodeContainerStats(['app-7|2.5%|10MiB / 1GiB', 'app-7-r2|3%|20MiB / 1GiB', 'bad|NaN%|no memory', 'broken|1.2.3%|10MiB / 1GiB']);
    const service = { runtimeId: 'app-7', replicas: 2, runtimeReplicas: 2, memLimitMb: 128 };
    expect(parsed.size).toBe(2);
    expect(nodeServiceStat(service, parsed)).toMatchObject({ cpuPct: 5.5, memBytes: 30 * 1024 ** 2, memLimitBytes: 256 * 1024 ** 2 });
    parsed.delete('app-7-r2');
    expect(nodeServiceStat(service, parsed)).toBeUndefined();
  });

  it('drops an unreachable node sample while other nodes continue collecting', async () => {
    mocks.agentOp.mockImplementation(async (_db, id) => {
      if (id === 1) throw new Error('node offline');
      return { exitCode: 0, lines: ['app-7|5%|4MiB / 1GiB'] };
    });
    const values = vi.fn(async () => undefined);
    const db = { insert: () => ({ values }) };
    const cache = new Map([[1, parseNodeContainerStats(['app-7|90%|8MiB / 1GiB'])]]);
    const onError = vi.fn();
    const services = [1, 2].map((serverId) => ({ id: serverId, serverId, runtimeId: 'app-7', replicas: 1 }));
    await collectNodeMetrics(db as never, services as never, cache, new AbortController().signal, onError);
    expect(cache.has(1)).toBe(false);
    expect(cache.get(2)?.get('app-7')?.cpuPct).toBe(5);
    expect(values).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ serviceId: 2, kind: 'cpu', value: 500 })]));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('never starts node requests after shutdown', async () => {
    const controller = new AbortController();
    controller.abort();
    await collectNodeMetrics({} as never, [{ serverId: 1 }] as never, new Map(), controller.signal, vi.fn());
    expect(mocks.agentOp).not.toHaveBeenCalled();
  });
});
