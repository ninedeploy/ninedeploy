import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServingTrafficOpen } from '@ninedeploy/schemas';
import { NodeServingTraffic } from '../../src/lib/nodeServingTraffic.js';
import { NodeProxyTraffic } from '../../src/lib/nodeProxyTraffic.js';
import type { NodeProxyTrafficIO } from '../../src/lib/nodeProxyTrafficDocker.js';

const input: ServingTrafficOpen = { purpose: 'autoscale', requestId: '1'.repeat(32), nodeId: 2, serviceId: 3, deploymentId: 4,
  slug: 'web', durationMs: 1000, routingConfig: 'http: {}', serving: [
    { name: 'web-4', id: 'a'.repeat(64), port: 80 }, { name: 'web-4-r2', id: 'b'.repeat(64), port: 80 },
  ] };
const managers: Array<NodeServingTraffic | NodeProxyTraffic> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const manager of managers.splice(0)) manager.closeAll(); vi.useRealTimers(); });
function fixture() {
  const streams = new Set<{ line: (line: string) => void; fail: () => void }>();
  let sequence = 0, enabled = true, sourceId = 'e'.repeat(64), markers = true;
  const emit = (over: { path?: string; status?: number; router?: string; upstream?: string; seq?: number } = {}) => {
    for (const stream of [...streams]) stream.line(`127.0.0.1 - - [01/Nov/2026:12:00:00 +0000] ${JSON.stringify(`GET ${over.path ?? '/private?token=fixture'} HTTP/1.1`)} ${over.status ?? 200} 0 "-" "-" ${over.seq ?? ++sequence} ${JSON.stringify(over.router ?? 'web_1@file')} ${JSON.stringify(over.upstream ?? 'http://web-4:80')} 2ms`);
  };
  const io: NodeProxyTrafficIO<ServingTrafficOpen> = {
    inspect: vi.fn(async () => ({ proxyId: 'f'.repeat(64), sourceId })),
    connect: vi.fn((_id, line, fail) => { const stream = { line, fail }; streams.add(stream); return { ready: Promise.resolve(), close: vi.fn(() => streams.delete(stream)) }; }),
    heartbeat: vi.fn(async (_id, path) => { if (markers) emit({ path, status: 404, router: '-', upstream: '-' }); }),
  };
  const manager = new NodeServingTraffic(io, () => Date.now(), () => enabled); managers.push(manager);
  return { manager, io, emit, streams, skip: () => ++sequence, disable: () => { enabled = false; }, restart: () => { sourceId = 'd'.repeat(64); }, dropMarkers: () => { markers = false; } };
}

