import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { domains, nodeProxyWriteHeads, servers, services, eq } from '@ninedeploy/db';
import { observabilityDb } from '../fixtures/observability.js';
import { reserveNodeProxyWrite } from '../../src/lib/nodeProxyAuthority.js';
import { syncAllNodeProxies, syncNodeProxy } from '../../src/lib/nodeProxy.js';
import { runOp } from '../../src/agent.js';

const io = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.agent, agentTransportSealed: io.sealed }));
let c: Awaited<ReturnType<typeof observabilityDb>>, caps: string[], tamper: boolean, supersede: boolean;
beforeEach(async () => {
  c = await observabilityDb(); await c.db.insert(servers).values({ id: 2, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
  caps = ['proxy.orderedWrite']; tamper = false; supersede = false;
  io.sealed.mockReset().mockResolvedValue(true); io.agent.mockReset();
  io.agent.mockImplementation(async (_db, _node, op, params) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps })}`] };
    if (op === 'proxy.writeConfig') {
      if (supersede && params.kind === 'static') await reserveNodeProxyWrite(c.db, 2);
      return { exitCode: 0, lines: ['proxy-config x unchanged'] };
    }
    if (op === 'proxy.writeOrderedConfig') return { exitCode: 0, lines: [`ND-PROXY-WRITE ${JSON.stringify({ revision: params.revision, requestId: params.requestId,
      contentHash: tamper ? 'f'.repeat(64) : createHash('sha256').update(params.content).digest('hex'), complete: true, changed: true })}`] };
    if (op === 'docker.inspect') return { exitCode: 0, lines: ['running'] };
    if (op === 'proxy.confirmRouting') return { exitCode: 0, lines: [`ND-PROXY-ROUTING ${createHash('sha256').update(params.content).digest('hex')}`] };
    throw new Error(`Unexpected op ${op}`);
  });
});
afterEach(() => c.close());

it('adopts only after capability discovery and orders every subsequent ordinary refresh', async () => {
  await expect(syncNodeProxy(c.db, 2, undefined, { adoptOrdered: true })).resolves.toEqual({ ok: true });
  await expect(syncNodeProxy(c.db, 2)).resolves.toEqual({ ok: true });
  const writes = io.agent.mock.calls.filter(call => call[2] === 'proxy.writeOrderedConfig');
  expect(writes.map(call => call[3].revision)).toEqual([1, 2]);
  expect(io.agent.mock.calls.filter(call => call[2] === 'proxy.writeConfig').every(call => call[3].kind === 'static')).toBe(true);
  expect((await c.db.select().from(nodeProxyWriteHeads))[0]?.revision).toBe(2);
});
it('does not adopt an older agent or accept an unmatched write receipt', async () => {
  caps = []; await expect(syncNodeProxy(c.db, 2, undefined, { adoptOrdered: true })).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/NINEDEPLOY_AGENT_ORDERED_PROXY/) });
  expect(await c.db.select().from(nodeProxyWriteHeads)).toEqual([]);
  caps = ['proxy.orderedWrite']; tamper = true;
  await expect(syncNodeProxy(c.db, 2, undefined, { adoptOrdered: true })).resolves.toMatchObject({ ok: false, routingUnconfirmed: true });
});
it('stops an older render when another refresh reserves a newer revision', async () => {
  await syncNodeProxy(c.db, 2, undefined, { adoptOrdered: true });
  io.agent.mockClear(); supersede = true;
  await expect(syncNodeProxy(c.db, 2)).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/superseded/) });
  expect(io.agent.mock.calls.some(call => call[2] === 'proxy.writeOrderedConfig')).toBe(false);
});
it('adopts ordered routing for a confirmed scale-down without a scale-up override', async () => {
  caps = ['proxy.orderedWrite', 'proxy.routingAck'];
  await expect(syncAllNodeProxies(c.db, [2], undefined, { confirmNode: 2, adoptOrderedNode: 2 })).resolves.toEqual([{ serverId: 2, ok: true }]);
  expect(io.agent.mock.calls.some(call => call[2] === 'proxy.writeOrderedConfig')).toBe(true);
  expect(io.agent.mock.calls.some(call => call[2] === 'proxy.confirmRouting')).toBe(true);
});
it('keeps a newer routing file when an older panel request reaches the real agent late', async () => {
  const work = mkdtempSync(join(tmpdir(), 'nd-proxy-sync-agent-')), cwd = vi.spyOn(process, 'cwd').mockReturnValue(work);
  try {
    await c.db.update(services).set({ serverId: 2, runtimeId: 'web-9', port: 3000 }).where(eq(services.id, 1));
    await c.db.insert(domains).values({ serviceId: 1, hostname: 'first.example.test', status: 'active', ssl: false });
    let release!: () => void, entered!: () => void, delay = false;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    io.agent.mockImplementation(async (_db, _node, op, params) => {
      if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps: ['proxy.orderedWrite'] })}`] };
      if (op === 'docker.inspect') return { exitCode: 0, lines: ['running'] };
      if (op === 'proxy.writeConfig' && params.kind === 'static') return { exitCode: 0, lines: ['proxy-config x unchanged'] };
      if (op === 'proxy.writeOrderedConfig') {
        if (delay) { delay = false; entered(); await blocked; }
        const lines: string[] = []; const exitCode = await runOp(op, params, line => lines.push(line), { sealed: true });
        return { exitCode, lines };
      }
      throw new Error(`Unexpected op ${op}`);
    });
    await expect(syncNodeProxy(c.db, 2, undefined, { adoptOrdered: true })).resolves.toEqual({ ok: true });
    delay = true; const older = syncNodeProxy(c.db, 2); await started;
    await c.db.insert(domains).values({ serviceId: 1, hostname: 'second.example.test', status: 'active', ssl: false });
    await expect(syncNodeProxy(c.db, 2)).resolves.toEqual({ ok: true });
    release(); await expect(older).resolves.toMatchObject({ ok: false, routingUnconfirmed: true });
    const written = readFileSync(join(work, '.agent-proxy', 'dynamic', 'ninedeploy.yml'), 'utf8');
    expect(written).toContain('first.example.test'); expect(written).toContain('second.example.test');
  } finally { cwd.mockRestore(); rmSync(work, { recursive: true, force: true }); }
}, 30_000);
