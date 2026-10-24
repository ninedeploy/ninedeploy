import Fastify from 'fastify';
import { setImmediate as yieldIO } from 'node:timers';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import { deployments, services, swarmTransitions } from '@ninedeploy/db';
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
async function journal(deploymentId = 9) {
  await f.db.insert(swarmTransitions).values({ serviceId: 1, deploymentId, managerNodeId: 'mgr0000000000000000000001', runtimeId: 'nd-web_web', payloadEncrypted: 'opaque-journal-for-worker-only', phase: 'submitted' });
}
async function protectedService() {
  f = await observabilityDb();
  await f.db.update(services).set({ status: 'deploying', orchestrator: 'swarm', runtimeId: 'nd-web_web' }).where(eq(services.id, 1));
  await f.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'deploying', startedAt: new Date() });
  await journal();
}
async function tick() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  app = Fastify(); app.decorate('db', f.db); await app.register(worker); await app.ready();
  await vi.advanceTimersByTimeAsync(2001);
  for (let i = 0; i < 1000; i++) await new Promise<void>(resolve => yieldIO(resolve));
}
it('hands an interrupted Swarm job to native recovery instead of failing or cleaning it at boot', async () => {
  await protectedService();
  io.capture.mockResolvedValue('web-9');
  app = Fastify(); app.decorate('db', f.db); await app.register(worker); await app.ready();
  expect((await f.db.query.deployments.findFirst({ where: eq(deployments.id, 9) }))?.status).toBe('deploying');
  expect((await f.db.select().from(swarmTransitions))[0]?.interrupted).toBe(true);
  expect(io.run.mock.calls.filter(call => (call[1] as string[])[0] === 'rm')).toEqual([]);
});
it('holds only the journalled service and frees its host slot for unrelated deployments', async () => {
  await protectedService();
  await f.db.insert(services).values({ id: 2, name: 'Other', slug: 'other', type: 'docker' });
  await f.db.insert(deployments).values([{ id: 10, serviceId: 1, status: 'queued' }, { id: 11, serviceId: 2, status: 'queued' }]);
  await tick();
  expect(work.pipeline.mock.calls.map(call => call[1])).toEqual([11]);
  expect((await f.db.query.deployments.findFirst({ where: eq(deployments.id, 10) }))?.status).toBe('queued');
});
it('rechecks a Swarm journal created after queue selection inside the atomic claim', async () => {
  f = await observabilityDb(); await f.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'queued' });
  work.ci.mockImplementationOnce(async () => { await journal(8); return false; });
  await tick();
  expect(work.ci).toHaveBeenCalled(); expect(work.pipeline).not.toHaveBeenCalled();
  expect((await f.db.query.deployments.findFirst({ where: eq(deployments.id, 9) }))?.status).toBe('queued');
});
it('does not requeue a journalled stale Swarm build as a fresh source deployment', async () => {
  await protectedService();
  await f.db.update(deployments).set({ status: 'building', startedAt: new Date(Date.now() - 90 * 60_000) }).where(eq(deployments.id, 9));
  await tick();
  expect((await f.db.query.deployments.findFirst({ where: eq(deployments.id, 9) }))?.status).toBe('building');
  expect(work.pipeline).not.toHaveBeenCalled();
});
