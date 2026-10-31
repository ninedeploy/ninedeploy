import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDb, eq, runMigrations, servers, services } from '@ninedeploy/db';
import { prepareNodeAutoscaleCapacity } from '../../src/engine/builders/nodeAutoscalePrepare.js';

let c: ReturnType<typeof createDb>;
const service = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
const owner = { serviceId: 1, serverId: 4, deploymentId: 9, epoch: 2, requestId: 'a'.repeat(32) };
const client = () => ({
  fence: vi.fn(async ({ timeoutMs: _timeout, ...request }) => ({ ...request, complete: true })),
  prepare: vi.fn(async input => ({ requestId: input.requestId, serviceId: input.serviceId, revision: input.revision, deploymentId: input.deploymentId, complete: true,
    items: input.specs.map((spec: { name: string }, index: number) => ({ id: String(index + 1).repeat(64), name: spec.name, deploymentId: input.deploymentId, running: input.startNames.includes(spec.name) })) })),
});
beforeEach(async () => {
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, status: 'running', runtimeId: 'web-8', port: 3000, publishedPort: 8080,
    volumeMount: '/data', autoscale: { minReplicas: 1, maxReplicas: 3, metric: 'cpu', target: 70, scaleUpSeconds: 60, scaleDownSeconds: 120 } });
});
afterEach(() => c.client?.close());

it('prepares all immutable capacity while exposing only the configured serving set', async () => {
  const agent = client();
  const result = await prepareNodeAutoscaleCapacity(agent, { service: await service(), owner, imageId: `sha256:${'f'.repeat(64)}`,
    envFile: '.agent-env/web-9.env', creationWatermark: 9, extraNetworks: ['nd-dbnet-main'] });
  expect(result.replicas).toBe(1); expect(result.serving).toHaveLength(1); expect(result.capacity).toHaveLength(3);
  const request = agent.prepare.mock.calls[0]![0];
  expect(request.startNames).toEqual(['web-9']);
  expect(request.specs.map((spec: { name: string }) => spec.name)).toEqual(['web-9', 'web-9-r2', 'web-9-r3']);
  for (const spec of request.specs) expect(spec).toMatchObject({ image: `sha256:${'f'.repeat(64)}`, extraNetworks: ['nd-dbnet-main'],
    volumes: [{ name: 'nd-svc-web-data', mount: '/data' }] });
  expect(request.specs[0].publish).toBe('8080:3000'); expect(request.specs[1].publish).toBeUndefined();
  expect(agent.fence.mock.calls[0]![0].revision).toBeLessThan(request.revision);
});
it('rejects an incomplete receipt and invalid inputs before preparing containers', async () => {
  const agent = client(), base = { service: await service(), owner, imageId: `sha256:${'f'.repeat(64)}`, envFile: '.agent-env/web-9.env', creationWatermark: 9 };
  await expect(prepareNodeAutoscaleCapacity(agent, { ...base, envFile: '.agent-env/other.env' })).rejects.toThrow(/environment/);
  await expect(prepareNodeAutoscaleCapacity(agent, { ...base, imageId: 'mutable:tag' })).rejects.toThrow(/image/);
  expect(agent.fence).not.toHaveBeenCalled();
  const prepare = agent.prepare.getMockImplementation()!;
  agent.prepare.mockImplementation(async input => ({ ...await prepare(input), items: [] }));
  await expect(prepareNodeAutoscaleCapacity(agent, base)).rejects.toThrow();
});
it('replays the identical preparation after a response is lost', async () => {
  const agent = client(), original = agent.prepare.getMockImplementation()!;
  let lost = true;
  agent.prepare.mockImplementation(async input => {
    const receipt = await original(input);
    if (lost) { lost = false; throw new Error('response lost'); }
    return receipt;
  });
  const result = await prepareNodeAutoscaleCapacity(agent, { service: await service(), owner, imageId: `sha256:${'f'.repeat(64)}`,
    envFile: '.agent-env/web-9.env', creationWatermark: 9 });
  expect(result.capacity).toHaveLength(3);
  expect(agent.prepare).toHaveBeenCalledTimes(2);
  expect(agent.prepare.mock.calls[1]![0]).toEqual(agent.prepare.mock.calls[0]![0]);
});
it('stops after one retry if preparation remains unavailable', async () => {
  const agent = client(); agent.prepare.mockRejectedValue(new Error('node offline'));
  await expect(prepareNodeAutoscaleCapacity(agent, { service: await service(), owner, imageId: `sha256:${'f'.repeat(64)}`,
    envFile: '.agent-env/web-9.env', creationWatermark: 9 })).rejects.toThrow('node offline');
  expect(agent.prepare).toHaveBeenCalledTimes(2);
});
