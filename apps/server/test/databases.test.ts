import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentRoutes, databasesRoutes } from '../src/modules/databases.js';
import { encrypt } from '../src/lib/crypto.js';
import { asUser, attachmentRow, backupRow, buildTestApp, createFakeDb, dbRow, svcRow } from './helpers.js';

const engineMocks = vi.hoisted(() => ({
  startDatabase: vi.fn(async (_d: unknown, log: (l: string) => void) => { log('starting'); }),
  stopDatabase: vi.fn(async (_d: unknown, log: (l: string) => void) => { log('stopping'); }),
  restartDatabase: vi.fn(async (_d: unknown, log: (l: string) => void) => { log('restarting'); }),
  databaseLogs: vi.fn(async (_d: unknown, _lines?: number) => ['log line 1', 'log line 2']),
  connectionString: vi.fn(() => 'postgres://conn'),
  defaultPort: vi.fn((_engine: string) => 5432),
  startDatabaseStudio: vi.fn(async (_d: unknown, _port: number, log: (l: string) => void) => { log('studio starting'); }),
  stopDatabaseStudio: vi.fn(async (_d: unknown, log: (l: string) => void) => { log('studio stopping'); }),
  adoptRetainedVolume: vi.fn(async () => ({ action: 'fresh' as const })),
  // Default: no volume of that name on the host. Never the real docker probe.
  volumeExists: vi.fn(async (_name: string) => false),
}));

