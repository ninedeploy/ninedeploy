import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeProxyTraffic, PROXY_TRAFFIC_MAX_SESSIONS } from '../../src/lib/nodeProxyTraffic.js';
import { proxyTrafficOpen, proxyTrafficSnapshot, type ProxyTrafficOpen } from '@ninedeploy/schemas';
import type { NodeProxyTrafficIO } from '../../src/lib/nodeProxyTrafficDocker.js';

const input: ProxyTrafficOpen = { requestId: '1'.repeat(32), nodeId: 2, serviceId: 3, deploymentId: 4, step: 1, slug: 'web', durationMs: 1000, routingConfig: 'http: {}',
  stable: [{ name: 'old', id: 'a'.repeat(64), port: 80 }], canary: [{ name: 'new', id: 'b'.repeat(64), port: 80 }] };
const managers: NodeProxyTraffic[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const manager of managers.splice(0)) manager.closeAll(); vi.useRealTimers(); });

function fixture() {
  const connections = new Set<{ line: (value: string) => void; fail: () => void }>();
  let seq = 0, sourceId = 'e'.repeat(64), enabled = true, dropMarker = false;
  const emit = (over: { seq?: number; path?: string; status?: number; router?: string; upstream?: string } = {}) => {
    const value = `172.18.0.2 - - [24/Oct/2026:12:00:00 +0000] ${JSON.stringify('GET ' + (over.path ?? '/') + ' HTTP/1.1')} ${over.status ?? 200} 1 "-" "-" ${over.seq ?? ++seq} ${JSON.stringify(over.router ?? 'web_1@file')} ${JSON.stringify(over.upstream ?? 'http://new:80')} 1ms`;
    for (const connection of connections) connection.line(value);
  };
  const io: NodeProxyTrafficIO = {
    inspect: vi.fn(async () => ({ proxyId: 'f'.repeat(64), sourceId })),
    connect: vi.fn((_id, line, fail) => {
      const connection = { line, fail }; connections.add(connection);
      return { ready: Promise.resolve(), close: vi.fn(() => { connections.delete(connection); }) };
    }),
    heartbeat: vi.fn(async (_id, path) => { if (!dropMarker) emit({ path, status: 404, router: '-', upstream: '-' }); }),
  };
  const manager = new NodeProxyTraffic(io, () => Date.now(), () => enabled); managers.push(manager);
  return { manager, io, emit, connections, changeSource: () => { sourceId = 'd'.repeat(64); }, disable: () => { enabled = false; },
    dropMarkers: () => { dropMarker = true; }, skip: () => ++seq };
}

