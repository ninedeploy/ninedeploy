import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentRoutes } from '../src/modules/databases.js';
import { backupRoutes, databaseBackupRoutes } from '../src/modules/backups.js';
import { jobRoutes } from '../src/modules/jobs.js';
import { asUser, buildTestApp, createFakeDb, dbRow, svcRow } from './helpers.js';

/**
 * Phase 1 security-scan regressions (2026-08-20).
 *
 * Each route below carried an access check for ONE side of the request and
 * took the other side's id on trust:
 *
 *   H-1  POST /services/:id/attachments   checked the service, trusted databaseId
 *   M-2  GET  /services/:id/jobs/:jobId/runs  checked the service, trusted jobId
 *   M-1  GET  /databases/:id/backups|storage  checked nothing but the session
 *
 * The shared choke-point (`lib/resourceAccess.ts`) already existed in all three
 * cases — it simply was not called. These tests exist so a future refactor
 * cannot quietly drop the call again.
 */

const engineMocks = vi.hoisted(() => ({
  connectionString: vi.fn(() => 'postgres://nine:secret@nd-db-pg:5432/app'),
  databaseLogs: vi.fn(async () => []),
  defaultPort: vi.fn(() => 5432),
  restartDatabase: vi.fn(async () => undefined),
  startDatabase: vi.fn(async () => undefined),
  startDatabaseStudio: vi.fn(async () => undefined),
  stopDatabase: vi.fn(async () => undefined),
  stopDatabaseStudio: vi.fn(async () => undefined),
  backupDatabase: vi.fn(async () => undefined),
  createBackupReadStream: vi.fn(async () => 'dump'),
  databaseSize: vi.fn(async () => 1234),
  restoreDatabase: vi.fn(async () => undefined),
}));
vi.mock('../src/engine/database.js', () => ({
  ENGINES: { postgres: { username: () => 'nine', dbName: () => 'app' } },
  ...engineMocks,
}));

vi.mock('../src/lib/backupRemote.js', () => ({
  deleteRemoteBackup: vi.fn(async () => undefined),
  fetchRemoteBackup: vi.fn(async () => '/tmp/x'),
  uploadBackup: vi.fn(async () => undefined),
}));

vi.mock('../src/lib/jobRunner.js', () => ({ runJob: vi.fn(async () => undefined) }));

const configMock = vi.hoisted(() => ({
  wildcardDomain: '',
  isProd: false,
  publicUrl: 'http://localhost:3000',
  paths: { dataDir: '/tmp', backupsDir: '/tmp/backups', masterKeyFile: '/tmp/master.key' },
  jwt: { secret: 'x', accessTtl: '15m', refreshTtl: '7d' },
}));
vi.mock('../src/config.js', () => ({ config: configMock }));

const MEMBER = 7;
const OWNER = 42;
const asMember = () => asUser({ id: MEMBER, isOperator: false });
const asAdmin = () => asUser({ id: 1, isOperator: true });

/**
 * Collect the SQL column names referenced by a drizzle condition. The graph is
 * cyclic (Column → Table → Column), so JSON.stringify is not an option; walk it
 * with a seen-set instead.
 */
function columnsIn(node: unknown, seen = new WeakSet<object>()): string[] {
  if (node === null || typeof node !== 'object' || seen.has(node)) return [];
  seen.add(node);
  const self = (node as { name?: unknown; columnType?: unknown }).columnType
    && typeof (node as { name?: unknown }).name === 'string'
    ? [(node as { name: string }).name]
    : [];
  return [...self, ...Object.values(node as Record<string, unknown>).flatMap((v) => columnsIn(v, seen))];
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── H-1 ────────────────────────────────────────────────────────────────────

describe('H-1: attaching a database authorizes the DATABASE, not just the service', () => {
  /** Caller owns service 3; database 5 is whatever the test supplies. */
  async function attachApp(database: Record<string, unknown> | undefined) {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 3, ownerUserId: MEMBER }), databases: database },
        insert: { database_attachments: [{ id: 9, serviceId: 3, databaseId: 5, envAlias: 'DATABASE_URL' }] },
      }),
    });
    await app.register(attachmentRoutes, { prefix: '/services' });
    return app;
  }

  const attach = (app: Awaited<ReturnType<typeof attachApp>>, headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/services/3/attachments', headers, payload: { databaseId: 5 } });

  it("a member cannot attach another tenant's database to their own service", async () => {
    // Owned by OWNER and in no project. Before the fix this returned 200 and
    // the pipeline injected the database's decrypted password into the
    // caller's container environment.
    const app = await attachApp(dbRow({ id: 5, ownerUserId: OWNER, projectId: null }));
    const res = await attach(app, asMember());
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('Database not found');
  });

  it('a legacy NULL-owner database stays admin-only', async () => {
    const app = await attachApp(dbRow({ id: 5, ownerUserId: null, projectId: null }));
    expect((await attach(app, asMember())).statusCode).toBe(404);
    expect((await attach(app, asAdmin())).statusCode).toBe(200);
  });

  it('the owning member and admins can still attach', async () => {
    const app = await attachApp(dbRow({ id: 5, ownerUserId: MEMBER }));
    expect((await attach(app, asMember())).statusCode).toBe(200);
    expect((await attach(app, asAdmin())).statusCode).toBe(200);
  });

  it('a missing database still reports 404 (unchanged behaviour)', async () => {
    const app = await attachApp(undefined);
    const res = await attach(app, asAdmin());
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('Database not found');
  });
});

