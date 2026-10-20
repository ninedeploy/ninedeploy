import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { backups, type Database, databaseAttachments, databases, type DB, type Service, services } from '@ninedeploy/db';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { config } from '../config.js';
import {
  backupDatabase,
  defaultPort,
  ENGINES,
  probeDatabaseCredentials,
  removeVolume,
  restoreDatabase,
  startDatabase,
  stopDatabase,
} from '../engine/database.js';
import { fetchRemoteBackup } from './backupRemote.js';
import { encrypt, randomToken } from './crypto.js';
import { slugifyWithSuffix } from './slug.js';

/**
 * 0.16.12: a database copy per PR preview.
 *
 * A parent service with `previewDatabaseCopy` on gives each of its PR
 * previews its own copy of every database attached to the parent. The copy
 * is made on the preview's first deploy (engine/pipeline.ts, before the
 * environment is assembled), from the parent database's latest completed
 * backup, or from a live dump when there is none. It is attached to the
 * preview under the parent's variable name, so `DATABASE_URL` points at the
 * copy and the preview never touches production data. The preview's
 * pre-deploy hook or its start command runs its migrations as usual.
 *
 * Copies are marked (`preview_copy_of`, `preview_service_id`), left out of
 * the daily built-in backups, removed with the preview
 * (lib/webhookDispatch.ts destroyPreviewService), and swept by housekeeping
 * once their preview is gone some other way.
 *
 * Engines: postgres (its dump holds only the `app` database, owned by the
 * same user on both sides) and the redis family (an RDB file carries no
 * credentials). A mysql/mariadb or mongo dump carries the server's own users
 * and would replace the copy's credentials, so those are not copied yet; nor
 * are databases on a node (previews run on the panel host).
 */

export const PREVIEW_COPY_ENGINES = new Set(['postgres', 'redis', 'valkey', 'keydb', 'dragonfly']);

export interface PreviewDatabaseDeps {
  start: (d: Database, log: (line: string) => void) => Promise<void>;
  /** Whether the database accepts its own credentials (waits while it starts). */
  ready: (d: Database) => Promise<boolean>;
  dump: (d: Database, file: string, log: (line: string) => void) => Promise<void>;
  restore: (d: Database, file: string, log: (line: string) => void) => Promise<void>;
  fetchRemote: (db: DB, backup: typeof backups.$inferSelect, file: string) => Promise<string>;
  stop: (d: Database, log: (line: string) => void) => Promise<void>;
  removeVolume: (name: string, log: (line: string) => void) => Promise<void>;
}

// Wrappers, not references: the engine functions are read when called, so a
// module that imports this one loads where the engine is mocked.
export const previewDatabaseDeps: PreviewDatabaseDeps = {
  start: (d, log) => startDatabase(d, log),
  ready: (d) => probeDatabaseCredentials(d, 45, 2_000),
  dump: (d, file, log) => backupDatabase(d, file, log),
  restore: (d, file, log) => restoreDatabase(d, file, log),
  fetchRemote: (db, b, file) => fetchRemoteBackup(db, b, file),
  stop: (d, log) => stopDatabase(d, log),
  removeVolume: (name, log) => removeVolume(name, log),
};

/** Why `d` is not copied for a preview, or null when it is. */
export function previewCopyRefusal(d: Pick<Database, 'engine' | 'serverId' | 'status'>): string | null {
  if (d.serverId != null) return 'it runs on a node; previews run on the panel host';
  if (!PREVIEW_COPY_ENGINES.has(d.engine)) return `${d.engine} copies are not supported yet (postgres and the redis family are)`;
  if (d.status !== 'running') return 'it is not running';
  return null;
}

/** Remove one copy: its container, volume, backups and row (its attachment goes with the row). */
async function removeCopy(db: DB, copy: Database, deps: PreviewDatabaseDeps, log: (line: string) => void): Promise<void> {
  await deps.stop(copy, log).catch((err: unknown) => log(`preview database: stopping ${copy.containerName} failed (${err instanceof Error ? err.message : String(err)})`));
  if (copy.volumeName) {
    await deps.removeVolume(copy.volumeName, log).catch((err: unknown) => log(`preview database: removing ${copy.volumeName} failed (${err instanceof Error ? err.message : String(err)})`));
  }
  for (const b of await db.select().from(backups).where(eq(backups.databaseId, copy.id))) {
    rmSync(b.path, { force: true });
  }
  await db.delete(databases).where(eq(databases.id, copy.id));
}

/**
 * Give `preview` its copies of the parent's databases. A no-op for a
 * service that is not a preview, a parent with the setting off, and copies
 * made already (a later deploy of the same PR keeps its data). Throws when
 * a copy cannot be made: the preview would otherwise boot without its data
 * or, worse, be pointed at something else.
 */
