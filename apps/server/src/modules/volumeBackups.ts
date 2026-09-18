import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { backups, databases, serviceVolumeAttachments, services } from '@ninedeploy/db';
import { createVolumeBackup } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { config } from '../config.js';
import { backupVolume, restoreVolume, volumeExists } from '../engine/database.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';
import { badRequest, conflict, notFound, parseId as num } from '../lib/errors.js';
import { containerRunning, listManagedVolumeNames, resolveVolumeOwnerWithSharing } from '../lib/inventory.js';
import { uploadBackup, fetchRemoteBackup, deleteRemoteBackup } from '../lib/backupRemote.js';
import { assertMayUseHostPrivilege } from '../lib/hostPrivilege.js';

const VOLUMES_SUBDIR = 'volumes';

/** Resolve the directory layout for a volume's backups under the
 *  configured `backupsDir`. Per-volume subdirectory keeps a noisy
 *  service's tarballs from clobbering a quieter one. */
function volumeBackupDir(volumeName: string): string {
  // Defense in depth: the route already validates against managed-volume
  // naming, but the path is also a host-side input and ends up in shell
  // scripts. Strip anything that could climb out of the dir.
  const safe = volumeName.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(config.paths.backupsDir, VOLUMES_SUBDIR, safe);
}

/** Build the on-disk path for a new backup file. */
function newBackupFile(volumeName: string, label?: string): { file: string; dir: string } {
  const dir = volumeBackupDir(volumeName);
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLabel = label?.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40);
  const filename = safeLabel ? `${volumeName}-${ts}-${safeLabel}.tar.gz` : `${volumeName}-${ts}.tar.gz`;
  return { file: path.join(dir, filename), dir };
}

/** Build the wire representation of a volume backup row. */
function serialize(b: typeof backups.$inferSelect) {
  return {
    id: b.id,
    databaseId: b.databaseId,
    volumeName: b.volumeName,
    scope: b.scope,
    status: b.status,
    sizeBytes: b.sizeBytes,
    label: b.label ?? null,
    hasRemoteCopy: Boolean(b.remoteKey),
    createdAt: b.createdAt.toISOString(),
  };
}

/**
 * Authorization gate: every volume mutation goes through this. The volume
 * itself is checked (must be a managed volume, must exist on this host)
 * and the caller is authorised as either admin or the owner of every
 * service that currently attaches the volume. Anonymous listing is
 * admin-only (mirrors the global /volumes policy).
 */
async function authorizeVolume(
  app: Parameters<FastifyPluginAsync>[0],
  user: { id: number; isOperator: boolean },
  volumeName: string,
  requireOwner: boolean,
): Promise<{ serviceIds: number[]; databaseContainer: string | null }> {
  if (!volumeName.startsWith('nd-svc-') && !volumeName.startsWith('nd-db-')) {
    throw badRequest('not a managed volume');
  }
  const known = (await listManagedVolumeNames().catch(() => [] as string[])).includes(volumeName);
  if (!known) throw notFound(`Volume '${volumeName}' does not exist on this host`);

  // Owner resolution: any service that attaches this volume, plus the
  // legacy `nd-svc-<slug>-data` heuristic. Members must own at least one;
  // admins bypass.
  const allAtts = await app.db.select().from(serviceVolumeAttachments);
  const resolved = resolveVolumeOwnerWithSharing(
    await app.db.select().from(services),
    await app.db.select().from(databases),
    volumeName,
    allAtts,
  );
  const ownerId = resolved?.owner.kind === 'service' ? resolved.owner.refId : null;

  if (requireOwner && !user.isOperator) {
    if (ownerId == null) throw badRequest('Volume has no owning service');
    await loadServiceForUser(app.db, ownerId, user);
  }
  // r164: every service that mounts the volume, and the owning database's
  // container, must be stopped before a restore. Only the single resolved
  // owner used to be returned — and never for `nd-db-*` volumes — so a
  // restore untarred over a RUNNING database's data files (corruption).
  const sharing = allAtts.filter((a) => a.volumeName === volumeName).map((a) => a.serviceId);
  const serviceIds = [...new Set([...(ownerId != null ? [ownerId] : []), ...sharing])];
  const databaseContainer = resolved?.owner.kind === 'database' ? (resolved.owner.containerName ?? null) : null;
  return { serviceIds, databaseContainer };
}

