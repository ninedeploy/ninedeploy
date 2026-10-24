import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openNodeProxyTraffic } from '../../src/lib/nodeProxyTrafficClient.js';
import { proxyTrafficTargetHash, proxyTrafficRoutingGeneration } from '../../src/lib/proxyTrafficCounter.js';
import { proxyTrafficOpen, type ProxyTrafficOpen, type ProxyTrafficSnapshot } from '@ninedeploy/schemas';
import { createFakeDb } from '../helpers.js';

const io = vi.hoisted(() => ({ op: vi.fn(), sealed: vi.fn(async () => true) }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.op, agentTransportSealed: io.sealed }));
const input: ProxyTrafficOpen = { requestId: '1'.repeat(32), nodeId: 2, serviceId: 3, deploymentId: 4, step: 1, slug: 'web', durationMs: 1000, routingConfig: 'http: {}',
  stable: [{ name: 'old', id: 'a'.repeat(64), port: 80 }], canary: [{ name: 'new', id: 'b'.repeat(64), port: 80 }] };
const empty = { requests: 0, errors: 0, errorRate: null, p95Ms: null };
let snapshot: ProxyTrafficSnapshot, service: Record<string, unknown>, deployment: Record<string, unknown>, caps: string[], version: string;
const frame = (value: unknown) => ({ exitCode: 0, lines: ['ND-PROXY-TRAFFIC ' + JSON.stringify(value)] });
const db = () => createFakeDb({ findFirst: { services: () => service, deployments: () => deployment } });
beforeEach(() => {
  io.op.mockReset(); io.sealed.mockReset().mockResolvedValue(true);
  service = { id: 3, type: 'docker', serverId: 2, slug: 'web', runtimeId: 'old', status: 'deploying', orchestrator: null };
  deployment = { id: 4, serviceId: 3, status: 'deploying', finishedAt: null }; caps = ['proxy.traffic']; version = '0.18.0';
  snapshot = { protocol: 1, basis: 'traefik-request-sequence', precisionMs: 1, windowId: 'c'.repeat(32), requestId: input.requestId,
    epoch: 'd'.repeat(32), sourceId: 'e'.repeat(64), proxyId: 'f'.repeat(64), targetHash: proxyTrafficTargetHash(proxyTrafficOpen.parse(input)),
    nodeId: 2, serviceId: 3, deploymentId: 4, step: 1, routingGeneration: proxyTrafficRoutingGeneration(input), elapsedMs: 0, startCounter: '10', endCounter: null, expected: null, observed: 0, complete: false,
    canary: empty, stable: empty };
  io.op.mockImplementation(async (_db, _node, op) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: ['ND-AGENT ' + JSON.stringify({ version, caps })] };
    if (op === 'proxy.traffic.open') return frame({ kind: 'open', snapshot });
    if (op === 'proxy.traffic.sample') return frame({ kind: 'sample', items: [{ ok: true, snapshot }] });
    if (op === 'proxy.traffic.finish') return frame({ kind: 'finish', snapshot });
    return frame({ kind: 'close', windowId: snapshot.windowId, closed: true });
  });
});

