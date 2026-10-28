import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, deployments, environments, runMigrations, services, users, workspaces } from '@ninedeploy/db';

/**
 * G5.5: the worker holds a deploy under a deploy freeze in the queue — every
 * trigger, as the check runs at claim time — says why once in its log, and
 * builds it once the freeze is lifted. Other deploys are not held up.
 */

const pipelineMock = vi.hoisted(() => ({ runDeployment: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock('../../src/engine/pipeline.js', () => pipelineMock);
const configMock = vi.hoisted(() => ({ config: { deployConcurrency: 2 } }));
vi.mock('../../src/config.js', () => configMock);
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
const logsMock = vi.hoisted(() => ({ logBus: { publish: vi.fn(), beginRun: vi.fn(), end: vi.fn() } }));
vi.mock('../../src/engine/logs.js', () => logsMock);
vi.mock('../../src/lib/exec.js', () => ({ capture: vi.fn(async () => ''), run: vi.fn(async () => undefined) }));

const { default: workerPlugin } = await import('../../src/plugins/worker.js');
const freezes = await import('../../src/lib/deployFreeze.js');

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
  await db.insert(environments).values({ id: 1, workspaceId: 1, name: 'production', slug: 'production' });
  await db.insert(services).values([
    { id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 2, environmentId: 1 },
    { id: 6, name: 'api', slug: 'api', type: 'docker', branch: 'main', ownerUserId: 2 },
  ] as never);
  pipelineMock.runDeployment.mockClear();
  logsMock.logBus.publish.mockClear();
});
afterEach(async () => {
  await app?.close();
});

describe('deploy freezes in the worker', () => {
  it('holds a frozen lane’s deploy as queued, builds the others, and builds it once lifted', async () => {
    const freeze = await freezes.createDeployFreeze(db, { scope: 'environment', targetId: 1, reason: 'release week' }, 2);
    await db.insert(deployments).values([
      { id: 60, serviceId: 5, status: 'queued', trigger: 'webhook' },
      { id: 61, serviceId: 6, status: 'queued', trigger: 'webhook' },
    ]);
    app = Fastify({ logger: false });
    app.decorate('db', db);
    await app.register(workerPlugin);
    await app.ready();

    await until(async () => pipelineMock.runDeployment.mock.calls.some((c) => c[1] === 61));
    await until(async () => logsMock.logBus.publish.mock.calls.some((c) => c[0] === 60));
    expect(await status(60)).toBe('queued');
    expect(pipelineMock.runDeployment.mock.calls.some((c) => c[1] === 60)).toBe(false);
    const lines = logsMock.logBus.publish.mock.calls.filter((c) => c[0] === 60).map((c) => String(c[1]));
    expect(lines).toEqual([expect.stringContaining('Deploy freeze on environment "production"')]);

    await freezes.liftDeployFreeze(db, freeze.id);
    await until(async () => pipelineMock.runDeployment.mock.calls.some((c) => c[1] === 60));
  });
});
