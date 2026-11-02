import type { Service } from '@ninedeploy/db';
import { describe, expect, it } from 'vitest';
import { createNodeAutoscaleDecider } from '../../src/lib/nodeAutoscaleDecision.js';

const service = { id: 7, type: 'docker', serverId: 4, orchestrator: null, status: 'running', asleepAt: null,
  runtimeId: 'web-9', runtimeReplicas: 2,
  autoscale: { minReplicas: 1, maxReplicas: 4, metric: 'cpu', target: 50, scaleUpSeconds: 60, scaleDownSeconds: 120 } } as Service;
const sample = (at: number, request: string, secondId = 'c'.repeat(64)) => ({ serverId: 4, sampledAt: at, requestId: request.repeat(32),
  serviceId: 7, deploymentId: 9, complete: true, items: [
    { id: 'b'.repeat(64), name: 'web-9', cpuPct: 90, cpuLimitMilli: 1000, memBytes: 100, memLimitBytes: 1000, restarts: 0 },
    { id: secondId, name: 'web-9-r2', cpuPct: 90, cpuLimitMilli: 1000, memBytes: 100, memLimitBytes: 1000, restarts: 0 },
  ] });

describe('node autoscale decisions', () => {
  it('waits for sustained fresh, complete samples before deciding', () => {
    const d = createNodeAutoscaleDecider();
    expect(d.observe(service, sample(0, 'a'), 0).to).toBeNull();
    expect(d.observe(service, sample(30_000, 'b'), 30_000).to).toBeNull();
    expect(d.observe(service, sample(60_000, 'c'), 60_000)).toEqual({ to: 4, holding: null, evidence: {
      serverId: 4, serviceId: 7, deploymentId: 9, sampledAt: 60_000, requestId: 'c'.repeat(32),
      targets: [{ name: 'web-9', id: 'b'.repeat(64) }, { name: 'web-9-r2', id: 'c'.repeat(64) }],
    } });
  });
  it('does not advance on repeated samples and resets on replacement or a blocked tick', () => {
    const d = createNodeAutoscaleDecider();
    d.observe(service, sample(0, 'a'), 0);
    expect(d.observe(service, sample(0, 'a'), 60_000).to).toBeNull();
    expect(d.observe(service, sample(60_000, 'b', 'd'.repeat(64)), 60_000).to).toBeNull();
    expect(d.observe(service, sample(90_000, 'c', 'd'.repeat(64)), 90_000, true).to).toBeNull();
    expect(d.observe(service, sample(120_000, 'd', 'd'.repeat(64)), 120_000).to).toBeNull();
    expect(d.observe(service, sample(180_000, 'e', 'd'.repeat(64)), 180_000).to).toBe(4);
  });
  it.each(['restarts', 'cpuLimitMilli', 'memLimitBytes'] as const)('restarts the decision window when observed %s changes', field => {
    const d = createNodeAutoscaleDecider();
    d.observe(service, sample(0, 'a'), 0);
    const next = sample(60_000, 'b');
    next.items[0]![field] = field === 'restarts' ? 1 : 800;
    expect(d.observe(service, next, 60_000).to).toBeNull();
  });
  it('fails closed on foreign, stale or incomplete samples and unsupported request metrics', () => {
    const d = createNodeAutoscaleDecider();
    d.observe(service, sample(0, 'a'), 0);
    expect(d.observe(service, { ...sample(60_000, 'b'), serverId: 5 }, 60_000).to).toBeNull();
    expect(d.observe(service, sample(0, 'a'), 100_000).to).toBeNull();
    expect(d.observe(service, { ...sample(100_000, 'c'), complete: false }, 100_000).to).toBeNull();
    expect(d.observe({ ...service, autoscale: { ...(service.autoscale as object), metric: 'rps' } }, sample(100_000, 'c'), 100_000).holding).toMatch(/serving-traffic window/);
    expect(d.observe(service, sample(120_000, 'd'), 120_000).to).toBeNull();
  });
  it('waits for the full scale-down window', () => {
    const d = createNodeAutoscaleDecider();
    const low = (at: number, id: string, cpu: number) => {
      const s = sample(at, id);
      return { ...s, items: s.items.map(item => ({ ...item, cpuPct: cpu })) };
    };
    expect(d.observe(service, low(0, 'a', 10), 0).to).toBeNull();
    expect(d.observe(service, low(60_000, 'b', 20), 60_000).to).toBeNull();
    expect(d.observe(service, low(120_000, 'c', 10), 120_000).to).toBe(1);
  });
  it('requires configured memory limits and resets the window when limits disappear', () => {
    const d = createNodeAutoscaleDecider();
    const memory = { ...service, autoscale: { ...(service.autoscale as object), metric: 'memory' } };
    const high = (at: number, id: string, limit = 1000) => {
      const s = sample(at, id);
      return { ...s, items: s.items.map(item => ({ ...item, memBytes: 900, memLimitBytes: limit })) };
    };
    d.observe(memory, high(0, 'a'), 0);
    expect(d.observe(memory, high(30_000, 'b', 0), 30_000).holding).toMatch(/memory limits/);
    expect(d.observe(memory, high(60_000, 'c'), 60_000).to).toBeNull();
    expect(d.observe(memory, high(120_000, 'd'), 120_000).to).toBe(4);
  });
});