// Partial ENGINES: `mysql` is a valid schema enum value but intentionally
// missing here so the "Unknown engine" branch of the create route is reachable.
vi.mock('../src/engine/database.js', async (importOriginal) => {
  // The real module is imported for its pure helpers (needsVolumeAdoption —
  // the adopted/retried gate under test); everything that touches docker or
  // the DB driver is stubbed below. The ENGINES override stays partial:
  // `mysql` is a valid schema enum value but intentionally missing here so
  // the "Unknown engine" branch of the create route is reachable.
  const actual = await importOriginal<typeof import('../src/engine/database.js')>();
  return {
    ...actual,
    ENGINES: {
      postgres: { username: () => 'nine', dbName: () => 'app' },
      redis: { username: () => undefined, dbName: () => undefined },
    },
    startDatabase: engineMocks.startDatabase,
    stopDatabase: engineMocks.stopDatabase,
    restartDatabase: engineMocks.restartDatabase,
    databaseLogs: engineMocks.databaseLogs,
    connectionString: engineMocks.connectionString,
    defaultPort: engineMocks.defaultPort,
    startDatabaseStudio: engineMocks.startDatabaseStudio,
    stopDatabaseStudio: engineMocks.stopDatabaseStudio,
    adoptRetainedVolume: engineMocks.adoptRetainedVolume,
    volumeExists: engineMocks.volumeExists,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('databases routes', () => {
  it('lists databases', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          databases: [
            { ...dbRow({ id: 1, status: 'running' }), attachments: [{ id: 1, service: { id: 10, name: 'web', slug: 'web' } }, { id: 2, service: null }] },
            dbRow({ id: 2, status: 'stopped', engine: 'redis' }),
          ],
        },
      }),
    });
    await app.register(databasesRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows[0]).toMatchObject({ id: 1, host: 'nd-db-pg', port: 5432, username: 'nine', database: 'app', connectionString: 'postgres://conn' });
    expect(rows[1]).toMatchObject({ id: 2, status: 'stopped', connectionString: null, username: null, database: null });
    // Optional project scoping (?projectId=) and its invalid-value fallback.
    const scoped = await app.inject({ method: 'GET', url: '/?projectId=2', headers: asUser() });
    expect(scoped.statusCode).toBe(200);
    const unscoped = await app.inject({ method: 'GET', url: '/?projectId=abc', headers: asUser() });
    expect(unscoped.statusCode).toBe(200);
  });

  it('creates and starts a database', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        insert: { databases: [dbRow({ id: 5, status: 'creating' })] },
        findFirst: { databases: dbRow({ id: 5, status: 'running' }) },
      }),
    });
    await app.register(databasesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'My DB', engine: 'postgres', version: '16' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 5, slug: 'pg', status: 'running' });
    expect(engineMocks.startDatabase).toHaveBeenCalled();
    expect(engineMocks.defaultPort).toHaveBeenCalledWith('postgres');
  });

  it('creates a database reusing an existing retained volume', async () => {
    const fakeDb = createFakeDb({
      // The INSERT stub mirrors what the route actually writes: a fresh row is
      // 'creating' with no marker yet, so the adoption gate fires.
      insert: { databases: [dbRow({ id: 8, volumeName: 'nd-db-old-data', status: 'creating' })] },
      findFirst: { databases: dbRow({ id: 8, volumeName: 'nd-db-old-data', status: 'running' }) },
    });    const app = await buildTestApp({ db: fakeDb });
    await app.register(databasesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'reconnected-db', engine: 'postgres', existingVolume: 'nd-db-old-data' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 8 });
    // A fresh row over a retained volume must go through adoption: the volume
    // may hold credentials from the deleted database that created it.
    expect(engineMocks.adoptRetainedVolume).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent creates on the same existingVolume (only one wins)', async () => {
    // The volume-clash check and the row insert are separated by awaits: two
    // concurrent creates with the SAME `existingVolume` could both pass the
    // check, both insert, and both mount one data directory — the loser's
    // stored password would no longer match the volume's real credentials.
    // Stateful fake that models a REAL async DB: the SELECT captures its
    // snapshot at EXECUTION time, but the result only resolves 25ms later —
    // after the OTHER request's insert has committed. That is exactly the
    // check-then-act window a naive implementation loses.
    const rows: Array<Record<string, unknown>> = [];
    let checks = 0;
    let releaseChecks: (() => void) | undefined;
    const _bothExecuted = new Promise<void>((resolve) => { releaseChecks = resolve; });
    const fakeDb = createFakeDb({
      select: {
        databases: () => {
          const snapshot = rows.slice(); // read at execution time
          checks += 1;
          if (checks === 2) releaseChecks?.();
          return new Promise((resolve) => setTimeout(() => resolve(snapshot), 25));
        },
      },
      insert: {
        databases: ((values: Record<string, unknown>) => {
          const row = { ...values, id: rows.length + 1 };
          rows.push(row);
          return [row];
        }) as never,
      },
      findFirst: { databases: dbRow({ id: 1, status: 'running' }) },
    });
    const app = await buildTestApp({ db: fakeDb });
    await app.register(databasesRoutes);

    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/',
        headers: asUser(),
        payload: { name: 'DB A', engine: 'postgres', existingVolume: 'nd-shared-data' },
      }),
      app.inject({
        method: 'POST',
        url: '/',
        headers: asUser(),
        payload: { name: 'DB B', engine: 'postgres', existingVolume: 'nd-shared-data' },
      }),
    ]);

    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 400]);
    expect(rows).toHaveLength(1);
  });

  describe('unclaimed volumes are operator-only (r096)', () => {
    // Tenant A deletes database `billing`; its volume is retained. Before r096
    // any member could re-create `billing` (or name the volume) and adoption
    // re-keyed A's data onto a row the member owns.
    const member = () => asUser({ id: 7, isOperator: false });
    const appFor = async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          insert: { databases: [dbRow({ id: 9, status: 'creating' })] },
          findFirst: { databases: dbRow({ id: 9, status: 'running' }) },
        }),
      });
      await app.register(databasesRoutes);
      return app;
    };

    it('refuses existingVolume for a non-operator', async () => {
      const app = await appFor();
      const res = await app.inject({
        method: 'POST',
        url: '/',
        headers: member(),
        payload: { name: 'x', engine: 'postgres', existingVolume: 'nd-db-billing-data' },
      });
      expect(res.statusCode).toBe(403);
      expect(engineMocks.adoptRetainedVolume).not.toHaveBeenCalled();
      expect(engineMocks.startDatabase).not.toHaveBeenCalled();
    });

    it('refuses a default name whose retained volume already exists on the host', async () => {
      engineMocks.volumeExists.mockResolvedValueOnce(true);
      const app = await appFor();
      const res = await app.inject({
        method: 'POST',
        url: '/',
        headers: member(),
        payload: { name: 'billing', engine: 'postgres' },
      });
      expect(res.statusCode).toBe(403);
      expect(engineMocks.volumeExists).toHaveBeenCalledWith('nd-db-billing-data');
      expect(engineMocks.adoptRetainedVolume).not.toHaveBeenCalled();
    });

    it('still lets a member create a database whose volume is fresh', async () => {
      const app = await appFor();
      const res = await app.inject({
        method: 'POST',
        url: '/',
        headers: member(),
        payload: { name: 'fresh', engine: 'postgres' },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  it('refuses a volume already owned by another database row', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        select: { databases: [dbRow({ id: 77, name: 'Other DB', volumeName: 'nd-db-old-data' })] },
      }),
    });
    await app.register(databasesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'thief-db', engine: 'postgres', existingVolume: 'nd-db-old-data' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { message: expect.stringContaining('already belongs to database "Other DB"') } });
    expect(engineMocks.startDatabase).not.toHaveBeenCalled();
  });

  it('surfaces adoption refusal as a failed create (volume kept, row marked error)', async () => {
    engineMocks.adoptRetainedVolume.mockRejectedValueOnce(
      new Error('Retained volume "nd-db-mysql-data" still holds mysql data whose credentials NineDeploy cannot re-key automatically'),
    );
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(databasesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'mysql-db', engine: 'redis' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { message: expect.stringContaining('cannot re-key') } });
    expect(engineMocks.startDatabase).not.toHaveBeenCalled();
  });

  it('resumes a matching caller-owned database for retryable Hub provisioning', async () => {
    const existing = dbRow({
      id: 9,
      ownerUserId: 1,
      name: 'directus-db',
      slug: 'directus-db',
      status: 'error',
      version: null,
      containerName: 'nd-db-directus-db',
    });
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { databases: existing } }) });
    await app.register(databasesRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'directus-db', engine: 'postgres', reuseExisting: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 9, status: 'running', host: 'nd-db-directus-db', port: 5432 });
    expect(engineMocks.startDatabase).toHaveBeenCalledWith(existing, expect.any(Function));
    // The retry of a FAILED first attempt is exactly where the retained-volume
    // trap re-opens: the row is 'error' with no marker, so its volume may hold
    // the deleted installation's credentials. Adoption must run again.
    expect(engineMocks.adoptRetainedVolume).toHaveBeenCalledTimes(1);
    expect(engineMocks.adoptRetainedVolume).toHaveBeenCalledWith(existing, expect.any(Function));
  });

  it('skips adoption for a row whose volume was already initialized under its own credentials', async () => {
    const existing = dbRow({
      id: 11,
      ownerUserId: 1,
      name: 'directus-db',
      slug: 'directus-db',
      status: 'stopped',
      version: null,
      containerName: 'nd-db-directus-db',
      initializedAt: new Date('2026-08-30T00:00:00Z'),
    });
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { databases: existing } }) });
    await app.register(databasesRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'directus-db', engine: 'postgres', reuseExisting: true },
    });

    expect(res.statusCode).toBe(200);
    expect(engineMocks.adoptRetainedVolume).not.toHaveBeenCalled();
    expect(engineMocks.startDatabase).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a same-name database owned by another user', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ ownerUserId: 2, slug: 'directus-db', name: 'directus-db', version: null }) },
      }),
    });
    await app.register(databasesRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'directus-db', engine: 'postgres', reuseExisting: true },
    });

    expect(res.statusCode).toBe(400);
    expect(engineMocks.startDatabase).not.toHaveBeenCalled();
  });

  it('rejects an unknown engine', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(databasesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'x', engine: 'mysql' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Unknown engine');
  });

  it('returns 400 when the insert fails', async () => {
    const app = await buildTestApp({ db: createFakeDb({ insert: { databases: [] } }) });
    await app.register(databasesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'x', engine: 'postgres' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('marks the database errored when startup fails', async () => {
    engineMocks.startDatabase.mockRejectedValueOnce(new Error('oom'));
    const app = await buildTestApp({
      db: createFakeDb({ insert: { databases: [dbRow({ id: 5 })] } }),
    });
    await app.register(databasesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'x', engine: 'postgres' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Failed to start database: oom');
  });

  it('formats non-Error startup failures', async () => {
    engineMocks.startDatabase.mockRejectedValueOnce('boom');
    const app = await buildTestApp({
      db: createFakeDb({ insert: { databases: [dbRow({ id: 5 })] } }),
    });
    await app.register(databasesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'x', engine: 'postgres' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Failed to start database: boom');
  });

  it('creates a redis database with nullable username and dbName', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        insert: { databases: [dbRow({ id: 5, engine: 'redis', status: 'creating' })] },
        findFirst: { databases: dbRow({ id: 5, engine: 'redis', status: 'running' }) },
      }),
    });
    await app.register(databasesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'cache', engine: 'redis' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 5, engine: 'redis', username: null, database: null });
  });

  it('gets a database by id', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { databases: dbRow({ id: 7 }) } }),
    });
    await app.register(databasesRoutes);
    const res = await app.inject({ method: 'GET', url: '/7', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 7 });
  });

  it('returns 404 for a missing database', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(databasesRoutes);
    const res = await app.inject({ method: 'GET', url: '/99', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('deletes a database and unlinks its backup files', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-dbdel-'));
    const dump = path.join(dir, 'backup.dump');
    writeFileSync(dump, 'data');
    try {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { databases: dbRow({ id: 7 }) },
          findMany: { backups: [backupRow({ id: 1, path: dump })] },
        }),
      });
      await app.register(databasesRoutes);
      const res = await app.inject({ method: 'DELETE', url: '/7', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(engineMocks.stopDatabase).toHaveBeenCalled();
      // The orphaned backup FILE is gone, not just the row.
      expect(existsSync(dump)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tolerates backup files that are missing or cannot be unlinked', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-dbdel-'));
    const locked = path.join(dir, 'not-a-file'); // a directory — unlink throws EISDIR
    mkdirSync(locked);
    try {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { databases: dbRow({ id: 7 }) },
          findMany: {
            backups: [
              backupRow({ id: 1, path: '/tmp/does-not-exist.dump' }),
              backupRow({ id: 2, path: locked }),
            ],
          },
        }),
      });
      await app.register(databasesRoutes);
      const res = await app.inject({ method: 'DELETE', url: '/7', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects deleting an in-use database unless force=true is passed', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          databases: {
            ...dbRow({ id: 7, name: 'prod-pg' }),
            attachments: [
              { service: { id: 1, name: 'api-svc', slug: 'api-svc' } },
              { service: null },
            ],
          },
        },
      }),
    });
    await app.register(databasesRoutes);

    // Blocked by default
    const resBlocked = await app.inject({ method: 'DELETE', url: '/7', headers: asUser() });
    expect(resBlocked.statusCode).toBe(400);
    expect(resBlocked.json().error.message).toContain('locked');
    expect(resBlocked.json().error.message).toContain('api-svc');

    // Allowed with force=true
    const resForce = await app.inject({ method: 'DELETE', url: '/7?force=true', headers: asUser() });
    expect(resForce.statusCode).toBe(200);
    expect(resForce.json()).toEqual({ ok: true });
  });

  it('returns 404 when deleting a missing database', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(databasesRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/99', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('applies limits and restarts a running database', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 7, status: 'running' }) },
        update: { databases: [dbRow({ id: 7, status: 'running', cpuShares: 512, memLimitMb: 1024 })] },
      }),
    });
    await app.register(databasesRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/7/limits',
      headers: asUser(),
      payload: { cpuShares: 512, memLimitMb: 1024 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cpuShares: 512, memLimitMb: 1024 });
    expect(engineMocks.stopDatabase).toHaveBeenCalled();
    expect(engineMocks.startDatabase).toHaveBeenCalled();
  });

  it('starts and stops Web Studio for a database', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 10, name: 'pg-prod', slug: 'pg-prod', engine: 'postgres', webGuiPort: null }) },
      }),
    });
    await app.register(databasesRoutes);

    // Start with custom port
    const resCustom = await app.inject({
      method: 'POST',
      url: '/10/studio',
      headers: asUser(),
      payload: { port: 18055 },
    });
    expect(resCustom.statusCode).toBe(200);
    expect(resCustom.json()).toMatchObject({ ok: true, port: 18055 });
    expect(engineMocks.startDatabaseStudio).toHaveBeenCalledWith(expect.anything(), 18055, expect.anything());

    // Start with default calculated port
    const resDefault = await app.inject({
      method: 'POST',
      url: '/10/studio',
      headers: asUser(),
    });
    expect(resDefault.statusCode).toBe(200);
    expect(resDefault.json()).toMatchObject({ ok: true, port: 18010 });

    // Stop studio
    const resStop = await app.inject({
      method: 'DELETE',
      url: '/10/studio',
      headers: asUser(),
    });
    expect(resStop.statusCode).toBe(200);
    expect(resStop.json()).toEqual({ ok: true });
    expect(engineMocks.stopDatabaseStudio).toHaveBeenCalled();

    // 404 for missing database on start / stop
    const appEmpty = await buildTestApp({ db: createFakeDb({ findFirst: { databases: null } }) });
    await appEmpty.register(databasesRoutes);
    const resNotFound1 = await appEmpty.inject({ method: 'POST', url: '/999/studio', headers: asUser() });
    expect(resNotFound1.statusCode).toBe(404);
    const resNotFound2 = await appEmpty.inject({ method: 'DELETE', url: '/999/studio', headers: asUser() });
    expect(resNotFound2.statusCode).toBe(404);
  });

  it('creates a postgres database with pgvector extension and vector version', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        insert: { databases: [dbRow({ id: 8, engine: 'postgres', version: 'vector', extensions: ['pgvector'] })] },
        findFirst: { databases: dbRow({ id: 8, engine: 'postgres', version: 'vector', extensions: ['pgvector'] }) },
      }),
    });
    await app.register(databasesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'vector-db', engine: 'postgres', extensions: ['pgvector'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 8, version: 'vector', extensions: ['pgvector'] });
  });

  it('does not restart a non-running database on limit changes', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 7, status: 'stopped' }) },
        update: { databases: [dbRow({ id: 7, status: 'stopped', cpuShares: 128, memLimitMb: 0 })] },
      }),
    });
    await app.register(databasesRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/7/limits',
      headers: asUser(),
      payload: { cpuShares: 128 },
    });
    expect(res.statusCode).toBe(200);
    expect(engineMocks.stopDatabase).not.toHaveBeenCalled();
  });

  it('returns 404 when updating limits on a missing database', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(databasesRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/99/limits',
      headers: asUser(),
      payload: { cpuShares: 128 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('restarts a database', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 3, name: 'pg-restart', status: 'running' }) },
        update: { databases: [dbRow({ id: 3, status: 'running' })] },
      }),
    });
    await app.register(databasesRoutes);
    const res = await app.inject({ method: 'POST', url: '/3/restart', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(engineMocks.restartDatabase).toHaveBeenCalled();

    const emptyApp = await buildTestApp({ db: createFakeDb() });
    await emptyApp.register(databasesRoutes);
    const notFoundRes = await emptyApp.inject({ method: 'POST', url: '/99/restart', headers: asUser() });
    expect(notFoundRes.statusCode).toBe(404);
  });

  it('stops a database', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 3, name: 'pg-stop', status: 'running' }) },
        update: { databases: [dbRow({ id: 3, status: 'stopped' })] },
      }),
    });
    await app.register(databasesRoutes);
    const res = await app.inject({ method: 'POST', url: '/3/stop', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(engineMocks.stopDatabase).toHaveBeenCalled();

    const emptyApp = await buildTestApp({ db: createFakeDb() });
    await emptyApp.register(databasesRoutes);
    const notFoundRes = await emptyApp.inject({ method: 'POST', url: '/99/stop', headers: asUser() });
    expect(notFoundRes.statusCode).toBe(404);
  });

  it('starts a database', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 3, name: 'pg-start', status: 'stopped' }) },
        update: { databases: [dbRow({ id: 3, status: 'running' })] },
      }),
    });
    await app.register(databasesRoutes);
    const res = await app.inject({ method: 'POST', url: '/3/start', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(engineMocks.startDatabase).toHaveBeenCalled();

    const emptyApp = await buildTestApp({ db: createFakeDb() });
    await emptyApp.register(databasesRoutes);
    const notFoundRes = await emptyApp.inject({ method: 'POST', url: '/99/start', headers: asUser() });
    expect(notFoundRes.statusCode).toBe(404);
  });

  it('retrieves database logs', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 3, name: 'pg-logs' }) },
      }),
    });
    await app.register(databasesRoutes);
    const res = await app.inject({ method: 'GET', url: '/3/logs?lines=50', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().logs).toEqual(['log line 1', 'log line 2']);

    const defaultLinesRes = await app.inject({ method: 'GET', url: '/3/logs', headers: asUser() });
    expect(defaultLinesRes.statusCode).toBe(200);

    const emptyApp = await buildTestApp({ db: createFakeDb() });
    await emptyApp.register(databasesRoutes);
    const notFoundRes = await emptyApp.inject({ method: 'GET', url: '/99/logs', headers: asUser() });
    expect(notFoundRes.statusCode).toBe(404);
  });

  it('retrieves database credentials', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 3, name: 'pg-creds', engine: 'postgres', passwordEncrypted: '' }) },
      }),
    });
    await app.register(databasesRoutes);
    const res = await app.inject({ method: 'GET', url: '/3/credentials', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      engine: 'postgres',
      username: 'nine',
      database: 'app',
      connectionString: 'postgres://conn',
    });

    const redisApp = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 4, name: 'redis-creds', engine: 'redis', username: 'rd-user', dbName: 'rd-db', passwordEncrypted: encrypt('enc-pass') }) },
      }),
    });
    await redisApp.register(databasesRoutes);
    const redisRes = await redisApp.inject({ method: 'GET', url: '/4/credentials', headers: asUser() });
    expect(redisRes.statusCode).toBe(200);

    const emptyApp = await buildTestApp({ db: createFakeDb() });
    await emptyApp.register(databasesRoutes);
    const notFoundRes = await emptyApp.inject({ method: 'GET', url: '/99/credentials', headers: asUser() });
    expect(notFoundRes.statusCode).toBe(404);
  });
});

