import { describe, expect, it } from 'vitest';
import { measureNodeAutoscale } from '../../src/lib/nodeAutoscaleMetrics.js';

const service = { id: 7, serverId: 4, runtimeId: 'web-9', runtimeReplicas: 2 };
const sample = { requestId: 'a'.repeat(32), serviceId: 7, deploymentId: 9, serverId: 4, sampledAt: 1_000, complete: true,
  items: [
    { id: 'b'.repeat(64), name: 'web-9', cpuPct: 40, cpuLimitMilli: 500, memBytes: 200, memLimitBytes: 1000, restarts: 0 },
    { id: 'c'.repeat(64), name: 'web-9-r2', cpuPct: 60, cpuLimitMilli: 2000, memBytes: 600, memLimitBytes: 1000, restarts: 0 },
  ] };

describe('node autoscale measurement', () => {
  it('uses each replica\'s observed CPU and memory limits', () => {
    expect(measureNodeAutoscale(service, 'cpu', sample, 2_000)).toEqual({ value: 55, holding: null });
    expect(measureNodeAutoscale(service, 'memory', sample, 2_000)).toEqual({ value: 40, holding: null });
  });
  it('holds when memory has no configured limit', () => {
    const items = [sample.items[0]!, { ...sample.items[1]!, memLimitBytes: 0 }];
    expect(measureNodeAutoscale(service, 'memory', { ...sample, items }, 2_000).value).toBeNull();
  });
  it('treats unlimited CPU as one core and accepts the freshness boundary', () => {
    const items = [{ ...sample.items[0]!, cpuLimitMilli: 0 }, sample.items[1]!];
    expect(measureNodeAutoscale(service, 'cpu', { ...sample, items }, 91_000).value).toBe(35);
    expect(measureNodeAutoscale(service, 'cpu', { ...sample, items }, 91_001).value).toBeNull();
  });
  it('holds invalid replica counts and malformed samples', () => {
    for (const count of [0, 11, 1.5]) expect(measureNodeAutoscale({ ...service, runtimeReplicas: count }, 'cpu', sample, 2_000).value).toBeNull();
    expect(measureNodeAutoscale(service, 'cpu', null, 2_000).value).toBeNull();
    expect(measureNodeAutoscale(service, 'cpu', { ...sample, items: [{ ...sample.items[0]!, cpuPct: NaN }, sample.items[1]!] }, 2_000).value).toBeNull();
  });
  it.each([
    { serverId: 5 }, { serviceId: 8 }, { deploymentId: 8 }, { complete: false },
    { sampledAt: 200_000 }, { sampledAt: -100_000 },
    { items: [sample.items[0]!] }, { items: [sample.items[0]!, sample.items[0]!] },
    { items: [sample.items[0]!, { ...sample.items[1]!, name: 'other' }] },
  ])('holds on stale, incomplete, or foreign evidence: %j', change => {
    expect(measureNodeAutoscale(service, 'cpu', { ...sample, ...change }, 2_000).value).toBeNull();
  });
});
