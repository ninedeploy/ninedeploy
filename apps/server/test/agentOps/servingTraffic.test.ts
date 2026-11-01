import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_OPS, advertisedCapabilities, runRegisteredOp } from '../../src/agentOps/index.js';
import { servingTrafficSnapshot } from '@ninedeploy/schemas';

const engine = vi.hoisted(() => ({ sequence: 0, lines: new Set<(line: string) => void>() }));
vi.mock('../../src/lib/nodeProxyTrafficDocker.js', () => ({ nodeProxyTrafficDocker: () => ({
  inspect: async () => ({ proxyId: 'f'.repeat(64), sourceId: 'e'.repeat(64) }),
  connect: (_id: string, line: (value: string) => void) => { engine.lines.add(line); return { ready: Promise.resolve(), close: () => engine.lines.delete(line) }; },
  heartbeat: async (_id: string, path: string) => {
    for (const line of engine.lines) line(`127.0.0.1 - - [01/Nov/2026:12:00:00 +0000] "GET ${path} HTTP/1.1" 404 0 "-" "-" ${++engine.sequence} "-" "-" 0ms`);
  },
}) }));
const input = { purpose: 'autoscale', requestId: '1'.repeat(32), nodeId: 2, serviceId: 3, deploymentId: 4, slug: 'web', durationMs: 1000, routingConfig: 'http: {}',
  serving: [{ name: 'web-4', id: 'a'.repeat(64), port: 80 }] };
const windows: string[] = [];
const call = async (action: string, args: Record<string, unknown>) => {
  const lines: string[] = [];
  expect(await runRegisteredOp(`proxy.servingTraffic.${action}`, args, line => lines.push(line), { sealed: true })).toBe(0);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^ND-SERVING-TRAFFIC /);
  return JSON.parse(lines[0]!.slice('ND-SERVING-TRAFFIC '.length));
};
beforeEach(() => { engine.sequence = 0; vi.useFakeTimers(); vi.stubEnv('NINEDEPLOY_AGENT_PROXY_TRAFFIC', 'on'); });
afterEach(async () => {
  vi.stubEnv('NINEDEPLOY_AGENT_PROXY_TRAFFIC', 'on');
  for (const windowId of windows.splice(0)) await call('close', { windowId });
  expect(engine.lines.size).toBe(0);
  vi.unstubAllEnvs(); vi.useRealTimers();
});

describe('sealed ordinary serving-traffic observations', () => {
  it('registers a separate sealed capability for all four operations', () => {
    for (const action of ['open', 'sample', 'finish', 'close']) expect(AGENT_OPS.get(`proxy.servingTraffic.${action}`)).toMatchObject({ cap: 'proxy.servingTraffic', sealedOnly: true });
  });

  it('requires the node owner to opt in and respects disable', () => {
    expect(advertisedCapabilities({})).not.toContain('proxy.servingTraffic');
    expect(advertisedCapabilities({ NINEDEPLOY_AGENT_PROXY_TRAFFIC: 'on' })).toContain('proxy.servingTraffic');
    expect(advertisedCapabilities({ NINEDEPLOY_AGENT_PROXY_TRAFFIC: 'off' })).not.toContain('proxy.servingTraffic');
  });

  it('refuses plaintext before parsing observation operands', async () => {
    await expect(runRegisteredOp('proxy.servingTraffic.open', {}, () => {}, { sealed: false })).rejects.toThrow(/sealed/);
  });

  it('observes a running generation without a canary and excludes other services', async () => {
    const opened = await call('open', input), windowId = opened.snapshot.windowId;
    windows.push(windowId);
    expect(servingTrafficSnapshot.parse(opened.snapshot)).toMatchObject({ purpose: 'autoscale', complete: false, serving: { requests: 0 } });
    for (const router of ['web_1@file', 'other_1@file']) for (const line of engine.lines) {
      line(`127.0.0.1 - - [01/Nov/2026:12:00:00 +0000] "GET /private?token=secret HTTP/1.1" 200 1 "-" "-" ${++engine.sequence} "${router}" "http://web-4:80" 2ms`);
    }
    expect(await call('sample', { windowIds: [windowId] })).toMatchObject({ items: [{ ok: true, snapshot: { serving: { requests: 1 }, observed: 2 } }] });
    await vi.advanceTimersByTimeAsync(1000);
    const receipt = await call('finish', { windowId });
    expect(receipt).toMatchObject({ kind: 'finish', snapshot: { complete: true, expected: 2, observed: 2, serving: { requests: 1 } } });
    expect(receipt.snapshot).not.toHaveProperty('step');
    expect(receipt.snapshot).not.toHaveProperty('canary');
    expect(receipt.snapshot).not.toHaveProperty('stable');
    expect(JSON.stringify(receipt)).not.toMatch(/private|token|secret/);
    expect(engine.lines.size).toBe(0);
  });

  it('rejects canary operands and incomplete serving generations', async () => {
    await expect(call('open', { ...input, step: 1 })).rejects.toMatchObject({ name: 'ZodError' });
    await expect(call('open', { ...input, serving: [{ ...input.serving[0], name: 'web-9' }] })).rejects.toMatchObject({ name: 'ZodError' });
    expect(engine.lines.size).toBe(0);
  });
});
