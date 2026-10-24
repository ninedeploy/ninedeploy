import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployments, domains, primaryTransitions, servers, services, eq } from '@ninedeploy/db';
import { proxyTrafficOpen, type ProxyTrafficOpen, type ProxyTrafficSnapshot } from '@ninedeploy/schemas';
import { observabilityDb } from '../fixtures/observability.js';
import { primaryCanaryTraffic } from '../../src/engine/primaryCanaryTraffic.js';
import { beginPrimaryTransition, type PrimaryRecoveryLease } from '../../src/engine/primaryRecovery.js';
import { beginCanary, canaryOwnedBy, endCanary, resetCanaryState, setCanaryStep } from '../../src/engine/canaryState.js';
import { runCanary } from '../../src/engine/canary.js';
import { proxyTrafficRoutingGeneration, proxyTrafficTargetHash } from '../../src/lib/proxyTrafficCounter.js';
import { ProxyRoutingUnconfirmed } from '../../src/lib/proxyRoutingAck.js';

const io = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn(), write: vi.fn(), local: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.agent, agentTransportSealed: io.sealed }));
vi.mock('../../src/lib/localCanaryTraffic.js', () => ({ openLocalCanaryTraffic: io.local }));
vi.mock('../../src/engine/proxy.js', async original => ({ ...await original<typeof import('../../src/engine/proxy.js')>(), writeDynamicConfig: io.write }));

let connection: Awaited<ReturnType<typeof observabilityDb>>, lease: PrimaryRecoveryLease | undefined;
let now: number, opened: ProxyTrafficOpen[], snapshot: ProxyTrafficSnapshot, caps: string[], requestErrors: number;
const source = { id: 1, slug: 'web', runtimeId: 'web-old', serverId: 2, orchestrator: null };
const runtime = { runtimeId: 'web-new', port: 3000, healthPath: '/ready?db=1', healthCheck: 'http-strict' as const, replicas: 1 };
const stats = (errors = 0) => ({ requests: 30, errors, errorRate: Math.round(errors / 30 * 100), p95Ms: 5 });
const frame = (body: unknown) => ({ exitCode: 0, lines: [`ND-PROXY-TRAFFIC ${JSON.stringify(body)}`] });
const checkpoint = async () => {
  await lease!.check();
  const dep = await connection.db.query.deployments.findFirst({ where: eq(deployments.id, 4) });
  if (dep?.status === 'cancelled') throw new Error('Deployment cancelled');
};
beforeEach(async () => {
  vi.resetAllMocks(); resetCanaryState(); now = 0; opened = []; requestErrors = 0;
  caps = ['docker.recovery', 'docker.probe', 'proxy.routingAck', 'proxy.traffic']; io.sealed.mockResolvedValue(true); io.write.mockResolvedValue(undefined);
  connection = await observabilityDb();
  await connection.db.insert(servers).values({ id: 2, name: 'Node', host: 'node.test', port: 4600, tokenEncrypted: 'fixture' });
  await connection.db.update(services).set({ runtimeId: 'web-old', serverId: 2, port: 3000, healthCheck: 'http-strict', healthPath: '/ready?db=1' }).where(eq(services.id, 1));
  await connection.db.insert(deployments).values({ id: 4, serviceId: 1, status: 'deploying' });
  await connection.db.insert(domains).values({ serviceId: 1, hostname: 'app.example.test', path: '/', status: 'active', ssl: false });
  io.agent.mockImplementation(async (_db, _node, op, args) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.18.0', caps })}`] };
    if (op === 'docker.identity') {
      const which = args.name === 'web-old' || args.name === 'a'.repeat(64) ? 'old' : args.name === 'web-new' || args.name === 'b'.repeat(64) ? 'new' : null;
      return { exitCode: 0, lines: [`ND-CONTAINER ${JSON.stringify(which ? { id: (which === 'old' ? 'a' : 'b').repeat(64), name: `web-${which}`, managed: 'service', serviceId: '1', deploymentId: which === 'old' ? '3' : '4' } : null)}`] };
    }
    if (op === 'proxy.traffic.open') {
      const input = proxyTrafficOpen.parse(args); opened.push(input);
      snapshot = { protocol: 1, basis: 'traefik-request-sequence', precisionMs: 1, windowId: opened.length.toString(16).padStart(32, '0'), requestId: input.requestId,
        epoch: 'd'.repeat(32), sourceId: 'e'.repeat(64), proxyId: 'f'.repeat(64), targetHash: proxyTrafficTargetHash(input), routingGeneration: proxyTrafficRoutingGeneration(input),
        nodeId: 2, serviceId: 1, deploymentId: 4, step: input.step, elapsedMs: 0, startCounter: '10', endCounter: null, expected: null, observed: 0, complete: false,
        canary: { requests: 0, errors: 0, errorRate: null, p95Ms: null }, stable: { requests: 0, errors: 0, errorRate: null, p95Ms: null } };
      return frame({ kind: 'open', snapshot });
    }
    if (op === 'proxy.traffic.sample' || op === 'proxy.traffic.finish') {
      snapshot = { ...snapshot, elapsedMs: now, observed: 60, canary: stats(requestErrors), stable: stats(),
        ...(op === 'proxy.traffic.finish' ? { complete: true, endCounter: '71', expected: 60 } : {}) };
      return op === 'proxy.traffic.finish' ? frame({ kind: 'finish', snapshot }) : frame({ kind: 'sample', items: [{ ok: true, snapshot }] });
    }
    if (op === 'proxy.traffic.close') return frame({ kind: 'close', windowId: args.windowId, closed: true });
    throw new Error(`Unexpected external operation: ${op}`);
  });
  const svc = await connection.db.query.services.findFirst({ where: eq(services.id, 1) });
  lease = await beginPrimaryTransition(connection.db, svc!, 4, runtime, { ...runtime, runtimeId: 'web-old' }, null);
});
afterEach(async () => { await lease?.release(); lease = undefined; connection?.close(); resetCanaryState(); });

