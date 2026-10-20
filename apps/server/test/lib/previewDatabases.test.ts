import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backups, createDb, type Database, databaseAttachments, databases, type DB, runMigrations, services, users } from '@ninedeploy/db';

/**
 * 0.16.12: a database copy per PR preview — made from the parent database's
 * latest backup (local or remote) or a live dump, attached to the preview
 * under the parent's variable name, and removed with the preview or swept
 * once it is orphaned. Real migrated SQLite; the engine calls are faked.
 */

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-preview-db-'));
vi.mock('../../src/config.js', () => ({ config: { paths: { backupsDir: path.join(tmp, 'backups') } } }));
mkdirSync(path.join(tmp, 'backups'), { recursive: true });
vi.mock('../../src/lib/crypto.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/crypto.js')>()),
  encrypt: (v: string) => `enc:${v}`,
}));

const { ensurePreviewDatabaseCopies, isPreviewCopy, previewCopyRefusal, removePreviewDatabaseCopies, sweepOrphanPreviewCopies, previewDatabaseDeps } = await import(
  '../../src/lib/previewDatabases.js'
);
type Deps = typeof previewDatabaseDeps;

let db: DB;

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 7, email: 'owner@example.com', passwordHash: 'x' });
  await db.insert(services).values([
    { id: 1, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 7, previewDatabaseCopy: true },
    { id: 2, name: 'web-pr-12', slug: 'web-pr-12', type: 'docker', branch: 'feat', ownerUserId: 7, isEphemeralPreview: true, previewParentServiceId: 1, prNumber: 12 },
  ] as never);
  await db.insert(databases).values([
    { id: 10, ownerUserId: 7, name: 'orders', slug: 'orders', engine: 'postgres', status: 'running', containerName: 'nd-db-orders', volumeName: 'nd-db-orders-data', passwordEncrypted: 'x', username: 'nine', dbName: 'app', memLimitMb: 256 },
    { id: 11, ownerUserId: 7, name: 'cache', slug: 'cache', engine: 'redis', status: 'running', containerName: 'nd-db-cache', volumeName: 'nd-db-cache-data', passwordEncrypted: 'x' },
    { id: 12, ownerUserId: 7, name: 'legacy', slug: 'legacy', engine: 'mysql', status: 'running', containerName: 'nd-db-legacy', volumeName: 'nd-db-legacy-data', passwordEncrypted: 'x' },
  ] as never);
  await db.insert(databaseAttachments).values([
    { serviceId: 1, databaseId: 10, envAlias: 'DATABASE_URL' },
    { serviceId: 1, databaseId: 11, envAlias: 'REDIS_URL' },
    { serviceId: 1, databaseId: 12, envAlias: 'MYSQL_URL' },
  ]);
});

function fakeDeps(over: Partial<Deps> = {}) {
  const calls: string[] = [];
  const deps: Deps = {
    start: vi.fn(async (d: Database) => {
      calls.push(`start ${d.containerName}`);
    }),
    ready: vi.fn(async () => true),
    dump: vi.fn(async (d: Database, file: string) => {
      calls.push(`dump ${d.containerName}`);
      writeFileSync(file, 'live');
    }),
    restore: vi.fn(async (d: Database, file: string) => {
      calls.push(`restore ${d.containerName} < ${path.basename(file)}`);
    }),
    fetchRemote: vi.fn(async (_db: DB, _b: unknown, file: string) => {
      calls.push('fetch remote');
      writeFileSync(file, 'remote');
      return file;
    }),
    stop: vi.fn(async (d: Database) => {
      calls.push(`stop ${d.containerName}`);
    }),
    removeVolume: vi.fn(async (name: string) => {
      calls.push(`rm volume ${name}`);
    }),
    ...over,
  };
  return { deps, calls };
}

const preview = async () => (await db.query.services.findFirst({ where: (s, { eq }) => eq(s.id, 2) }))!;
const copies = async () => (await db.select().from(databases)).filter((d) => d.previewServiceId != null);

