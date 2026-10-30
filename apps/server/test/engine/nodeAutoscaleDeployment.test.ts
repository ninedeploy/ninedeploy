import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDb, deploymentRuntimeOwners, deployments, eq, nodeDeploymentPreparations, runMigrations, servers, services } from '@ninedeploy/db';
import { prepareNodeAutoscaleDeployment } from '../../src/engine/builders/nodeAutoscaleDeployment.js';
import { beginNodeDeploymentPreparation, completeNodeDeploymentPreparation } from '../../src/lib/nodeDeploymentPreparation.js';
import { reserveServiceRuntimeOwner } from '../../src/lib/serviceRuntimeOwner.js';

let c: ReturnType<typeof createDb>, caps: string[], calls: string[];
const owner = { serviceId: 1, serverId: 4, deploymentId: 9, epoch: 2, requestId: 'a'.repeat(32) };
const service = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
const agent = vi.fn(async (op: string, params: Record<string, unknown>) => {
  calls.push(op);
  if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps })}`] };
  if (op === 'docker.imageInspect') return { exitCode: 0, lines: [`sha256:${'f'.repeat(64)}|1234`] };
  if (op === 'file.writeEnv') return { exitCode: 0, lines: [`wrote .agent-env/${params.name}.env`] };
  if (op === 'file.deleteEnv') return { exitCode: 0, lines: [] };
  throw new Error(`Unexpected op ${op}`);
});
const client = () => ({
  fence: vi.fn(async ({ timeoutMs: _timeout, ...input }) => ({ ...input, complete: true })),
  prepare: vi.fn(async input => ({ requestId: input.requestId, serviceId: input.serviceId, deploymentId: input.deploymentId, revision: input.revision,
    complete: true, items: input.specs.map((spec: { name: string }, index: number) => ({ id: String(index + 1).repeat(64), name: spec.name,
      deploymentId: input.deploymentId, running: input.startNames.includes(spec.name) })) })),
});
beforeEach(async () => {
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, status: 'running', runtimeId: 'web-8',
    autoscale: { minReplicas: 1, maxReplicas: 3, metric: 'cpu', target: 70, scaleUpSeconds: 60, scaleDownSeconds: 120 } });
  caps = ['docker.mutations', 'docker.prepareAttemptEnv', 'docker.retireHandoff', 'docker.startSet', 'docker.readiness', 'proxy.routingAck', 'proxy.orderedWrite', 'image.manage', 'docker.runSpec']; calls = []; agent.mockClear();
});
afterEach(() => c.client?.close());
const options = async () => ({ service: await service(), owner, image: 'example:latest', creationWatermark: 9, env: { KEY: 'fixture' },
  agent, client: client(), sealed: true, checkpoint: async () => {}, log: () => {}, journal: { begin: async () => {}, complete: async () => {} } });

it('refuses to prepare a node generation without its durable journal before any agent effects', async () => {
  const opts = await options();
  await expect(prepareNodeAutoscaleDeployment({ ...opts, journal: undefined } as never)).rejects.toThrow(/journal/i);
  expect(calls).toEqual([]); expect(opts.client.fence).not.toHaveBeenCalled(); expect(opts.client.prepare).not.toHaveBeenCalled();
});
it('refuses unsupported node request-rate autoscaling before any agent effects', async () => {
  const opts = await options();
  opts.service = { ...opts.service, autoscale: { minReplicas: 1, maxReplicas: 3, metric: 'rps', target: 100, scaleUpSeconds: 60, scaleDownSeconds: 120 } };
  await expect(prepareNodeAutoscaleDeployment(opts)).rejects.toThrow(/request.rate|rps/i);
  expect(calls).toEqual([]); expect(opts.client.prepare).not.toHaveBeenCalled();
});

it('pins the inspected image and removes the environment only after confirmed preparation', async () => {
  const opts = await options(), result = await prepareNodeAutoscaleDeployment(opts);
  expect(result.imageId).toBe(`sha256:${'f'.repeat(64)}`); expect(result.serving).toHaveLength(1); expect(result.capacity).toHaveLength(3);
  expect(result.runtime).toMatchObject({ runtimeId: 'web-9', replicas: 1, nodeDeploymentOwner: owner,
    nodeTargets: result.serving, nodeCapacityTargets: result.capacity, imageDigest: result.imageId });
  expect(calls.indexOf('docker.imageInspect')).toBeLessThan(calls.indexOf('file.writeEnv'));
  expect(calls.at(-1)).toBe('file.deleteEnv');
  expect(opts.client.prepare.mock.calls[0]![0].specs.every((spec: { image: string }) => spec.image === result.imageId)).toBe(true);
});
it('preserves strict readiness settings in the candidate runtime', async () => {
  const opts = await options();
  opts.service = { ...opts.service, port: 3000, healthCheck: 'http-strict', healthPath: '/ready' };
  const result = await prepareNodeAutoscaleDeployment(opts);
  expect(result.runtime).toMatchObject({ port: 3000, healthCheck: 'http-strict', healthPath: '/ready' });
  expect(result.runtime.nodeTargets).toEqual(result.capacity.slice(0, result.replicas));
  expect(result.runtime.nodeCapacityTargets).not.toBe(result.capacity);
});
it('records intent before preparation and freezes the receipt before environment cleanup', async () => {
  const opts = await options();
  const journal = { begin: vi.fn(async () => { calls.push('journal.begin'); }), complete: vi.fn(async () => { calls.push('journal.complete'); }) };
  const result = await prepareNodeAutoscaleDeployment({ ...opts, journal });
  expect(journal.begin).toHaveBeenCalledWith({ runtimeId: 'web-9', imageId: result.imageId, serving: 1, capacity: 3 });
  expect(journal.complete).toHaveBeenCalledWith(result.capacity);
  expect(calls.indexOf('journal.begin')).toBeLessThan(calls.indexOf('file.writeEnv'));
  expect(calls.indexOf('journal.complete')).toBeLessThan(calls.indexOf('file.deleteEnv'));
});
it('stores the preparation intent and receipt under the real SQLite deployment owner', async () => {
  await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'deploying' });
  const prior = await reserveServiceRuntimeOwner(c.db, 1, 'restart', null, 'b'.repeat(32));
  await reserveServiceRuntimeOwner(c.db, 1, 'deploy', prior, owner.requestId);
  await c.db.insert(deploymentRuntimeOwners).values(owner);
  const opts = await options();
  const journal = { begin: (spec: Parameters<typeof beginNodeDeploymentPreparation>[2]) => beginNodeDeploymentPreparation(c.db, owner, spec),
    complete: (targets: Parameters<typeof completeNodeDeploymentPreparation>[2]) => completeNodeDeploymentPreparation(c.db, owner, targets) };
  const prepare = opts.client.prepare.getMockImplementation()!;
  opts.client.prepare.mockImplementation(async input => {
    expect((await c.db.select().from(nodeDeploymentPreparations))[0]).toMatchObject({ phase: 'preparing', targets: null, runtimeId: 'web-9' });
    return prepare(input);
  });
  const result = await prepareNodeAutoscaleDeployment({ ...opts, journal });
  expect((await c.db.select().from(nodeDeploymentPreparations))[0]).toMatchObject({ phase: 'prepared', runtimeId: 'web-9',
    imageId: result.imageId, serving: 1, capacity: 3, targets: result.capacity });
});
it('reuses a persisted intent after an unconfirmed preparation attempt', async () => {
  await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'deploying' });
  const prior = await reserveServiceRuntimeOwner(c.db, 1, 'restart', null, 'b'.repeat(32));
  await reserveServiceRuntimeOwner(c.db, 1, 'deploy', prior, owner.requestId);
  await c.db.insert(deploymentRuntimeOwners).values(owner);
  const opts = await options();
  const journal = { begin: (spec: Parameters<typeof beginNodeDeploymentPreparation>[2]) => beginNodeDeploymentPreparation(c.db, owner, spec),
    complete: (targets: Parameters<typeof completeNodeDeploymentPreparation>[2]) => completeNodeDeploymentPreparation(c.db, owner, targets) };
  opts.client.prepare.mockRejectedValueOnce(new Error('reply lost')).mockRejectedValueOnce(new Error('reply lost'));
  await expect(prepareNodeAutoscaleDeployment({ ...opts, journal })).rejects.toThrow('reply lost');
  expect((await c.db.select().from(nodeDeploymentPreparations))[0]).toMatchObject({ phase: 'preparing', targets: null });
  const resumed = await prepareNodeAutoscaleDeployment({ ...opts, journal });
  expect((await c.db.select().from(nodeDeploymentPreparations))[0]).toMatchObject({ phase: 'prepared', targets: resumed.capacity });
  expect(opts.client.prepare.mock.calls[0]![0].requestId).toBe(opts.client.prepare.mock.calls[2]![0].requestId);
});
it('defers panel-side environment cleanup if the receipt cannot be saved', async () => {
  const opts = await options(), messages: string[] = []; opts.log = line => messages.push(line);
  const journal = { begin: async () => {}, complete: async () => { throw new Error('journal unavailable'); } };
  await expect(prepareNodeAutoscaleDeployment({ ...opts, journal })).rejects.toThrow('journal unavailable');
  expect(calls).not.toContain('file.deleteEnv');
  expect(messages).toContain('Node environment cleanup deferred: preparation outcome is unconfirmed.');
});
it('refuses an older or unsealed agent before writing any environment file', async () => {
  const opts = await options(); caps = [];
  await expect(prepareNodeAutoscaleDeployment(opts)).rejects.toThrow(/agent/i);
  expect(calls).not.toContain('file.writeEnv'); expect(opts.client.fence).not.toHaveBeenCalled();
  calls = []; await expect(prepareNodeAutoscaleDeployment({ ...opts, sealed: false })).rejects.toThrow(/unencrypted|sealed/);
  expect(calls).toEqual([]);
});
it('requires isolated preparation environment support before writing secrets', async () => {
  const opts = await options(); caps = caps.filter(cap => cap !== 'docker.prepareAttemptEnv');
  await expect(prepareNodeAutoscaleDeployment(opts)).rejects.toThrow(/agent/i);
  expect(calls).not.toContain('file.writeEnv'); expect(opts.client.prepare).not.toHaveBeenCalled();
});
it('requires the recovery handoff capability before writing secrets or creating capacity', async () => {
  const opts = await options(); caps = caps.filter(cap => cap !== 'docker.retireHandoff');
  await expect(prepareNodeAutoscaleDeployment(opts)).rejects.toThrow(/agent/i);
  expect(calls).not.toContain('file.writeEnv'); expect(opts.client.prepare).not.toHaveBeenCalled();
});
it('uses a distinct request-bound environment for each attempt', async () => {
  const opts = await options();
  await prepareNodeAutoscaleDeployment(opts); await prepareNodeAutoscaleDeployment(opts);
  const paths = opts.client.prepare.mock.calls.map(call => call[0].specs[0].envFile as string);
  const requestIds = opts.client.prepare.mock.calls.map(call => call[0].requestId as string);
  expect(requestIds[0]).toBe(requestIds[1]); expect(paths[0]).not.toBe(paths[1]);
  for (const path of paths) expect(path).toMatch(new RegExp(`^\\.agent-env/nd-prep-${requestIds[0]}-[a-f0-9]{32}\\.env$`));
});
it('does not delete another concurrent attempt environment when its own preparation finishes', async () => {
  const opts = await options(), prepare = opts.client.prepare.getMockImplementation()!;
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let count = 0;
  opts.client.prepare.mockImplementation(async input => {
    if (++count === 1) { entered(); await blocked; }
    return prepare(input);
  });
  const first = prepareNodeAutoscaleDeployment(opts); await ready;
  try {
    await prepareNodeAutoscaleDeployment(opts);
    const writes = agent.mock.calls.filter(call => call[0] === 'file.writeEnv').map(call => call[1].name);
    const deletes = agent.mock.calls.filter(call => call[0] === 'file.deleteEnv').map(call => call[1].name);
    expect(writes).toHaveLength(2); expect(writes[0]).not.toBe(writes[1]); expect(deletes).toEqual([writes[1]]);
  } finally { release(); await first; }
});
it('defers panel-side environment cleanup while preparation may still be running', async () => {
  const opts = await options(), messages: string[] = []; opts.log = line => messages.push(line);
  opts.client.prepare.mockRejectedValue(new Error('reply lost'));
  await expect(prepareNodeAutoscaleDeployment(opts)).rejects.toThrow('reply lost');
  expect(calls).toContain('file.writeEnv'); expect(calls).not.toContain('file.deleteEnv');
  expect(messages).toContain('Node environment cleanup deferred: preparation outcome is unconfirmed.');
});
it('retains the environment if ownership changes while preparation is in flight', async () => {
  const opts = await options(); let current = true;
  opts.checkpoint = async () => { if (!current) throw new Error('owner changed'); };
  const prepare = opts.client.prepare.getMockImplementation()!;
  opts.client.prepare.mockImplementation(async input => { const reply = await prepare(input); current = false; return reply; });
  await expect(prepareNodeAutoscaleDeployment(opts)).rejects.toThrow('owner changed');
  expect(opts.client.prepare).toHaveBeenCalledTimes(1);
  expect(calls).not.toContain('file.deleteEnv');
});
it('does not start preparation when ownership is lost during the fence request', async () => {
  const opts = await options(); let current = true;
  opts.checkpoint = async () => { if (!current) throw new Error('owner changed'); };
  const fence = opts.client.fence.getMockImplementation()!;
  opts.client.fence.mockImplementation(async input => { const reply = await fence(input); current = false; return reply; });
  await expect(prepareNodeAutoscaleDeployment(opts)).rejects.toThrow('owner changed');
  expect(opts.client.prepare).not.toHaveBeenCalled(); expect(calls).toContain('file.deleteEnv');
});
it('rejects ambiguous image inspection before creating an environment file', async () => {
  const opts = await options(), original = opts.agent;
  opts.agent = async (op, params, sink, extra) => op === 'docker.imageInspect'
    ? { exitCode: 0, lines: [`sha256:${'f'.repeat(64)}|1234`, `sha256:${'e'.repeat(64)}|1234`] }
    : original(op, params, sink, extra);
  await expect(prepareNodeAutoscaleDeployment(opts)).rejects.toThrow(/image is unconfirmed/);
  expect(calls).not.toContain('file.writeEnv'); expect(opts.client.fence).not.toHaveBeenCalled();
});
it('reports an unconfirmed environment cleanup without claiming the deployment failed', async () => {
  const opts = await options(), original = opts.agent, messages: string[] = [];
  opts.log = line => messages.push(line);
  opts.agent = async (op, params, sink, extra) => op === 'file.deleteEnv'
    ? { exitCode: 1, lines: [] } : original(op, params, sink, extra);
  await expect(prepareNodeAutoscaleDeployment(opts)).resolves.toMatchObject({ replicas: 1 });
  expect(messages).toContain('Node environment file cleanup is unconfirmed.');
});
