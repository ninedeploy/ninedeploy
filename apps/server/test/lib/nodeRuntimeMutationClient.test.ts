import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@ninedeploy/db';
import { createNodeRuntimeMutationClient } from '../../src/lib/nodeRuntimeMutationClient.js';
const io = vi.hoisted(() => ({ op: vi.fn(), sealed: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.op, agentTransportSealed: io.sealed }));
const header = { requestId: 'a'.repeat(32), serviceId: 7, revision: 8, timeoutMs: 30_000 };
const target = { id: 'b'.repeat(64), name: 'web-10', deploymentId: 10 };
const spare = { id: 'c'.repeat(64), name: 'web-10-r2', deploymentId: 10 };
const spec = { name: target.name, serviceId: 7, deploymentId: 10, image: 'sha256:' + 'f'.repeat(64) };
const requests = {
  fence: header,
  prepare: { ...header, deploymentId: 10, specs: [spec, { ...spec, name: spare.name }], startNames: [target.name] },
  networks: { ...header, action: 'connect' as const, targets: [target, spare], networks: ['nd-dbnet-pg'] },
  retire: { ...header, targets: [target, spare], graceSeconds: 5 },
  limits: { ...header, targets: [target, spare], memLimitMb: 64 },
  start: { ...header, targets: [target, spare] },
  stop: { ...header, targets: [target, spare], graceSeconds: 5 },
};
const kinds = ['fence', 'prepare', 'networks', 'retire', 'limits', 'start', 'stop'] as const;
type Kind = typeof kinds[number];
const prefixes = { 'docker.runtimeFence': 'ND-RUNTIME-FENCE ', 'docker.prepare': 'ND-PREPARED ', 'docker.networkSet': 'ND-NETWORKS ', 'docker.retireSet': 'ND-RETIRED-SET ', 'docker.limits': 'ND-LIMITS ', 'docker.startSet': 'ND-STARTED-SET ', 'docker.stopSet': 'ND-STOPPED-SET ' };
const db = {} as DB;
let patch: Record<string, unknown>, caps: string[], version: string, mutate: (() => void) | undefined, now: number;
const checkpoint = vi.fn(async () => undefined);
const client = (signal?: AbortSignal) => createNodeRuntimeMutationClient(db, 2, { checkpoint, signal });
const invoke = (kind: Kind, input: unknown = requests[kind], signal?: AbortSignal) => Promise.resolve().then(() => client(signal)[kind](input as never));
beforeEach(() => {
  patch = {}; caps = ['docker.mutations', 'docker.limits', 'docker.startSet']; version = '0.19.0'; mutate = undefined; now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  checkpoint.mockReset().mockResolvedValue(undefined); io.sealed.mockReset().mockResolvedValue(true);
  io.op.mockReset().mockImplementation(async (_db, _server, op: keyof typeof prefixes | 'agent.ping', params) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: ['ND-AGENT ' + JSON.stringify({ version, caps })] };
    mutate?.();
    const common = { requestId: params.requestId, serviceId: params.serviceId, revision: params.revision, complete: true };
    const reply = op === 'docker.runtimeFence' ? common : op === 'docker.prepare'
      ? { ...common, deploymentId: 10, items: [{ ...target, running: true }, { ...spare, running: false }] }
      : op === 'docker.networkSet' ? { ...common, action: params.action, networks: params.networks, items: params.targets.map((item: object) => ({ ...item, connected: params.action === 'connect' })) }
      : op === 'docker.limits' ? { ...common, items: params.targets }
      : op === 'docker.startSet' ? { ...common, items: params.targets.map((item: object) => ({ ...item, running: true })) }
      : op === 'docker.stopSet' ? { ...common, items: params.targets.map((item: object) => ({ ...item, running: false })) }
      : { ...common, items: params.targets.map((item: object) => ({ ...item, removed: true })) };
    return { exitCode: 0, lines: [prefixes[op] + JSON.stringify({ ...reply, ...patch })] };
  });
});
afterEach(() => vi.restoreAllMocks());