// ── M-2 ────────────────────────────────────────────────────────────────────

describe('M-2: job run history is scoped to the job’s own service', () => {
  const leakyRun = {
    id: 1,
    jobId: 11,
    status: 'completed',
    output: 'AWS_SECRET_ACCESS_KEY=leaked',
    exitCode: 0,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
  };

  const job = (over: Record<string, unknown>) => ({
    id: 11,
    serviceId: 3,
    name: 'nightly',
    cron: '* * * * *',
    kind: 'deploy',
    command: null,
    enabled: true,
    lastRunAt: null,
    createdAt: new Date(),
    ...over,
  });

  /** The caller owns service 3; the job row is whatever the test supplies. */
  async function runsApp(scheduledJob: Record<string, unknown> | undefined) {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 3, ownerUserId: MEMBER }), scheduled_jobs: scheduledJob },
        findMany: { job_runs: [leakyRun] },
      }),
    });
    await app.register(jobRoutes, { prefix: '/services' });
    return app;
  }

  it('an unknown jobId is a 404 instead of another service’s output', async () => {
    // The lookup is now `(jobs.id = jobId AND jobs.serviceId = id)`, so a job
    // belonging to a different service resolves to nothing.
    const app = await runsApp(undefined);
    const res = await app.inject({
      method: 'GET', url: '/services/3/jobs/11/runs', headers: asMember(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('leaked');
  });

  it('the run history of the service’s own job is still returned', async () => {
    const app = await runsApp(job({ serviceId: 3 }));
    const res = await app.inject({
      method: 'GET', url: '/services/3/jobs/11/runs', headers: asMember(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it('the job lookup is constrained by BOTH id and serviceId', async () => {
    // Guards the actual fix: the fake db ignores predicates, so assert that a
    // two-column condition was built rather than a bare `eq(jobRuns.jobId)`.
    const seen: unknown[] = [];
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: svcRow({ id: 3, ownerUserId: MEMBER }),
          scheduled_jobs: (args: unknown) => {
            seen.push(args);
            return job({ serviceId: 3 });
          },
        },
        findMany: { job_runs: [] },
      }),
    });
    await app.register(jobRoutes, { prefix: '/services' });
    await app.inject({ method: 'GET', url: '/services/3/jobs/11/runs', headers: asMember() });
    expect(seen).toHaveLength(1);
    const where = (seen[0] as { where?: unknown }).where;
    expect(columnsIn(where)).toEqual(expect.arrayContaining(['id', 'service_id']));
  });
});

// ── M-1 ────────────────────────────────────────────────────────────────────

describe('M-1: backup routes run the database access check', () => {
  const otherTenantDb = dbRow({ id: 5, ownerUserId: OWNER, projectId: null });
  const backupRow = {
    id: 1, databaseId: 5, status: 'completed', sizeBytes: 42,
    path: '/x', remoteKey: null, createdAt: new Date(),
  };

  async function backupApp(database: Record<string, unknown>) {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: database },
        findMany: {
          backups: [backupRow],
          // visibleDatabaseIds() reads the full database list for members.
          databases: [otherTenantDb],
          // Must return [] so wsIds = [] and visibleDatabaseIds returns [].
          // A non-operator member with no workspace memberships sees no databases.
          workspaceMembers: async () => [],
        },
        // select.databases omitted — default proxy returns [] for a member with
        // no workspace membership → visibleDatabaseIds = [], so the route
        // correctly returns no backups (no DBs to scope to).
      }),
    });
    await app.register(databaseBackupRoutes, { prefix: '/databases' });
    await app.register(backupRoutes, { prefix: '/backups' });
    return app;
  }

  it("a member cannot list another tenant's backups", async () => {
    const app = await backupApp(otherTenantDb);
    const res = await app.inject({ method: 'GET', url: '/databases/5/backups', headers: asMember() });
    expect(res.statusCode).toBe(404);
  });

  it("a member cannot probe another tenant's database size", async () => {
    const app = await backupApp(otherTenantDb);
    const res = await app.inject({ method: 'GET', url: '/databases/5/storage', headers: asMember() });
    expect(res.statusCode).toBe(404);
  });

  it('the instance-wide backup list is scoped to visible databases', async () => {
    const app = await backupApp(otherTenantDb);
    const res = await app.inject({ method: 'GET', url: '/backups', headers: asMember() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    // Database names were the disclosure that mattered on this route.
    expect(res.body).not.toContain('victim-payments-db');
  });

  it('admins still see every backup', async () => {
    const app = await backupApp(otherTenantDb);
    const res = await app.inject({ method: 'GET', url: '/backups', headers: asAdmin() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it('the owning member still sees their own database and backups', async () => {
    const app = await backupApp(dbRow({ id: 5, ownerUserId: MEMBER }));
    expect((await app.inject({ method: 'GET', url: '/databases/5/backups', headers: asMember() })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/databases/5/storage', headers: asMember() })).statusCode).toBe(200);
  });
});
