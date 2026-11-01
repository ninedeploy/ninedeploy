import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { type createDb, domains, nodeServingTrafficReceipts, services } from '@ninedeploy/db';
import { servingTrafficOpen, type ServingTrafficOpen, type ServingTrafficSnapshot } from '@ninedeploy/schemas';
import { renderDynamicConfig } from '../../src/engine/proxy.js';
import { nodeServingTrafficContext } from '../../src/lib/nodeServingTrafficContext.js';
import { consumeNodeServingTraffic } from '../../src/lib/nodeServingTrafficReceipt.js';
import { proxyTrafficRoutingGeneration, proxyTrafficTargetHash } from '../../src/lib/proxyTrafficCounter.js';
import { reserveServiceRuntimeOwner } from '../../src/lib/serviceRuntimeOwner.js';
import { servingReceiptFixture } from '../fixtures/servingTrafficReceipt.js';

let c: ReturnType<typeof createDb>, input: ServingTrafficOpen, context: string;
const openedAt = 100_000, receivedAt = 101_000;
const observation = () => ({ context, openedAt, receivedAt });
const rows = () => c.db.select().from(nodeServingTrafficReceipts);
function receipt(startCounter = '10', endCounter = '11', nonce = 1, patch: Partial<ServingTrafficSnapshot> = {}) {
  const params = servingTrafficOpen.parse({ ...input, requestId: nonce.toString(16).padStart(32, '0') });
  return { params, snapshot: { protocol: 1, purpose: 'autoscale', basis: 'traefik-request-sequence', precisionMs: 1,
    windowId: nonce.toString(16).padStart(32, '0'), requestId: params.requestId, epoch: 'd'.repeat(32), sourceId: 'e'.repeat(64), proxyId: 'f'.repeat(64),
    nodeId: 4, serviceId: 1, deploymentId: 9, targetHash: proxyTrafficTargetHash(params), routingGeneration: proxyTrafficRoutingGeneration(params),
    elapsedMs: 1000, startCounter, endCounter, observed: Number(BigInt(endCounter) - BigInt(startCounter) - 1n),
    expected: Number(BigInt(endCounter) - BigInt(startCounter) - 1n), complete: true,
    serving: { requests: 0, errors: 0, errorRate: null, p95Ms: null }, ...patch } as ServingTrafficSnapshot };
}
function consume(value: ReturnType<typeof receipt>, timing = observation(), now = receivedAt) {
  return consumeNodeServingTraffic(c.db, value.params, value.snapshot, timing, () => now);
}
beforeEach(async () => {
  ({ c, input, context } = await servingReceiptFixture('file::memory:'));
});
afterEach(() => c.client?.close());

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const worker = fileURLToPath(new URL('../fixtures/servingTrafficReceiptProcess.ts', import.meta.url));
it('persists completed zero across process restarts and consumes a concurrent replay only once', () => {
  const root = mkdtempSync(join(tmpdir(), 'nd-serving-process-'));
  const run = (mode: string) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', worker, mode, root], { cwd: serverRoot, encoding: 'utf8', timeout: 15_000 }));
  try {
    expect(run('seed')).toEqual({ persisted: 1 });
    expect(run('replay')).toEqual({ replayRefused: true, persisted: 1 });
    expect(run('concurrent')).toEqual({ accepted: 1, rejected: 1, persisted: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('computes RPS per actual serving replica from a completed interval', async () => {
  await c.db.update(services).set({ runtimeReplicas: 2 });
  input = servingTrafficOpen.parse({ ...input, routingConfig: await renderDynamicConfig(c.db, { serverId: 4 }),
    serving: [...input.serving, { name: 'web-9-r2', id: 'b'.repeat(64), port: 3000 }] });
  context = await nodeServingTrafficContext(c.db, input);
  const value = receipt('10', '16', 1, { serving: { requests: 5, errors: 0, errorRate: 0, p95Ms: 4 } });
  expect(await consume(value)).toMatchObject({ value: 2.5 });
  expect(await rows()).toMatchObject([{ requests: 5, elapsedMs: 1000, replicas: 2 }]);
});
it('refuses duplicate request IDs even with a new window and source', async () => {
  const first = receipt(); await consume(first);
  const next = receipt('20', '21', 2, { sourceId: '0'.repeat(64), requestId: first.params.requestId });
  next.params.requestId = first.params.requestId; next.snapshot.targetHash = proxyTrafficTargetHash(next.params);
  await expect(consume(next)).rejects.toThrow(/request or window/); expect(await rows()).toHaveLength(1);
});
it('refuses duplicate window IDs even with a new request and source', async () => {
  await consume(receipt());
  await expect(consume(receipt('20', '21', 2, { windowId: receipt().snapshot.windowId, sourceId: '0'.repeat(64) }))).rejects.toThrow(/request or window/);
  expect(await rows()).toHaveLength(1);
});
it.each([['10', '11'], ['9', '10'], ['5', '15']] as const)('refuses reused or superseded intervals %s..%s', async (start, end) => {
  await consume(receipt());
  await expect(consume(receipt(start, end, 2))).rejects.toThrow(/interval.*consumed|superseded/);
  expect(await rows()).toHaveLength(1);
});
it('accepts ordered non-overlapping windows with the same source', async () => {
  await consume(receipt('8', '9')); await consume(receipt('10', '11', 2));
  await expect(consume(receipt('9', '10', 3))).rejects.toThrow(/interval/);
  expect(await rows()).toHaveLength(2);
});
it('does not reset the source watermark when an agent epoch changes', async () => {
  await consume(receipt());
  await expect(consume(receipt('10', '11', 2, { epoch: '0'.repeat(32) }))).rejects.toThrow(/interval/);
});
it('permits a new proxy source but retains the old source watermark', async () => {
  await consume(receipt());
  await consume(receipt('1', '2', 2, { sourceId: '0'.repeat(64), proxyId: '1'.repeat(64) }));
  await expect(consume(receipt('10', '11', 3))).rejects.toThrow(/interval/);
  expect(await rows()).toHaveLength(2);
});
it('preserves uint64 precision above JavaScript safe integers and orders decimal boundaries correctly', async () => {
  await consume(receipt('18446744073709551610', '18446744073709551611'));
  await expect(consume(receipt('18446744073709551609', '18446744073709551610', 2))).rejects.toThrow(/interval/);
  await consume(receipt('18446744073709551612', '18446744073709551613', 3));
  expect((await rows()).map(row => row.endCounter).sort()).toEqual(['18446744073709551611', '18446744073709551613']);
});
it.each([
  { openedAt: 100_001, receivedAt }, { openedAt, receivedAt: 100_999 }, { openedAt: -1, receivedAt },
  { openedAt, receivedAt: 101_001 }, { openedAt, receivedAt: 100_999.5 },
])('rejects inconsistent, future or shortened panel timing: %j', async timing => {
  await expect(consume(receipt(), { context, ...timing })).rejects.toThrow(/stale, future|observation/);
  expect(await rows()).toHaveLength(0);
});
it('rejects stale completed windows without refreshing their receipt time', async () => {
  await expect(consume(receipt(), observation(), receivedAt + 90_001)).rejects.toThrow(/stale/);
  expect(await rows()).toHaveLength(0);
});
it('rechecks freshness before committing rather than extending a slow measurement', async () => {
  const value = receipt(); let calls = 0;
  await expect(consumeNodeServingTraffic(c.db, value.params, value.snapshot, observation(), () => ++calls === 1 ? receivedAt : receivedAt + 90_001)).rejects.toThrow(/stale/);
  expect(await rows()).toHaveLength(0);
});
it.each([{ complete: false, endCounter: null, expected: null }, { elapsedMs: 999 }, { requestId: '2'.repeat(32) },
  { targetHash: '0'.repeat(64) }, { routingGeneration: '0'.repeat(64) }, { nodeId: 5 }, { serviceId: 2 }, { deploymentId: 10 }])('rejects incomplete, short or unbound receipts: %j', async patch => {
  await expect(consume(receipt('10', '11', 1, patch))).rejects.toThrow(); expect(await rows()).toHaveLength(0);
});
it('refuses an observation whose runtime ownership changed before durable consumption', async () => {
  await reserveServiceRuntimeOwner(c.db, 1, 'deploy', null, '2'.repeat(32));
  await expect(consume(receipt())).rejects.toThrow(/context changed/); expect(await rows()).toHaveLength(0);
});
it('refuses changed routing before durable consumption', async () => {
  await c.db.update(domains).set({ hostname: 'changed.test' });
  await expect(consume(receipt())).rejects.toThrow(/context changed/); expect(await rows()).toHaveLength(0);
});
