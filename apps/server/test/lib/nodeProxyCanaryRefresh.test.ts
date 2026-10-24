import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { domains, servers, services, eq } from '@ninedeploy/db';
import { observabilityDb } from '../fixtures/observability.js';
import { beginCanary, resetCanaryState, setCanaryStep } from '../../src/engine/canaryState.js';
import { syncNodeProxy } from '../../src/lib/nodeProxy.js';
import { withRoutingAck } from '../../src/lib/proxyRoutingAck.js';
import { renderDynamicConfig } from '../../src/engine/proxy.js';

const io = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.agent, agentTransportSealed: io.sealed }));

let connection: Awaited<ReturnType<typeof observabilityDb>>, caps: string[], receipt: string | undefined;
const writes = () => io.agent.mock.calls.filter(call => call[2] === 'proxy.writeConfig' && call[3].kind === 'dynamic').map(call => call[3].content as string);
beforeEach(async () => {
  vi.resetAllMocks(); resetCanaryState(); caps = ['proxy.routingAck']; receipt = undefined;
  connection = await observabilityDb();
  await connection.db.insert(servers).values({ id: 2, name: 'Node', host: 'node.test', port: 4600, tokenEncrypted: 'fixture' });
  await connection.db.update(services).set({ serverId: 2, runtimeId: 'web-old', port: 3000 }).where(eq(services.id, 1));
  await connection.db.insert(domains).values({ serviceId: 1, hostname: 'canary.test', path: '/', status: 'active', ssl: false });
  io.sealed.mockResolvedValue(true);
  io.agent.mockImplementation(async (_db, _node, op, args) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.18.0', caps })}`] };
    if (op === 'proxy.writeConfig') return { exitCode: 0, lines: ['proxy-config x unchanged'] };
    if (op === 'docker.inspect') return { exitCode: 0, lines: ['running'] };
    if (op === 'proxy.confirmRouting') return { exitCode: 0, lines: [`ND-PROXY-ROUTING ${receipt ?? createHash('sha256').update(args.content).digest('hex')}`] };
    throw new Error(`Unexpected external operation: ${op}`);
  });
});
afterEach(() => { connection?.close(); resetCanaryState(); });
const split = () => {
  beginCanary(1, 'web', 4, 1, true, true, { serverId: 2, stableRuntimeId: 'web-old' });
  setCanaryStep(1, 1, { runtimeId: 'web-new', port: 3000, replicas: 1, weight: 50 }, 0, 30_000);
};

describe('ordinary node proxy refresh during a canary', () => {
  it('preserves the loaded generation marker when the split is refreshed unchanged', async () => {
    split();
    const routes = await renderDynamicConfig(connection.db, { serverId: 2 });
    expect(routes).toContain('web-old:3000'); expect(routes).toContain('web-new:3000');
    await expect(syncNodeProxy(connection.db, 2, undefined, { confirmRouting: true })).resolves.toEqual({ ok: true });
    await expect(syncNodeProxy(connection.db, 2)).resolves.toEqual({ ok: true });
    expect(writes()).toEqual([withRoutingAck(routes), withRoutingAck(routes)]);
    expect(io.agent.mock.calls.filter(call => call[2] === 'proxy.confirmRouting')).toHaveLength(2);
  });
  it('keeps inactive and unrelated nodes on their ordinary refresh path', async () => {
    await expect(syncNodeProxy(connection.db, 2)).resolves.toEqual({ ok: true });
    split();
    await expect(syncNodeProxy(connection.db, 3)).resolves.toEqual({ ok: true });
    expect(writes().every(content => !content.includes('nd_routing_ack'))).toBe(true);
    expect(io.agent.mock.calls.some(call => call[2] === 'agent.ping' || call[2] === 'proxy.confirmRouting')).toBe(false);
  });
  it('refuses a lost confirmation capability before changing the active node routing', async () => {
    split(); caps = [];
    await expect(syncNodeProxy(connection.db, 2)).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/confirm loaded HTTP\/TLS routing/) });
    expect(io.agent.mock.calls.map(call => call[2])).toEqual(['agent.ping']);
  });
  it('does not send active canary routing over an unsealed connection', async () => {
    split(); io.sealed.mockResolvedValue(false);
    await expect(syncNodeProxy(connection.db, 2)).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/unencrypted/) });
    expect(io.agent).not.toHaveBeenCalled();
  });
  it('reports a stale receipt as unknown routing after a concurrent domain change', async () => {
    split();
    const old = await renderDynamicConfig(connection.db, { serverId: 2 });
    await expect(syncNodeProxy(connection.db, 2, undefined, { confirmRouting: true })).resolves.toEqual({ ok: true });
    receipt = createHash('sha256').update(old).digest('hex');
    await connection.db.insert(domains).values({ serviceId: 1, hostname: 'second.test', path: '/', status: 'active', ssl: false });
    await expect(syncNodeProxy(connection.db, 2)).resolves.toMatchObject({ ok: false, routingUnconfirmed: true });
    expect(writes()[1]).not.toBe(writes()[0]);
  });
});
