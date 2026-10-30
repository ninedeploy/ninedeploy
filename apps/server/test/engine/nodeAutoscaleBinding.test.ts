import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDb, deployments, eq, nodeDeploymentPreparations, runMigrations, servers, services } from '@ninedeploy/db';
import { claimNodeDeploymentAttempt, createNodeDeploymentAuthority } from '../../src/lib/nodeDeploymentOwner.js';

const h = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn(async () => true) }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: h.agent, agentTransportSealed: h.sealed }));
const { bindNodeAutoscalePreparation } = await import('../../src/engine/builders/nodeAutoscaleBinding.js');
const { createRemoteDockerBuilder } = await import('../../src/engine/builders/remoteDocker.js');
let c: ReturnType<typeof createDb>;
const caps = ['docker.mutations', 'docker.prepareAttemptEnv', 'docker.startSet', 'docker.readiness', 'docker.recovery', 'docker.probe', 'proxy.routingAck', 'proxy.orderedWrite', 'image.manage', 'docker.runSpec'];
beforeEach(async () => {
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, status: 'idle', port: 3000,
    autoscale: { minReplicas: 1, maxReplicas: 2, metric: 'cpu', target: 70, scaleUpSeconds: 60, scaleDownSeconds: 120 } });
  await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'queued' });
  h.sealed.mockReset().mockResolvedValue(true);
  h.agent.mockReset().mockImplementation(async (_db, _server, op, params) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps })}`] };
    if (op === 'docker.runtimeFence') return { exitCode: 0, lines: [`ND-RUNTIME-FENCE ${JSON.stringify({ requestId: params.requestId, serviceId: params.serviceId, revision: params.revision, deploymentWatermark: params.deploymentWatermark, complete: true })}`] };
    if (op === 'docker.prepare') return { exitCode: 0, lines: [`ND-PREPARED ${JSON.stringify({ requestId: params.requestId, serviceId: params.serviceId, deploymentId: params.deploymentId, revision: params.revision,
      complete: true, items: params.specs.map((spec: { name: string }, index: number) => ({ id: String(index + 1).repeat(64), name: spec.name, deploymentId: params.deploymentId, running: params.startNames.includes(spec.name) })) })}`] };
    throw Error(`Unexpected mutation ${op}`);
  });
});
afterEach(() => c.client?.close());

it('binds builder inputs to a persisted owner, watermark and immutable preparation receipt', async () => {
  const service = (await c.db.query.services.findFirst())!;
  const admission = await claimNodeDeploymentAttempt(c.db, 9, service, '{}');
  if (!admission.claimed) throw Error('Missing deployment owner');
  await c.db.insert(deployments).values({ id: 20, serviceId: 1, status: 'cancelled' });
  await c.db.delete(deployments).where(eq(deployments.id, 20));
  const authority = createNodeDeploymentAuthority(c.db, admission.owner);
  const agent = vi.fn(async (op: string, params: Record<string, unknown>) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps })}`] };
    if (op === 'docker.imageInspect') return { exitCode: 0, lines: [`sha256:${'f'.repeat(64)}|42`] };
    if (op === 'file.writeEnv') return { exitCode: 0, lines: [`wrote .agent-env/${params.name}.env`] };
    if (op === 'file.deleteEnv') return { exitCode: 0, lines: [] };
    throw Error(`Unexpected agent op ${op}`);
  });
  const prepare = bindNodeAutoscalePreparation({ db: c.db, owner: admission.owner, agent, sealed: async () => true, checkpoint: () => authority.check(), log: () => {} });
  const runtime = await prepare({ service, deploymentId: 9, image: 'fixture:latest', env: { KEY: 'value' }, volumeAttachments: [], files: [] });
  expect(runtime).toMatchObject({ runtimeId: 'web-9', imageDigest: `sha256:${'f'.repeat(64)}`, replicas: 1, nodeDeploymentOwner: admission.owner });
  expect((await c.db.select().from(nodeDeploymentPreparations))[0]).toMatchObject({ phase: 'prepared', capacity: 2, targets: runtime.nodeCapacityTargets });
  expect(h.agent.mock.calls.find(call => call[2] === 'docker.runtimeFence')?.[3].deploymentWatermark).toBe(20);
  expect(agent.mock.calls.at(-1)?.[0]).toBe('file.deleteEnv');
});

it('rejects changed ownership before contacting a node', async () => {
  const service = (await c.db.query.services.findFirst())!;
  const admission = await claimNodeDeploymentAttempt(c.db, 9, service, '{}');
  if (!admission.claimed) throw Error('Missing deployment owner');
  const agent = vi.fn();
  const prepare = bindNodeAutoscalePreparation({ db: c.db, owner: admission.owner, agent, sealed: async () => true, checkpoint: async () => {}, log: () => {} });
  await c.db.update(services).set({ serverId: null }).where(eq(services.id, 1));
  await expect(prepare({ service, deploymentId: 9, image: 'fixture:latest', env: {}, volumeAttachments: [], files: [] })).rejects.toThrow(/authority changed/i);
  expect(agent).not.toHaveBeenCalled(); expect(h.agent).not.toHaveBeenCalled();
});

it('passes the builder image through the real bound preparation without legacy container creation', async () => {
  const service = (await c.db.query.services.findFirst())!;
  const admission = await claimNodeDeploymentAttempt(c.db, 9, service, '{}');
  if (!admission.claimed) throw Error('Missing deployment owner');
  const imageId = `sha256:${'f'.repeat(64)}`;
  const agent = vi.fn(async (op: string, params: Record<string, unknown>) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps })}`] };
    if (op === 'docker.networkCreate') return { exitCode: 0, lines: [] };
    if (op === 'docker.imageInspect') return { exitCode: 0, lines: [`${imageId}|42`] };
    if (op === 'file.writeEnv') return { exitCode: 0, lines: [`wrote .agent-env/${params.name}.env`] };
    if (op === 'file.deleteEnv') return { exitCode: 0, lines: [] };
    throw Error(`Unexpected agent op ${op}`);
  });
  const prepareCapacity = bindNodeAutoscalePreparation({ db: c.db, owner: admission.owner, agent, sealed: async () => true, checkpoint: async () => {}, log: () => {} });
  const builder = createRemoteDockerBuilder(agent, { prebuiltImage: { tag: imageId, imageId }, prepareCapacity, isSealed: async () => true });
  const runtime = await builder.buildAndRun({ deploymentId: 9, service, workDir: '/unused', commitSha: '', env: {}, log: () => {} });
  expect(runtime.nodeCapacityTargets).toHaveLength(2);
  expect((await c.db.select().from(nodeDeploymentPreparations))[0]).toMatchObject({ phase: 'prepared', imageId, targets: runtime.nodeCapacityTargets });
  expect(agent.mock.calls.map(call => call[0])).not.toContain('docker.runEnv');
  expect(agent.mock.calls.map(call => call[0])).not.toContain('docker.runSpec');
});
