import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDb, databaseAttachments, databases, deployments, domains, eq, nodeAutoscaleCapacity, nodeDeploymentPreparations, runMigrations, servers, services, serviceTargets } from '@ninedeploy/db';
import { servingTrafficOpen, type ServingTrafficOpen, type ServingTrafficSnapshot } from '@ninedeploy/schemas';
import { renderDynamicConfig } from '../../src/engine/proxy.js';
import { beginCanary, endCanary } from '../../src/engine/canaryState.js';
import { openNodeServingTraffic } from '../../src/lib/nodeServingTrafficClient.js';
import { proxyTrafficTargetHash, proxyTrafficRoutingGeneration } from '../../src/lib/proxyTrafficCounter.js';
import { reserveServiceRuntimeOwner } from '../../src/lib/serviceRuntimeOwner.js';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';

const io = vi.hoisted(() => ({ op: vi.fn(), sealed: vi.fn(async () => true) }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.op, agentTransportSealed: io.sealed }));
let c: ReturnType<typeof createDb>, input: ServingTrafficOpen, snapshot: ServingTrafficSnapshot;
let caps: string[], version: string;
const frame = (value: unknown) => ({ exitCode: 0, lines: [`ND-SERVING-TRAFFIC ${JSON.stringify(value)}`] });
const closedCalls = () => io.op.mock.calls.filter(args => args[2] === 'proxy.servingTraffic.close');
beforeEach(async () => {
  vi.clearAllMocks(); io.sealed.mockResolvedValue(true);
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values([{ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' }, { id: 5, name: 'Other', host: 'other.test', tokenEncrypted: 'fixture' }]);
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, status: 'running', runtimeId: 'web-9', port: 3000 });
  await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'running', finishedAt: new Date() });
  await c.db.insert(domains).values({ serviceId: 1, hostname: 'web.test', status: 'active' });
  await c.db.insert(nodeAutoscaleCapacity).values({ deploymentId: 9, serviceId: 1, serverId: 4, runtimeId: 'web-9', imageId: `sha256:${'f'.repeat(64)}`,
    targets: [{ name: 'web-9', id: 'a'.repeat(64) }, { name: 'web-9-r2', id: 'b'.repeat(64) }] });
  input = servingTrafficOpen.parse({ purpose: 'autoscale', requestId: '1'.repeat(32), nodeId: 4, serviceId: 1, deploymentId: 9, slug: 'web', durationMs: 1000,
    routingConfig: await renderDynamicConfig(c.db, { serverId: 4 }), serving: [{ name: 'web-9', id: 'a'.repeat(64), port: 3000 }] });
  snapshot = { protocol: 1, purpose: 'autoscale', basis: 'traefik-request-sequence', precisionMs: 1, windowId: 'c'.repeat(32), requestId: input.requestId,
    epoch: 'd'.repeat(32), sourceId: 'e'.repeat(64), proxyId: 'f'.repeat(64), targetHash: proxyTrafficTargetHash(input), nodeId: 4, serviceId: 1, deploymentId: 9,
    routingGeneration: proxyTrafficRoutingGeneration(input), elapsedMs: 0, startCounter: '10', endCounter: null, expected: null, observed: 0, complete: false,
    serving: { requests: 0, errors: 0, errorRate: null, p95Ms: null } };
  caps = ['proxy.servingTraffic']; version = '0.19.0';
  io.op.mockImplementation(async (_db, _node, op) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version, caps })}`] };
    if (op === 'proxy.servingTraffic.open') return frame({ kind: 'open', snapshot });
    if (op === 'proxy.servingTraffic.sample') return frame({ kind: 'sample', items: [{ ok: true, snapshot }] });
    if (op === 'proxy.servingTraffic.finish') return frame({ kind: 'finish', snapshot });
    return frame({ kind: 'close', windowId: snapshot.windowId, closed: true });
  });
});
afterEach(() => { endCanary(1); vi.restoreAllMocks(); c.client?.close(); });

it('observes the selected running deployment and delivers a completed zero exactly once', async () => {
  const window = await openNodeServingTraffic(c.db, input);
  expect(await window.sample()).toMatchObject({ complete: false, serving: { requests: 0 } });
  snapshot = { ...snapshot, elapsedMs: 1000, endCounter: '11', expected: 0, complete: true };
  expect(await window.finish()).toMatchObject({ complete: true, observed: 0, elapsedMs: 1000 });
  await expect(window.finish()).rejects.toThrow('window closed');
  await window.close(); expect(closedCalls()).toHaveLength(1);
  expect(io.op.mock.calls.every(args => args[1] === 4)).toBe(true);
});
it.each([{ serverId: 5 }, { runtimeId: 'web-10' }, { status: 'deploying' }, { status: 'stopped' }, { orchestrator: 'swarm' }, { type: 'compose' },
  { runtimeReplicas: 2 }, { port: 4000 }, { asleepAt: new Date() }])('refuses ineligible running context before agent contact: %j', async patch => {
  await c.db.update(services).set(patch as Partial<typeof services.$inferInsert>);
  await expect(openNodeServingTraffic(c.db, input)).rejects.toThrow(/placement|capacity/);
  expect(io.op).not.toHaveBeenCalled();
});
it.each(['queued', 'building', 'deploying'] as const)('does not observe across %s deployment work', async status => {
  await c.db.insert(deployments).values({ serviceId: 1, status });
  await expect(openNodeServingTraffic(c.db, input)).rejects.toThrow(/active runtime work/);
  expect(io.op).not.toHaveBeenCalled();
});
it('rejects prepared replacement work and multi-node traffic', async () => {
  await c.db.insert(nodeDeploymentPreparations).values({ deploymentId: 9, serviceId: 1, serverId: 4, epoch: 1, requestId: '2'.repeat(32), runtimeId: 'web-9',
    imageId: `sha256:${'f'.repeat(64)}`, serving: 1, capacity: 2 });
  await expect(openNodeServingTraffic(c.db, input)).rejects.toThrow(/active runtime work/);
  await c.db.delete(nodeDeploymentPreparations);
  await c.db.insert(serviceTargets).values({ serviceId: 1, serverId: 5, runtimeId: 'web-t5-9' });
  await expect(openNodeServingTraffic(c.db, input)).rejects.toThrow(/fanout/);
  expect(io.op).not.toHaveBeenCalled();
});
it('rejects pending lifecycle work and active canary ownership', async () => {
  beginCanary(1, 'web', 10, 2, false, false, { serverId: 4, stableRuntimeId: 'web-9' });
  await expect(openNodeServingTraffic(c.db, input)).rejects.toThrow(/active runtime work/);
  endCanary(1);
  await acceptNodeLifecycleIntent(c.db, (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!, 'stop');
  await expect(openNodeServingTraffic(c.db, input)).rejects.toThrow();
  expect(io.op).not.toHaveBeenCalled();
});
it.each(['owner', 'target', 'route', 'database', 'config'] as const)('closes and refuses a %s change during the RPC', async change => {
  const window = await openNodeServingTraffic(c.db, input);
  io.op.mockImplementationOnce(async () => {
    if (change === 'owner') await reserveServiceRuntimeOwner(c.db, 1, 'deploy', null, '2'.repeat(32));
    if (change === 'target') await c.db.update(nodeAutoscaleCapacity).set({ targets: [{ name: 'web-9', id: 'b'.repeat(64) }] });
    if (change === 'route') await c.db.update(domains).set({ hostname: 'changed.test' });
    if (change === 'database') await c.db.update(nodeAutoscaleCapacity).set({ databaseNetworks: ['new-network'] });
    if (change === 'config') await c.db.update(services).set({ cpuLimitMilli: 500 });
    return frame({ kind: 'sample', items: [{ ok: true, snapshot }] });
  });
  await expect(window.sample()).rejects.toThrow(/changed/);
  expect(closedCalls()).toHaveLength(1);
});
it('closes an idle window immediately when cancelled, without forwarding its cancelled signal to cleanup', async () => {
  const controller = new AbortController();
  const window = await openNodeServingTraffic(c.db, input, { signal: controller.signal });
  controller.abort(); await window.close();
  expect(closedCalls()).toHaveLength(1);
  expect(closedCalls()[0]![5]).toEqual({ timeoutMs: 2000 });
  await expect(window.sample()).rejects.toThrow('window closed');
});
it('cleans up a bound opening reply received after cancellation', async () => {
  const controller = new AbortController(), original = io.op.getMockImplementation()!;
  io.op.mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[2] === 'proxy.servingTraffic.open') controller.abort();
    return result;
  });
  await expect(openNodeServingTraffic(c.db, input, { signal: controller.signal })).rejects.toThrow();
  expect(closedCalls()).toHaveLength(1);
});
it('closes a reservation if the controller checkpoint fails after opening', async () => {
  const checkpoint = async () => {
    if (io.op.mock.calls.some(args => args[2] === 'proxy.servingTraffic.open')) throw new Error('controller ownership lost');
  };
  await expect(openNodeServingTraffic(c.db, input, { checkpoint })).rejects.toThrow('controller ownership lost');
  expect(closedCalls()).toHaveLength(1);
});
it('does not contact the agent for an already cancelled request', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(openNodeServingTraffic(c.db, input, { signal: controller.signal })).rejects.toThrow();
  expect(io.op).not.toHaveBeenCalled();
});
it('refuses old, opted-out or unsealed agents without opening a window', async () => {
  caps = []; version = '0.18.16'; await expect(openNodeServingTraffic(c.db, input)).rejects.toThrow(/0.19.0/);
  version = '0.19.0'; await expect(openNodeServingTraffic(c.db, input)).rejects.toThrow(/opt-in/);
  io.sealed.mockResolvedValue(false); await expect(openNodeServingTraffic(c.db, input)).rejects.toThrow(/unencrypted/);
  expect(io.op.mock.calls.some(args => args[2] === 'proxy.servingTraffic.open')).toBe(false);
});
it.each([{ nodeId: 5 }, { serviceId: 2 }, { deploymentId: 10 }, { requestId: '2'.repeat(32) }, { targetHash: '0'.repeat(64) }, { routingGeneration: '0'.repeat(64) }])('never closes an unbound foreign reservation: %j', async patch => {
  Object.assign(snapshot, patch);
  await expect(openNodeServingTraffic(c.db, input)).rejects.toThrow(/different observation/);
  expect(closedCalls()).toHaveLength(0);
});
it.each([{ windowId: '0'.repeat(32) }, { sourceId: '0'.repeat(64) }, { proxyId: '0'.repeat(64) }, { epoch: '0'.repeat(32) }, { startCounter: '9' }])('refuses source continuity loss: %j', async patch => {
  const window = await openNodeServingTraffic(c.db, input); snapshot = { ...snapshot, ...patch };
  await expect(window.sample()).rejects.toThrow(/coverage changed/);
  expect(closedCalls()[0]![3]).toEqual({ windowId: 'c'.repeat(32) });
});
it('does not expose mutable continuity state through returned receipts', async () => {
  const window = await openNodeServingTraffic(c.db, input);
  window.receipt.sourceId = '0'.repeat(64);
  const sample = await window.sample(); sample.serving.requests = 100;
  expect(await window.sample()).toMatchObject({ sourceId: 'e'.repeat(64), serving: { requests: 0 } });
  await window.close();
});
it('accepts matching database bridges but refuses changed database placement during observation', async () => {
  await c.db.insert(databases).values({ id: 1, name: 'Database', slug: 'pg', engine: 'postgres', serverId: 4, status: 'running', passwordEncrypted: 'fixture' });
  await c.db.insert(databaseAttachments).values({ id: 1, serviceId: 1, databaseId: 1, envAlias: 'DATABASE_URL' });
  await c.db.update(nodeAutoscaleCapacity).set({ databaseNetworks: ['1:1:nd-dbnet-pg'] });
  const window = await openNodeServingTraffic(c.db, input);
  expect(await window.sample()).toMatchObject({ complete: false });
  await c.db.update(databases).set({ serverId: 5 });
  await expect(window.finish()).rejects.toThrow(/capacity changed/);
  expect(closedCalls()).toHaveLength(1);
});
it('requires a complete immutable capacity receipt, including idle spares', async () => {
  await c.db.update(nodeAutoscaleCapacity).set({ targets: [{ name: 'web-9', id: 'a'.repeat(64) }, { name: 'web-9-r2', id: 'a'.repeat(64) }] });
  await expect(openNodeServingTraffic(c.db, input)).rejects.toThrow(/capacity changed/);
  await c.db.delete(nodeAutoscaleCapacity);
  await expect(openNodeServingTraffic(c.db, input)).rejects.toThrow(/capacity changed/);
  expect(io.op).not.toHaveBeenCalled();
});
it('rejects missing coverage, partial receipts and too short final intervals', async () => {
  const window = await openNodeServingTraffic(c.db, input);
  await expect(window.finish()).rejects.toThrow(/coverage changed/);
  const next = await openNodeServingTraffic(c.db, input);
  snapshot = { ...snapshot, elapsedMs: 999, complete: true, endCounter: '11', expected: 0 };
  await expect(next.finish()).rejects.toThrow(/coverage changed/);
});
it('cleans up rejected completed opening receipts', async () => {
  snapshot = { ...snapshot, elapsedMs: 1000, complete: true, endCounter: '11', expected: 0 };
  await expect(openNodeServingTraffic(c.db, input)).rejects.toThrow(/already completed/);
  expect(closedCalls()).toHaveLength(1);
});
it('rechecks ownership after capability preflight and before opening a reservation', async () => {
  const original = io.op.getMockImplementation()!;
  io.op.mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[2] === 'agent.ping') await reserveServiceRuntimeOwner(c.db, 1, 'deploy', null, '2'.repeat(32));
    return result;
  });
  await expect(openNodeServingTraffic(c.db, input)).rejects.toThrow(/context changed/);
  expect(io.op.mock.calls.some(args => args[2] === 'proxy.servingTraffic.open')).toBe(false);
});
it('rejects overlapping polls and never returns an in-flight result after explicit close', async () => {
  const window = await openNodeServingTraffic(c.db, input);
  const entered = Promise.withResolvers<void>(), reply = Promise.withResolvers<ReturnType<typeof frame>>();
  io.op.mockImplementationOnce(() => { entered.resolve(); return reply.promise; });
  const sample = window.sample(); await entered.promise;
  await expect(window.finish()).rejects.toThrow(/already in progress/);
  await window.close(); reply.resolve(frame({ kind: 'sample', items: [{ ok: true, snapshot }] }));
  await expect(sample).rejects.toThrow(/window closed/);
  expect(closedCalls()).toHaveLength(1);
});
it('rejects a queued deployment received during finalization, even for a valid completed receipt', async () => {
  const window = await openNodeServingTraffic(c.db, input);
  snapshot = { ...snapshot, elapsedMs: 1000, complete: true, endCounter: '11', expected: 0 };
  io.op.mockImplementationOnce(async () => {
    await c.db.insert(deployments).values({ serviceId: 1, status: 'queued' });
    return frame({ kind: 'finish', snapshot });
  });
  await expect(window.finish()).rejects.toThrow(/active runtime work/);
  expect(closedCalls()).toHaveLength(1);
});
it('refuses disappearing request counts and error counts instead of reporting zero', async () => {
  const window = await openNodeServingTraffic(c.db, input);
  snapshot = { ...snapshot, observed: 1, serving: { requests: 1, errors: 1, errorRate: 100, p95Ms: 4 } };
  await window.sample();
  snapshot = { ...snapshot, observed: 0, serving: { requests: 0, errors: 0, errorRate: null, p95Ms: null } };
  await expect(window.sample()).rejects.toThrow(/coverage changed/); expect(closedCalls()).toHaveLength(1);
});
it.each([
  { exitCode: 1, lines: [] }, { exitCode: 0, lines: [] }, { exitCode: 0, lines: ['ND-SERVING-TRAFFIC {'] },
  { exitCode: 0, lines: ['ND-SERVING-TRAFFIC {}', 'ND-SERVING-TRAFFIC {}'] },
  { exitCode: 0, lines: [`ND-SERVING-TRAFFIC ${'é'.repeat(33 * 1024)}`] },
  frame({ kind: 'finish' }),
  frame({ kind: 'sample', items: [{ ok: false, reason: 'logs missing' }] }),
])('fails closed on unavailable or malformed sample replies: %j', async reply => {
  const window = await openNodeServingTraffic(c.db, input); io.op.mockResolvedValueOnce(reply);
  await expect(window.sample()).rejects.toThrow(); expect(closedCalls()).toHaveLength(1);
});