describe('attachment routes', () => {
  it('lists attachments with resolved databases', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          databaseAttachments: [
            attachmentRow({ id: 1, databaseId: 2 }),
            attachmentRow({ id: 2, databaseId: 99 }),
          ],
        },
        // First lookup (databaseId 2) resolves; second (databaseId 99) is missing.
        findFirst: {
          services: svcRow(),
          databases: (() => {
            let n = 0;
            return () => (n++ === 0 ? dbRow({ id: 2, name: 'pg', engine: 'postgres' }) : undefined);
          })(),
        },
      }),
    });
    await app.register(attachmentRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/attachments', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows[0]).toMatchObject({ id: 1, databaseId: 2, database: { name: 'pg', engine: 'postgres', status: 'running' } });
    expect(rows[1]).toMatchObject({ id: 2, databaseId: 99, database: null });
  });

  it('requires a databaseId when attaching', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(attachmentRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/attachments', headers: asUser(), payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an attach request without a body', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(attachmentRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/attachments', headers: asUser() });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the service is missing', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(attachmentRoutes);
    const res = await app.inject({
      method: 'POST', url: '/99/attachments', headers: asUser(), payload: { databaseId: 2 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('Service not found');
  });

  it('returns 404 when the service or database is missing', async () => {
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: svcRow() } }) });
    await app.register(attachmentRoutes);
    const noDb = await app.inject({
      method: 'POST', url: '/1/attachments', headers: asUser(), payload: { databaseId: 2 },
    });
    expect(noDb.statusCode).toBe(404);
    expect(noDb.json().error.message).toBe('Database not found');
  });

  it('attaches a database with the default env alias', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow(), databases: dbRow({ id: 2, engine: 'postgres' }) },
        insert: { database_attachments: [attachmentRow({ id: 9, databaseId: 2, envAlias: 'DATABASE_URL' })] },
      }),
    });
    await app.register(attachmentRoutes);
    const res = await app.inject({
      method: 'POST', url: '/1/attachments', headers: asUser(), payload: { databaseId: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 9, databaseId: 2, envAlias: 'DATABASE_URL' });
  });

  it('uses REDIS_URL for redis and a custom alias when provided', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow(), databases: dbRow({ id: 2, engine: 'redis' }) },
        insert: { database_attachments: [attachmentRow({ id: 9, databaseId: 2, envAlias: 'REDIS_URL' })] },
      }),
    });
    await app.register(attachmentRoutes);
    const res = await app.inject({
      method: 'POST', url: '/1/attachments', headers: asUser(), payload: { databaseId: 2, envAlias: '  CACHE_URL  ' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ envAlias: 'CACHE_URL' });
  });

  it('rejects an env alias whose charset would break docker --env-file', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow(), databases: dbRow({ id: 2 }) },
      }),
    });
    await app.register(attachmentRoutes);
    const res = await app.inject({
      method: 'POST', url: '/1/attachments', headers: asUser(), payload: { databaseId: 2, envAlias: 'MY ALIAS' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('defaults the redis alias to REDIS_URL', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow(), databases: dbRow({ id: 2, engine: 'redis' }) },
        insert: { database_attachments: [attachmentRow({ id: 9, databaseId: 2, envAlias: 'REDIS_URL' })] },
      }),
    });
    await app.register(attachmentRoutes);
    const res = await app.inject({
      method: 'POST', url: '/1/attachments', headers: asUser(), payload: { databaseId: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ envAlias: 'REDIS_URL' });
  });

  it('returns 400 when the attachment already exists', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow(), databases: dbRow() },
        insert: { database_attachments: () => { throw new Error('UNIQUE constraint failed: database_attachments_service_database_idx'); } },
      }),
    });
    await app.register(attachmentRoutes);
    const res = await app.inject({
      method: 'POST', url: '/1/attachments', headers: asUser(), payload: { databaseId: 2 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Already attached');
  });

  it('reuses an existing attachment for a retryable Hub deploy', async () => {
    const existing = attachmentRow({ id: 12, serviceId: 1, databaseId: 2, envAlias: 'DATABASE_URL' });
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow(), databases: dbRow({ id: 2 }), databaseAttachments: existing },
      }),
    });
    await app.register(attachmentRoutes);
    const res = await app.inject({
      method: 'POST', url: '/1/attachments', headers: asUser(), payload: { databaseId: 2, reuseExisting: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 12, databaseId: 2, envAlias: 'DATABASE_URL' });
  });

  it('detaches a database', async () => {
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: svcRow() } }) });
    await app.register(attachmentRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/1/attachments/5', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('404s when detaching an unknown attachment', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow() }, delete: { database_attachments: [] } }),
    });
    await app.register(attachmentRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/1/attachments/99', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });
});
