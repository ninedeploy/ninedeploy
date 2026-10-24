import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_OPS, advertisedCapabilities, runRegisteredOp } from '../../src/agentOps/index.js';
import { nodeProxyTraffic } from '../../src/lib/nodeProxyTraffic.js';

const engine = vi.hoisted(() => ({ sequence: 0, lines: new Set<(line: string) => void>() }));
vi.mock('../../src/lib/nodeProxyTrafficDocker.js', () => ({ nodeProxyTrafficDocker: () => ({
  inspect: async () => ({ proxyId: 'f'.repeat(64), sourceId: 'e'.repeat(64) }),
  connect: (_id: string, line: (value: string) => void) => { engine.lines.add(line); return { ready: Promise.resolve(), close: () => engine.lines.delete(line) }; },
  heartbeat: async (_id: string, path: string) => {
    for (const line of engine.lines) line(`127.0.0.1 - - [24/Oct/2026:12:00:00 +0000] "GET ${path} HTTP/1.1" 404 0 "-" "-" ${++engine.sequence} "-" "-" 0ms`);
  },
}) }));
beforeEach(() => { engine.sequence = 0; vi.useFakeTimers(); });
afterEach(() => { nodeProxyTraffic.closeAll(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('sealed proxy traffic observation registry', () => {
  it('registers explicit observation lifecycle operations', () => {
    for (const op of ['proxy.traffic.open', 'proxy.traffic.sample', 'proxy.traffic.finish', 'proxy.traffic.close']) {
      expect(AGENT_OPS.get(op)).toMatchObject({ cap: 'proxy.traffic', sealedOnly: true });
    }
  });

  it('advertises observation only after node-owner opt-in', () => {
    expect(advertisedCapabilities({})).not.toContain('proxy.traffic');
    expect(advertisedCapabilities({ NINEDEPLOY_AGENT_PROXY_TRAFFIC: 'on' })).toContain('proxy.traffic');
    expect(advertisedCapabilities({ NINEDEPLOY_AGENT_PROXY_TRAFFIC: 'off' })).not.toContain('proxy.traffic');
  });

  it('refuses plaintext before reading any observation operands', async () => {
    vi.stubEnv('NINEDEPLOY_AGENT_PROXY_TRAFFIC', 'on');
    await expect(runRegisteredOp('proxy.traffic.open', {}, () => {}, { sealed: false })).rejects.toThrow(/sealed/);
  });

  it('dispatches the sealed lifecycle and emits aggregate receipts from the real reservation manager', async () => {
    vi.stubEnv('NINEDEPLOY_AGENT_PROXY_TRAFFIC', 'on');
    const call = async (op: string, args: Record<string, unknown>) => {
      const lines: string[] = [];
      expect(await runRegisteredOp(op, args, line => lines.push(line), { sealed: true })).toBe(0);
      expect(lines).toHaveLength(1); expect(lines[0]).toMatch(/^ND-PROXY-TRAFFIC /);
      return JSON.parse(lines[0]!.slice('ND-PROXY-TRAFFIC '.length));
    };
    const opened = await call('proxy.traffic.open', { requestId: '1'.repeat(32), nodeId: 2, serviceId: 3, deploymentId: 4, step: 1, slug: 'web', durationMs: 1000, routingConfig: 'http: {}',
      stable: [{ name: 'old', id: 'a'.repeat(64), port: 80 }], canary: [{ name: 'new', id: 'b'.repeat(64), port: 80 }] });
    const windowId = opened.snapshot.windowId;
    expect(opened).toMatchObject({ kind: 'open', snapshot: { complete: false } });
    expect(await call('proxy.traffic.sample', { windowIds: [windowId] })).toMatchObject({ kind: 'sample', items: [{ ok: true }] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await call('proxy.traffic.finish', { windowId })).toMatchObject({ kind: 'finish', snapshot: { complete: true, observed: 0 } });
    expect(engine.lines.size).toBe(0);
    expect(await call('proxy.traffic.close', { windowId })).toEqual({ kind: 'close', windowId, closed: true });
    expect(await call('proxy.traffic.sample', { windowIds: [windowId] })).toMatchObject({ items: [{ ok: false, windowId }] });
  });
});
