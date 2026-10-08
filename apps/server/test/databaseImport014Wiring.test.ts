/**
 * 0.14 T4 wiring guard (DESIGN §6 M1, M2, M16): the dump-import routes the
 * module registers (with the chunk route's own body limit), the
 * backup-destination `/objects` route, and the database-imports plugin doing
 * its boot recovery and hourly sweep once registered. Mounting the module in
 * `api.ts` and the plugin in `app.ts` is pinned by network014Wiring.test.ts;
 * the authz classification of every route by authzMatrix.test.ts.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import Fastify from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDb, databaseImports, databases, users } from '@ninedeploy/db';
import { DATABASE_IMPORT_CHUNK_SIZE } from '@ninedeploy/schemas';

vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const { databaseImportRoutes } = await import('../src/modules/databaseImports.js');
const { backupDestinationRoutes } = await import('../src/modules/backupDestinations.js');
const plugin = (await import('../src/plugins/databaseImports.js')).default;
const { STALE_IMPORT_MS, INTERRUPTED_IMPORT_ERROR } = await import('../src/lib/databaseImport.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-import-wiring-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function collect(register: (app: ReturnType<typeof Fastify>) => Promise<unknown>) {
  const app = Fastify();
  const routes: Array<{ key: string; bodyLimit?: number }> = [];
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) if (m !== 'HEAD') routes.push({ key: `${m} ${r.url}`, bodyLimit: r.bodyLimit });
  });
  await register(app);
  await app.ready();
  await app.close();
  return routes;
}

describe('dump-import routes (M1)', () => {
  it('registers every import route under the module prefix, the chunk route with its own body limit', async () => {
    const routes = await collect((app) => app.register(databaseImportRoutes, { prefix: '/v1/databases' }));
    expect(routes.map((r) => r.key).sort()).toEqual(
      [
        'GET /v1/databases/:id/imports',
        'POST /v1/databases/:id/imports',
        'GET /v1/databases/:id/imports/:importId',
        'DELETE /v1/databases/:id/imports/:importId',
        'PUT /v1/databases/:id/imports/:importId/chunks/:index',
        'POST /v1/databases/:id/imports/:importId/start',
      ].sort(),
    );
    expect(routes.find((r) => r.key.startsWith('PUT'))!.bodyLimit).toBe(DATABASE_IMPORT_CHUNK_SIZE + 1024);
  });
});

describe('backup-destination objects route (M16)', () => {
  it('is registered next to the destination routes', async () => {
    const routes = await collect(async (app) => {
      app.decorate('authenticate', async () => undefined);
      app.decorate('requireAdmin', async () => undefined);
      await app.register(backupDestinationRoutes, { prefix: '/v1/backup-destinations' });
    });
    expect(routes.map((r) => r.key)).toContain('GET /v1/backup-destinations/:id/objects');
  });
});

describe('database-imports plugin (M2)', () => {
  it('recovers interrupted imports at boot and sweeps stale ones on its interval', async () => {
    const created = createDb({ url: ':memory:' });
    const db = created.db;
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await db.insert(users).values({ id: 1, email: 'u@example.com', passwordHash: 'x' });
    const [d] = await db.insert(databases).values({ name: 'pg', slug: 'pg', engine: 'postgres', passwordEncrypted: 'v1:x' }).returning();
    const staging = path.join(tmp, '1.part');
    writeFileSync(staging, 'x');
    const base = { databaseId: d!.id, source: 'upload' as const, sizeBytes: 1, createdByUserId: 1 };
    const [running] = await db.insert(databaseImports).values({ ...base, status: 'running', stagingPath: staging }).returning();
    const [stale] = await db.insert(databaseImports).values({ ...base, status: 'uploading' }).returning();
    const oldSec = Math.floor((Date.now() - STALE_IMPORT_MS - 60_000) / 1000);
    await db.run(`UPDATE database_imports SET updated_at = ${oldSec} WHERE id = ${stale!.id}` as never);

    const app = Fastify();
    app.decorate('db', db);
    await app.register(plugin, { intervalMs: 25 });
    await app.ready();
    expect(app.hasPlugin('ninedeploy-database-imports')).toBe(true);
    const get = async (id: number) => (await db.query.databaseImports.findFirst({ where: eq(databaseImports.id, id) }))!;
    expect(await get(running!.id)).toMatchObject({ status: 'failed', error: INTERRUPTED_IMPORT_ERROR, stagingPath: null });
    expect(existsSync(staging)).toBe(false);
    expect((await get(stale!.id)).status).toBe('expired');

    // The interval keeps sweeping after boot.
    const [later] = await db.insert(databaseImports).values({ ...base, status: 'pending' }).returning();
    await db.run(`UPDATE database_imports SET updated_at = ${oldSec} WHERE id = ${later!.id}` as never);
    await vi.waitFor(async () => expect((await get(later!.id)).status).toBe('expired'), { timeout: 2000, interval: 25 });
    await app.close();
    created.client?.close();
  });

  it('never blocks startup when the database is unavailable', async () => {
    const app = Fastify();
    await app.register(plugin);
    await expect(app.ready()).resolves.toBeDefined();
    await app.close();
  });
});
