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
  it('fails closed on foreign, stale or incomplete samples and unsupported request metrics', () => {
    const d = createNodeAutoscaleDecider();
    d.observe(service, sample(0, 'a'), 0);
    expect(d.observe(service, { ...sample(60_000, 'b'), serverId: 5 }, 60_000).to).toBeNull();
    expect(d.observe(service, sample(0, 'a'), 100_000).to).toBeNull();
    expect(d.observe(service, { ...sample(100_000, 'c'), complete: false }, 100_000).to).toBeNull();
    expect(d.observe({ ...service, autoscale: { ...(service.autoscale as object), metric: 'rps' } }, sample(100_000, 'c'), 100_000).holding).toMatch(/request rate/);
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
