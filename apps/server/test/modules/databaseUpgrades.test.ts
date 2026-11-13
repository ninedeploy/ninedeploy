import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Database, databases, databaseUpgrades, type DB, runMigrations, users } from '@ninedeploy/db';
import { buildTestApp } from '../helpers.js';

/**
 * O2: the upgrade routes over a real migrated SQLite, with the module's Docker
 * layer swapped for fakes; and the lifecycle routes refusing while an upgrade
 * runs (modules/databases.ts mutateDatabase).
 */

const { tmp } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs'); const p = require('node:path') as typeof import('node:path'); const o = require('node:os') as typeof import('node:os');
  const dir = fs.mkdtempSync(p.join(o.tmpdir(), 'nd-db-upgrade-routes-'));
  fs.mkdirSync(p.join(dir, 'backups'), { recursive: true });
  return { tmp: dir };
});
vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return { ...actual, config: { ...actual.config, paths: { ...actual.config.paths, backupsDir: path.join(tmp, 'backups'), dataDir: tmp } } };
});
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const upgrade = await import('../../src/lib/databaseUpgrade.js');
const { databaseUpgradeRoutes } = await import('../../src/modules/databaseUpgrades.js');
const { databasesRoutes } = await import('../../src/modules/databases.js');

const SEP = '\u001f';
let db: DB;
const real = { ...upgrade.databaseUpgradeDeps };

function fakeDocker() {
  const calls: string[] = [];
  Object.assign(upgrade.databaseUpgradeDeps, {
    psql: async (container: string, sql: string, o?: { database?: string }) => {
      const staging = container.endsWith('-new');
      if (sql.includes('server_version_num')) return staging ? '180001' : '160004';
      if (sql.includes('pg_database_size')) return '1000';
      if (sql.includes('FROM pg_database') || sql.includes('FROM pg_roles')) return '';
      if (o?.database === 'postgres') return '0';
      if (sql.includes('query_to_xml')) return `public.t${SEP}3`;
      if (sql.includes('pg_extension')) return ['1', '1', '0', '0', '0', 'plpgsql'].join(SEP);
      return '';
    },
    containerImage: async () => ({ id: 'sha256:old', tag: 'postgres:16' }),
    containerRunning: async () => true,
    pull: async () => undefined,
    stopAndRemove: async (name: string) => { calls.push(`stop ${name}`); },
    runIsolated: async () => undefined,
    waitReady: async () => true,
    dump: async (_d: Database, file: string) => { writeFileSync(file, 'x'); },
    restore: async () => undefined,
    createVolume: async () => undefined,
    volumeExists: async (name: string) => name === 'nd-db-orders-data',
    removeVolume: async (name: string) => { calls.push(`volume- ${name}`); return true; },
    start: async (d: Database) => { calls.push(`start ${d.volumeName}`); },
    attachBridges: async () => undefined,
    freeBytes: async () => 100 * 1024 ** 3,
    maintenance: async (_d: Database, _log: unknown, op: () => Promise<unknown>) => op(),
    fileSize: async () => 1,
  } satisfies Partial<typeof real>);
  return calls;
}

beforeEach(async () => {
  Object.assign(upgrade.databaseUpgradeDeps, real);
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'x', isOperator: true } as never);
  await db.insert(databases).values({
    id: 10, ownerUserId: 1, name: 'orders', slug: 'orders', engine: 'postgres', status: 'running', version: '16',
    containerName: 'nd-db-orders', volumeName: 'nd-db-orders-data', passwordEncrypted: 'x',
  } as never);
});

async function app() {
  const a = await buildTestApp({ db });
  await a.register(databaseUpgradeRoutes, { prefix: '/v1/databases' });
  await a.register(databasesRoutes, { prefix: '/v1/databases' });
  await a.ready();
  return a;
}
const as = { 'x-test-user': '1', 'x-test-operator': 'true' };