describe('ensurePreviewDatabaseCopies', () => {
  it('copies postgres and redis from their latest backups, attaches them under the parent aliases, and skips mysql', async () => {
    const dump = path.join(tmp, 'backups', 'orders-1.dump');
    writeFileSync(dump, 'sql');
    await db.insert(backups).values([
      { databaseId: 10, scope: 'scheduled', status: 'completed', path: path.join(tmp, 'old.dump'), createdAt: new Date(1000) },
      { databaseId: 10, scope: 'scheduled', status: 'completed', path: dump, createdAt: new Date(2000) },
      { databaseId: 10, scope: 'scheduled', status: 'failed', path: dump, createdAt: new Date(3000) },
    ] as never);
    const lines: string[] = [];
    const { deps, calls } = fakeDeps();
    expect(await ensurePreviewDatabaseCopies(db, await preview(), (l) => lines.push(l), deps)).toBe(2);
    const made = await copies();
    expect(made.map((c) => [c.name, c.engine, c.status, c.previewCopyOf, c.ownerUserId])).toEqual([
      ['orders · PR #12', 'postgres', 'running', 10, 7],
      ['cache · PR #12', 'redis', 'running', 11, 7],
    ]);
    expect(made[0]!.slug).toMatch(/^orders-pr12-[a-z0-9]+$/);
    expect(made[0]).toMatchObject({ containerName: `nd-db-${made[0]!.slug}`, volumeName: `nd-db-${made[0]!.slug}-data`, memLimitMb: 256, internalPort: 5432 });
    expect(made[0]!.passwordEncrypted).not.toBe('x');
    // The postgres copy came from the newest completed backup; redis had none, so a live dump.
    expect(calls).toContain(`restore ${made[0]!.containerName} < orders-1.dump`);
    expect(calls).toContain('dump nd-db-cache');
    const att = await db.select().from(databaseAttachments).where((await import('drizzle-orm')).eq(databaseAttachments.serviceId, 2));
    expect(att.map((a) => [a.envAlias, a.databaseId])).toEqual([
      ['DATABASE_URL', made[0]!.id],
      ['REDIS_URL', made[1]!.id],
    ]);
    expect(lines).toContain('Preview database: legacy is not copied (mysql copies are not supported yet (postgres and the redis family are)); the preview gets no MYSQL_URL');
    expect(lines.some((l) => l.startsWith('Preview database: orders copied to orders · PR #12 from backup #'))).toBe(true);
    // The temporary live dump is gone; the backup file is left alone.
    expect(existsSync(dump)).toBe(true);
    expect((await import('node:fs')).readdirSync(path.join(tmp, 'backups')).filter((f) => f.startsWith('preview-copy-'))).toEqual([]);
  });

  it('fetches a remote-only backup to a temporary file', async () => {
    await db.insert(backups).values({ databaseId: 10, scope: 'db', status: 'completed', path: path.join(tmp, 'gone.dump'), remoteKey: 'k/orders.dump' } as never);
    await db.delete(databaseAttachments).where((await import('drizzle-orm')).ne(databaseAttachments.databaseId, 10));
    const { deps, calls } = fakeDeps();
    await ensurePreviewDatabaseCopies(db, await preview(), () => undefined, deps);
    expect(calls).toContain('fetch remote');
  });

  it('a later deploy keeps its copy; it is attached again if the attachment went', async () => {
    await db.delete(databaseAttachments).where((await import('drizzle-orm')).ne(databaseAttachments.databaseId, 10));
    const { deps } = fakeDeps();
    expect(await ensurePreviewDatabaseCopies(db, await preview(), () => undefined, deps)).toBe(1);
    await db.delete(databaseAttachments).where((await import('drizzle-orm')).eq(databaseAttachments.serviceId, 2));
    expect(await ensurePreviewDatabaseCopies(db, await preview(), () => undefined, deps)).toBe(0);
    expect(deps.start).toHaveBeenCalledTimes(1);
    expect((await db.select().from(databaseAttachments)).filter((a) => a.serviceId === 2)).toHaveLength(1);
  });

  it('a copy that fails is removed and fails the deploy', async () => {
    await db.delete(databaseAttachments).where((await import('drizzle-orm')).ne(databaseAttachments.databaseId, 10));
    const { deps, calls } = fakeDeps({ restore: vi.fn(async () => Promise.reject(new Error('psql: syntax error'))) });
    await expect(ensurePreviewDatabaseCopies(db, await preview(), () => undefined, deps)).rejects.toThrow(
      'Could not copy database orders for the preview: psql: syntax error',
    );
    expect(await copies()).toEqual([]);
    expect(calls.filter((c) => c.startsWith('stop') || c.startsWith('rm volume'))).toHaveLength(2);
  });

  it('a copy that never accepts its credentials fails too', async () => {
    await db.delete(databaseAttachments).where((await import('drizzle-orm')).ne(databaseAttachments.databaseId, 10));
    const notReady = fakeDeps({ ready: vi.fn(async () => false) });
    await expect(ensurePreviewDatabaseCopies(db, await preview(), () => undefined, notReady.deps)).rejects.toThrow(/did not start accepting connections/);
    const afterRestore = fakeDeps({ ready: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) });
    await expect(ensurePreviewDatabaseCopies(db, await preview(), () => undefined, afterRestore.deps)).rejects.toThrow(/does not accept its credentials after the restore/);
  });

  it('does nothing for a service that is not a preview, or a parent with the setting off', async () => {
    const { deps } = fakeDeps();
    const parent = (await db.query.services.findFirst({ where: (s, { eq }) => eq(s.id, 1) }))!;
    expect(await ensurePreviewDatabaseCopies(db, parent, () => undefined, deps)).toBe(0);
    await db.update(services).set({ previewDatabaseCopy: false }).where((await import('drizzle-orm')).eq(services.id, 1));
    expect(await ensurePreviewDatabaseCopies(db, await preview(), () => undefined, deps)).toBe(0);
    expect(deps.start).not.toHaveBeenCalled();
  });
});

