import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDb, deployments, eq, nodeDeploymentPreparations, runMigrations, servers, services } from '@ninedeploy/db';
import { claimNodeDeploymentAttempt } from '../../src/lib/nodeDeploymentOwner.js';
import { beginNodeDeploymentPreparation, completeNodeDeploymentPreparation } from '../../src/lib/nodeDeploymentPreparation.js';

const h = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn(async () => true) }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: h.agent, agentTransportSealed: h.sealed }));
const { recoverPreparedNodeCandidate, createNodePreparationRecoveryRunner } = await import('../../src/lib/nodePreparationRecovery.js');
let c: ReturnType<typeof createDb>, owner: Awaited<ReturnType<typeof claimNodeDeploymentAttempt>> & { claimed: true }, loseReply: boolean;
const targets = [{ id: 'a'.repeat(64), name: 'web-9', deploymentId: 9 }, { id: 'b'.repeat(64), name: 'web-9-r2', deploymentId: 9 }];
beforeEach(async () => {
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, runtimeId: 'web-8', status: 'running' });
  await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'queued' });
  const result = await claimNodeDeploymentAttempt(c.db, 9, (await c.db.query.services.findFirst())!, '{}');
  if (!result.claimed) throw Error('Missing owner'); owner = result;
  await beginNodeDeploymentPreparation(c.db, owner.owner, { runtimeId: 'web-9', imageId: `sha256:${'f'.repeat(64)}`, serving: 1, capacity: 2 });
  await completeNodeDeploymentPreparation(c.db, owner.owner, targets);
  await c.db.update(deployments).set({ status: 'failed' }).where(eq(deployments.id, 9));
  loseReply = false; h.sealed.mockReset().mockResolvedValue(true);
  h.agent.mockReset().mockImplementation(async (_db, _server, op, params) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: ['ND-AGENT {"version":"0.19.0","caps":["docker.mutations"]}'] };
    const common = { requestId: params.requestId, serviceId: params.serviceId, revision: params.revision, complete: true };
    if (op === 'docker.runtimeFence') return { exitCode: 0, lines: [`ND-RUNTIME-FENCE ${JSON.stringify({ ...common, deploymentWatermark: params.deploymentWatermark })}`] };
    if (op === 'docker.runtimeInventory') return { exitCode: 0, lines: [`ND-RUNTIME-INVENTORY ${JSON.stringify({ ...common, deploymentWatermark: params.deploymentWatermark, items: targets.map(item => ({ ...item, running: true })) })}`] };
    if (op === 'docker.retireSet') {
      if (loseReply) { loseReply = false; throw Error('lost reply'); }
      return { exitCode: 0, lines: [`ND-RETIRED-SET ${JSON.stringify({ ...common, items: params.targets.map((item: object) => ({ ...item, removed: true })) })}`] };
    }
    throw Error(`Unexpected operation ${op}`);
  });
});
afterEach(() => c.client?.close());

it('replays retirement after a lost reply without reissuing the older fence', async () => {
  loseReply = true;
  await expect(recoverPreparedNodeCandidate(c.db, owner.owner)).rejects.toThrow('lost reply');
  expect((await c.db.select().from(nodeDeploymentPreparations))[0]?.phase).toBe('retiring');
  expect(await recoverPreparedNodeCandidate(c.db, owner.owner)).toEqual({ deploymentId: 9, retired: 2 });
  expect(h.agent.mock.calls.filter(call => call[2] === 'docker.runtimeFence')).toHaveLength(1);
  expect(await c.db.select().from(nodeDeploymentPreparations)).toEqual([]);
  expect((await c.db.query.services.findFirst())?.runtimeId).toBe('web-8');
});

it('does not retire a generation selected by the service', async () => {
  await c.db.update(services).set({ runtimeId: 'web-9' }).where(eq(services.id, 1));
  await expect(recoverPreparedNodeCandidate(c.db, owner.owner)).rejects.toThrow(/routing|ownership/);
  expect(h.agent).not.toHaveBeenCalled();
  expect(await c.db.select().from(nodeDeploymentPreparations)).toHaveLength(1);
});
it('retains the candidate if the node reports a replacement under its name', async () => {
  const original = h.agent.getMockImplementation()!;
  h.agent.mockImplementation(async (...args) => {
    if (args[2] === 'docker.runtimeInventory') {
      const p = args[3];
      return { exitCode: 0, lines: [`ND-RUNTIME-INVENTORY ${JSON.stringify({ requestId: p.requestId, serviceId: p.serviceId, revision: p.revision,
        deploymentWatermark: p.deploymentWatermark, complete: true, items: [{ ...targets[0], id: 'c'.repeat(64), running: true }] })}`] };
    }
    return original(...args);
  });
  await expect(recoverPreparedNodeCandidate(c.db, owner.owner)).rejects.toThrow(/identity changed/);
  expect(h.agent.mock.calls.some(call => call[2] === 'docker.retireSet')).toBe(false);
  expect((await c.db.select().from(nodeDeploymentPreparations))[0]?.phase).toBe('prepared');
});
it('leaves an active deployment untouched', async () => {
  await c.db.update(deployments).set({ status: 'deploying' }).where(eq(deployments.id, 9));
  await expect(recoverPreparedNodeCandidate(c.db, owner.owner)).rejects.toThrow(/routing|ownership/);
  expect(h.agent).not.toHaveBeenCalled();
});
it('retains the journal when service selection changes during retirement', async () => {
  const original = h.agent.getMockImplementation()!;
  h.agent.mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[2] === 'docker.retireSet') await c.db.update(services).set({ runtimeId: 'web-9' }).where(eq(services.id, 1));
    return result;
  });
  await expect(recoverPreparedNodeCandidate(c.db, owner.owner)).rejects.toThrow(/routing|ownership/);
  expect((await c.db.select().from(nodeDeploymentPreparations))[0]?.phase).toBe('retiring');
});
it('rotates held recovery work without starving later failed deployments', async () => {
  for (let id = 10; id <= 21; id++) {
    await c.db.insert(deployments).values({ id, serviceId: 1, status: id === 21 ? 'deploying' : 'failed' });
    await c.db.insert(nodeDeploymentPreparations).values({ deploymentId: id, serviceId: 1, serverId: 4, epoch: 1, requestId: 'c'.repeat(32),
      runtimeId: `web-${id}`, imageId: `sha256:${'f'.repeat(64)}`, serving: 1, capacity: 1, phase: 'prepared', targets: [{ id: 'a'.repeat(64), name: `web-${id}` }] });
  }
  const attempts: number[] = [];
  const recover = vi.fn(async (_db, value) => { attempts.push(value.deploymentId); throw Error('node offline'); });
  const run = createNodePreparationRecoveryRunner(c.db, { recover });
  expect(await run()).toEqual({ recovered: 0, held: 10 });
  expect(await run()).toEqual({ recovered: 0, held: 2 });
  expect(attempts).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  expect(await run()).toEqual({ recovered: 0, held: 10 });
  expect(attempts[12]).toBe(9);
});
