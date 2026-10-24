import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deployments, services } from '@ninedeploy/db';
import { observabilityDb } from '../fixtures/observability.js';

const h = vi.hoisted(() => ({ pipeline: vi.fn(async (..._args: unknown[]) => {}) }));
vi.mock('../../src/engine/pipeline.js', () => ({ runDeployment: h.pipeline }));
vi.mock('../../src/config.js', () => ({ config: { deployConcurrency: 2 } }));
vi.mock('../../src/lib/ciGate.js', () => ({ holdForCiIfNeeded: async () => false, pollCiGates: async () => [] }));
vi.mock('../../src/lib/exec.js', () => ({ capture: async () => '', run: async () => {} }));
vi.mock('../../src/engine/logs.js', () => ({ logBus: { publish() {}, beginRun() {}, end() {} } }));
const { default: worker } = await import('../../src/plugins/worker.js');
let f: Awaited<ReturnType<typeof observabilityDb>> | undefined;
let app: ReturnType<typeof Fastify> | undefined;
afterEach(async () => { await app?.close(); f?.close(); h.pipeline.mockReset(); });
async function boot() {
  f = await observabilityDb();
  app = Fastify({ logger: false }); app.decorate('db', f.db);
  await app.register(worker); await app.ready();
  return f.db;
}
async function until(check: () => boolean) {
  const deadline = performance.now() + 12_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('Worker transition proof timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
describe('routing transition exclusion through the real worker and SQLite', () => {
  it('holds the transitioning service while another service can use the free slot', async () => {
    const db = await boot();
    await db.insert(services).values({ id: 2, name: 'API', slug: 'api', type: 'docker', ownerUserId: 1 });
    await db.insert(deployments).values([
      { id: 1, serviceId: 1, status: 'deploying', startedAt: new Date(), createdAt: new Date(1000) },
      { id: 2, serviceId: 1, status: 'queued', createdAt: new Date(2000) },
      { id: 3, serviceId: 2, status: 'queued', createdAt: new Date(3000) },
    ]);
    h.pipeline.mockImplementation(async (_db, id) => { await db.update(deployments).set({ status: 'running' }).where(eq(deployments.id, id as number)); });
    await until(() => h.pipeline.mock.calls.some(c => c[1] === 3));
    expect(h.pipeline.mock.calls.map(c => c[1])).toEqual([3]);
    expect((await db.query.deployments.findFirst({ where: eq(deployments.id, 2) }))?.status).toBe('queued');
  });

  it('rechecks the transition inside the atomic claim after queue selection', async () => {
    const db = await boot();
    await db.insert(deployments).values({ id: 1, serviceId: 1, status: 'queued', createdAt: new Date(1000) });
    let resolved = false;
    const original = db.update.bind(db);
    db.update = ((table: Parameters<typeof db.update>[0]) => {
      const statement = original(table);
      return { set(values: Record<string, unknown>) {
        const chain = statement.set(values);
        return { async where(condition: Parameters<typeof chain.where>[0]) {
          if (table === deployments && values['status'] === 'building' && !resolved) {
            await db.insert(deployments).values({ id: 2, serviceId: 1, status: 'deploying', startedAt: new Date(), createdAt: new Date(2000) });
            const result = await chain.where(condition); resolved = true; return result;
          }
          return chain.where(condition);
        } };
      } };
    }) as typeof db.update;
    await until(() => resolved);
    expect((await db.query.deployments.findFirst({ where: eq(deployments.id, 1) }))?.status).toBe('queued');
    expect(h.pipeline).not.toHaveBeenCalled();
  });
});
