import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nodeAutoscaleCapacity, nodeServingTrafficReceipts, services } from '@ninedeploy/db';
import { idleWatchOpen, type IdleWatchOpen, type IdleWatchSnapshot } from '@ninedeploy/schemas';
import { openNodeIdleWatch } from '../../src/lib/nodeIdleWatchClient.js';
import { proxyTrafficRoutingGeneration, proxyTrafficTargetHash } from '../../src/lib/proxyTrafficCounter.js';
import { servingReceiptFixture } from '../fixtures/servingTrafficReceipt.js';
import { reserveServiceRuntimeOwner } from '../../src/lib/serviceRuntimeOwner.js';

const io = vi.hoisted(() => ({ op: vi.fn(), sealed: vi.fn(async () => true) }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.op, agentTransportSealed: io.sealed }));
let f: Awaited<ReturnType<typeof servingReceiptFixture>>, input: IdleWatchOpen, snapshot: IdleWatchSnapshot, caps: string[];
const frame = (value: unknown) => ({ exitCode: 0, lines: [`ND-IDLE-WATCH ${JSON.stringify(value)}`] });
const closes = () => io.op.mock.calls.filter(args => args[2] === 'proxy.idleWatch.close');
beforeEach(async () => {
  vi.clearAllMocks(); io.sealed.mockResolvedValue(true);
  f = await servingReceiptFixture('file::memory:');
  input = idleWatchOpen.parse({ ...f.input, purpose: 'idle', durationMs: 60_000 });
  caps = ['proxy.idleWatch'];
  snapshot = { protocol: 1, purpose: 'idle', basis: 'traefik-request-sequence', precisionMs: 1, windowId: 'c'.repeat(32), requestId: input.requestId,
    epoch: 'd'.repeat(32), sourceId: 'e'.repeat(64), proxyId: 'f'.repeat(64), targetHash: proxyTrafficTargetHash(input), routingGeneration: proxyTrafficRoutingGeneration(input),
    nodeId: 4, serviceId: 1, deploymentId: 9, elapsedMs: 0, startCounter: '10', endCounter: null, expected: null, observed: 0, complete: false,
    serving: { requests: 0, errors: 0, errorRate: null, p95Ms: null } };
  io.op.mockImplementation(async (_db, _node, op) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps })}`] };
    if (op === 'proxy.idleWatch.open') return frame({ kind: 'open', snapshot });
    if (op === 'proxy.idleWatch.sample') return frame({ kind: 'sample', items: [{ ok: true, snapshot }] });
    if (op === 'proxy.idleWatch.finish') return frame({ kind: 'finish', snapshot });
    return frame({ kind: 'close', windowId: snapshot.windowId, closed: true });
  });
});
afterEach(() => { vi.restoreAllMocks(); f.c.client?.close(); });

it('keeps a long window on the idle capability without creating an autoscale receipt', async () => {
  const window = await openNodeIdleWatch(f.c.db, input);
  expect(window.context).toBeTruthy(); expect(window.afterOpen).toBeGreaterThanOrEqual(window.beforeOpen);
  snapshot = { ...snapshot, elapsedMs: 15_000 }; expect(await window.sample()).toMatchObject({ complete: false, elapsedMs: 15_000 });
  snapshot = { ...snapshot, elapsedMs: 60_000, complete: true, endCounter: '11', expected: 0 };
  expect(await window.finish()).toMatchObject({ complete: true, purpose: 'idle', serving: { requests: 0 } });
  await expect(window.finish()).rejects.toThrow(/closed/);
  expect(await f.c.db.select().from(nodeServingTrafficReceipts)).toEqual([]);
  expect(io.op.mock.calls.every(args => args[1] === 4 && ['agent.ping', 'proxy.idleWatch.open', 'proxy.idleWatch.sample', 'proxy.idleWatch.finish', 'proxy.idleWatch.close'].includes(args[2]))).toBe(true);
  expect(closes()).toHaveLength(1);
});
it('does not require autoscale spare capacity for a normal selected node deployment', async () => {
  await f.c.db.delete(nodeAutoscaleCapacity);
  const window = await openNodeIdleWatch(f.c.db, input); await window.close(); expect(closes()).toHaveLength(1);
});
it('refuses Swarm or changed serving placement without contacting an agent', async () => {
  await f.c.db.update(services).set({ orchestrator: 'swarm' });
  await expect(openNodeIdleWatch(f.c.db, input)).rejects.toThrow(/placement/); expect(io.op).not.toHaveBeenCalled();
});
it('closes a window on runtime ownership change during a poll', async () => {
  const window = await openNodeIdleWatch(f.c.db, input);
  io.op.mockImplementationOnce(async () => {
    await reserveServiceRuntimeOwner(f.c.db, 1, 'deploy', null, '2'.repeat(32));
    return frame({ kind: 'sample', items: [{ ok: true, snapshot }] });
  });
  await expect(window.sample()).rejects.toThrow(/context changed/); expect(closes()).toHaveLength(1);
});
it('refuses a serving-only agent, and refuses unsealed idle support', async () => {
  caps = ['proxy.servingTraffic']; await expect(openNodeIdleWatch(f.c.db, input)).rejects.toThrow(/opt-in/);
  caps = ['proxy.idleWatch']; io.sealed.mockResolvedValue(false);
  await expect(openNodeIdleWatch(f.c.db, input)).rejects.toThrow(/unencrypted/);
  expect(io.op.mock.calls.some(args => args[2] === 'proxy.idleWatch.open')).toBe(false);
});
it('cleans up idle cancellation without its cancelled signal', async () => {
  const abort = new AbortController(), window = await openNodeIdleWatch(f.c.db, input, { signal: abort.signal });
  abort.abort(); await window.close(); expect(closes()).toHaveLength(1); expect(closes()[0]![5]).toEqual({ timeoutMs: 2000 });
});
it.each(['purpose', 'source', 'foreign', 'short', 'missing'])('refuses %s evidence without an idle-zero fallback', async fault => {
  const window = await openNodeIdleWatch(f.c.db, input);
  if (fault === 'purpose') Object.assign(snapshot, { purpose: 'autoscale' });
  if (fault === 'source') snapshot.sourceId = '0'.repeat(64);
  if (fault === 'foreign') snapshot.windowId = '0'.repeat(32);
  if (fault === 'short') snapshot = { ...snapshot, elapsedMs: 59_999, complete: true, endCounter: '11', expected: 0 };
  if (fault === 'missing') io.op.mockResolvedValueOnce(frame({ kind: 'finish' }));
  await expect(window.finish()).rejects.toThrow(); expect(closes()).toHaveLength(1);
});
