import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDb, deployments, eq, runMigrations, servers, services } from '@ninedeploy/db';
import { admitNodeAutoscale } from '../../src/lib/nodeAutoscaleAuthority.js';
import { nodeAutoscaleRuntime } from '../../src/lib/nodeAutoscaleRuntime.js';
import { reserveServiceRuntimeOwner } from '../../src/lib/serviceRuntimeOwner.js';

const io = vi.hoisted(() => ({ client: vi.fn(), sealed: vi.fn(), agent: vi.fn(), refusal: vi.fn(), ready: vi.fn(), route: vi.fn() }));
vi.mock('../../src/lib/nodeRuntimeMutationClient.js', () => ({ createNodeRuntimeMutationClient: io.client }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.agent, agentTransportSealed: io.sealed }));
vi.mock('../../src/lib/agentCapabilities.js', () => ({ capabilityRefusal: io.refusal }));
vi.mock('../../src/lib/nodeReadiness.js', () => ({ verifyNodeReadiness: io.ready }));
vi.mock('../../src/engine/proxy.js', () => ({ writeDynamicConfig: io.route }));
let c: ReturnType<typeof createDb>;
const service = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
beforeEach(async () => {
  vi.resetAllMocks(); io.sealed.mockResolvedValue(true); io.refusal.mockResolvedValue(null); io.ready.mockResolvedValue(true); io.route.mockResolvedValue(undefined);
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, status: 'running', runtimeId: 'web-9', port: 3000,
    healthCheck: 'http-strict', healthPath: '/ready', healthTimeoutSeconds: 30,
    autoscale: { minReplicas: 1, maxReplicas: 3, metric: 'cpu', target: 70, scaleUpSeconds: 60, scaleDownSeconds: 120 } });
  await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'running' });
});
afterEach(() => c.client?.close());

it.each([
  { healthCheck: null, port: 3000, expected: 'tcp' },
  { healthCheck: null, port: null, expected: 'auto' },
  { healthCheck: 'running' as const, port: 3000, expected: 'running' },
])('applies the node readiness policy before scaling: $expected', async ({ healthCheck, port, expected }) => {
  await c.db.update(services).set({ healthCheck, port }).where(eq(services.id, 1));
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  await nodeAutoscaleRuntime(c.db, admission).ready(admission.service, [{ id: 'a'.repeat(64), name: 'web-9-r2', deploymentId: 9 }]);
  expect(io.ready.mock.calls[0]![1]).toMatchObject({ mode: expected, port });
});
it('uses sealed readiness with immutable IDs and binds scale-up promotion to the owner', async () => {
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const runtime = nodeAutoscaleRuntime(c.db, admission);
  const target = { id: 'a'.repeat(64), name: 'web-9-r2', deploymentId: 9 };
  await expect(runtime.ready(admission.service, [target])).resolves.toBe(true);
  expect(io.refusal).toHaveBeenCalledWith(expect.any(Function), '#4', true, expect.objectContaining({ cap: 'docker.readiness', sealedRequired: true }));
  expect(io.ready).toHaveBeenCalledWith(expect.any(Function), { targets: [{ id: target.id, name: target.name }], port: 3000, path: '/ready', mode: 'http-strict' }, 30_000, expect.any(Function), expect.any(Function));
  await runtime.route(admission.service, 4);
  expect(io.route).toHaveBeenCalledWith(c.db, expect.objectContaining({ requireNode: 4, confirmNodeRouting: true, requireOrderedNode: true,
    autoscalePromotion: { serviceId: 1, workerToken: admission.workerToken, ownerEpoch: admission.owner.epoch, requestId: admission.owner.requestId } }));
});
it('requires ordered confirmation for scale-down without a scale-up promotion', async () => {
  await c.db.update(services).set({ runtimeReplicas: 2 }).where(eq(services.id, 1));
  const admission = (await admitNodeAutoscale(c.db, await service(), 1))!;
  await nodeAutoscaleRuntime(c.db, admission).route(admission.service, 4);
  const options = io.route.mock.calls[0]![1];
  expect(options).toMatchObject({ requireNode: 4, confirmNodeRouting: true, requireOrderedNode: true });
  expect(options.autoscalePromotion).toBeUndefined();
});
it('refuses readiness if the agent lacks its sealed capability', async () => {
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  io.refusal.mockResolvedValue({ message: 'readiness unavailable' });
  await expect(nodeAutoscaleRuntime(c.db, admission).ready(admission.service, [{ id: 'a'.repeat(64), name: 'web-9-r2', deploymentId: 9 }])).rejects.toThrow('readiness unavailable');
  expect(io.ready).not.toHaveBeenCalled();
});
it('gives each mutation client a checkpoint that rejects a superseded owner', async () => {
  const admission = (await admitNodeAutoscale(c.db, await service(), 2))!;
  const fence = vi.fn(async () => ({ ok: true })); io.client.mockReturnValue({ fence });
  const request = { requestId: 'a'.repeat(32), serviceId: 1, revision: 4, timeoutMs: 1000, deploymentWatermark: 9 };
  await nodeAutoscaleRuntime(c.db, admission).fence(4, request);
  expect(fence).toHaveBeenCalledWith(request);
  const checkpoint = io.client.mock.calls[0]![2].checkpoint as () => Promise<void>;
  await expect(checkpoint()).resolves.toBeUndefined();
  await reserveServiceRuntimeOwner(c.db, 1, 'deploy', admission.owner, 'b'.repeat(32));
  await expect(checkpoint()).rejects.toThrow(/ownership/);
});