describe('ordinary serving-generation observations', () => {
  it('measures the marker interval rather than including final verification or losing opening verification time', async () => {
    const f = fixture(); let inspections = 0;
    vi.mocked(f.io.inspect).mockImplementation(async () => {
      const delay = [0, 800, 200, 400][inspections++] ?? 0;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return { proxyId: 'f'.repeat(64), sourceId: 'e'.repeat(64) };
    });
    const opening = f.manager.open(input);
    await vi.advanceTimersByTimeAsync(800);
    const opened = await opening;
    expect(opened.elapsedMs).toBe(800);
    await vi.advanceTimersByTimeAsync(1000);
    const finishing = f.manager.finish({ windowId: opened.windowId });
    await vi.advanceTimersByTimeAsync(600);
    expect((await finishing).elapsedMs).toBe(2000);
  });

  it('aggregates only the selected immutable serving replicas with complete global sequence coverage', async () => {
    const f = fixture(), opened = await f.manager.open(input);
    f.emit(); f.emit({ upstream: 'http://web-4-r2:80', status: 503 }); f.emit({ router: 'another_1@file' });
    await vi.advanceTimersByTimeAsync(1000);
    const receipt = await f.manager.finish({ windowId: opened.windowId });
    expect(receipt).toMatchObject({ purpose: 'autoscale', complete: true, observed: 3, expected: 3, serving: { requests: 2, errors: 1, errorRate: 50 } });
    expect(receipt).not.toHaveProperty('canary'); expect(receipt).not.toHaveProperty('step');
    expect(JSON.stringify(receipt)).not.toMatch(/private|token|routingConfig/);
    expect(f.streams.size).toBe(0);
  });

  it('reports actual zero traffic only after two consecutive live markers', async () => {
    const f = fixture(), opened = await f.manager.open(input);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await f.manager.finish({ windowId: opened.windowId })).toMatchObject({ complete: true, expected: 0, observed: 0, serving: { requests: 0 } });
  });

  it('counts selected serving leaves reached through an HTTP twin router', async () => {
    const f = fixture(), opened = await f.manager.open(input);
    f.emit({ router: 'web_1_http@file' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await f.manager.finish({ windowId: opened.windowId })).toMatchObject({ complete: true, serving: { requests: 1 } });
  });

  it('refuses log loss instead of fabricating zero RPS and frees its stream', async () => {
    const f = fixture(), opened = await f.manager.open(input); f.skip(); f.emit();
    await vi.advanceTimersByTimeAsync(1000);
    const failure = expect(f.manager.finish({ windowId: opened.windowId })).rejects.toThrow(/incomplete/);
    await vi.advanceTimersByTimeAsync(5100); await failure;
    expect(f.streams.size).toBe(0); expect(f.manager.activeCount()).toBe(0);
  });

  it.each(['restart', 'disable', 'route', 'log', 'replica'] as const)('invalidates an active observation on %s', async fault => {
    const f = fixture(), opened = await f.manager.open(input);
    if (fault === 'restart') f.restart();
    if (fault === 'disable') f.disable();
    if (fault === 'route') vi.mocked(f.io.inspect).mockRejectedValueOnce(Error('routing changed'));
    if (fault === 'log') for (const stream of [...f.streams]) stream.fail();
    if (fault === 'replica') f.emit({ upstream: 'http://web-99:80' });
    expect(await f.manager.sample({ windowIds: [opened.windowId] })).toMatchObject([{ ok: false }]);
    expect(f.streams.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(f.manager.finish({ windowId: opened.windowId })).rejects.toThrow(/unavailable/);
  });

  it('binds retries to the generation, route and duration and retains a completed receipt without a new source', async () => {
    const f = fixture(), opened = await f.manager.open(input);
    expect(await f.manager.open(input)).toEqual(opened);
    for (const change of [{ durationMs: 2000 }, { routingConfig: 'http: {}\n' }, { serving: [{ ...input.serving[0]!, id: 'c'.repeat(64) }, input.serving[1]!] }]) {
      await expect(f.manager.open({ ...input, ...change })).rejects.toThrow(/identity changed/);
    }
    await vi.advanceTimersByTimeAsync(1000);
    const final = await f.manager.finish({ windowId: opened.windowId });
    await vi.advanceTimersByTimeAsync(21_000);
    expect(await f.manager.finish({ windowId: opened.windowId })).toEqual(final);
    expect(await f.manager.open(input)).toEqual(final); expect(f.io.connect).toHaveBeenCalledOnce();
  });

  it('cancels stalled source inspection without allocating a late stream', async () => {
    const f = fixture(); let resolve!: (value: { proxyId: string; sourceId: string }) => void;
    vi.mocked(f.io.inspect).mockReturnValue(new Promise(yes => { resolve = yes; }));
    const failure = expect(f.manager.open(input)).rejects.toThrow(/expired/);
    await vi.advanceTimersByTimeAsync(10_001); await failure;
    resolve({ proxyId: 'f'.repeat(64), sourceId: 'e'.repeat(64) }); await vi.advanceTimersByTimeAsync(1);
    expect(f.io.connect).not.toHaveBeenCalled(); expect(f.manager.activeCount()).toBe(0);
  });

  it('expires idle observations and never returns cached metrics for closed windows', async () => {
    const f = fixture(), opened = await f.manager.open({ ...input, durationMs: 60_000 });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await f.manager.sample({ windowIds: [opened.windowId] })).toMatchObject([{ ok: false }]);
    expect(f.streams.size).toBe(0);
  });

  it('does not share window handles with the canary observation namespace', async () => {
    const f = fixture(), opened = await f.manager.open(input);
    const canary = new NodeProxyTraffic({ ...f.io, inspect: async () => ({ proxyId: 'f'.repeat(64), sourceId: 'e'.repeat(64) }) }, () => Date.now()); managers.push(canary);
    expect(await canary.sample({ windowIds: [opened.windowId] })).toMatchObject([{ ok: false }]);
    canary.close({ windowId: opened.windowId });
    expect(f.manager.activeCount()).toBe(1);
    expect(await f.manager.sample({ windowIds: [opened.windowId] })).toMatchObject([{ ok: true }]);
  });
});
