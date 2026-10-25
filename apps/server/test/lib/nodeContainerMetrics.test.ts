import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@ninedeploy/db';
import { readNodeContainerMetrics } from '../../src/lib/nodeContainerMetrics.js';

const io = vi.hoisted(() => ({ op: vi.fn(), sealed: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.op, agentTransportSealed: io.sealed }));
const spec = { serviceId: 7, deploymentId: 9, targets: [{ name: 'web-9', id: 'a'.repeat(64) }] };
const db = {} as DB;
let patch: Record<string, unknown>, caps: string[], version: string, mutate: (() => void) | undefined;
beforeEach(() => {
  patch = {}; caps = ['docker.metrics']; version = '0.19.0'; mutate = undefined;
  io.sealed.mockReset().mockResolvedValue(true);
  io.op.mockReset().mockImplementation(async (_db, server, op, params) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version, caps })}`] };
    mutate?.();
    return { exitCode: 0, lines: [`ND-METRICS ${JSON.stringify({ requestId: params.requestId, serviceId: 7, deploymentId: 9, complete: true,
      items: [{ ...spec.targets[0], cpuPct: server, cpuLimitMilli: 500, memBytes: 100, memLimitBytes: 1000, restarts: 0 }], ...patch })}`] };
  });
});
afterEach(() => vi.useRealTimers());
const options = () => ({ checkpoint: vi.fn(async () => undefined) });

describe('selected-node resource evidence', () => {
  it('keeps equal container names on different hosts separate', async () => {
    const [first, second] = await Promise.all([readNodeContainerMetrics(db, 2, spec, options()), readNodeContainerMetrics(db, 3, spec, options())]);
    expect(first).toMatchObject({ serverId: 2, items: [{ cpuPct: 2 }] });
    expect(second).toMatchObject({ serverId: 3, items: [{ cpuPct: 3 }] });
    expect(Number.isFinite(first.sampledAt)).toBe(true);
    expect(io.op.mock.calls.filter(call => call[2] === 'docker.metrics').map(call => call[1]).sort()).toEqual([2, 3]);
  });
  it.each([0, -1, NaN, 1.5])('refuses an unspecified or invalid host before transport: %s', async server => {
    await expect(readNodeContainerMetrics(db, server, spec, options())).rejects.toThrow(/explicit server/);
    expect(io.sealed).not.toHaveBeenCalled(); expect(io.op).not.toHaveBeenCalled();
  });
  it('refuses plaintext and older agents without falling back to local data', async () => {
    io.sealed.mockResolvedValue(false);
    await expect(readNodeContainerMetrics(db, 2, spec, options())).rejects.toThrow(/unencrypted/);
    expect(io.op).not.toHaveBeenCalled();
    io.sealed.mockResolvedValue(true); caps = []; version = '0.18.2';
    await expect(readNodeContainerMetrics(db, 2, spec, options())).rejects.toThrow(/Update.*v0.19.0/);
    version = '0.19.0';
    await expect(readNodeContainerMetrics(db, 2, spec, options())).rejects.toThrow(/owner turned it off.*NINEDEPLOY_AGENT_CONTAINER_METRICS=off/);
    expect(io.op.mock.calls.every(call => call[2] === 'agent.ping')).toBe(true);
  });
  it.each([{ requestId: 'f'.repeat(32) }, { serviceId: 8 }, { deploymentId: 10 }, { complete: false }, { items: [] }])('refuses another context or incomplete evidence: %j', async changed => {
    patch = changed;
    await expect(readNodeContainerMetrics(db, 2, spec, options())).rejects.toThrow();
  });
  it('rejects an ownership change while a metric response is in flight', async () => {
    let owner = true;
    mutate = () => { owner = false; };
    await expect(readNodeContainerMetrics(db, 2, spec, { checkpoint: async () => { if (!owner) throw Error('Owner changed'); } })).rejects.toThrow('Owner changed');
  });
  it('rejects a late success without extending the original deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const started = Date.now(); mutate = () => vi.setSystemTime(started + 101);
    await expect(readNodeContainerMetrics(db, 2, spec, { ...options(), timeoutMs: 100 })).rejects.toThrow(/deadline/);
    expect(io.op.mock.calls.every(call => call[5].timeoutMs <= 100)).toBe(true);
  });
  it('preserves cancellation before and during collection', async () => {
    const abort = new AbortController(); mutate = () => abort.abort(new Error('Cancelled'));
    await expect(readNodeContainerMetrics(db, 2, spec, { ...options(), signal: abort.signal })).rejects.toThrow('Cancelled');
    expect(io.op.mock.calls.every(call => call[5].signal === abort.signal)).toBe(true);
    io.op.mockClear();
    await expect(readNodeContainerMetrics(db, 2, spec, { ...options(), signal: abort.signal })).rejects.toThrow('Cancelled');
    expect(io.op).not.toHaveBeenCalled();
  });
  it.each([
    [{ ...spec.targets[0], id: 'c'.repeat(64) }],
    [{ ...spec.targets[0], name: 'another' }],
    [spec.targets[0], spec.targets[0]],
  ])('refuses missing, duplicate or changed immutable target evidence: %j', async (...items) => {
    patch = { items: items.map(target => ({ ...target, cpuPct: 1, cpuLimitMilli: 500, memBytes: 100, memLimitBytes: 1000, restarts: 0 })) };
    await expect(readNodeContainerMetrics(db, 2, spec, options())).rejects.toThrow(/identity|coverage/);
  });
  it.each(['missing', 'duplicate', 'malformed', 'oversized', 'failed'])('refuses an unusable transport receipt: %s', async kind => {
    const normal = io.op.getMockImplementation()!;
    io.op.mockImplementation(async (...args) => {
      const result = await normal(...args);
      if (args[2] === 'agent.ping') return result;
      if (kind === 'failed') return { ...result, exitCode: 1 };
      if (kind === 'missing') return { ...result, lines: ['diagnostic only'] };
      if (kind === 'duplicate') return { ...result, lines: [...result.lines, ...result.lines] };
      return { ...result, lines: [`ND-METRICS ${kind === 'malformed' ? '{' : ' '.repeat(65537)}`] };
    });
    await expect(readNodeContainerMetrics(db, 2, spec, options())).rejects.toThrow();
  });
  it('propagates node unavailability instead of converting it into zero resource usage', async () => {
    io.op.mockRejectedValue(new Error('Node offline'));
    await expect(readNodeContainerMetrics(db, 2, spec, options())).rejects.toThrow(/offline|unavailable|cannot/i);
    expect(io.op.mock.calls.every(call => call[2] === 'agent.ping')).toBe(true);
  });
  it('refuses an ownership loss during the capability probe before sampling', async () => {
    const normal = io.op.getMockImplementation()!;
    let owner = true;
    io.op.mockImplementation(async (...args) => { const result = await normal(...args); owner = false; return result; });
    await expect(readNodeContainerMetrics(db, 2, spec, { checkpoint: async () => { if (!owner) throw Error('Owner changed'); } })).rejects.toThrow('Owner changed');
    expect(io.op.mock.calls.map(call => call[2])).toEqual(['agent.ping']);
  });
});
