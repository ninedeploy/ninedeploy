import { existsSync, statSync, unlinkSync } from 'node:fs';
import { audit } from '../lib/audit.js';
import path from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { backups, databases } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { backupDatabase, createBackupReadStream, databaseSize, restoreDatabase } from '../engine/database.js';
import { deleteRemoteBackup, fetchRemoteBackup, uploadBackup } from '../lib/backupRemote.js';
import { listBackupDrills, runBackupDrill } from '../lib/backupDrill.js';
import { assertDatabaseRole, type AuthedUser, loadDatabaseForUser, visibleDatabaseIds } from '../lib/resourceAccess.js';
import { badRequest, forbidden, notFound, parseId as num } from '../lib/errors.js';

function serialize(b: typeof backups.$inferSelect) {
  return {
    id: b.id,
    databaseId: b.databaseId,
    // Present on scope='volumes' rows so the Backups page can show WHICH
    // volume a snapshot belongs to (and tell the two scopes apart).
    scope: b.scope,
    volumeName: b.volumeName,
    status: b.status,
    sizeBytes: b.sizeBytes,
    // Volume-scope rows carry their snapshot name ('manual', 'schedule-…');
    // NULL for database rows, which are named by `databaseName`.
    label: b.scope === 'volumes' ? (b.label ?? null) : null,
    createdAt: b.createdAt.toISOString(),
  };
}

/**
 * Resolve a database the caller may see. Delegates to the shared access
 * choke-point rather than doing a bare id lookup: these routes expose the
 * existence, name, size and backup cadence of a tenant's database, so they
 * need the same decision every route in `modules/databases.ts` makes.
 */
async function getDb(app: Parameters<FastifyPluginAsync>[0], id: number, user: AuthedUser) {
  return loadDatabaseForUser(app.db, id, user);
}

/**
 * Gate the instance-wide backup routes (`/backups/:bid`), which address a
 * backup by its own id rather than through its database.
 *
 * These were `requireAdmin` with NO per-database check: correct while
 * "operator" was the only way to reach them, but the moment a workspace admin
 * can manage their own backups the ownership check has to exist, or one tenant
 * could delete or download another's dump by guessing an id.
 *
 * Volume-scope backups carry no `databaseId`, so there is no workspace to
 * derive a role from — those stay instance-operator-only.
 */
async function assertMayManageBackup(
  app: Parameters<FastifyPluginAsync>[0],
  row: { databaseId: number | null } | undefined,
  user: AuthedUser,
): Promise<void> {
  if (user.isOperator) return;
  // A missing row is reported as "not found" by the caller; refusing here would
  // turn a 404 into a 403 and leak which ids exist.
  if (!row) return;
  if (row.databaseId == null) throw forbidden('Operator access required for this backup');
  const d = await loadDatabaseForUser(app.db, row.databaseId, user);
  await assertDatabaseRole(app.db, d, user, 'admin');
}

