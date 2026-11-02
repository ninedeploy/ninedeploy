import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_OPS, advertisedCapabilities, runRegisteredOp } from '../../src/agentOps/index.js';
import { idleWatchSnapshot } from '@ninedeploy/schemas';

const engine = vi.hoisted(() => ({ sequence: 0, lines: new Set<(line: string) => void>() }));
vi.mock('../../src/lib/nodeProxyTrafficDocker.js', () => ({ nodeProxyTrafficDocker: () => ({
  inspect: async () => ({ proxyId: 'f'.repeat(64), sourceId: 'e'.repeat(64) }),
  connect: (_id: string, line: (value: string) => void) => { engine.lines.add(line); return { ready: Promise.resolve(), close: () => engine.lines.delete(line) }; },
  // One proxy request has one sequence number, whichever windows read it.
  heartbeat: async (_id: string, path: string) => {
    const sequence = ++engine.sequence;
    for (const line of engine.lines) line(`127.0.0.1 - - [01/Nov/2026:12:00:00 +0000] "GET ${path} HTTP/1.1" 404 0 "-" "-" ${sequence} "-" "-" 0ms`);
  },
}) }));
const MINUTE = 60_000;
let ids = 0;
const nextId = () => (++ids).toString(16).padStart(32, '0');
const input = (requestId = nextId(), durationMs = 2 * MINUTE) => ({ purpose: 'idle', requestId, nodeId: 2, serviceId: 3, deploymentId: 4, slug: 'web',
  durationMs, routingConfig: 'http: {}', serving: [{ name: 'web-4', id: 'a'.repeat(64), port: 80 }] });
const request = (router = 'web_1@file') => { const sequence = ++engine.sequence; for (const line of engine.lines) {
  line(`127.0.0.1 - - [01/Nov/2026:12:00:00 +0000] "GET /private?token=secret HTTP/1.1" 200 1 "-" "-" ${sequence} "${router}" "http://web-4:80" 2ms`);
} };
const windows: string[] = [];
const call = async (action: string, args: Record<string, unknown>) => {
  const lines: string[] = [];
  expect(await runRegisteredOp(`proxy.idleWatch.${action}`, args, line => lines.push(line), { sealed: true })).toBe(0);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^ND-IDLE-WATCH /);
  return JSON.parse(lines[0]!.slice('ND-IDLE-WATCH '.length));
};
const open = async (args = input()) => { const opened = await call('open', args); windows.push(opened.snapshot.windowId); return opened.snapshot; };
/** Keep a window alive the way the panel will: a sample well inside the 30 s lease. */
const hold = async (windowIds: string[], ms: number) => {
  for (let left = ms; left > 0; left -= 15_000) {
    await vi.advanceTimersByTimeAsync(Math.min(15_000, left));
    const sampled = await call('sample', { windowIds });
    expect(sampled.items.every((item: { ok: boolean }) => item.ok)).toBe(true);
  }
};
beforeEach(() => { engine.sequence = 0; vi.useFakeTimers(); vi.stubEnv('NINEDEPLOY_AGENT_PROXY_TRAFFIC', 'on'); });
afterEach(async () => {
  vi.stubEnv('NINEDEPLOY_AGENT_PROXY_TRAFFIC', 'on');
  for (const windowId of windows.splice(0)) await call('close', { windowId });
  expect(engine.lines.size).toBe(0);
  vi.unstubAllEnvs(); vi.useRealTimers();
});

describe('sealed node idle watch (R2 scale to zero)', () => {
  it('registers a separate sealed capability behind the same owner opt-in', () => {
    for (const action of ['open', 'sample', 'finish', 'close']) expect(AGENT_OPS.get(`proxy.idleWatch.${action}`)).toMatchObject({ cap: 'proxy.idleWatch', sealedOnly: true });
    expect(advertisedCapabilities({})).not.toContain('proxy.idleWatch');
    expect(advertisedCapabilities({ NINEDEPLOY_AGENT_PROXY_TRAFFIC: 'on' })).toContain('proxy.idleWatch');
    expect(advertisedCapabilities({ NINEDEPLOY_AGENT_PROXY_TRAFFIC: 'off' })).not.toContain('proxy.idleWatch');
  });

  it('refuses plaintext, autoscale operands and windows outside one minute to one hour', async () => {
    await expect(runRegisteredOp('proxy.idleWatch.open', input(), () => {}, { sealed: false })).rejects.toThrow(/sealed/);
    for (const bad of [{ ...input(), purpose: 'autoscale' }, input(nextId(), 59_999), input(nextId(), 3_600_001)]) {
      await expect(runRegisteredOp('proxy.idleWatch.open', bad, () => {}, { sealed: true })).rejects.toThrow();
    }
    expect(engine.lines.size).toBe(0);
  });

  it('proves a verified zero over a window longer than the serving limit while sampled inside its lease', async () => {
    const opened = await open();
    expect(idleWatchSnapshot.parse(opened)).toMatchObject({ purpose: 'idle', complete: false, serving: { requests: 0 } });
    request('other_1@file');
    await hold([opened.windowId], 2 * MINUTE);
    const receipt = await call('finish', { windowId: opened.windowId });
    expect(idleWatchSnapshot.parse(receipt.snapshot)).toMatchObject({ purpose: 'idle', complete: true, observed: 1, expected: 1, serving: { requests: 0 } });
    expect(receipt.snapshot.elapsedMs).toBeGreaterThanOrEqual(2 * MINUTE);
    expect(JSON.stringify(receipt)).not.toMatch(/private|token|secret/);
  });

  it('counts a single serving request, so the window is not idle', async () => {
    const opened = await open();
    await hold([opened.windowId], MINUTE);
    request();
    await hold([opened.windowId], MINUTE);
    expect((await call('finish', { windowId: opened.windowId })).snapshot).toMatchObject({ complete: true, serving: { requests: 1 } });
  });

  it('ends a window whose lease lapsed; it never reads as idle', async () => {
    const opened = await open();
    await vi.advanceTimersByTimeAsync(31_000);
    expect((await call('sample', { windowIds: [opened.windowId] })).items).toEqual([expect.objectContaining({ ok: false, windowId: opened.windowId })]);
    await expect(runRegisteredOp('proxy.idleWatch.finish', { windowId: opened.windowId }, () => {}, { sealed: true })).rejects.toThrow();
    expect(engine.lines.size).toBe(0);
  });

  it('lets the panel chain overlapping windows from one source', async () => {
    const first = await open();
    await hold([first.windowId], MINUTE);
    const second = await open(input());
    await hold([first.windowId, second.windowId], MINUTE);
    const done = (await call('finish', { windowId: first.windowId })).snapshot;
    // The next window began before the previous one ended: no unobserved gap between them.
    expect(BigInt(second.startCounter)).toBeLessThan(BigInt(done.endCounter));
    expect([second.sourceId, second.proxyId, second.epoch]).toEqual([done.sourceId, done.proxyId, done.epoch]);
  });

  it('refuses operations while the node owner has observations off, so open windows lapse with their lease', async () => {
    const opened = await open();
    vi.stubEnv('NINEDEPLOY_AGENT_PROXY_TRAFFIC', 'off');
    await expect(runRegisteredOp('proxy.idleWatch.sample', { windowIds: [opened.windowId] }, () => {}, { sealed: true })).rejects.toThrow(/opted in/);
    await vi.advanceTimersByTimeAsync(31_000);
    vi.stubEnv('NINEDEPLOY_AGENT_PROXY_TRAFFIC', 'on');
    expect((await call('sample', { windowIds: [opened.windowId] })).items[0]).toMatchObject({ ok: false });
  });
});