describe('bound node traffic receipts', () => {
  it.each([{ orchestrator: 'swarm' }, { serverId: null }, { serverId: 9 }, { status: 'stopped' }, { type: 'compose' }, { runtimeId: 'other' }])('refuses an ineligible or changed source before contacting the agent %j', async patch => {
    Object.assign(service, patch);
    await expect(openNodeProxyTraffic(db(), input)).rejects.toThrow(/ownership changed/);
    expect(io.op).not.toHaveBeenCalled();
  });
  it('uses only the recorded node, forwards cancellation and closes the known reservation', async () => {
    const controller = new AbortController(), window = await openNodeProxyTraffic(db(), input, { signal: controller.signal });
    expect(await window.sample()).toMatchObject({ complete: false, nodeId: 2 });
    snapshot = { ...snapshot, elapsedMs: 1000, endCounter: '11', expected: 0, complete: true };
    expect(await window.finish()).toMatchObject({ complete: true, observed: 0 });
    await window.close(); await window.close();
    expect(io.op.mock.calls.every(args => args[1] === 2)).toBe(true);
    const call = io.op.mock.calls.find(args => args[2] === 'proxy.traffic.open')!;
    expect(call[5]).toMatchObject({ timeoutMs: 20_000, signal: controller.signal });
    const closes = io.op.mock.calls.filter(args => args[2] === 'proxy.traffic.close');
    expect(closes).toHaveLength(1); expect(closes[0]![3]).toEqual({ windowId: 'c'.repeat(32) });
    expect(closes[0]![5]).toEqual({ timeoutMs: 2000 });
  });

  it.each([{ nodeId: 8 }, { serviceId: 8 }, { deploymentId: 8 }, { step: 2 }, { requestId: '2'.repeat(32) }, { targetHash: '0'.repeat(64) }, { routingGeneration: '0'.repeat(64) }])('refuses an open receipt from another context %j', async patch => {
    Object.assign(snapshot, patch);
    await expect(openNodeProxyTraffic(db(), input)).rejects.toThrow(/different observation/);
    expect(io.op.mock.calls.filter(args => args[2] === 'proxy.traffic.close')).toHaveLength(0);
  });

  it.each([{ sourceId: '0'.repeat(64) }, { proxyId: '0'.repeat(64) }, { epoch: '0'.repeat(32) }, { windowId: '0'.repeat(32) }, { startCounter: '9' }])('refuses a changed source and closes only its known reservation %j', async patch => {
    const window = await openNodeProxyTraffic(db(), input); snapshot = { ...snapshot, ...patch };
    await expect(window.sample()).rejects.toThrow(/coverage changed/);
    expect(io.op.mock.calls.find(args => args[2] === 'proxy.traffic.close')![3]).toEqual({ windowId: 'c'.repeat(32) });
  });

  it('refuses incomplete, short and internally inconsistent final receipts', async () => {
    const window = await openNodeProxyTraffic(db(), input);
    await expect(window.finish()).rejects.toThrow(/coverage changed/);
    snapshot = { ...snapshot, elapsedMs: 0, complete: false }; const next = await openNodeProxyTraffic(db(), input);
    snapshot = { ...snapshot, endCounter: '11', expected: 0, complete: true, elapsedMs: 999 };
    await expect(next.finish()).rejects.toThrow(/coverage changed/);
  });

  it('does not accept disappearing counts or a completed window during a poll', async () => {
    const window = await openNodeProxyTraffic(db(), input);
    snapshot = { ...snapshot, observed: 1, canary: { requests: 1, errors: 1, errorRate: 100, p95Ms: 5 } }; await window.sample();
    snapshot = { ...snapshot, observed: 0, canary: empty };
    await expect(window.sample()).rejects.toThrow(/coverage changed/);
    snapshot = { ...snapshot, complete: false }; const next = await openNodeProxyTraffic(db(), input);
    snapshot = { ...snapshot, endCounter: '11', expected: 0, complete: true, elapsedMs: 1000 };
    await expect(next.sample()).rejects.toThrow(/coverage changed/);
  });

  it('rechecks placement and deployment cancellation after an in-flight reply', async () => {
    const window = await openNodeProxyTraffic(db(), input);
    io.op.mockImplementationOnce(async () => { service.serverId = 8; return frame({ kind: 'sample', items: [{ ok: true, snapshot }] }); });
    await expect(window.sample()).rejects.toThrow(/ownership changed/);
    service.serverId = 2; deployment.status = 'cancelled';
    await expect(openNodeProxyTraffic(db(), input)).rejects.toThrow(/ownership changed/);
  });

  it('refuses older, owner-disabled and unsealed agents before reserving a window', async () => {
    caps = []; version = '0.17.1'; await expect(openNodeProxyTraffic(db(), input)).rejects.toThrow(/v0.18.0/);
    version = '0.18.0'; await expect(openNodeProxyTraffic(db(), input)).rejects.toThrow(/opt-in/);
    io.sealed.mockResolvedValue(false); await expect(openNodeProxyTraffic(db(), input)).rejects.toThrow(/unencrypted/);
    expect(io.op.mock.calls.some(args => args[2] === 'proxy.traffic.open')).toBe(false);
  });

  it('refuses unavailable, missing and duplicated receipts without empty fallback', async () => {
    const window = await openNodeProxyTraffic(db(), input);
    io.op.mockResolvedValueOnce(frame({ kind: 'sample', items: [{ ok: false, windowId: snapshot.windowId, reason: 'source unavailable' }] }));
    await expect(window.sample()).rejects.toThrow(/unavailable/);
    io.op.mockResolvedValueOnce({ exitCode: 0, lines: [] });
    await expect(openNodeProxyTraffic(db(), input)).rejects.toThrow(/cannot observe|unreachable/);
  });

  it.each([
    { exitCode: 1, lines: [] },
    { exitCode: 0, lines: ['ND-PROXY-TRAFFIC not-json'] },
    { exitCode: 0, lines: ['ND-PROXY-TRAFFIC {}', 'ND-PROXY-TRAFFIC {}'] },
    { exitCode: 0, lines: ['ND-PROXY-TRAFFIC ' + 'x'.repeat(65_537)] },
  ])('rejects unconfirmed RPC receipts and frees the known reservation: %j', async reply => {
    const window = await openNodeProxyTraffic(db(), input);
    io.op.mockResolvedValueOnce(reply);
    await expect(window.sample()).rejects.toThrow(/not confirmed/);
    expect(io.op.mock.calls.find(args => args[2] === 'proxy.traffic.close')![3]).toEqual({ windowId: snapshot.windowId });
  });

  it('rejects wrong operation phases and cannot reuse a closed client window', async () => {
    const window = await openNodeProxyTraffic(db(), input);
    io.op.mockResolvedValueOnce(frame({ kind: 'sample', snapshot }));
    await expect(window.finish()).rejects.toThrow(/not confirmed/);
    const calls = io.op.mock.calls.length;
    await expect(window.sample()).rejects.toThrow(/closed/);
    await expect(window.finish()).rejects.toThrow(/closed/);
    expect(io.op.mock.calls).toHaveLength(calls);
    const normal = io.op.getMockImplementation()!;
    io.op.mockImplementation(async (...args) => args[2] === 'proxy.traffic.open' ? frame({ kind: 'sample', snapshot }) : normal(...args));
    await expect(openNodeProxyTraffic(db(), input)).rejects.toThrow(/open receipt/);
  });

  it('does not reopen an already completed reservation', async () => {
    snapshot = { ...snapshot, endCounter: '11', expected: 0, complete: true, elapsedMs: 1000 };
    await expect(openNodeProxyTraffic(db(), input)).rejects.toThrow(/already completed/);
  });

  it('closes a verified reservation if the caller lease fails after opening, even if cleanup is unreachable', async () => {
    let calls = 0;
    const checkpoint = async () => { if (++calls === 2) throw Error('Deployment lease lost'); };
    const normal = io.op.getMockImplementation()!;
    io.op.mockImplementation(async (...args) => { if (args[2] === 'proxy.traffic.close') throw Error('Node unreachable'); return normal(...args); });
    await expect(openNodeProxyTraffic(db(), input, { checkpoint })).rejects.toThrow(/lease lost/);
    expect(io.op.mock.calls.filter(args => args[2] === 'proxy.traffic.close')).toHaveLength(1);
  });
});