/** Per-database storage + backup actions. Mounted under /databases. */
export const databaseBackupRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/storage', async (req) => {
    const d = await getDb(app, num((req.params as { id: string }).id), req.user!);
    return { sizeBytes: await databaseSize(d) };
  });

  app.get('/:id/backups', async (req) => {
    const id = num((req.params as { id: string }).id);
    await getDb(app, id, req.user!);
    const rows = await app.db.query.backups.findMany({ where: eq(backups.databaseId, id), orderBy: desc(backups.createdAt) });
    return rows.map(serialize);
  });

  // Creating a backup means acquiring a full plaintext dump of the database, so
  // it sits at `admin` on that database rather than at `member`. It used to be
  // instance-operator-only, which meant a workspace admin could not back up
  // their OWN database — stricter than the published permission matrix and not
  // usable by a team. Operators still qualify (they resolve as `owner`).
  app.post('/:id/backups', async (req) => {
    const id = num((req.params as { id: string }).id);
    const d = await getDb(app, id, req.user!);
    await assertDatabaseRole(app.db, d, req.user!, 'admin');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(config.paths.backupsDir, `${d.slug}-${ts}.dump`);
    const log = (line: string) => app.log.info({ component: 'backup' }, line);

    const [row] = await app.db.insert(backups).values({ databaseId: id, scope: 'db', status: 'running', path: file }).returning();
    try {
      log(`Backing up ${d.name} → ${path.basename(file)}`);
      await backupDatabase(d, file, log);
      const sizeBytes = existsSync(file) ? statSync(file).size : 0;
      await app.db.update(backups).set({ status: 'completed', sizeBytes }).where(eq(backups.id, row!.id));
      // Remote copy (best-effort — never fails the local backup).
      await uploadBackup(app.db, row!.id, file, log);
    } catch (err) {
      await app.db.update(backups).set({ status: 'failed' }).where(eq(backups.id, row!.id));
      throw badRequest(`Backup failed: ${err instanceof Error ? err.message : err}`);
    }
    const updated = await app.db.query.backups.findFirst({ where: eq(backups.id, row!.id) });
    void audit(app.db, req.user!.id, 'backup.create', d.name);
    return serialize(updated!);
  });

  app.post('/:id/backups/:bid/restore', async (req) => {
    const id = num((req.params as { id: string }).id);
    const bid = num((req.params as { bid: string }).bid);
    const d = await getDb(app, id, req.user!);
    await assertDatabaseRole(app.db, d, req.user!, 'admin');
    const b = await app.db.query.backups.findFirst({ where: eq(backups.id, bid) });
    // Ownership: without this check a backup of database A could be restored
    // into database B (cross-database data corruption).
    if (!b || b.databaseId !== d.id) throw notFound('Backup not found');
    const log = (line: string) => app.log.info({ component: 'backup' }, line);
    // Remote-only backups are fetched to a local temp path first.
    let restorePath = b.path;
    const isRemoteTemp = !existsSync(b.path);
    if (isRemoteTemp) {
      if (!b.remoteKey) throw notFound('Backup not found');
      restorePath = path.join(config.paths.backupsDir, `${path.basename(b.path)}.remote`);
      log(`Fetching remote object ${b.remoteKey}`);
      await fetchRemoteBackup(app.db, b, restorePath);
    }
    try {
      log(`Restoring ${d.name} from ${path.basename(restorePath)}`);
      await restoreDatabase(d, restorePath, log);
    } catch (err) {
      throw badRequest(`Restore failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      // The fetched temp copy is not tracked in the DB — always remove it.
      if (isRemoteTemp) {
        try {
          unlinkSync(restorePath);
        } catch {
          /* best-effort */
        }
      }
    }
    void audit(app.db, req.user!.id, 'backup.restore', path.basename(restorePath));
    return { ok: true };
  });

  // ── backup drill (G-17) ──────────────────────────────────────────────
  // Runs an engine-specific smoke check on a backup file
  // (pg_restore --list, redis-check-rdb, mysqldump header
  // parse, ...). The result lands on a `backup_drills` row
  // so the panel can show a history without re-running. The
  // route is intentionally NOT background: the validators
  // cap at a few seconds and the panel polls the result
  // row when the operator opens the detail view.
  app.post<{ Params: { id: string }; Body: { backupId?: number } }>(
    '/:id/backups/drill',
    async (req) => {
      const id = num((req.params as { id: string }).id);
      const d = await getDb(app, id, req.user!);
      // Member can read but the drill mutates state (creates
      // a backup_drills row) — gate at member so a viewer
      // cannot fill the table with no-ops.
      await assertDatabaseRole(app.db, d, req.user!, 'member');
      const body = (req.body ?? {}) as { backupId?: number };
      if (!body.backupId || typeof body.backupId !== 'number') {
        throw badRequest('backupId is required');
      }
      let result: Awaited<ReturnType<typeof runBackupDrill>>;
      try {
        result = await runBackupDrill(app.db, d.id, body.backupId);
      } catch (err) {
        throw badRequest(`Drill failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      void audit(
        app.db,
        req.user!.id,
        'backup.drill',
        `${d.name}: backup=${body.backupId} status=${result.status}`,
      );
      return {
        ok: true,
        drillId: result.drillId,
        status: result.status,
        durationMs: result.durationMs,
        details: result.details,
        error: result.error,
      };
    },
  );

  // History list. The panel renders the most recent run
  // first; a hard cap of 25 keeps the response small.
  app.get<{ Params: { id: string } }>('/:id/drills', async (req) => {
    const id = num((req.params as { id: string }).id);
    const d = await getDb(app, id, req.user!);
    return listBackupDrills(app.db, d.id, 25);
  });
};

/** Global backup list + delete + download. Mounted under /backups. */
export const backupRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (req) => {
    const rows = await app.db.query.backups.findMany({ orderBy: desc(backups.createdAt) });
    const dbs = await app.db.select().from(databases);
    const name = new Map(dbs.map((d) => [d.id, d.name]));
    // Members see only backups of databases they may access; `null` means
    // unrestricted (admin). The instance-wide list would otherwise disclose
    // every tenant's database names, backup sizes and schedule cadence.
    const visible = await visibleDatabaseIds(app.db, req.user!);
    const scoped = visible === null ? rows : rows.filter((b) => b.databaseId != null && visible.includes(b.databaseId));
    return scoped.map((b) => ({ ...serialize(b), databaseName: b.databaseId ? (name.get(b.databaseId) ?? null) : null }));
  });

  app.delete('/:bid', async (req) => {
    const bid = num((req.params as { bid: string }).bid);
    const b = await app.db.query.backups.findFirst({ where: eq(backups.id, bid) });
    await assertMayManageBackup(app, b, req.user!);
    if (b && existsSync(b.path)) unlinkSync(b.path);
    if (b) await deleteRemoteBackup(app.db, b);
    await app.db.delete(backups).where(eq(backups.id, bid));
    void audit(app.db, req.user!.id, 'backup.delete', `#${bid}`);
    return { ok: true };
  });

  // Downloading returns the decrypted plaintext dump.
  app.get('/:bid/download', async (req, reply) => {
    const bid = num((req.params as { bid: string }).bid);
    const b = await app.db.query.backups.findFirst({ where: eq(backups.id, bid) });
    await assertMayManageBackup(app, b, req.user!);
    if (!b || !existsSync(b.path)) throw notFound('Backup not found');
    // DB backups: encrypted at rest — hand the user the PLAINTEXT dump.
    // Volume backups: stored as plain tar.gz — stream the file directly
    // (readFileSync here used to buffer the whole tar.gz into heap).
    if (b.scope === 'volumes') {
      const { createReadStream } = await import('node:fs');
      return reply
        .type('application/gzip')
        .header('content-disposition', `attachment; filename="${path.basename(b.path)}"`)
        .header('content-length', statSync(b.path).size)
        .send(createReadStream(b.path));
    }
    return reply
      .type('application/octet-stream')
      .header('content-disposition', `attachment; filename="${path.basename(b.path)}"`)
      .send(await createBackupReadStream(b.path));
  });
};