async function settle(id: number) {
  await vi.waitFor(async () => {
    const r = await db.query.databaseUpgrades.findFirst({ where: eq(databaseUpgrades.id, id) });
    expect(r?.status).not.toBe('running');
  });
}

describe('database upgrade routes', () => {
  it('options read the live major; POST admits (202), the run completes, then finalize removes the previous volume', async () => {
    const calls = fakeDocker();
    const a = await app();
    const options = await a.inject({ method: 'GET', url: '/v1/databases/10/upgrades/options', headers: as });
    expect(options.json()).toEqual({ databaseId: 10, engine: 'postgres', currentMajor: 16, targets: [17, 18], currentSeries: '16', versions: ['17', '18'], refusal: null });

    const started = await a.inject({ method: 'POST', url: '/v1/databases/10/upgrades', headers: as, payload: { toMajor: 18 } });
    expect(started.statusCode).toBe(202);
    const body = started.json();
    expect(body).toMatchObject({ databaseId: 10, fromMajor: 16, toMajor: 18, previousVolume: 'nd-db-orders-data', targetVolume: `nd-db-orders-data-u${body.id}` });
    await settle(body.id);

    const list = await a.inject({ method: 'GET', url: '/v1/databases/10/upgrades', headers: as });
    expect(list.json()[0]).toMatchObject({ id: body.id, status: 'completed', verification: { tables: 1, rows: 3, mismatches: [] } });
    expect((await a.inject({ method: 'GET', url: '/v1/databases/10/upgrades/options', headers: as })).json().refusal.code).toBe('database_upgrade_unfinalized');

    const fin = await a.inject({ method: 'POST', url: `/v1/databases/10/upgrades/${body.id}/finalize`, headers: as });
    expect(fin.statusCode).toBe(200);
    expect(fin.json()).toMatchObject({ status: 'finalized', removedVolume: 'nd-db-orders-data' });
    expect(calls).toContain('volume- nd-db-orders-data');
  });

  it('refuses a body without a valid target, and an upgrade id of another database', async () => {
    fakeDocker();
    const a = await app();
    expect((await a.inject({ method: 'POST', url: '/v1/databases/10/upgrades', headers: as, payload: { toMajor: 'x' } })).statusCode).toBe(422);
    expect((await a.inject({ method: 'POST', url: '/v1/databases/10/upgrades', headers: as, payload: { toMajor: 16 } })).json().error?.code ?? '').toBe('database_upgrade_target');
    expect((await a.inject({ method: 'POST', url: '/v1/databases/10/upgrades/999/rollback', headers: as })).statusCode).toBe(404);
  });

  it('stop, start, restart, limits and delete refuse while an upgrade runs', async () => {
    await db.insert(databaseUpgrades).values({
      databaseId: 10, engine: 'postgres', fromMajor: 16, toMajor: 18, targetVersion: '18', fromImage: 'sha256:old', toImage: 'postgres:18',
      previousVolume: 'nd-db-orders-data', targetVolume: 'nd-db-orders-data-u1', status: 'running', phase: 'dump',
    });
    const a = await app();
    for (const [method, url, payload] of [
      ['POST', '/v1/databases/10/stop', undefined],
      ['POST', '/v1/databases/10/start', undefined],
      ['POST', '/v1/databases/10/restart', undefined],
      ['PATCH', '/v1/databases/10/limits', { memLimitMb: 256 }],
      ['DELETE', '/v1/databases/10', undefined],
    ] as const) {
      const res = await a.inject({ method, url, headers: as, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(409);
      expect(res.json().error?.message ?? res.body, `${method} ${url}`).toContain('major upgrade');
    }
    // A create retry for the same database (reuseExisting) must not start it either.
    const retry = await a.inject({ method: 'POST', url: '/v1/databases', headers: as, payload: { name: 'orders', engine: 'postgres', version: '16', reuseExisting: true } });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error?.message).toContain('major upgrade');
    expect((await db.query.databases.findFirst({ where: eq(databases.id, 10) }))!.status).toBe('running');
  });
});
