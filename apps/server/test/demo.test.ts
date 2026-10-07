import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConfigs, createDb, deployments, serviceWorkspaces, services, users, type DB } from '@ninedeploy/db';
import { demoRoutes } from '../src/modules/demo.js';
import { ensureDefaultWorkspace } from '../src/modules/workspaces.js';
import { serviceRole } from '../src/lib/resourceAccess.js';
import { asUser, buildTestApp, createFakeDb } from './helpers.js';
import { encrypt } from '../src/lib/crypto.js';

const auditMocks = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMocks);

const appWith = async (fixtures: Record<string, unknown>) => {
  const app = await buildTestApp({ db: createFakeDb(fixtures as never) });
  await app.register(demoRoutes, { prefix: '/demo' });
  return app;
};

describe('demo routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires authentication', async () => {
    const app = await appWith({});
    const res = await app.inject({ method: 'POST', url: '/demo/seed' });
    expect(res.statusCode).toBe(401);
  });

  it('creates ONE real demo service and queues its first build when nothing exists yet', async () => {
    let queuedValues: Record<string, unknown> | undefined;
    let serviceValues: Record<string, unknown> | undefined;
    const app = await appWith({
      findFirst: {
        projects: null,
        services: null,
        workspaces: null,
      },
      findMany: {
        workspaces: [],
      },
      insert: {
        projects: [{ id: 10, name: 'Next.js Demo', slug: 'nextjs-demo' }],
        services: (values: Record<string, unknown>) => {
          serviceValues = values;
          return [
            {
              id: 30,
              name: values.name,
              slug: values.slug,
              type: values.type,
              status: values.status,
              port: values.port,
            },
          ];
        },
        build_configs: [{ serviceId: 30 }],
        deployments: (values: Record<string, unknown>) => {
          queuedValues = values;
          return [{ id: 50, ...values }];
        },
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/demo/seed',
      headers: asUser(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.projectName).toBe('Next.js Demo');
    // Exactly ONE service, real state (idle — nothing is pretending to run),
    // built from the pinned public repo via its own Dockerfile.
    expect(body.services).toHaveLength(1);
    expect(body.services[0]).toMatchObject({
      id: 30,
      name: 'Next.js Demo',
      type: 'docker',
      status: 'idle',
      port: 3000,
    });
    expect(body.database).toBeNull();
    // The service row carries the pinned repo and its host port.
    expect(serviceValues?.repoUrl).toBe('https://github.com/ersinkoc/nextjs-test');
    expect(serviceValues?.publishedPort).toBe(3000);
    expect(serviceValues?.healthPath).toBe('/api/health');
    // And the first deployment is QUEUED for the deploy worker — the seed
    // must result in a real build, not fake rows.
    expect(queuedValues?.status).toBe('queued');
    expect(auditMocks.audit).toHaveBeenCalled();
  });

  it('re-seed is idempotent: returns the existing service and queues nothing', async () => {
    let deploymentsInserted = 0;
    const app = await appWith({
      findFirst: {
        projects: { id: 10, name: 'Next.js Demo', slug: 'nextjs-demo' },
        services: {
          id: 30,
          name: 'Next.js Demo',
          slug: 'nextjs-demo',
          type: 'docker',
          status: 'running',
          port: 3000,
        },
      },
      findMany: {
        workspaces: [],
      },
      insert: {
        deployments: (values: Record<string, unknown>) => {
          deploymentsInserted += 1;
          return [{ id: 50, ...values }];
        },
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/demo/seed',
      headers: asUser(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.services).toHaveLength(1);
    expect(body.services[0]).toMatchObject({ id: 30, status: 'running' });
    expect(body.database).toBeNull();
    // The build was already queued on the first seed — a re-seed must not
    // queue another one (or duplicate the project/workspace tags).
    expect(deploymentsInserted).toBe(0);
  });

  it('reaps the legacy fake demo rows before seeding the real one', async () => {
    // The pre-0.5.0 seed inserted rows CLAIMING to run (nginx image container,
    // PM2 service, a postgres row with no container). The new seed reaps them
    // first so a legacy install does not keep dead services on the dashboard.
    // The fake db's delete resolvers receive no predicate args — count the
    // sweeps instead: 8 tables (env, deployments, buildConfigs, project and
    // workspace tags, services, the database, the legacy project).
    let deleteCalls = 0;
    const sweep = () => {
      deleteCalls += 1;
      return [];
    };
    const app = await appWith({
      findFirst: {
        projects: { id: 11, name: 'Next.js Demo Stack', slug: 'nextjs-demo-stack' },
        services: null,
        databases: {
          id: 20, name: 'demo-postgres', slug: 'demo-postgres', engine: 'postgres',
          projectId: 11, passwordEncrypted: encrypt('demo_secure_pass_2026'),
        },
        workspaces: null,
      },
      select: {
        services: [
          { id: 31, slug: 'nextjs-docker-app', name: 'Next.js Docker App', type: 'docker', status: 'running', runtimeId: 'docker-nextjs-demo-container' },
          { id: 32, slug: 'nextjs-pm2-service', name: 'Next.js PM2 Service', type: 'pm2', status: 'running', runtimeId: 'pm2-nextjs-demo-process' },
        ],
      },
      findMany: {
        workspaces: [],
        service_projects: [],
        databases: [{ id: 20 }],
      },
      insert: {
        projects: [{ id: 10, name: 'Next.js Demo', slug: 'nextjs-demo' }],
        services: (values: Record<string, unknown>) => [{ id: 30, ...values }],
        build_configs: [{ serviceId: 30 }],
        deployments: [{ id: 50, status: 'queued' }],
      },
      delete: {
        env_vars: sweep,
        deployments: sweep,
        build_configs: sweep,
        service_projects: sweep,
        service_workspaces: sweep,
        services: sweep,
        databases: sweep,
        projects: sweep,
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/demo/seed',
      headers: asUser(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    // The NEW real demo is created regardless.
    expect(body.services[0]).toMatchObject({ id: 30, type: 'docker', status: 'idle' });
    // The legacy fake rows were swept across all 8 child/parent tables, plus
    // the legacy project's shared env vars (r541: no FK cascades them).
    expect(deleteCalls).toBe(9);
    expect(auditMocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'demo.legacy_reaped',
      expect.stringContaining('nextjs-docker-app'),
    );
  });

  it('r221: never reaps tenant rows that merely share the legacy slugs', async () => {
    let deleteCalls = 0;
    const sweep = () => {
      deleteCalls += 1;
      return [];
    };
    const app = await appWith({
      findFirst: {
        projects: { id: 11, name: 'Next.js Demo Stack', slug: 'nextjs-demo-stack' },
        services: null,
        // A real database: different credentials, not in the legacy project.
        databases: { id: 20, slug: 'demo-postgres', projectId: 99, passwordEncrypted: encrypt('a-real-secret') },
        workspaces: null,
      },
      select: {
        // A real service deployed under the same slug.
        services: [{ id: 31, slug: 'nextjs-docker-app', type: 'docker', status: 'running', runtimeId: 'nextjs-docker-app-1-17' }],
      },
      findMany: { workspaces: [] },
      insert: {
        projects: [{ id: 10, name: 'Next.js Demo', slug: 'nextjs-demo' }],
        services: (values: Record<string, unknown>) => [{ id: 30, ...values }],
        build_configs: [{ serviceId: 30 }],
        deployments: [{ id: 50, status: 'queued' }],
      },
      delete: {
        env_vars: sweep, deployments: sweep, build_configs: sweep, service_projects: sweep,
        service_workspaces: sweep, services: sweep, databases: sweep, projects: sweep,
      },
    });
    const res = await app.inject({ method: 'POST', url: '/demo/seed', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(deleteCalls).toBe(0);
    expect(auditMocks.audit).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'demo.legacy_reaped', expect.anything());
  });
});

// Real migrated SQLite (temp file: libsql transactions need a file, not
// :memory:) — the tag and atomicity contracts live in real tables/triggers.
describe('demo seed against a migrated database', () => {
  const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
  const OP = 1;
  const TENANT = 2;
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  async function freshDb(): Promise<DB> {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-demo-'));
    const created = createDb({ url: `file:${path.join(dir, 'test.db').split(path.sep).join('/')}` });
    cleanups.push(() => {
      created.client?.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file lock */
      }
    });
    await migrate(created.db, { migrationsFolder: MIGRATIONS });
    await created.db.insert(users).values([
      { id: OP, email: 'op@example.com', passwordHash: 'x', name: 'Op', isInstanceOperator: true },
      { id: TENANT, email: 'tenant@example.com', passwordHash: 'x', name: 'Tenant' },
    ]);
    return created.db;
  }

  async function seed(db: DB) {
    const app = await buildTestApp({ db });
    await app.register(demoRoutes, { prefix: '/demo' });
    return app.inject({ method: 'POST', url: '/demo/seed', headers: asUser({ id: OP, isOperator: true }) });
  }

  const demoService = (db: DB) => db.query.services.findFirst({ where: eq(services.slug, 'nextjs-demo') });

  it("F300: tags the demo service into the operator's own seats only, never a tenant workspace", async () => {
    // Workspaces minted by ensureDefaultWorkspace are slugged from the name
    // (`op-s-workspace`), so the old `personal-<id>` lookup missed and the
    // seed tagged EVERY workspace — giving each tenant owner `owner` on it.
    const db = await freshDb();
    const opWs = await ensureDefaultWorkspace(db, { id: OP, name: 'Op' });
    await ensureDefaultWorkspace(db, { id: TENANT, name: 'Tenant' });
    expect((await seed(db)).statusCode).toBe(200);
    const svc = (await demoService(db))!;
    const tags = await db.select().from(serviceWorkspaces).where(eq(serviceWorkspaces.serviceId, svc.id));
    expect(tags.map((t) => t.workspaceId)).toEqual([opWs.id]);
    expect(await serviceRole(db, svc, { id: TENANT, role: 'member', isOperator: false })).toBeNull();
  });

  it('F301: a seed that fails part-way persists nothing, so the retry builds a complete demo', async () => {
    const db = await freshDb();
    await ensureDefaultWorkspace(db, { id: OP, name: 'Op' });
    await db.run(sql.raw('CREATE TABLE f301_fail (n INTEGER)'));
    await db.run(sql.raw('INSERT INTO f301_fail VALUES (1)'));
    await db.run(
      sql.raw(
        "CREATE TRIGGER f301_inject BEFORE INSERT ON deployments WHEN (SELECT n FROM f301_fail) = 1 BEGIN SELECT RAISE(ABORT, 'injected'); END",
      ),
    );
    expect((await seed(db)).statusCode).toBe(500);
    // The service row is the re-seed idempotency key: it must not survive alone.
    expect(await demoService(db)).toBeUndefined();
    expect(await db.select().from(buildConfigs)).toHaveLength(0);

    await db.run(sql.raw('UPDATE f301_fail SET n = 0'));
    expect((await seed(db)).statusCode).toBe(200);
    const svc = (await demoService(db))!;
    expect(await db.select().from(buildConfigs).where(eq(buildConfigs.serviceId, svc.id))).toHaveLength(1);
    const deps = await db.select().from(deployments).where(eq(deployments.serviceId, svc.id));
    expect(deps.filter((d) => d.status === 'queued')).toHaveLength(1);
    expect(await db.select().from(serviceWorkspaces).where(eq(serviceWorkspaces.serviceId, svc.id))).toHaveLength(1);
  });
});
