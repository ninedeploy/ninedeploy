import Fastify from 'fastify';
import { setImmediate as yieldIO } from 'node:timers';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import { deployments, nodeLifecycleIntents, primaryTransitions, servers, services } from '@ninedeploy/db';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';
import { observabilityDb } from '../fixtures/observability.js';
const work = vi.hoisted(() => ({ pipeline: vi.fn(async (..._args: unknown[]) => {}), ci: vi.fn(async (..._args: unknown[]) => false) }));
const io = vi.hoisted(() => ({ run: vi.fn(async (..._a: unknown[]) => {}), capture: vi.fn(async (..._a: unknown[]) => '') }));
vi.mock('../../src/config.js', () => ({ config: { deployConcurrency: 1 } }));
vi.mock('../../src/lib/exec.js', () => io);
vi.mock('../../src/engine/pipeline.js', () => ({ runDeployment: work.pipeline }));
vi.mock('../../src/lib/ciGate.js', () => ({ holdForCiIfNeeded: work.ci, pollCiGates: async () => [] }));
vi.mock('../../src/engine/logs.js', () => ({ logBus: { publish() {}, beginRun() {}, end() {} } }));
const { default: worker } = await import('../../src/plugins/worker.js');
let f: Awaited<ReturnType<typeof observabilityDb>>, app: ReturnType<typeof Fastify>;
afterEach(async () => { await app?.close(); f?.close(); io.run.mockReset(); io.capture.mockReset(); work.pipeline.mockClear(); work.ci.mockReset().mockResolvedValue(false); vi.useRealTimers(); });
it('hands a journalled primary transition to recovery instead of deleting a possibly routed candidate at boot', async () => {
  f = await observabilityDb();
  await f.db.update(services).set({ status: 'deploying' }).where(eq(services.id, 1));
  await f.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'deploying', startedAt: new Date() });
  await f.db.insert(primaryTransitions).values({ serviceId: 1, deploymentId: 9,
    previous: { runtimeId: 'web-7', port: 8080, healthPath: '/', healthCheck: 'http-strict', replicas: 1, commitSha: null, containers: [{ name: 'web-7', id: 'a'.repeat(64), observed: true }] },
    candidate: { runtimeId: 'web-9', port: 8080, healthPath: '/', healthCheck: 'http-strict', replicas: 1, commitSha: null, containers: [{ name: 'web-9', id: 'b'.repeat(64), observed: true }] },
    phase: 'routing', desiredRuntimeId: 'web-7', routingTouched: true,
  });
  io.capture.mockImplementation(async (...args) => (args[1] as string[])[0] === 'ps' ? 'web-9' : 'running');
  app = Fastify(); app.decorate('db', f.db); await app.register(worker); await app.ready();
  expect(io.run.mock.calls.filter(c => (c[1] as string[])[0] === 'rm')).toEqual([]);
  expect((await f.db.query.deployments.findFirst({ where: eq(deployments.id, 9) }))?.status).toBe('deploying');
  expect((await f.db.select().from(primaryTransitions))[0]?.interrupted).toBe(true);
});

async function protectedService() {
  f = await observabilityDb();
  await f.db.update(services).set({ status: 'deploying' }).where(eq(services.id, 1));
  await f.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'deploying', startedAt: new Date() });
  await f.db.insert(primaryTransitions).values({ serviceId: 1, deploymentId: 9,
    previous: { runtimeId: 'web-7', port: 8080, healthPath: '/', healthCheck: 'http-strict', replicas: 1, commitSha: null, containers: [{ name: 'web-7', id: 'a'.repeat(64), observed: true }] },
    candidate: { runtimeId: 'web-9', port: 8080, healthPath: '/', healthCheck: 'http-strict', replicas: 1, commitSha: null, containers: [{ name: 'web-9', id: 'b'.repeat(64), observed: true }] },
    phase: 'routing', desiredRuntimeId: 'web-7', routingTouched: true,
  });

}
async function startWorkerTick() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  app = Fastify(); app.decorate('db', f.db); await app.register(worker); await app.ready();
  await vi.advanceTimersByTimeAsync(2001);
  for (let i = 0; i < 1000; i++) await new Promise<void>(resolve => yieldIO(resolve));
}
it('leaves only the protected service queued while other services use the host deploy slot', async () => {
  await protectedService();
  await f.db.insert(services).values({ id: 2, name: 'Other', slug: 'other', type: 'docker' });
  await f.db.insert(deployments).values([{ id: 10, serviceId: 1, status: 'queued' }, { id: 11, serviceId: 2, status: 'queued' }]);
  await startWorkerTick();
  expect(work.pipeline.mock.calls.map(c => c[1])).toEqual([11]);
  expect((await f.db.query.deployments.findFirst({ where: eq(deployments.id, 10) }))?.status).toBe('queued');
});
it.each(['web-8', null])('leaves a node deployment queued while Stop is unsettled: runtime=%s', async runtimeId => {
  f = await observabilityDb();
  await f.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
  await f.db.update(services).set({ serverId: 4, runtimeId, status: 'running' }).where(eq(services.id, 1));
  await f.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'deploying' });
  const stop = await acceptNodeLifecycleIntent(f.db, (await f.db.query.services.findFirst({ where: eq(services.id, 1) }))!, 'stop');
  await f.db.insert(services).values({ id: 2, name: 'Other', slug: 'other', type: 'docker' });
  await f.db.insert(deployments).values([{ id: 10, serviceId: 1, status: 'queued' }, { id: 11, serviceId: 2, status: 'queued' }]);
  await startWorkerTick();
  expect(work.pipeline.mock.calls.map(c => c[1])).toEqual([11]);
  expect((await f.db.query.deployments.findFirst({ where: eq(deployments.id, 10) }))?.status).toBe('queued');
  await f.db.update(nodeLifecycleIntents).set({ phase: 'completed', completedAt: new Date() }).where(eq(nodeLifecycleIntents.id, stop.id));
  await vi.advanceTimersByTimeAsync(2001);
  for (let i = 0; i < 1000; i++) await new Promise<void>(resolve => yieldIO(resolve));
  expect(work.pipeline.mock.calls.map(c => c[1])).toEqual([11, 10]);
});
it('rechecks a journal created after queue selection inside the atomic claim', async () => {
  f = await observabilityDb(); await f.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'queued' });
  work.ci.mockImplementationOnce(async () => {
    await f.db.insert(primaryTransitions).values({ serviceId: 1, deploymentId: 8, candidate: { runtimeId: 'web-8', port: 8080, healthPath: '/', healthCheck: null, replicas: 1, commitSha: null, containers: [] } });
    return false;
  });
  await startWorkerTick();
  expect(work.ci).toHaveBeenCalled(); expect(work.pipeline).not.toHaveBeenCalled();
  expect((await f.db.query.deployments.findFirst({ where: eq(deployments.id, 9) }))?.status).toBe('queued');
});
it('never requeues a journalled stale build as a fresh deployment', async () => {
  await protectedService();
  await f.db.update(deployments).set({ status: 'building', startedAt: new Date(Date.now() - 90 * 60_000) }).where(eq(deployments.id, 9));
  await startWorkerTick();
  expect((await f.db.query.deployments.findFirst({ where: eq(deployments.id, 9) }))?.status).toBe('building');
  expect(work.pipeline).not.toHaveBeenCalled(); expect(io.run).not.toHaveBeenCalled();
});
