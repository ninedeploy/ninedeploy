import { beforeEach, describe, expect, it, vi } from 'vitest';
import { templateRoutes } from '../src/modules/templates.js';
import { asUser, buildTestApp, createFakeDb, dbRow, depRow, svcRow } from './helpers.js';

const databaseMocks = vi.hoisted(() => ({
  startDatabase: vi.fn(async () => undefined),
  defaultPort: vi.fn(() => 3306),
  ENGINES: {
    mysql: { username: () => 'root', dbName: () => 'app' },
    postgres: { username: () => 'nine', dbName: () => 'app' },
  },
}));
vi.mock('../src/engine/database.js', () => databaseMocks);

describe('template routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseMocks.startDatabase.mockResolvedValue(undefined);
  });

  it('lists template summaries', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows).toHaveLength(89);
    expect(rows.some((row: { id: string }) => row.id === 'umami-stack')).toBe(true);
    expect(rows[0]).toMatchObject({ id: 'n8n', name: 'n8n', category: 'Automation', runtimeVerified: true });
    expect(rows[0]).not.toHaveProperty('description');
  });

  it('returns a full template by id', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);
    const res = await app.inject({ method: 'GET', url: '/n8n', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'n8n', image: 'n8nio/n8n', port: 5678 });
  });

  it('returns 404 for an unknown template', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);
    const res = await app.inject({ method: 'GET', url: '/nope', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('exposes curated community templates without falsely marking them verified', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);
    const res = await app.inject({ method: 'GET', url: '/ollama', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'ollama', runtimeVerified: false });
  });

  it('generates fresh secrets for secret env values on one-click deploys', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          services: [svcRow({ id: 7, name: 'Grafana', slug: 'grafana-0001' })],
          deployments: [depRow({ id: 8 })],
          env_vars: [{ id: 1, key: 'GF_SECURITY_ADMIN_PASSWORD', valueEncrypted: 'x', isSecret: true }],
        },
      }),
    });
    await app.register(templateRoutes);
    const res = await app.inject({ method: 'POST', url: '/grafana/deploy', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The generated secret is returned once and is NOT the registry default.
    expect(body.generatedSecrets).toHaveLength(1);
    expect(body.generatedSecrets[0]).toMatchObject({ key: 'GF_SECURITY_ADMIN_PASSWORD' });
    expect(body.generatedSecrets[0].value).not.toBe('admin');
    expect(body.generatedSecrets[0].value.length).toBeGreaterThanOrEqual(16);
  });

  it('deploys a template with env vars and a secret', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          services: [svcRow({ id: 7, name: 'Grafana', slug: 'grafana-0001' })],
          deployments: [depRow({ id: 8 })],
          env_vars: [{ id: 1, key: 'GF_SECURITY_ADMIN_PASSWORD', valueEncrypted: 'x', isSecret: true }],
        },
      }),
    });
    await app.register(templateRoutes);
    const res = await app.inject({ method: 'POST', url: '/grafana/deploy', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ serviceId: 7, deploymentId: 8 });
  });

  it('deploys a template with a non-secret env var', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          services: [svcRow({ id: 7, name: 'Vaultwarden', slug: 'vaultwarden-0001' })],
          deployments: [depRow({ id: 8 })],
          env_vars: [{ id: 1, key: 'ROCKET_PORT', valueEncrypted: 'x', isSecret: false }],
        },
      }),
    });
    await app.register(templateRoutes);
    const res = await app.inject({ method: 'POST', url: '/vaultwarden/deploy', headers: asUser() });
    expect(res.statusCode).toBe(200);
  });

  it('deploys a template with no env section', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        insert: { services: [svcRow({ id: 7, name: 'n8n', slug: 'n8n-0001' })], deployments: [depRow({ id: 8 })] },
      }),
    });
    await app.register(templateRoutes);
    const res = await app.inject({ method: 'POST', url: '/n8n/deploy', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ serviceId: 7, deploymentId: 8 });
  });

  it('deploys a template without a volume mount', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          services: [svcRow({ id: 7, name: 'Excalidraw', slug: 'excalidraw-0001', volumeMount: null })],
          deployments: [depRow({ id: 8 })],
        },
      }),
    });
    await app.register(templateRoutes);
    const res = await app.inject({ method: 'POST', url: '/excalidraw/deploy', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ serviceId: 7, deploymentId: 8 });
  });

  it('updates an existing template variable from an explicit override', async () => {
    let envUpdate: Record<string, unknown> | undefined;
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          env_vars: [{ id: 4, serviceId: 7, key: 'GF_SECURITY_ADMIN_PASSWORD', valueEncrypted: 'old', isSecret: true }],
        },
        insert: {
          services: [svcRow({ id: 7, name: 'Grafana', slug: 'grafana' })],
          deployments: [depRow({ id: 8, serviceId: 7, status: 'queued' })],
        },
        update: {
          env_vars: (value) => { envUpdate = value as Record<string, unknown>; return [value as Record<string, unknown>]; },
        },
      }),
    });
    await app.register(templateRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/grafana/deploy',
      headers: asUser(),
      payload: { env: [{ key: 'GF_SECURITY_ADMIN_PASSWORD', value: 'chosen', isSecret: true }] },
    });
    expect(res.statusCode).toBe(200);
    expect(envUpdate).toMatchObject({ isSecret: true });
    expect(res.json().generatedSecrets).toEqual([]);
  });

  it('allows an explicitly labelled community template to enter the normal deployment pipeline', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          services: [svcRow({ id: 17, name: 'Ollama', slug: 'ollama-0001' })],
          deployments: [depRow({ id: 18 })],
        },
      }),
    });
    await app.register(templateRoutes);

    const res = await app.inject({ method: 'POST', url: '/ollama/deploy', headers: asUser() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ serviceId: 17, deploymentId: 18 });
  });

  it('durably queues database provisioning for the worker before a CLI template deploy', async () => {
    let serviceInsert: Record<string, unknown> | undefined;
    let attachmentInsert: Record<string, unknown> | undefined;
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          services: (value) => {
            serviceInsert = value as Record<string, unknown>;
            return [svcRow({ id: 7, name: 'WordPress', slug: 'wordpress-0001' })];
          },
          databases: (value) => [dbRow({ ...(value as Record<string, unknown>), id: 9 })],
          database_attachments: (value) => {
            attachmentInsert = value as Record<string, unknown>;
            return [{ id: 11, ...(value as Record<string, unknown>) }];
          },
          deployments: [depRow({ id: 8 })],
        },
      }),
    });
    await app.register(templateRoutes);

    const res = await app.inject({ method: 'POST', url: '/wordpress/deploy', headers: asUser() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ serviceId: 7, deploymentId: 8, databaseId: null });
    expect(serviceInsert?.templateDatabaseEnv).toEqual({
      WORDPRESS_DB_HOST: 'host', // internal bridge alias — see registry note
      WORDPRESS_DB_USER: 'username',
      WORDPRESS_DB_PASSWORD: 'password',
      WORDPRESS_DB_NAME: 'database',
    });
    expect(serviceInsert?.templateId).toBe('wordpress');
    expect(databaseMocks.startDatabase).not.toHaveBeenCalled();
    expect(attachmentInsert).toBeUndefined();
  });

  it('prepares a database-backed service identity without waiting for dependency provisioning', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          services: (value) => [svcRow({ ...(value as Record<string, unknown>), id: 15 })],
          databases: () => { throw new Error('prepare must not create database'); },
          database_attachments: () => { throw new Error('prepare must not attach database'); },
          deployments: [depRow({ id: 16, serviceId: 15, status: 'queued', message: 'Deploy from template: Ghost' })],
        },
      }),
    });
    await app.register(templateRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/ghost/prepare',
      headers: asUser(),
      payload: { name: 'Ghost' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ serviceId: 15, serviceName: 'Ghost', serviceSlug: 'ghost', deploymentId: 16 });
    expect(databaseMocks.startDatabase).not.toHaveBeenCalled();
  });

  it('reuses an in-flight durable deployment without provisioning in the request', async () => {
    let deploymentUpdate: Record<string, unknown> | undefined;
    const existingService = svcRow({
      id: 25,
      ownerUserId: 1,
      name: 'Ghost',
      slug: 'ghost',
      image: 'ghost:5-alpine',
      port: 2368,
      volumeMount: '/var/lib/ghost/content',
      status: 'idle',
    });
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: existingService,
          deployments: depRow({
            id: 26,
            serviceId: 25,
            status: 'building',
            message: 'Provisioning template dependencies: Ghost',
          }),
        },
        insert: {
          databases: (value) => [dbRow({ ...(value as Record<string, unknown>), id: 27 })],
          deployments: () => { throw new Error('must reuse prepared deployment'); },
        },
        update: {
          deployments: (value) => {
            deploymentUpdate = value as Record<string, unknown>;
            return [value as Record<string, unknown>];
          },
        },
      }),
    });
    await app.register(templateRoutes);

    const res = await app.inject({ method: 'POST', url: '/ghost/deploy', headers: asUser(), payload: { name: 'Ghost' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ serviceId: 25, deploymentId: 26, databaseId: null, alreadyInProgress: true });
    expect(deploymentUpdate).toBeUndefined();
  });

  it('rejects a cross-repository image override for panel deploys', async () => {
    const app = await buildTestApp({ db: createFakeDb({}) });
    await app.register(templateRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/n8n/deploy',
      headers: asUser(),
      payload: { name: 'Automation', image: 'attacker/image' },
    });

    // The Hub tag override may only pin a version of the template's OWN
    // repository — a different repository would run unverified bytes under a
    // vetted template's name.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/repository/);
  });

  it('pins a same-repository image tag while keeping port and volume authoritative', async () => {
    let serviceInsert: Record<string, unknown> | undefined;
    const envInserts: Array<Record<string, unknown>> = [];
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          services: (value) => {
            serviceInsert = value as Record<string, unknown>;
            return [svcRow({ ...(value as Record<string, unknown>), id: 21 })];
          },
          env_vars: (value) => {
            envInserts.push(value as Record<string, unknown>);
            return [{ id: envInserts.length, ...(value as Record<string, unknown>) }];
          },
          deployments: [depRow({ id: 22, serviceId: 21, status: 'queued' })],
        },
      }),
    });
    await app.register(templateRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/n8n/deploy',
      headers: asUser(),
      payload: {
        name: 'Automation',
        image: 'n8nio/n8n:1.100.0',
        port: 9999,
        volumeMount: '/host',
      },
    });

    expect(res.statusCode).toBe(200);
    // The tag override survives; port and volume stay registry-controlled.
    expect(serviceInsert).toMatchObject({
      name: 'Automation',
      image: 'n8nio/n8n:1.100.0',
      port: 5678,
      volumeMount: '/home/node/.n8n',
    });
  });

  it('keeps registry-controlled runtime fields authoritative for panel deploys', async () => {
    let serviceInsert: Record<string, unknown> | undefined;
    const envInserts: Array<Record<string, unknown>> = [];
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          services: (value) => {
            serviceInsert = value as Record<string, unknown>;
            return [svcRow({ ...(value as Record<string, unknown>), id: 21 })];
          },
          env_vars: (value) => {
            envInserts.push(value as Record<string, unknown>);
            return [{ id: envInserts.length, ...(value as Record<string, unknown>) }];
          },
          deployments: [depRow({ id: 22, serviceId: 21, status: 'queued' })],
        },
      }),
    });
    await app.register(templateRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/n8n/deploy',
      headers: asUser(),
      payload: {
        name: 'Automation',
        serverId: 3,
        publishedPort: 8080,
        healthPath: '/healthz',
        cpuShares: 512,
        memLimitMb: 1024,
        env: [{ key: 'CUSTOM_SETTING', value: 'enabled', isSecret: false }],
        image: 'n8nio/n8n',
        port: 9999,
        volumeMount: '/host',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(serviceInsert).toMatchObject({
      name: 'Automation',
      slug: 'automation',
      serverId: 3,
      publishedPort: 8080,
      healthPath: '/healthz',
      cpuShares: 512,
      memLimitMb: 1024,
      image: 'n8nio/n8n',
      port: 5678,
      volumeMount: '/home/node/.n8n',
    });
    expect(envInserts).toContainEqual(expect.objectContaining({ key: 'CUSTOM_SETTING', serviceId: 21 }));
  });

  it('refuses a member template deploy onto a remote server (r097)', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/n8n/deploy',
      headers: asUser({ id: 7, isOperator: false }),
      payload: { name: 'Automation', serverId: 3 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('remote server');
  });

  it('reconciles an interrupted install without rotating secrets or duplicating its deployment', async () => {
    let serviceUpdate: Record<string, unknown> | undefined;
    const existing = svcRow({
      id: 31,
      ownerUserId: 1,
      name: 'Grafana',
      slug: 'grafana',
      image: 'grafana/grafana',
      port: 3000,
      volumeMount: '/var/lib/grafana',
      status: 'error',
      serverId: 9,
      publishedPort: 8081,
      healthPath: '/api/health',
      cpuShares: 256,
      memLimitMb: 512,
    });
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: existing,
          deployments: depRow({ id: 32, serviceId: 31, status: 'building' }),
        },
        findMany: {
          env_vars: [{ id: 33, serviceId: 31, key: 'GF_SECURITY_ADMIN_PASSWORD', valueEncrypted: 'preserved', isSecret: true }],
        },
        insert: {
          services: () => { throw new Error('must not duplicate service'); },
          env_vars: () => { throw new Error('must not rotate secret'); },
          deployments: () => { throw new Error('must not duplicate deployment'); },
        },
        update: {
          services: (value) => {
            serviceUpdate = value as Record<string, unknown>;
            return [value as Record<string, unknown>];
          },
        },
      }),
    });
    await app.register(templateRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/grafana/deploy',
      headers: asUser(),
      payload: { name: 'Grafana', serverId: 10, publishedPort: 8082 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ serviceId: 31, deploymentId: 32, alreadyInProgress: true, generatedSecrets: [] });
    expect(serviceUpdate).toMatchObject({ serverId: 10, publishedPort: 8082, healthPath: '/api/health', cpuShares: 256, memLimitMb: 512 });
  });

  it('fails atomically when the service or deployment row cannot be created', async () => {
    const noService = await buildTestApp({ db: createFakeDb({ insert: { services: [] } }) });
    await noService.register(templateRoutes);
    const serviceRes = await noService.inject({ method: 'POST', url: '/n8n/deploy', headers: asUser() });
    expect(serviceRes.statusCode).toBe(400);
    expect(serviceRes.json().error.message).toContain('Could not create template service');

    const noDeployment = await buildTestApp({
      db: createFakeDb({
        insert: {
          services: [svcRow({ id: 71, name: 'n8n', slug: 'n8n-0001' })],
          deployments: [],
        },
      }),
    });
    await noDeployment.register(templateRoutes);
    const deploymentRes = await noDeployment.inject({ method: 'POST', url: '/n8n/deploy', headers: asUser() });
    expect(deploymentRes.statusCode).toBe(400);
    expect(deploymentRes.json().error.message).toContain('Could not queue template deployment');
  });

  it('reuses and restarts an attached managed database on retry', async () => {
    const existingService = svcRow({
      id: 41,
      ownerUserId: 1,
      name: 'WordPress',
      slug: 'wordpress',
      image: 'wordpress:latest',
      port: 80,
      volumeMount: '/var/www/html',
      status: 'error',
    });
    const existingDatabase = dbRow({
      id: 42,
      ownerUserId: 1,
      name: 'WordPress DB',
      slug: 'wordpress-db',
      engine: 'mysql',
      status: 'error',
      containerName: 'nd-db-wordpress-db',
      internalPort: 3306,
    });
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: existingService,
          databases: existingDatabase,
          deployments: depRow({ id: 43, serviceId: 41, status: 'deploying' }),
        },
        findMany: {
          database_attachments: [{ id: 44, serviceId: 41, databaseId: 42, envAlias: 'DATABASE_URL' }],
        },
        insert: {
          services: () => { throw new Error('must not duplicate service'); },
          databases: () => { throw new Error('must not duplicate database'); },
          database_attachments: () => { throw new Error('must not duplicate attachment'); },
          deployments: () => { throw new Error('must not duplicate deployment'); },
        },
      }),
    });
    await app.register(templateRoutes);

    const res = await app.inject({ method: 'POST', url: '/wordpress/deploy', headers: asUser(), payload: { name: 'WordPress' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ serviceId: 41, databaseId: null, deploymentId: 43, alreadyInProgress: true });
    expect(databaseMocks.startDatabase).not.toHaveBeenCalled();
  });

  it('queues safely even when the request process cannot start Docker', async () => {
    databaseMocks.startDatabase.mockRejectedValueOnce(new Error('container exited'));
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          services: [svcRow({ id: 51, name: 'WordPress', slug: 'wordpress-0001' })],
          databases: [dbRow({ id: 52, ownerUserId: 1, slug: 'wordpress-0001-db', engine: 'mysql' })],
          deployments: [depRow({ id: 53, serviceId: 51, status: 'queued' })],
        },
      }),
    });
    await app.register(templateRoutes);

    const res = await app.inject({ method: 'POST', url: '/wordpress/deploy', headers: asUser() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deploymentId: 53, databaseId: null });
  });

  it('provisions every bundled managed-database template through the same contract', async () => {
    const ids = ['directus', 'ghost', 'hasura', 'matomo', 'umami', 'vikunja', 'wordpress', 'yourls'];
    for (const [index, id] of ids.entries()) {
      const serviceId = 100 + index;
      const databaseId = 200 + index;
      const app = await buildTestApp({
        db: createFakeDb({
          insert: {
            services: (value) => [svcRow({ ...(value as Record<string, unknown>), id: serviceId })],
            databases: (value) => [dbRow({ ...(value as Record<string, unknown>), id: databaseId })],
            deployments: [depRow({ id: 300 + index, serviceId, status: 'queued' })],
          },
        }),
      });
      await app.register(templateRoutes);

      const res = await app.inject({ method: 'POST', url: `/${id}/deploy`, headers: asUser() });

      expect(res.statusCode, id).toBe(200);
      expect(res.json(), id).toMatchObject({ serviceId, databaseId: null });
      await app.close();
    }
    expect(databaseMocks.startDatabase).not.toHaveBeenCalled();
  });

  it('rejects reuse when the stable service slug belongs to another owner', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: svcRow({
            id: 61,
            ownerUserId: 2,
            slug: 'grafana',
            image: 'grafana/grafana',
            port: 3000,
            volumeMount: '/var/lib/grafana',
          }),
        },
      }),
    });
    await app.register(templateRoutes);

    const res = await app.inject({ method: 'POST', url: '/grafana/deploy', headers: asUser(), payload: { name: 'Grafana' } });

    // The caller here is an ADMIN, who can see the colliding service — so the
    // explicit, actionable error stays.
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'slug_taken' } });
  });

  it('L-12: a member never learns that another tenant owns the slug', async () => {
    // Only the FIRST lookup finds the other tenant's service; the retried slug
    // is free, which is what a real database would report.
    let lookups = 0;
    const inserted: Record<string, unknown>[] = [];
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: () => (++lookups === 1
            ? svcRow({ id: 61, ownerUserId: 2, slug: 'grafana', image: 'grafana/grafana', port: 3000, volumeMount: '/var/lib/grafana' })
            : undefined),
        },
        insert: {
          services: (v: Record<string, unknown>) => {
            inserted.push(v);
            return [svcRow({ id: 77, ownerUserId: 5, slug: String(v['slug']) })];
          },
        },
      }),
    });
    await app.register(templateRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/grafana/deploy',
      headers: asUser({ id: 5, isOperator: false }),
      payload: { name: 'Grafana' },
    });

    // No 'slug_taken', no mention of the other service: the member simply gets
    // a service on a free slug derived from the one they asked for.
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain('slug_taken');
    expect(inserted).toHaveLength(1);
    // The collision-avoidance suffix is a base64url token (3 random bytes), so
    // it may contain `-` or `_` — match any URL-safe character after the dash.
    expect(String(inserted[0]!['slug'])).toMatch(/^grafana-[A-Za-z0-9_-]+$/);
    expect(String(inserted[0]!['slug'])).not.toBe('grafana');
  });

  /**
   * A compose template becomes a `type: 'compose'` service, and
   * `lib/hostPrivilege.ts` treats compose as a HOST privilege: the compose file
   * can bind-mount host paths or ask for a privileged container. This route
   * used to hard-code `type: 'docker'` in its privilege check, so a member
   * could stand up and queue a compose stack here — while
   * `assertMayDeployStoredService` correctly refused them the next deploy of
   * that very same service.
   */
  it('refuses a compose-stack template to a non-operator', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/umami-stack/deploy',
      headers: asUser({ id: 5, isOperator: false }),
      payload: { name: 'Umami' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/Compose deploys run/);
  });

  it('still lets a plain image template through for a non-operator', async () => {
    // The gate must key off what will actually be created, not refuse
    // everything: an ordinary `type: 'docker'` template stays open.
    const app = await buildTestApp({
      db: createFakeDb({
        insert: { services: (v: Record<string, unknown>) => [svcRow({ id: 78, ownerUserId: 5, slug: String(v['slug']) })] },
      }),
    });
    await app.register(templateRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/grafana/deploy',
      headers: asUser({ id: 5, isOperator: false }),
      payload: { name: 'Grafana' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('returns 404 when deploying an unknown template', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);
    const res = await app.inject({ method: 'POST', url: '/nope/deploy', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });
});