export async function ensurePreviewDatabaseCopies(
  db: DB,
  preview: Service,
  log: (line: string) => void,
  deps: PreviewDatabaseDeps = previewDatabaseDeps,
): Promise<number> {
  if (!preview.isEphemeralPreview || preview.previewParentServiceId == null) return 0;
  const parent = await db.query.services.findFirst({ where: eq(services.id, preview.previewParentServiceId) });
  if (!parent?.previewDatabaseCopy) return 0;
  const attached = await db
    .select({ alias: databaseAttachments.envAlias, d: databases })
    .from(databaseAttachments)
    .innerJoin(databases, eq(databases.id, databaseAttachments.databaseId))
    .where(eq(databaseAttachments.serviceId, parent.id));
  let made = 0;
  for (const { alias, d } of attached) {
    const existing = await db.query.databases.findFirst({ where: and(eq(databases.previewCopyOf, d.id), eq(databases.previewServiceId, preview.id)) });
    if (existing) {
      await db.insert(databaseAttachments).values({ serviceId: preview.id, databaseId: existing.id, envAlias: alias }).onConflictDoNothing();
      continue;
    }
    const refusal = previewCopyRefusal(d);
    if (refusal) {
      log(`Preview database: ${d.name} is not copied (${refusal}); the preview gets no ${alias}`);
      continue;
    }
    const cfg = ENGINES[d.engine]!;
    const slug = slugifyWithSuffix(d.slug, `pr${preview.prNumber ?? preview.id}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, '')}`);
    const [copy] = await db
      .insert(databases)
      .values({
        projectId: d.projectId,
        // The preview's owner: the pipeline admits an attachment only when its owner holds admin on the database.
        ownerUserId: preview.ownerUserId ?? d.ownerUserId,
        name: `${d.name} · PR #${preview.prNumber ?? '?'}`,
        slug,
        engine: d.engine,
        version: d.version,
        status: 'creating',
        containerName: `nd-db-${slug}`,
        volumeName: `nd-db-${slug}-data`,
        username: cfg.username() ?? null,
        passwordEncrypted: encrypt(randomToken(18)),
        dbName: cfg.dbName() ?? null,
        extensions: d.extensions ?? [],
        cpuShares: d.cpuShares,
        cpuLimitMilli: d.cpuLimitMilli,
        memLimitMb: d.memLimitMb,
        previewCopyOf: d.id,
        previewServiceId: preview.id,
      })
      .returning();
    const temp: string[] = [];
    try {
      log(`Preview database: copying ${d.name} to ${copy!.name} …`);
      await deps.start(copy!, log);
      if (!(await deps.ready(copy!))) throw new Error(`${copy!.containerName} did not start accepting connections`);
      const latest = await db.query.backups.findFirst({
        where: and(eq(backups.databaseId, d.id), eq(backups.status, 'completed')),
        orderBy: [desc(backups.createdAt), desc(backups.id)],
      });
      let file: string;
      let source: string;
      if (latest && existsSync(latest.path)) {
        file = latest.path;
        source = `backup #${latest.id} of ${latest.createdAt?.toISOString() ?? 'an unknown time'}`;
      } else if (latest?.remoteKey) {
        file = path.join(config.paths.backupsDir, `preview-copy-${randomUUID()}.dump`);
        temp.push(file);
        await deps.fetchRemote(db, latest, file);
        source = `backup #${latest.id} of ${latest.createdAt?.toISOString() ?? 'an unknown time'} (from remote storage)`;
      } else {
        file = path.join(config.paths.backupsDir, `preview-copy-${randomUUID()}.dump`);
        temp.push(file);
        log(`Preview database: ${d.name} has no backup yet; taking a dump of it now`);
        await deps.dump(d, file, log);
        source = 'a dump taken now';
      }
      await deps.restore(copy!, file, log);
      if (!(await deps.ready(copy!))) throw new Error(`${copy!.containerName} does not accept its credentials after the restore`);
      await db
        .update(databases)
        .set({ status: 'running', internalHost: copy!.containerName, internalPort: defaultPort(d.engine), initializedAt: new Date() })
        .where(eq(databases.id, copy!.id));
      await db.insert(databaseAttachments).values({ serviceId: preview.id, databaseId: copy!.id, envAlias: alias });
      log(`Preview database: ${d.name} copied to ${copy!.name} from ${source}; the preview's ${alias} points at the copy`);
      made++;
    } catch (err) {
      await removeCopy(db, copy!, deps, log);
      throw new Error(`Could not copy database ${d.name} for the preview: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      for (const f of temp) rmSync(f, { force: true });
    }
  }
  return made;
}

/** Remove the copies of a preview that is being destroyed. Best-effort per copy; returns how many went. */
export async function removePreviewDatabaseCopies(
  db: DB,
  previewId: number,
  log: (line: string) => void,
  deps: PreviewDatabaseDeps = previewDatabaseDeps,
): Promise<number> {
  const copies = await db.select().from(databases).where(eq(databases.previewServiceId, previewId));
  for (const copy of copies) await removeCopy(db, copy, deps, log);
  return copies.length;
}

/** Housekeeping: remove copies whose preview no longer exists (its parent was deleted, or the row went another way). */
export async function sweepOrphanPreviewCopies(
  db: DB,
  log: (line: string) => void,
  deps: PreviewDatabaseDeps = previewDatabaseDeps,
): Promise<number> {
  const orphans = await db.select().from(databases).where(and(isNotNull(databases.previewCopyOf), isNull(databases.previewServiceId)));
  for (const copy of orphans) await removeCopy(db, copy, deps, log);
  return orphans.length;
}

/** The daily built-in backup leaves preview copies out: they are disposable and would keep 7 dumps each. */
export const isPreviewCopy = (d: Pick<Database, 'previewCopyOf' | 'previewServiceId'>): boolean => d.previewCopyOf != null || d.previewServiceId != null;
