import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, services, servers, deployments, eq, serviceTargets } from '@ninedeploy/db';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';
import { recoverCompletedInitialStop } from '../../src/lib/nodeLegacyStopRecovery.js';
import { nodeLifecycleIntents } from '@ninedeploy/db';

let c: ReturnType<typeof createDb>;
beforeEach(async () => {
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values([{ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' }, { id: 5, name: 'Other', host: 'node2.test', tokenEncrypted: 'fixture' }]);
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, runtimeId: null, status: 'deploying' });
  await c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'deploying' });
  const service = (await c.db.query.services.findFirst())!;
  const stop = await acceptNodeLifecycleIntent(c.db, service, 'stop');
  await c.db.update(nodeLifecycleIntents).set({ phase: 'completed', targets: [], completedAt: new Date() }).where(eq(nodeLifecycleIntents.id, stop.id));
});
afterEach(() => c.client?.close());

describe('completed initial Stop recovery', () => {
  const service = async () => (await c.db.query.services.findFirst())!;
  const dependencies = () => ({ check: vi.fn(async () => {}), sealed: vi.fn(async () => true),
    agent: vi.fn(async (_server: number, op: string, params: Record<string, unknown>) => ({ exitCode: 0,
      lines: op === 'agent.ping' ? ['ND-AGENT ' + JSON.stringify({ version: '0.18.11', caps: ['docker.mutations'] })] :
        ['ND-RUNTIME-LEGACY ' + JSON.stringify({ requestId: params.requestId, serviceId: params.serviceId, revision: params.revision, deploymentWatermark: params.deploymentWatermark, complete: true })] })) });
  it.each([{ orchestrator: 'swarm' as const }, { type: 'compose' as const }])('does not operate on an unsupported runtime: %j', async change => {
    const deps = dependencies();
    await recoverCompletedInitialStop(c.db, { ...await service(), ...change }, deps);
    expect(deps.check).not.toHaveBeenCalled(); expect(deps.agent).not.toHaveBeenCalled();
  });
  it('requires a sealed connection and validates the exact persisted watermark', async () => {
    const deps = dependencies(); await recoverCompletedInitialStop(c.db, await service(), deps);
    expect(deps.agent).toHaveBeenCalledTimes(2); expect(deps.agent.mock.calls[1]![2]).toMatchObject({ serviceId: 1, deploymentWatermark: 10 });
    deps.sealed.mockResolvedValue(false);
    await expect(recoverCompletedInitialStop(c.db, await service(), deps)).rejects.toThrow(/sealed/);
    expect(deps.agent).toHaveBeenCalledTimes(2);
  });
  it('rejects a forged reply and a changed fan-out placement', async () => {
    const deps = dependencies();
    deps.agent.mockResolvedValueOnce({ exitCode: 0, lines: ['ND-AGENT ' + JSON.stringify({ version: '0.18.11', caps: ['docker.mutations'] })] });
    deps.agent.mockResolvedValueOnce({ exitCode: 0, lines: ['ND-RUNTIME-LEGACY ' + JSON.stringify({ requestId: '0'.repeat(32), serviceId: 1, revision: 1, deploymentWatermark: 10, complete: true })] });
    await expect(recoverCompletedInitialStop(c.db, await service(), deps)).rejects.toThrow(/ownership/);
    await c.db.insert(serviceTargets).values({ serviceId: 1, serverId: 5 });
    await expect(recoverCompletedInitialStop(c.db, await service(), deps)).rejects.toThrow(/placement changed/);
  });
  it('rechecks placement after a slow agent ping before any handoff', async () => {
    const deps = dependencies();
    const original = deps.agent.getMockImplementation()!;
    deps.agent.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1] === 'agent.ping') await c.db.insert(serviceTargets).values({ serviceId: 1, serverId: 5 });
      return result;
    });
    await expect(recoverCompletedInitialStop(c.db, await service(), deps)).rejects.toThrow(/placement changed/);
    expect(deps.agent.mock.calls.map(call => call[1])).toEqual(['agent.ping']);
  });
  it('rejects a changed completed Stop snapshot after an agent reply', async () => {
    const deps = dependencies(), original = deps.agent.getMockImplementation()!;
    const saved = (await c.db.query.nodeLifecycleIntents.findFirst())!;
    deps.agent.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1] === 'agent.ping') await c.db.update(nodeLifecycleIntents).set({ snapshot: { ...saved.snapshot, creationFenceDeploymentId: 11 } }).where(eq(nodeLifecycleIntents.id, saved.id));
      return result;
    });
    await expect(recoverCompletedInitialStop(c.db, await service(), deps)).rejects.toThrow(/placement changed/);
    expect(deps.agent.mock.calls.map(call => call[1])).toEqual(['agent.ping']);
  });
  it('does not accept a reply after deployment authority is lost', async () => {
    const deps = dependencies();
    const original = deps.agent.getMockImplementation()!;
    deps.agent.mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      deps.check.mockRejectedValue(new Error('lost authority'));
      return result;
    });
    await expect(recoverCompletedInitialStop(c.db, await service(), deps)).rejects.toThrow('lost authority');
    expect(deps.agent).toHaveBeenCalledOnce();
  });
  it('asks for an agent update before attempting handoff on 0.18.10', async () => {
    const deps = dependencies();
    deps.agent.mockResolvedValueOnce({ exitCode: 0, lines: ['ND-AGENT ' + JSON.stringify({ version: '0.18.10', caps: ['docker.mutations'] })] });
    await expect(recoverCompletedInitialStop(c.db, await service(), deps)).rejects.toThrow(/update.*0\.18\.11/i);
    expect(deps.agent).toHaveBeenCalledOnce(); expect(deps.agent.mock.calls[0]![1]).toBe('agent.ping');
  });
  it('checks all participants before handing off any node', async () => {
    await c.db.insert(serviceTargets).values({ serviceId: 1, serverId: 5 });
    await c.db.update(services).set({ status: 'deploying' }).where(eq(services.id, 1));
    await c.db.insert(deployments).values({ id: 11, serviceId: 1, status: 'building' });
    const stop = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    await c.db.update(nodeLifecycleIntents).set({ phase: 'completed', targets: [], completedAt: new Date() }).where(eq(nodeLifecycleIntents.id, stop.id));
    const deps = dependencies();
    deps.agent.mockImplementation(async (serverId, op) => ({ exitCode: 0, lines: op === 'agent.ping'
      ? ['ND-AGENT ' + JSON.stringify({ version: serverId === 4 ? '0.18.11' : '0.18.10', caps: ['docker.mutations'] })]
      : [] }));
    await expect(recoverCompletedInitialStop(c.db, await service(), deps)).rejects.toThrow(/node #5.*0\.18\.11/i);
    expect(deps.agent.mock.calls.map(call => [call[0], call[1]])).toEqual([[4, 'agent.ping'], [5, 'agent.ping']]);
  });
  it('does not continue to another node when placement changes during a handoff', async () => {
    await c.db.insert(serviceTargets).values({ serviceId: 1, serverId: 5 });
    await c.db.update(services).set({ status: 'deploying' }).where(eq(services.id, 1));
    await c.db.insert(deployments).values({ id: 11, serviceId: 1, status: 'building' });
    const stop = await acceptNodeLifecycleIntent(c.db, await service(), 'stop');
    await c.db.update(nodeLifecycleIntents).set({ phase: 'completed', targets: [], completedAt: new Date() }).where(eq(nodeLifecycleIntents.id, stop.id));
    const deps = dependencies(), original = deps.agent.getMockImplementation()!;
    deps.agent.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0] === 4 && args[1] === 'docker.runtimeLegacyHandoff') await c.db.delete(serviceTargets).where(eq(serviceTargets.serviceId, 1));
      return result;
    });
    await expect(recoverCompletedInitialStop(c.db, await service(), deps)).rejects.toThrow(/placement changed/);
    expect(deps.agent.mock.calls.map(call => [call[0], call[1]])).toEqual([[4, 'agent.ping'], [5, 'agent.ping'], [4, 'docker.runtimeLegacyHandoff']]);
  });
});
