import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, deployments, environments, runMigrations, services, users, workspaces } from '@ninedeploy/db';

/**
 * 0.16.13: the worker holds an unreviewed deploy into an approval-gated lane
 * instead of building it, keeps one waiting deploy per service, and drops a
 * service's older waiting deploys when a newer deploy of it starts. A real
 * migrated SQLite; the pipeline, the deploy log and docker are faked.
 */

const pipelineMock = vi.hoisted(() => ({ runDeployment: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock('../../src/engine/pipeline.js', () => pipelineMock);
const configMock = vi.hoisted(() => ({ config: { deployConcurrency: 1 } }));
vi.mock('../../src/config.js', () => configMock);
const auditMock = vi.hoisted(() => ({ audit: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock('../../src/lib/audit.js', () => auditMock);
const logsMock = vi.hoisted(() => ({ logBus: { publish: vi.fn(), beginRun: vi.fn(), end: vi.fn() } }));
vi.mock('../../src/engine/logs.js', () => logsMock);
vi.mock('../../src/lib/exec.js', () => ({ capture: vi.fn(async () => ''), run: vi.fn(async () => undefined) }));

const { default: workerPlugin } = await import('../../src/plugins/worker.js');

let db: DB;
let app: ReturnType<typeof Fastify>;

const status = async (id: number) => (await db.query.deployments.findFirst({ where: (d, { eq }) => eq(d.id, id) }))?.status;
const until = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 2, email: 'admin@example.com', passwordHash: 'x' });
  await db.insert(workspaces).values({ id: 1, name: 'Acme', slug: 'acme', ownerId: 2 });
  await db.insert(environments).values({ id: 1, workspaceId: 1, name: 'production', slug: 'production', requireApproval: true });
  await db.insert(services).values([
    { id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 2, environmentId: 1 },
    { id: 6, name: 'api', slug: 'api', type: 'docker', branch: 'main', ownerUserId: 2, environmentId: 1 },
    { id: 7, name: 'web-pr-1', slug: 'web-pr-1', type: 'docker', branch: 'pr', ownerUserId: 2, previewParentServiceId: 5 },
  ] as never);
  for (const f of [pipelineMock.runDeployment, auditMock.audit, logsMock.logBus.publish, logsMock.logBus.end]) f.mockClear();
});
afterEach(async () => {
  await app?.close();
});

const boot = async () => {
  app = Fastify({ logger: false });
  app.decorate('db', db);
  await app.register(workerPlugin);
  await app.ready();
};

describe('deploy approvals in the worker', () => {
  it('holds an unreviewed deploy, replaces an older waiting one, and builds a reviewed one', async () => {
    const t = Date.now();
    await db.insert(deployments).values([
      { id: 58, serviceId: 6, status: 'awaiting_approval', trigger: 'webhook', createdAt: new Date(t - 5000) },
      { id: 59, serviceId: 5, status: 'awaiting_approval', trigger: 'webhook', createdAt: new Date(t - 4000) },
      { id: 60, serviceId: 5, status: 'queued', trigger: 'webhook', createdAt: new Date(t - 3000) },
      { id: 61, serviceId: 6, status: 'queued', trigger: 'user', reviewedBy: 2, reviewedAt: new Date(), createdAt: new Date(t - 2000) },
    ]);
    await boot();
    await until(async () => pipelineMock.runDeployment.mock.calls.length > 0);

    expect(await status(60)).toBe('awaiting_approval');
    expect(await status(59)).toBe('cancelled'); // replaced by #60
    expect(pipelineMock.runDeployment.mock.calls[0]![1]).toBe(61);
    expect(await status(58)).toBe('cancelled'); // dropped: #61 of the same service started
    expect(auditMock.audit).toHaveBeenCalledWith(expect.anything(), 2, 'deploy.awaiting_approval', 'web #60', { serviceId: 5 });
    expect(logsMock.logBus.publish).toHaveBeenCalledWith(60, expect.stringContaining('Waiting for approval'));
    expect(logsMock.logBus.publish).toHaveBeenCalledWith(59, '⏹ Replaced by a newer deploy (#60) waiting for approval');
    expect(logsMock.logBus.publish).toHaveBeenCalledWith(58, '⏹ Dropped: a newer deploy (#61) of this service started');
  });

  it("holds a PR preview's deploy through its parent's lane, and builds once the lane needs no approval", async () => {
    await db.insert(deployments).values({ id: 70, serviceId: 7, status: 'queued', trigger: 'webhook' });
    await boot();
    await until(async () => (await status(70)) === 'awaiting_approval');
    expect(pipelineMock.runDeployment).not.toHaveBeenCalled();

    await db.update(environments).set({ requireApproval: false });
    await db.insert(deployments).values({ id: 71, serviceId: 7, status: 'queued', trigger: 'webhook' });
    await until(async () => pipelineMock.runDeployment.mock.calls.length > 0);
    expect(pipelineMock.runDeployment.mock.calls[0]![1]).toBe(71);
  });
});
