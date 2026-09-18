import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demoRoutes } from '../src/modules/demo.js';
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
    // The legacy fake rows were swept across all 8 child/parent tables.
    expect(deleteCalls).toBe(8);
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
