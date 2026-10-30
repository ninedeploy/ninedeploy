import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDb, deployments, eq, runMigrations, servers, services, serviceTargets } from '@ninedeploy/db';
import { applyNodeLimits } from '../../src/lib/nodeLimitUpdate.js';
const io = vi.hoisted(() => ({ op: vi.fn(), sealed: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.op, agentTransportSealed: io.sealed }));
let c: ReturnType<typeof createDb>, unavailable: number | null, invalid: number | null;
const service = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
const id = (node: number, name: string) => (node === 4 ? name.endsWith('r2') ? 'b' : 'a' : 'c').repeat(64);
beforeEach(async () => {
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values([{ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' }, { id: 5, name: 'Target', host: 'target.test', tokenEncrypted: 'fixture' }]);
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, status: 'running', runtimeId: 'web-9',
    replicas: 2, runtimeReplicas: 2, memLimitMb: 64 });
  await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'running' });
  await c.db.insert(serviceTargets).values({ serviceId: 1, serverId: 5, runtimeId: 'web-t5-9' });
  unavailable = null; invalid = null; io.sealed.mockReset().mockResolvedValue(true);
  io.op.mockReset().mockImplementation(async (_db, node, op, params) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: ['ND-AGENT ' + JSON.stringify({ version: '0.18.12', caps: node === unavailable ? [] : ['docker.mutations', 'docker.limits', 'docker.recovery'] })] };
    if (op === 'docker.runtimeFence') return { exitCode: 0, lines: ['ND-RUNTIME-FENCE ' + JSON.stringify({ requestId: params.requestId, serviceId: params.serviceId, revision: params.revision, deploymentWatermark: params.deploymentWatermark, complete: true })] };
    if (op === 'docker.identity') return { exitCode: 0, lines: ['ND-CONTAINER ' + JSON.stringify({ id: id(node, params.name), name: params.name, managed: 'service', serviceId: node === invalid ? '2' : '1', deploymentId: '9' })] };
    if (op === 'docker.limits') return { exitCode: 0, lines: ['ND-LIMITS ' + JSON.stringify({ requestId: params.requestId, serviceId: params.serviceId, revision: params.revision, complete: true, items: params.targets })] };
    throw new Error('Unexpected operation ' + op);
  });
});
afterEach(() => c.client?.close());
it('fences every node and applies the exact owned replicas only after complete discovery', async () => {
  expect(await applyNodeLimits(c.db, await service())).toBe(true);
  const calls = io.op.mock.calls, effects = calls.filter(call => call[2] === 'docker.limits');
  expect(effects.map(call => [call[1], call[3].targets.map((target: { name: string }) => target.name)])).toEqual([[4, ['web-9', 'web-9-r2']], [5, ['web-t5-9']]]);
  expect(effects.every(call => call[3].cpuShares === 0 && call[3].cpuLimitMilli === 0 && call[3].memLimitMb === 64)).toBe(true);
  const lastIdentity = calls.findLastIndex(call => call[2] === 'docker.identity');
  expect(calls.findIndex(call => call[2] === 'docker.limits')).toBeGreaterThan(lastIdentity);
  expect(calls.filter(call => call[2] === 'docker.runtimeFence')).toHaveLength(2);
});
it('does not fence or update any node when one agent lacks the capability', async () => {
  unavailable = 5; expect(await applyNodeLimits(c.db, await service())).toBe(false);
  expect(io.op.mock.calls.every(call => call[2] === 'agent.ping')).toBe(true);
});
it('does not update any node when one identity belongs to another service', async () => {
  invalid = 5; expect(await applyNodeLimits(c.db, await service())).toBe(false);
  expect(io.op.mock.calls.some(call => call[2] === 'docker.limits')).toBe(false);
});
it('does not claim success when target placement changes during discovery', async () => {
  const normal = io.op.getMockImplementation()!;
  io.op.mockImplementation(async (...args) => {
    const result = await normal(...args);
    if (args[2] === 'docker.identity') await c.db.update(serviceTargets).set({ runtimeId: 'web-t5-10' }).where(eq(serviceTargets.serverId, 5));
    return result;
  });
  expect(await applyNodeLimits(c.db, await service())).toBe(false);
  expect(io.op.mock.calls.some(call => call[2] === 'docker.limits')).toBe(false);
});
it('does not claim success when a node returns an incomplete limit receipt', async () => {
  const normal = io.op.getMockImplementation()!;
  io.op.mockImplementation(async (...args) => args[2] === 'docker.limits' && args[1] === 5
    ? { exitCode: 0, lines: ['ND-LIMITS ' + JSON.stringify({ requestId: args[3].requestId, serviceId: 1, revision: args[3].revision, complete: true, items: [] })] }
    : normal(...args));
  expect(await applyNodeLimits(c.db, await service())).toBe(false);
});