async function stage(overrides: Partial<Parameters<typeof runCanary>[0]> = {}) {
  let owner: symbol | undefined;
  const owned = async () => { await checkpoint(); if (owner && !canaryOwnedBy(1, 4, owner)) throw new ProxyRoutingUnconfirmed('Canary ownership changed'); };
  const traffic = await primaryCanaryTraffic(connection.db, source, 4, lease, owned);
  return runCanary({ ...traffic, serviceId: 1, slug: 'web', deploymentId: 4, serverId: 2, stableRuntimeId: 'web-old', runtime,
    onOwner: value => { owner = value; }, config: { steps: [50], stepSeconds: 30, maxErrorRate: 5, maxP95Ms: null, minRequests: 20 },
    checkpoint: owned, log: () => undefined, probe: async () => true, now: () => now, sleep: async ms => { now += ms; }, ...overrides });
}

describe('primary canary worker traffic binding', () => {
  it('runs the engine with real primary recovery, scoped rendering and sealed node receipts', async () => {
    await expect(stage()).resolves.toBe('completed');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ nodeId: 2, serviceId: 1, deploymentId: 4, step: 1, durationMs: 30_000,
      stable: [{ name: 'web-old', id: 'a'.repeat(64), port: 3000 }], canary: [{ name: 'web-new', id: 'b'.repeat(64), port: 3000 }] });
    expect(opened[0]!.routingConfig).toContain('web-old:3000'); expect(opened[0]!.routingConfig).toContain('web-new:3000');
    expect(opened[0]!.routingConfig).toContain('/ready?db=1');
    expect(io.write).toHaveBeenCalledWith(connection.db, { requireNode: 2, confirmNodeRouting: true });
    expect((await connection.db.select().from(primaryTransitions))[0]).toMatchObject({ phase: 'routing', desiredRuntimeId: 'web-old' });
    expect(io.local).not.toHaveBeenCalled();
  });
  it('rejects measured 5xx and confirms rollback on the same node before reporting failure', async () => {
    requestErrors = 30; await expect(stage()).rejects.toThrow(/requests failed/);
    expect(io.write).toHaveBeenCalledTimes(2);
    expect(io.write.mock.calls.every(call => call[1].requireNode === 2 && call[1].confirmNodeRouting === true)).toBe(true);
    expect(io.agent.mock.calls.filter(call => call[2] === 'proxy.traffic.close')).toHaveLength(1);
    expect(io.local).not.toHaveBeenCalled();
  });
  it('does not open measurement before the required routing acknowledgement succeeds', async () => {
    io.write.mockRejectedValue(new ProxyRoutingUnconfirmed());
    await expect(stage()).rejects.toBeInstanceOf(ProxyRoutingUnconfirmed);
    expect(opened).toEqual([]); expect(io.local).not.toHaveBeenCalled();
  });
  it.each(['proxy.traffic', 'proxy.routingAck'])('refuses an owner-disabled capability before touching routing: %s', async cap => {
    caps = caps.filter(value => value !== cap);
    await expect(stage()).rejects.toThrow(/Node proxy traffic unavailable/);
    expect(io.write).not.toHaveBeenCalled(); expect(opened).toEqual([]); expect(io.local).not.toHaveBeenCalled();
  });
  it('refuses unsealed transport without probing or writing routing', async () => {
    io.agent.mockClear(); io.sealed.mockResolvedValue(false);
    await expect(stage()).rejects.toThrow(/unencrypted/);
    expect(io.agent).not.toHaveBeenCalled(); expect(io.write).not.toHaveBeenCalled();
  });
  it.each(['previous-id', 'candidate-id', 'unobserved', 'different-node', 'different-deployment', 'different-service', 'native', 'missing-port', 'replica-count'])('refuses an incomplete or unrelated primary journal: %s', async changed => {
    if (changed === 'previous-id') lease!.row.previous!.containers[0]!.id = null;
    if (changed === 'candidate-id') lease!.row.candidate.containers[0]!.id = null;
    if (changed === 'unobserved') lease!.row.candidate.containers[0]!.observed = false;
    if (changed === 'different-node') lease!.row.serverId = 9;
    if (changed === 'different-deployment') lease!.row.deploymentId = 9;
    if (changed === 'different-service') lease!.row.serviceId = 9;
    if (changed === 'native') lease!.row.previous!.native = 'native';
    if (changed === 'missing-port') lease!.row.candidate.port = null;
    if (changed === 'replica-count') lease!.row.candidate.replicas = 2;
    await expect(stage()).rejects.toThrow(/identities were not confirmed/);
    expect(io.write).not.toHaveBeenCalled(); expect(opened).toEqual([]);
  });
  it('refuses node mode without a durable transition', async () => {
    await expect(primaryCanaryTraffic(connection.db, source, 4, undefined, async () => undefined)).rejects.toThrow(/identities were not confirmed/);
    expect(io.write).not.toHaveBeenCalled();
  });
  it('rechecks cancellation during observation and closes the reservation before rollback', async () => {
    let cancelled = false;
    await expect(stage({ sleep: async ms => {
      now += ms;
      if (!cancelled) { cancelled = true; await connection.db.update(deployments).set({ status: 'cancelled' }).where(eq(deployments.id, 4)); }
    } })).rejects.toThrow('Deployment cancelled');
    expect(io.agent.mock.calls.filter(call => call[2] === 'proxy.traffic.close')).toHaveLength(1);
    expect(io.write).toHaveBeenCalledTimes(2); expect(io.local).not.toHaveBeenCalled();
  });
  it('refuses a saved step after the canary incarnation is replaced, without closing its successor', async () => {
    const traffic = await primaryCanaryTraffic(connection.db, source, 4, lease, checkpoint);
    const owner = beginCanary(1, 'web', 4, 1, true, true, { serverId: 2, stableRuntimeId: 'web-old' });
    setCanaryStep(1, 1, { ...runtime, weight: 50 }, 0, 30_000);
    const window = await traffic.openTraffic!({ deploymentId: 4, serverId: 2, stableRuntimeId: 'web-old', step: 1, weight: 50, durationMs: 30_000 });
    endCanary(1, 4, owner); beginCanary(1, 'web', 5, 1, true, true, { serverId: 2, stableRuntimeId: 'web-old' });
    await expect(window.sample()).rejects.toThrow(/step or placement changed/);
    expect(io.agent.mock.calls.filter(call => call[2] === 'proxy.traffic.close')).toHaveLength(1);
    expect(canaryOwnedBy(1, 5)).toBe(true);
  });
  it('keeps ordinary panel measurement on the local observer', async () => {
    const traffic = await primaryCanaryTraffic(connection.db, { ...source, serverId: null }, 4, undefined, async () => undefined);
    await traffic.openTraffic!({ deploymentId: 4, serverId: null, stableRuntimeId: 'web-old', step: 1, weight: 50, durationMs: 30_000 });
    expect(io.local).toHaveBeenCalledWith(connection.db, { ...source, serverId: null }, 90_000);
    await traffic.writeConfig(); expect(io.write).toHaveBeenCalledWith(connection.db, { confirmServiceId: 1 });
    expect(opened).toEqual([]);
  });
  it('does not substitute stopped spare capacity for a serving replica', async () => {
    lease!.row.previous!.spares![0] = { name: 'web-old-r2', id: 'c'.repeat(64), observed: true };
    lease!.row.candidate.spares![0] = { name: 'web-new-r2', id: 'd'.repeat(64), observed: true };
    await expect(stage()).resolves.toBe('completed');
    expect(opened[0]!.stable).toHaveLength(1); expect(opened[0]!.canary).toHaveLength(1);
  });
  it('rejects a changed immutable identity during polling and closes its reservation', async () => {
    await expect(stage({ sleep: async ms => { now += ms; lease!.row.candidate.containers[0]!.id = 'c'.repeat(64); } })).rejects.toThrow(/identities were not confirmed/);
    expect(io.agent.mock.calls.filter(call => call[2] === 'proxy.traffic.close')).toHaveLength(1);
    expect(io.local).not.toHaveBeenCalled();
  });
  it('retains the journal when the worker lease is replaced during a step', async () => {
    await expect(stage({ sleep: async ms => {
      now += ms; await connection.db.update(primaryTransitions).set({ ownerToken: 'another-worker' }).where(eq(primaryTransitions.serviceId, 1));
    } })).rejects.toBeInstanceOf(ProxyRoutingUnconfirmed);
    expect(io.agent.mock.calls.filter(call => call[2] === 'proxy.traffic.close')).toHaveLength(1);
    expect(io.write).toHaveBeenCalledTimes(1);
    expect((await connection.db.select().from(primaryTransitions))[0]?.ownerToken).toBe('another-worker');
  });
});
