import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB, Service } from '@ninedeploy/db';
import { readNodeAutoscaleSample } from '../../src/lib/nodeAutoscaleSample.js';

const h = vi.hoisted(() => ({ op: vi.fn(), sealed: vi.fn(), metrics: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: h.op, agentTransportSealed: h.sealed }));
vi.mock('../../src/lib/nodeContainerMetrics.js', () => ({ readNodeContainerMetrics: h.metrics }));
const service = { id: 7, slug: 'web', type: 'docker', serverId: 4, orchestrator: null, status: 'running', asleepAt: null,
  runtimeId: 'web-9', runtimeReplicas: 2, cpuLimitMilli: 500, memLimitMb: 128,
  autoscale: { minReplicas: 1, maxReplicas: 3, metric: 'memory', target: 70, scaleUpSeconds: 60, scaleDownSeconds: 120 } } as Service;
let current: Service;
const db = { query: { services: { findFirst: async () => current } } } as unknown as DB;
beforeEach(() => {
  current = structuredClone(service); h.sealed.mockReset().mockResolvedValue(true);
  h.op.mockReset().mockImplementation(async (_db, _server, op, params) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: ['ND-AGENT {"version":"0.18.13","caps":["docker.recovery"]}'] };
    const id = params.name.endsWith('-r2') ? 'c'.repeat(64) : 'b'.repeat(64);
    return { exitCode: 0, lines: [`ND-CONTAINER ${JSON.stringify({ id, name: params.name, managed: 'service', serviceId: '7', deploymentId: '9' })}`] };
  });
  h.metrics.mockReset().mockImplementation(async (_db, serverId, spec, options) => {
    await options.checkpoint();
    return { serverId, sampledAt: Date.now(), requestId: 'a'.repeat(32), serviceId: 7, deploymentId: 9, complete: true,
      items: spec.targets.map((target: object) => ({ ...target, cpuPct: 40, cpuLimitMilli: 500, memBytes: 100, memLimitBytes: 1000, restarts: 0 })) };
  });
});
describe('node autoscale sample', () => {
  it('samples the selected node and exact serving identities', async () => {
    const sample = await readNodeAutoscaleSample(db, service);
    expect(sample.items).toHaveLength(2);
    expect(h.metrics.mock.calls[0]![1]).toBe(4);
    expect(h.metrics.mock.calls[0]![2]).toEqual({ serviceId: 7, deploymentId: 9, targets: [
      { id: 'b'.repeat(64), name: 'web-9' }, { id: 'c'.repeat(64), name: 'web-9-r2' },
    ] });
  });
  it('refuses foreign identities before requesting metrics', async () => {
    const original = h.op.getMockImplementation()!;
    h.op.mockImplementation(async (...args) => args[2] === 'docker.identity'
      ? { exitCode: 0, lines: [`ND-CONTAINER ${JSON.stringify({ id: 'b'.repeat(64), name: args[3].name, managed: 'service', serviceId: '7', deploymentId: '8' })}`] }
      : original(...args));
    await expect(readNodeAutoscaleSample(db, service)).rejects.toThrow(/identity/i);
    expect(h.metrics).not.toHaveBeenCalled();
  });
  it('refuses a changed service while identity inspection is in flight', async () => {
    const original = h.op.getMockImplementation()!;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    h.op.mockImplementation(async (...args) => {
      if (args[2] === 'docker.identity') { entered(); await pending; }
      return original(...args);
    });
    const result = readNodeAutoscaleSample(db, service);
    try { await started; current = { ...current, runtimeId: 'web-10' }; } finally { release(); }
    await expect(result).rejects.toThrow(/changed/i);
    expect(h.metrics).not.toHaveBeenCalled();
  });
  it('refuses plaintext, missing identities, and a stopped service', async () => {
    h.sealed.mockResolvedValueOnce(false);
    await expect(readNodeAutoscaleSample(db, service)).rejects.toThrow(/sealed|unencrypted/i);
    h.op.mockImplementation(async (_db, _server, op) => op === 'agent.ping'
      ? { exitCode: 0, lines: ['ND-AGENT {"version":"0.18.13","caps":["docker.recovery"]}'] }
      : { exitCode: 0, lines: ['ND-CONTAINER null'] });
    await expect(readNodeAutoscaleSample(db, service)).rejects.toThrow(/identity/i);
    current = { ...service, status: 'stopped' };
    await expect(readNodeAutoscaleSample(db, service)).rejects.toThrow(/changed/i);
    expect(h.metrics).not.toHaveBeenCalled();
  });
  it('rejects metrics if placement changes while the node is sampling', async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const original = h.metrics.getMockImplementation()!;
    h.metrics.mockImplementation(async (...args) => { entered(); await pending; return original(...args); });
    const result = readNodeAutoscaleSample(db, service);
    try { await started; current = { ...current, serverId: 5 }; } finally { release(); }
    await expect(result).rejects.toThrow(/changed/i);
  });
  it('checks the service again when an identity request fails after ownership changes', async () => {
    const original = h.op.getMockImplementation()!;
    h.op.mockImplementation(async (...args) => {
      if (args[2] === 'docker.identity') { current = { ...current, serverId: 5 }; throw new Error('node disconnected'); }
      return original(...args);
    });
    await expect(readNodeAutoscaleSample(db, service)).rejects.toThrow(/changed/i);
    expect(h.metrics).not.toHaveBeenCalled();
  });
  it('preserves identity request failures when the service has not changed', async () => {
    const original = h.op.getMockImplementation()!;
    h.op.mockImplementation(async (...args) => {
      if (args[2] === 'docker.identity') throw new Error('node disconnected');
      return original(...args);
    });
    await expect(readNodeAutoscaleSample(db, service)).rejects.toThrow('node disconnected');
    expect(h.metrics).not.toHaveBeenCalled();
  });
  it('enforces the overall deadline while discovering sealed transport', async () => {
    const abort = new AbortController();
    h.sealed.mockImplementation(async (_db, _server, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const result = readNodeAutoscaleSample(db, service, { timeoutMs: 40, signal: abort.signal });
    const outcome = Promise.race([result.then(() => 'resolved', () => 'rejected'), new Promise<string>(resolve => setTimeout(() => resolve('hung'), 400))]);
    try { expect(await outcome).toBe('rejected'); } finally { abort.abort(); await result.catch(() => undefined); }
    expect(h.op).not.toHaveBeenCalled();
  });
});