/** Per-volume backup management. Mounted under /v1/volumes/:name/backups. */
export const volumeBackupRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  // ── GET /:name/backups — list a volume's backups (newest first) ────────
  app.get('/:name/backups', async (req) => {
    const name = (req.params as { name: string }).name;
    await authorizeVolume(app, req.user!, name, true);
    const rows = await app.db
      .select()
      .from(backups)
      .where(and(eq(backups.volumeName, name), eq(backups.scope, 'volumes')))
      .orderBy(desc(backups.createdAt));
    return rows.map(serialize);
  });

  // ── POST /:name/backups — trigger a new backup now ─────────────────────
  // Admin-only because the snapshot operation is host-level (sibling
  // container + tar to host disk). Same posture as the database backup
  // route, which is also admin-only.
  app.post('/:name/backups', { preHandler: [app.requireAdmin] }, async (req) => {
    const name = (req.params as { name: string }).name;
    const input = createVolumeBackup.parse(req.body ?? {});
    // Auth-only call: the volume's owning services no longer land on the
    // backup row (scope='volumes' rows carry volumeName only — see insert).
    await authorizeVolume(app, req.user!, name, true);
    // The volume is expected to be on this host; the auth helper already
    // verified. Defensive double-check (volumeExists makes a fresh docker
    // call, so it's the only one that can be wrong by now).
    if (!(await volumeExists(name))) throw notFound(`Volume '${name}' disappeared`);

    const { file } = newBackupFile(name, input.label);
    // Persist the label so the panel can NAME the snapshot; the filename only
    // embeds it. Default matches what "Backup now" has always meant.
    const label = input.label?.trim() || 'manual';
    const log = (line: string) => req.log.info({ component: 'volume-backup' }, line);

    // Reserve the row up front so the worker / UI can observe status. The
    // sibling-container tar streams to the host; if it fails the row is
    // flipped to 'failed' and a partial file is best-effort unlinked.
    // scope='volumes' rows must carry volumeName ONLY — the advertised
    // backups invariant is "exactly one of (databaseId, volumeName)", and a
    // stray databaseId here would confuse restore routing and retention.
    const [row] = await app.db
      .insert(backups)
      .values({
        databaseId: null,
        volumeName: name,
        scope: 'volumes',
        status: 'running',
        path: file,
        label,
      })
      .returning();

    try {
      await backupVolume(name, file, log);
      const sizeBytes = existsSync(file) ? statSync(file).size : 0;
      await app.db
        .update(backups)
        .set({ status: 'completed', sizeBytes })
        .where(eq(backups.id, row!.id));
      // Remote push (best-effort) — the local copy is the source of truth.
      // Phase 2 will switch to a "user-configured destination" lookup but
      // for now we share the active destination with DB backups.
      await uploadBackup(app.db, row!.id, file, log);
      // Prune older backups so the directory never grows unbounded.
      await pruneOldBackups(app.db, name, log);
    } catch (err) {
      await app.db.update(backups).set({ status: 'failed' }).where(eq(backups.id, row!.id));
      try { unlinkSync(file); } catch { /* best-effort */ }
      throw badRequest(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const updated = await app.db.query.backups.findFirst({ where: eq(backups.id, row!.id) });
    void audit(app.db, req.user!.id, 'volume.backup.create', `${name} → ${path.basename(file)}`);
    return serialize(updated!);
  });

  // ── POST /:name/backups/:bid/restore — restore one backup to its volume ─
  // The target service must be stopped so the restored contents are not
  // immediately re-overwritten by a still-running process. The volume
  // itself can stay mounted; tar extract overwrites in place. We refuse
  // if the service is running because the operating container holds
  // open file handles and a clean restore means "swap the bytes under
  // the live process" which corrupts anything that was mmap()'d.
  app.post('/:name/backups/:bid/restore', { preHandler: [app.requireAdmin] }, async (req) => {
    const name = (req.params as { name: string }).name;
    const bid = num((req.params as { bid: string }).bid);
    const { serviceIds, databaseContainer } = await authorizeVolume(app, req.user!, name, true);

    const b = await app.db.query.backups.findFirst({
      where: and(eq(backups.id, bid), eq(backups.volumeName, name), eq(backups.scope, 'volumes')),
    });
    if (!b) throw notFound('Backup not found');

    // Refuse if the owning database, the owning service or any service
    // attaching the volume is currently running.
    if (databaseContainer && (await containerRunning(databaseContainer))) {
      throw conflict('The database is running — stop it before restoring its volume');
    }
    for (const sid of serviceIds) {
      const svc = await app.db.query.services.findFirst({ where: eq(services.id, sid) });
      if (svc && (await containerRunning(svc.runtimeId))) {
        throw conflict(`Service "${svc.name}" is running — stop the service before restoring`);
      }
    }

    const log = (line: string) => req.log.info({ component: 'volume-restore' }, line);
    // Remote-only: fetch to a local temp file first, restore, then remove.
    let restorePath = b.path;
    let isRemoteTemp = false;
    if (!existsSync(b.path)) {
      if (!b.remoteKey) throw notFound('Backup not found');
      restorePath = `${b.path}.remote`;
      log(`Fetching remote object ${b.remoteKey}`);
      await fetchRemoteBackup(app.db, b.remoteKey, restorePath);
      isRemoteTemp = true;
    }

    try {
      await restoreVolume(name, restorePath, log);
    } catch (err) {
      throw badRequest(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (isRemoteTemp) {
        try { unlinkSync(restorePath); } catch { /* best-effort */ }
      }
    }
    void audit(app.db, req.user!.id, 'volume.backup.restore', `${name} ← ${path.basename(restorePath)}`);
    return { ok: true };
  });

  // ── GET /:name/backups/:bid/download — stream the tar.gz to the client ─
  // Admin-only — the file is the underlying Docker volume bytes in the
  // clear (no encryption; the same posture as database backups).
  app.get('/:name/backups/:bid/download', { preHandler: [app.requireAdmin] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const name = (req.params as { name: string }).name;
    const bid = num((req.params as { bid: string }).bid);
    await authorizeVolume(app, req.user!, name, true);
    const b = await app.db.query.backups.findFirst({
      where: and(eq(backups.id, bid), eq(backups.volumeName, name), eq(backups.scope, 'volumes')),
    });
    if (!b || !existsSync(b.path)) throw notFound('Backup file not found');
    reply
      .type('application/gzip')
      .header('content-disposition', `attachment; filename="${path.basename(b.path)}"`)
      .send(readFileSync(b.path));
    return reply;
  });
};

/**
 * Keep the most recent N backups for one volume. Older rows (and their
 * on-disk tar.gz files) are deleted. Called after a successful backup so
 * the directory never grows unbounded.
 *
 * Exported for the scheduled-job path — a `kind: 'backup'` cron also
 * calls this so the schedule doesn't pile up duplicates.
 */
export async function pruneOldBackups(
  db: Parameters<FastifyPluginAsync>[0]['db'],
  volumeName: string,
  log: (line: string) => void = () => undefined,
): Promise<{ deleted: number; kept: number }> {
  const keep = config.volumeBackupRetainCount;
  const rows = await db
    .select()
    .from(backups)
    .where(and(eq(backups.volumeName, volumeName), eq(backups.scope, 'volumes')))
    .orderBy(desc(backups.createdAt));
  if (rows.length <= keep) return { deleted: 0, kept: rows.length };
  const toDelete = rows.slice(keep);
  for (const row of toDelete) {
    try { unlinkSync(row.path); } catch { /* file may already be gone */ }
    if (row.remoteKey) await deleteRemoteBackup(db, row.remoteKey).catch(() => undefined);
    await db.delete(backups).where(eq(backups.id, row.id));
  }
  log(`Pruned ${toDelete.length} old backup(s) for ${volumeName} (kept newest ${keep})`);
  return { deleted: toDelete.length, kept: keep };
}

/**
 * Take a backup of every volume currently attached to a service. Used by
 * the `kind: 'backup'` scheduled job: it captures the primary
 * `volumeMount` (when set) and every row in `service_volume_attachments`
 * for the service, in order. Failures on individual volumes do not
 * abort the sweep — the scheduler records one row per volume.
 */
export async function backupServiceVolumes(
  app: Parameters<FastifyPluginAsync>[0],
  serviceId: number,
  log: (line: string) => void = () => undefined,
): Promise<{ created: number; failed: number }> {
  const svc = await app.db.query.services.findFirst({ where: eq(services.id, serviceId) });
  if (!svc) return { created: 0, failed: 0 };

  const targets: string[] = [];
  // r163: the primary volume is `nd-svc-<slug>-data` (builders/docker.ts
  // mounts it at `volumeMount`). This used to push the CONTAINER path
  // (`/data` → `data`), which the managed-name filter below then dropped —
  // a template service with only its primary volume was "backed up" with
  // created=0, failed=0, and nothing on disk.
  if (svc.volumeMount) targets.push(`nd-svc-${svc.slug}-data`);
  // Always include the explicit attachments, regardless of type.
  const atts = await app.db
    .select()
    .from(serviceVolumeAttachments)
    .where(eq(serviceVolumeAttachments.serviceId, serviceId));
  for (const a of atts) targets.push(a.volumeName);

  // Dedup + filter to managed names only (defense in depth).
  const unique = [...new Set(targets)].filter((n) => /^nd-(svc|db)-[a-z0-9_.-]+$/.test(n));

  let created = 0;
  let failed = 0;
  for (const name of unique) {
    if (!(await volumeExists(name).catch(() => false))) {
      log(`Skipping ${name} — not on this host`);
      failed++;
      continue;
    }
    const scheduledLabel = `schedule-${new Date().toISOString().slice(0, 10)}`;
    const { file } = newBackupFile(name, scheduledLabel);
    const [row] = await app.db
      .insert(backups)
      .values({ databaseId: null, volumeName: name, scope: 'volumes', status: 'running', path: file, label: scheduledLabel })
      .returning();
    try {
      await backupVolume(name, file, log);
      const sizeBytes = existsSync(file) ? statSync(file).size : 0;
      await app.db.update(backups).set({ status: 'completed', sizeBytes }).where(eq(backups.id, row!.id));
      await uploadBackup(app.db, row!.id, file, log).catch(() => undefined);
      await pruneOldBackups(app.db, name, log);
      created++;
    } catch (err) {
      await app.db.update(backups).set({ status: 'failed' }).where(eq(backups.id, row!.id));
      try { unlinkSync(file); } catch { /* best-effort */ }
      log(`Scheduled backup of ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  return { created, failed };
}

/** Mark unused imports so a future tree-shake doesn't drop them. */
void isNotNull;
void assertMayUseHostPrivilege;