describe('node observation reservations', () => {
  it('opens, samples in batches and finishes with matching request/target identities', async () => {
    const f = fixture(), opened = await f.manager.open(input);
    expect(proxyTrafficSnapshot.parse(opened)).toMatchObject({ complete: false, nodeId: 2, serviceId: 3, deploymentId: 4, step: 1 });
    f.emit({ status: 503 });
    expect(await f.manager.sample({ windowIds: [opened.windowId] })).toMatchObject([{ ok: true, snapshot: { canary: { errors: 1 }, complete: false } }]);
    await vi.advanceTimersByTimeAsync(1000);
    const final = await f.manager.finish({ windowId: opened.windowId });
    expect(final).toMatchObject({ complete: true, canary: { requests: 1, errors: 1 }, expected: 1, observed: 1, windowId: opened.windowId, targetHash: opened.targetHash });
    expect(final.elapsedMs).toBeGreaterThanOrEqual(1000);
    expect(f.connections.size).toBe(0); expect(f.manager.activeCount()).toBe(0);
    expect(await f.manager.finish({ windowId: opened.windowId })).toEqual(final);
  });

  it('does not resurrect a closed request or allocate a second stream on retries', async () => {
    const f = fixture(), first = await f.manager.open(input);
    expect(await f.manager.open(input)).toEqual(first); expect(f.io.connect).toHaveBeenCalledOnce();
    await expect(f.manager.open({ ...input, nodeId: 8 })).rejects.toThrow(/identity changed/);
    f.manager.close({ windowId: first.windowId });
    await expect(f.manager.open(input)).rejects.toThrow(/closed/); expect(f.connections.size).toBe(0);
  });

  it('waits for the configured duration without destroying an early finish request', async () => {
    const f = fixture(), opened = await f.manager.open(input);
    await expect(f.manager.finish({ windowId: opened.windowId })).rejects.toThrow(/duration/);
    expect(f.manager.activeCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await f.manager.finish({ windowId: opened.windowId })).toMatchObject({ complete: true, expected: 0, observed: 0 });
  });

  it('retains a completed receipt for its retry cache lifetime after the active observation deadline', async () => {
    const f = fixture(), opened = await f.manager.open(input);
    await vi.advanceTimersByTimeAsync(1000);
    const final = await f.manager.finish({ windowId: opened.windowId });
    await vi.advanceTimersByTimeAsync(21_000);
    expect(await f.manager.finish({ windowId: opened.windowId })).toEqual(final);
    expect(f.io.connect).toHaveBeenCalledOnce(); expect(f.connections.size).toBe(0);
    await vi.advanceTimersByTimeAsync(39_001);
    await expect(f.manager.finish({ windowId: opened.windowId })).rejects.toThrow(/unknown or expired/);
  });

  it('refuses missing producer records instead of a successful empty window', async () => {
    const f = fixture(), opened = await f.manager.open(input); f.skip(); f.emit();
    await vi.advanceTimersByTimeAsync(1000);
    const failing = expect(f.manager.finish({ windowId: opened.windowId })).rejects.toThrow(/incomplete/);
    await vi.advanceTimersByTimeAsync(5100); await failing;
    expect(f.manager.activeCount()).toBe(0); expect(f.connections.size).toBe(0);
  });

  it('accepts a late completion only when it closes the observed sequence gap', async () => {
    const f = fixture(), opened = await f.manager.open(input); const pending = f.skip();
    await vi.advanceTimersByTimeAsync(1000);
    const finishing = f.manager.finish({ windowId: opened.windowId });
    await vi.advanceTimersByTimeAsync(100); f.emit({ seq: pending });
    await vi.advanceTimersByTimeAsync(20);
    expect(await finishing).toMatchObject({ complete: true, observed: 1, expected: 1 });
  });

  it('refuses a log stream that never acknowledges the start marker and frees it', async () => {
    const f = fixture(); f.dropMarkers();
    const failing = expect(f.manager.open(input)).rejects.toThrow(/could not be opened/);
    await vi.advanceTimersByTimeAsync(5100); await failing;
    expect(f.manager.activeCount()).toBe(0); expect(f.connections.size).toBe(0);
  });

  it('fails source replacement and owner disable without returning old samples', async () => {
    const f = fixture(), opened = await f.manager.open(input); f.changeSource();
    expect(await f.manager.sample({ windowIds: [opened.windowId] })).toMatchObject([{ ok: false, windowId: opened.windowId }]);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(f.manager.finish({ windowId: opened.windowId })).rejects.toThrow(/source changed/);
    const g = fixture(), live = await g.manager.open(input); g.disable();
    expect(await g.manager.sample({ windowIds: [live.windowId] })).toMatchObject([{ ok: false }]);
    expect(g.connections.size).toBe(0);
    await expect(g.manager.open({ ...input, requestId: '2'.repeat(32) })).rejects.toThrow(/owner disabled/);
  });

  it('invalidates the reservation after a failed loaded-routing check even if the source later recovers', async () => {
    const f = fixture(), opened = await f.manager.open(input);
    vi.mocked(f.io.inspect).mockRejectedValueOnce(Error('Routing is no longer loaded'));
    expect(await f.manager.sample({ windowIds: [opened.windowId] })).toMatchObject([{ ok: false }]);
    expect(f.connections.size).toBe(0); expect(f.manager.activeCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(f.manager.finish({ windowId: opened.windowId })).rejects.toThrow(/source changed or unavailable/);
  });

  it('bounds routing bytes before opening I/O and binds idempotency to the requested generation', async () => {
    const f = fixture();
    await expect(f.manager.open({ ...input, routingConfig: '€'.repeat(400_000) })).rejects.toThrow(/exceeds 1 MiB/);
    expect(f.io.inspect).not.toHaveBeenCalled();
    const opened = await f.manager.open(input);
    expect(opened.routingGeneration).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(opened)).not.toContain(input.routingConfig);
    await expect(f.manager.open({ ...input, routingConfig: input.routingConfig + '\n# new generation' })).rejects.toThrow(/identity changed/);
  });

  it('expires idle sessions and preserves the epoch boundary after shutdown', async () => {
    const f = fixture(), opened = await f.manager.open({ ...input, durationMs: 60_000 });
    await vi.advanceTimersByTimeAsync(30_001); expect(f.manager.activeCount()).toBe(0); expect(f.connections.size).toBe(0);
    expect(await f.manager.sample({ windowIds: [opened.windowId] })).toMatchObject([{ ok: false }]);
    f.manager.closeAll();
    const next = await f.manager.open(input); expect(next.epoch).not.toBe(opened.epoch); expect(next.windowId).not.toBe(opened.windowId);
    expect(await f.manager.sample({ windowIds: [opened.windowId] })).toMatchObject([{ ok: false }]);
  });

  it('cannot keep a reservation alive beyond its maximum lifetime by polling', async () => {
    const f = fixture(), opened = await f.manager.open(input);
    await vi.advanceTimersByTimeAsync(20_000); await f.manager.sample({ windowIds: [opened.windowId] });
    await vi.advanceTimersByTimeAsync(1001);
    expect(await f.manager.sample({ windowIds: [opened.windowId] })).toMatchObject([{ ok: false }]); expect(f.connections.size).toBe(0);
  });

  it('bounds concurrent windows and releases slots after close', async () => {
    const f = fixture(), windows = [];
    for (let n = 0; n < PROXY_TRAFFIC_MAX_SESSIONS; n++) windows.push(await f.manager.open({ ...input, requestId: n.toString(16).padStart(32, '0') }));
    await expect(f.manager.open({ ...input, requestId: 'f'.repeat(32) })).rejects.toThrow(/too many/);
    f.manager.close({ windowId: windows[0]!.windowId });
    expect(await f.manager.open({ ...input, requestId: 'f'.repeat(32) })).toMatchObject({ complete: false });
  });

  it('cancels stalled opening I/O and does not allocate a late stream', async () => {
    const f = fixture(); let resolve!: (value: { proxyId: string; sourceId: string }) => void;
    const stalled = new Promise<{ proxyId: string; sourceId: string }>(yes => { resolve = yes; });
    vi.mocked(f.io.inspect).mockReturnValue(stalled);
    const failed = expect(f.manager.open(input)).rejects.toThrow(/expired/);
    await vi.advanceTimersByTimeAsync(10_001); await failed;
    resolve({ proxyId: 'f'.repeat(64), sourceId: 'e'.repeat(64) }); await vi.advanceTimersByTimeAsync(1);
    expect(f.io.connect).not.toHaveBeenCalled(); expect(f.manager.activeCount()).toBe(0);
  });

  it('closes a stream that fails synchronously during connection setup', async () => {
    const f = fixture(), close = vi.fn();
    vi.mocked(f.io.connect).mockImplementation((_id, _line, failure) => { failure(); return { ready: Promise.resolve(), close }; });
    await expect(f.manager.open(input)).rejects.toThrow(/stream unavailable/); expect(close).toHaveBeenCalledOnce();
  });

  it('does not ingest duplicate counters or expose valid metrics after a stream failure', async () => {
    const f = fixture(), opened = await f.manager.open(input); f.emit({ seq: 2 }); f.emit({ seq: 2 });
    expect(await f.manager.sample({ windowIds: [opened.windowId] })).toMatchObject([{ ok: false }]); expect(f.connections.size).toBe(0);
  });

  it('validates operands and receipt consistency without accepting extra fields', async () => {
    const f = fixture();
    await expect(f.manager.open({ ...input, path: '/etc/private' })).rejects.toThrow();
    expect(() => proxyTrafficOpen.parse({ ...input, canary: input.stable })).toThrow(/distinct/);
    const opened = await f.manager.open(input);
    expect(() => proxyTrafficSnapshot.safeParse({ ...opened, startCounter: 'private-value' })).not.toThrow();
    expect(proxyTrafficSnapshot.safeParse({ ...opened, startCounter: 'private-value' }).success).toBe(false);
    expect(() => proxyTrafficSnapshot.parse({ ...opened, complete: true })).toThrow(/coverage/);
    await expect(f.manager.sample({ windowIds: [opened.windowId, opened.windowId] })).rejects.toThrow(/duplicate/);
    expect(f.manager.close({ windowId: '0'.repeat(32) })).toEqual({ windowId: '0'.repeat(32), closed: true });
  });
});