describe('teardown', () => {
  it('removes a preview\'s copies with their backups, and sweeps orphans', async () => {
    await db.delete(databaseAttachments).where((await import('drizzle-orm')).ne(databaseAttachments.databaseId, 10));
    const { deps, calls } = fakeDeps();
    await ensurePreviewDatabaseCopies(db, await preview(), () => undefined, deps);
    const [copy] = await copies();
    const copyDump = path.join(tmp, 'copy.dump');
    writeFileSync(copyDump, 'x');
    await db.insert(backups).values({ databaseId: copy!.id, scope: 'db', status: 'completed', path: copyDump } as never);
    expect(await removePreviewDatabaseCopies(db, 2, () => undefined, deps)).toBe(1);
    expect(await copies()).toEqual([]);
    expect(existsSync(copyDump)).toBe(false);
    expect(calls).toContain(`rm volume ${copy!.volumeName}`);

    // An orphan: its preview row went without the teardown (the parent was deleted).
    await ensurePreviewDatabaseCopies(db, await preview(), () => undefined, deps);
    await db.delete(services).where((await import('drizzle-orm')).eq(services.id, 2));
    const orphan = (await db.select().from(databases)).find((d) => d.previewCopyOf === 10)!;
    expect(orphan.previewServiceId).toBeNull();
    expect(await sweepOrphanPreviewCopies(db, () => undefined, deps)).toBe(1);
    expect((await db.select().from(databases)).map((d) => d.id).sort()).toEqual([10, 11, 12]);
  });

  it('a failed stop or volume removal is logged; the row still goes', async () => {
    await db.delete(databaseAttachments).where((await import('drizzle-orm')).ne(databaseAttachments.databaseId, 10));
    await ensurePreviewDatabaseCopies(db, await preview(), () => undefined, fakeDeps().deps);
    const lines: string[] = [];
    const broken = fakeDeps({ stop: vi.fn(async () => Promise.reject('busy')), removeVolume: vi.fn(async () => Promise.reject(new Error('in use'))) });
    expect(await removePreviewDatabaseCopies(db, 2, (l) => lines.push(l), broken.deps)).toBe(1);
    expect(lines.some((l) => l.includes('failed (busy)'))).toBe(true);
    expect(lines.some((l) => l.includes('failed (in use)'))).toBe(true);
    expect(await copies()).toEqual([]);
  });
});

describe('previewCopyRefusal, isPreviewCopy', () => {
  it('names why a database is not copied', () => {
    expect(previewCopyRefusal({ engine: 'postgres', serverId: null, status: 'running' })).toBeNull();
    expect(previewCopyRefusal({ engine: 'postgres', serverId: 3, status: 'running' })).toMatch(/node/);
    expect(previewCopyRefusal({ engine: 'mongo', serverId: null, status: 'running' })).toMatch(/mongo copies/);
    expect(previewCopyRefusal({ engine: 'valkey', serverId: null, status: 'stopped' })).toBe('it is not running');
  });

  it('marks copies', () => {
    expect(isPreviewCopy({ previewCopyOf: null, previewServiceId: null })).toBe(false);
    expect(isPreviewCopy({ previewCopyOf: 1, previewServiceId: null })).toBe(true);
    expect(isPreviewCopy({ previewCopyOf: null, previewServiceId: 2 })).toBe(true);
  });

  it('the default deps call the engine when used', () => {
    expect(Object.keys(previewDatabaseDeps).sort()).toEqual(['dump', 'fetchRemote', 'ready', 'removeVolume', 'restore', 'start', 'stop']);
  });
});