describe('node autoscale decisions on serving traffic (rps)', () => {
  const rps = { ...service, autoscale: { ...(service.autoscale as object), metric: 'rps', target: 10 } } as Service;
  const serving = (at: number, n: number, requests: number, patch: Record<string, unknown> = {}) => {
    const id = n.toString(16).padStart(32, '0'), start = 10 + n * 1000;
    return { kind: 'serving', serverId: 4, sampledAt: at, serving: [{ name: 'web-9', id: 'b'.repeat(64) }, { name: 'web-9-r2', id: 'c'.repeat(64) }],
      snapshot: { protocol: 1, purpose: 'autoscale', basis: 'traefik-request-sequence', precisionMs: 1, windowId: id, requestId: id,
        epoch: 'd'.repeat(32), sourceId: 'e'.repeat(64), proxyId: 'f'.repeat(64), targetHash: (n % 10).toString().repeat(64), routingGeneration: '2'.repeat(64),
        nodeId: 4, serviceId: 7, deploymentId: 9, elapsedMs: 10_000, startCounter: String(start), endCounter: String(start + requests + 1),
        observed: requests, expected: requests, complete: true,
        serving: { requests, errors: 0, errorRate: requests ? 0 : null, p95Ms: requests ? 5 : null }, ...patch } };
  };

  it('scales up on sustained per-replica request rate and binds the receipt as evidence', () => {
    const d = createNodeAutoscaleDecider(), seen: number[] = [];
    // 400 requests over 10 s across two replicas is 20 rps each.
    expect(d.observe(rps, serving(0, 1, 400), 0, false, o => seen.push(o.value)).to).toBeNull();
    expect(d.observe(rps, serving(60_000, 2, 400), 60_000)).toEqual({ to: 4, holding: null, evidence: {
      serverId: 4, serviceId: 7, deploymentId: 9, sampledAt: 60_000, requestId: (2).toString(16).padStart(32, '0'),
      targets: [{ name: 'web-9', id: 'b'.repeat(64) }, { name: 'web-9-r2', id: 'c'.repeat(64) }] } });
    expect(seen).toEqual([20]);
  });
  it('treats a verified zero window as zero traffic and scales down after the full window', () => {
    const d = createNodeAutoscaleDecider();
    expect(d.observe(rps, serving(0, 1, 0), 0).to).toBeNull();
    expect(d.observe(rps, serving(60_000, 2, 0), 60_000).to).toBeNull();
    expect(d.observe(rps, serving(120_000, 3, 0), 120_000).to).toBe(1);
  });
  it('keeps the sustained window across windows, whose targetHash binds each unique request', () => {
    const d = createNodeAutoscaleDecider();
    expect(serving(0, 1, 400).snapshot.targetHash).not.toBe(serving(30_000, 2, 400).snapshot.targetHash);
    expect(d.observe(rps, serving(0, 1, 400), 0).to).toBeNull();
    expect(d.observe(rps, serving(30_000, 2, 400), 30_000).to).toBeNull();
    expect(d.observe(rps, serving(60_000, 3, 400), 60_000).to).toBe(4);
  });
  it.each(['sourceId', 'proxyId', 'routingGeneration', 'epoch'] as const)('restarts the window when the %s changes', field => {
    const d = createNodeAutoscaleDecider();
    d.observe(rps, serving(0, 1, 400), 0);
    // A valid but different identity: the window starts again instead of being refused.
    const next = d.observe(rps, serving(60_000, 2, 400, { [field]: '9'.repeat(field === 'epoch' ? 32 : 64) }), 60_000);
    expect(next.to).toBeNull(); expect(next.holding ?? '').not.toMatch(/serving-traffic window/);
  });
  it('does not advance on a repeated receipt and holds on incomplete or foreign windows', () => {
    const d = createNodeAutoscaleDecider();
    d.observe(rps, serving(0, 1, 400), 0);
    expect(d.observe(rps, { ...serving(60_000, 1, 400) }, 60_000)).toEqual({ to: null, holding: 'waiting for a new node metrics sample' });
    const open = serving(60_000, 2, 400);
    expect(d.observe(rps, { ...open, snapshot: { ...open.snapshot, complete: false, endCounter: null, expected: null } }, 60_000).holding).toMatch(/serving-traffic window/);
    expect(d.observe(rps, { ...serving(60_000, 3, 400), serverId: 5 }, 60_000).holding).toMatch(/serving-traffic window/);
    expect(d.observe(rps, serving(60_000, 4, 400, { deploymentId: 8 }), 60_000).holding).toMatch(/serving-traffic window/);
    expect(d.observe(rps, { ...serving(60_000, 5, 400), serving: [{ name: 'web-9', id: 'b'.repeat(64) }] }, 60_000).holding).toMatch(/serving-traffic window/);
    expect(d.observe(rps, serving(0, 6, 400), 200_000).holding).toMatch(/serving-traffic window/);
  });
});