describe('selected-node ordered runtime mutation client', () => {
  it.each(kinds)('binds %s to its exact node and durable request identity across retries', async kind => {
    const first = await invoke(kind), second = await invoke(kind); expect(second).toEqual(first);
    const calls = io.op.mock.calls.filter(call => call[2] !== 'agent.ping'); expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call[1]).toBe(2); expect(call[3]).toMatchObject(requests[kind]); expect(call[5].timeoutMs).toBe(header.timeoutMs);
    }
    expect(checkpoint).toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, NaN])('refuses an invalid node before discovery: %s', server => {
    expect(() => createNodeRuntimeMutationClient(db, server, { checkpoint })).toThrow(/explicit node/);
    expect(io.op).not.toHaveBeenCalled(); expect(io.sealed).not.toHaveBeenCalled();
  });
  it.each(kinds)('validates %s before transport or discovery', async kind => {
    await expect(invoke(kind, { ...requests[kind], revision: 0 })).rejects.toThrow(); expect(io.sealed).not.toHaveBeenCalled(); expect(io.op).not.toHaveBeenCalled();
  });
  it.each(kinds)('requires encrypted transport for %s', async kind => {
    io.sealed.mockResolvedValue(false); await expect(invoke(kind)).rejects.toThrow(/unencrypted/); expect(io.op).not.toHaveBeenCalled();
  });
  it('distinguishes an older agent from an owner-disabled ordered protocol', async () => {
    caps = []; version = '0.18.3'; await expect(invoke('fence')).rejects.toThrow(/Update.*v0.18.10/);
    version = '0.19.0'; await expect(invoke('fence')).rejects.toThrow(/NINEDEPLOY_AGENT_CONTAINER_MUTATIONS=off/);
    expect(io.op.mock.calls.every(call => call[2] === 'agent.ping')).toBe(true);
  });
  it('does not send limits to an agent that lacks the dedicated capability', async () => {
    caps = ['docker.mutations']; version = '0.18.11';
    await expect(invoke('limits')).rejects.toThrow(/0\.18\.12/);
    expect(io.op.mock.calls.every(call => call[2] === 'agent.ping')).toBe(true);
  });
  it('requires evidence for every exact limit target', async () => {
    for (const items of [[], [target], [target, { ...spare, id: 'e'.repeat(64) }], [target, { ...spare, deploymentId: 11 }]]) {
      patch = { items }; await expect(invoke('limits')).rejects.toThrow();
    }
  });
  it('does not accept a fence that acknowledges a different deployment watermark', async () => {
    patch = { deploymentWatermark: 9 };
    await expect(invoke('fence', { ...requests.fence, deploymentWatermark: 10 })).rejects.toThrow(/identity|coverage/);
  });
  it.each(kinds)('rejects %s replies belonging to another owner or revision', async kind => {
    for (const change of [{ requestId: 'd'.repeat(32) }, { serviceId: 8 }, { revision: 9 }, { complete: false }]) {
      patch = change; await expect(invoke(kind)).rejects.toThrow();
    }
  });
  it.each([
    { deploymentId: 11 }, { items: [{ ...target, running: true }] },
    { items: [{ ...target, running: false }, { ...spare, running: false }] },
    { items: [{ ...target, running: true }, { ...spare, running: true }] },
    { items: [{ ...target, running: true }, { ...spare, name: 'foreign', running: false }] },
    { items: [{ ...target, running: true }, { ...spare, deploymentId: 11, running: false }] },
  ])('refuses incomplete or changed prepared capacity: %j', async changed => {
    patch = changed; await expect(invoke('prepare')).rejects.toThrow(/identity|coverage/);
  });
  it('allows a wholly stopped capacity set and binds every stopped member', async () => {
    patch = { items: [{ ...target, running: false }, { ...spare, running: false }] };
    await expect(invoke('prepare', { ...requests.prepare, startNames: [] })).resolves.toMatchObject(patch);
  });
  it.each(['networks', 'retire'] as const)('checks every immutable generation in %s evidence', async kind => {
    const state = kind === 'networks' ? { connected: true } : { removed: true };
    for (const changed of [[], [{ ...target, ...state }], [{ ...target, ...state }, { ...spare, id: 'e'.repeat(64), ...state }],
      [{ ...target, ...state }, { ...spare, name: 'foreign', ...state }], [{ ...target, ...state }, { ...spare, deploymentId: 11, ...state }]]) {
      patch = { items: changed }; await expect(invoke(kind)).rejects.toThrow();
    }
  });
  it.each(['start', 'stop'] as const)('requires the complete %s set with the requested final state', async kind => {
    const running = kind === 'start';
    for (const changed of [[], [{ ...target, running }], [{ ...target, running }, { ...spare, id: 'e'.repeat(64), running }],
      [{ ...target, running }, { ...spare, deploymentId: 11, running }], [{ ...target, running }, { ...spare, running: !running }]]) {
      patch = { items: changed }; await expect(invoke(kind)).rejects.toThrow();
    }
  });
  it.each([{ networks: ['foreign'] }, { action: 'disconnect', items: [{ ...target, connected: false }, { ...spare, connected: false }] }])('requires the requested networks and action: %j', async changed => {
    patch = changed; await expect(invoke('networks')).rejects.toThrow(/identity|coverage/);
  });
  it('accepts disconnected membership and empty retirement receipts', async () => {
    await expect(invoke('networks', { ...requests.networks, action: 'disconnect' })).resolves.toMatchObject({ action: 'disconnect', items: [{ connected: false }, { connected: false }] });
    await expect(invoke('retire', { ...requests.retire, targets: [] })).resolves.toMatchObject({ items: [] });
    await expect(invoke('stop', { ...requests.stop, targets: [] })).resolves.toMatchObject({ items: [] });
  });
  it.each(['missing', 'duplicate', 'malformed', 'oversized', 'failed'])('refuses unusable transport evidence: %s', async mode => {
    const normal = io.op.getMockImplementation()!;
    io.op.mockImplementation(async (...args) => {
      const result = await normal(...args); if (args[2] === 'agent.ping') return result;
      if (mode === 'failed') return { ...result, exitCode: 1 };
      if (mode === 'missing') return { ...result, lines: ['diagnostic only'] };
      if (mode === 'duplicate') return { ...result, lines: [...result.lines, ...result.lines] };
      return { ...result, lines: ['ND-RUNTIME-FENCE ' + (mode === 'malformed' ? '{' : ' '.repeat(65_537))] };
    });
    await expect(invoke('fence')).rejects.toThrow();
  });
  it('refuses ownership loss before admission and after an in-flight success', async () => {
    checkpoint.mockRejectedValue(new Error('Owner changed')); await expect(invoke('fence')).rejects.toThrow('Owner changed'); expect(io.op).not.toHaveBeenCalled();
    checkpoint.mockResolvedValue(undefined); mutate = () => { checkpoint.mockRejectedValue(new Error('Owner changed')); };
    await expect(invoke('prepare')).rejects.toThrow('Owner changed');
  });
  it('never mutates after an ownership loss during capability discovery', async () => {
    const normal = io.op.getMockImplementation()!;
    io.op.mockImplementation(async (...args) => { const result = await normal(...args); checkpoint.mockRejectedValue(new Error('Owner changed')); return result; });
    await expect(invoke('fence')).rejects.toThrow('Owner changed'); expect(io.op.mock.calls.map(call => call[2])).toEqual(['agent.ping']);
  });
  it('preserves cancellation through discovery and the actual mutation', async () => {
    const abort = new AbortController(); mutate = () => abort.abort(new Error('Cancelled'));
    await expect(invoke('retire', requests.retire, abort.signal)).rejects.toThrow('Cancelled');
    expect(io.sealed).toHaveBeenCalledWith(db, 2, abort.signal); expect(io.op.mock.calls.every(call => call[5].signal === abort.signal)).toBe(true);
    io.op.mockClear(); await expect(invoke('fence', requests.fence, abort.signal)).rejects.toThrow('Cancelled'); expect(io.op).not.toHaveBeenCalled();
  });
  it('charges discovery against the original deadline and rejects a late success', async () => {
    const normal = io.op.getMockImplementation()!;
    io.op.mockImplementation(async (...args) => { const result = await normal(...args); now += args[2] === 'agent.ping' ? 1000 : header.timeoutMs; return result; });
    await expect(invoke('fence')).rejects.toThrow(/deadline/);
    expect(io.op.mock.calls[1]![3].timeoutMs).toBe(header.timeoutMs - 1000);
    expect(io.op.mock.calls[1]![5].timeoutMs).toBe(header.timeoutMs - 1000);
  });
});
