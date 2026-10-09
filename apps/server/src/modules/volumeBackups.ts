import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { backups, databases, serviceVolumeAttachments, services } from '@ninedeploy/db';
import { createVolumeBackup } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { config } from '../config.js';
import { backupVolume, createBackupReadStream, restoreVolume, volumeExists } from '../engine/database.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';
import { badRequest, conflict, HttpError, notFound, parseId as num } from '../lib/errors.js';
import { capture } from '../lib/exec.js';
import { listManagedVolumeNames, resolveVolumeOwnerWithSharing } from '../lib/inventory.js';
import { uploadBackup, fetchRemoteBackup, deleteRemoteBackupForRetention } from '../lib/backupRemote.js';
import { MAX_REPLICAS, replicaNames } from '../engine/dockerNames.js';
import { assertMayUseHostPrivilege } from '../lib/hostPrivilege.js';
// ── 0.16 T5 node volumes ──
import { assertNodeCapability, capabilityRefusal, nodeLabel } from '../lib/agentCapabilities.js';
import { agentOp, agentTransportSealed } from '../lib/agentClient.js';
import { backupNodeVolume, nodeVolumeExists, nodeVolumeUsers, requireNode, restoreNodeVolume, volumeHostId } from '../lib/nodeVolumes.js';
// ── end 0.16 T5 ──

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

/**
 * F183: the pre-restore "is it running?" probe must fail CLOSED. The shared
 * lib/inventory containerRunning() maps any docker CLI failure to "not
 * running" — here that let a restore swap files under a live service. A
 * failed probe refuses the restore (503) instead.
 */
async function runningForRestore(container: string): Promise<boolean> {
  let out: string;
  try {
    out = await capture('docker', ['ps', '--filter', `name=^${container}$`, '-q']);
  } catch (err) {
    throw new HttpError(
      503,
      'runtime_daemon_unavailable',
      `Could not verify that ${container} is stopped (${err instanceof Error ? err.message : String(err)}) — restore refused`,
    );
  }
  return out.trim().length > 0;
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
    // 0.16 T5: where the volume lived when it was backed up (null = the panel host).
    serverId: b.serverId ?? null,
  };
}

// ── 0.16 T5 node volumes ──
/** How a volume's host is named in messages. */
const hostName = (serverId: number | null): string => (serverId === null ? 'the panel host' : `node #${serverId}`);

/** What a node volume backup or restore needs from the agent (design §4.2). */
const NODE_STREAM_CAPS = ['stream', 'volume.manage'] as const;

/**
 * The restore guard for a node volume: every container on the node that
 * mounts the volume must be stopped (the panel host's r164/F182 rule, read
 * from the node's own `docker ps`). Fails closed: a node that cannot answer
 * refuses the restore. A container that is a service's runtime is named as
 * that service, with the panel host's "stop the service" message.
 */
async function assertNodeVolumeIdle(
  app: Parameters<FastifyPluginAsync>[0],
  serverId: number,
  volumeName: string,
  serviceIds: number[],
): Promise<void> {
  let users: Awaited<ReturnType<typeof nodeVolumeUsers>>;
  try {
    users = await nodeVolumeUsers(app.db, serverId, volumeName);
  } catch (err) {
    throw new HttpError(
      503,
      'runtime_daemon_unavailable',
      `Could not verify on node #${serverId} that nothing uses ${volumeName} (${err instanceof Error ? err.message : String(err)}) — restore refused`,
    );
  }
  const running = users.filter((u) => u.running);
  if (running.length === 0) return;
  for (const sid of serviceIds) {
    const svc = await app.db.query.services.findFirst({ where: eq(services.id, sid) });
    if (!svc?.runtimeId) continue;
    const names = new Set(replicaNames(svc.runtimeId, MAX_REPLICAS));
    if (running.some((u) => names.has(u.container))) {
      throw conflict(`Service "${svc.name}" is running — stop the service before restoring`);
    }
  }
  throw conflict(`Volume ${volumeName} is in use on node #${serverId} by ${running.map((u) => u.container).join(', ')} — stop it before restoring`);
}
// ── end 0.16 T5 ──

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
  // ── 0.16 T5 node volumes ── (null = the panel host, today's check)
  serverId: number | null = null,
  // ── end 0.16 T5 ──
): Promise<{ serviceIds: number[]; databaseContainer: string | null }> {
  if (!volumeName.startsWith('nd-svc-') && !volumeName.startsWith('nd-db-')) {
    throw badRequest('not a managed volume');
  }
  // ── 0.16 T5 node volumes ──
  if (serverId !== null) {
    await requireNode(app.db, serverId);
    if (!(await nodeVolumeExists(app.db, serverId, volumeName))) {
      throw notFound(`Volume '${volumeName}' does not exist on node #${serverId}`);
    }
  } else {
    // ── end 0.16 T5 ──
    const known = (await listManagedVolumeNames().catch(() => [] as string[])).includes(volumeName);
    if (!known) throw notFound(`Volume '${volumeName}' does not exist on this host`);
  }

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
    // 0.16 T5: `?serverId=` lists the backups taken on that node only;
    // absent = every backup of the name, as before (each row says its host).
    const host = volumeHostId(req.query);
    await authorizeVolume(app, req.user!, name, true, host);
    const rows = await app.db
      .select()
      .from(backups)
      .where(and(eq(backups.volumeName, name), eq(backups.scope, 'volumes')))
      .orderBy(desc(backups.createdAt));
    return (host === null ? rows : rows.filter((r) => (r.serverId ?? null) === host)).map(serialize);
  });

  // ── POST /:name/backups — trigger a new backup now ─────────────────────
  // Admin-only because the snapshot operation is host-level (sibling
  // container + tar to host disk). Same posture as the database backup
  // route, which is also admin-only.
  app.post('/:name/backups', { preHandler: [app.requireAdmin] }, async (req) => {
    const name = (req.params as { name: string }).name;
    const input = createVolumeBackup.parse(req.body ?? {});
    // ── 0.16 T5 node volumes ──
    // `?serverId=`: the volume on that node, streamed through its agent into
    // the same backups directory, file name and format (design §4.2).
    const host = volumeHostId(req.query);
    if (host !== null) {
      await authorizeVolume(app, req.user!, name, true, host);
      return serialize(await backupVolumeOnNode(app, host, name, input.label, (line) => req.log.info({ component: 'volume-backup' }, line), req.user!.id));
    }
    // ── end 0.16 T5 ──
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
      // F180: uploadBackup can throw (an undecryptable destination secret);
      // that must not reach the catch below, which would flip this completed
      // row to `failed` and unlink the finished snapshot.
      await uploadBackup(app.db, row!.id, file, log).catch((err: unknown) => {
        log(`warning: remote upload failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      // Prune older backups so the directory never grows unbounded.
      await pruneOldBackups(app.db, name, log).catch((err: unknown) => {
        log(`warning: backup retention failed: ${err instanceof Error ? err.message : String(err)}`);
      });
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
  // itself can stay mounted; the engine extracts into a staging directory
  // and swaps the contents in. We refuse if the service is running because
  // the operating container holds open file handles and a clean restore
  // means "swap the bytes under the live process" which corrupts anything
  // that was mmap()'d.
  app.post('/:name/backups/:bid/restore', { preHandler: [app.requireAdmin] }, async (req) => {
    const name = (req.params as { name: string }).name;
    const bid = num((req.params as { bid: string }).bid);
    // ── 0.16 T5 node volumes ──
    // The target host: `?serverId=` (a node) or the panel host. A backup
    // taken on another host restores only with `?acrossHosts=true` — the
    // archive format is the same everywhere; this guards against surprise
    // when the service moved (design §4.2).
    const host = volumeHostId(req.query);
    const acrossHosts = (req.query as { acrossHosts?: unknown }).acrossHosts === 'true';
    // ── end 0.16 T5 ──
    const { serviceIds, databaseContainer } = await authorizeVolume(app, req.user!, name, true, host);

    const b = await app.db.query.backups.findFirst({
      where: and(eq(backups.id, bid), eq(backups.volumeName, name), eq(backups.scope, 'volumes')),
    });
    if (!b) throw notFound('Backup not found');
    // ── 0.16 T5 node volumes ──
    const takenOn = b.serverId ?? null;
    if (takenOn !== host && !acrossHosts) {
      throw new HttpError(
        409,
        'backup_host_mismatch',
        `This backup was taken on ${hostName(takenOn)} and the restore targets ${hostName(host)}. Confirm with ?acrossHosts=true to restore it there.`,
      );
    }
    if (host !== null) {
      // Refused before anything but `agent.ping` when the node cannot stream.
      await assertNodeCapability(app.db, host, { cap: [...NODE_STREAM_CAPS], feature: 'restore a volume', sealedRequired: true });
      await assertNodeVolumeIdle(app, host, name, serviceIds);
    }
    // ── end 0.16 T5 ──

    // Refuse if the owning database, the owning service or any service
    // attaching the volume is currently running.
    if (host === null && databaseContainer && (await runningForRestore(databaseContainer))) {
      throw conflict('The database is running — stop it before restoring its volume');
    }
    for (const sid of host === null ? serviceIds : []) {
      const svc = await app.db.query.services.findFirst({ where: eq(services.id, sid) });
      if (!svc?.runtimeId) continue;
      // F182: replicas (`<runtimeId>-r2..-rN`) mount the volume too — a
      // running replica blocks the restore even when the primary is down.
      for (const container of replicaNames(svc.runtimeId, MAX_REPLICAS)) {
        if (await runningForRestore(container)) {
          throw conflict(`Service "${svc.name}" is running — stop the service before restoring`);
        }
      }
    }

    const log = (line: string) => req.log.info({ component: 'volume-restore' }, line);
    // Remote-only: fetch to a local temp file first, restore, then remove.
    let restorePath = b.path;
    let isRemoteTemp = false;
    if (!existsSync(b.path)) {
      if (!b.remoteKey) throw notFound('Backup not found');
      // r647: unique per request — see modules/backups.ts.
      restorePath = `${b.path}.${randomUUID()}.remote`;
      log(`Fetching remote object ${b.remoteKey}`);
      await fetchRemoteBackup(app.db, b, restorePath);
      isRemoteTemp = true;
    }

    try {
      // ── 0.16 T5 node volumes ──
      if (host !== null) await restoreNodeVolume(app.db, host, name, restorePath, log);
      else await restoreVolume(name, restorePath, log);
      // ── end 0.16 T5 ──
    } catch (err) {
      if (host !== null && err instanceof HttpError) throw err;
      throw badRequest(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (isRemoteTemp) {
        try { unlinkSync(restorePath); } catch { /* best-effort */ }
      }
    }
    void audit(
      app.db,
      req.user!.id,
      'volume.backup.restore',
      `${name}${host === null ? '' : ` on node #${host}`} ← ${path.basename(restorePath)}`,
    );
    return { ok: true };
  });

  // ── GET /:name/backups/:bid/download — stream the tar.gz to the client ─
  // Admin-only. Snapshots are encrypted at rest under the master key; the
  // stream decrypts on the fly so the client receives the plain tar.gz
  // (legacy plaintext archives stream as-is — same posture as DB backups).
  app.get('/:name/backups/:bid/download', { preHandler: [app.requireAdmin] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const name = (req.params as { name: string }).name;
    const bid = num((req.params as { bid: string }).bid);
    await authorizeVolume(app, req.user!, name, true, volumeHostId(req.query));
    const b = await app.db.query.backups.findFirst({
      where: and(eq(backups.id, bid), eq(backups.volumeName, name), eq(backups.scope, 'volumes')),
    });
    if (!b || !existsSync(b.path)) throw notFound('Backup file not found');
    reply
      .type('application/gzip')
      .header('content-disposition', `attachment; filename="${path.basename(b.path)}"`)
      .send(await createBackupReadStream(b.path));
    return reply;
  });
};

/**
 * Keep the most recent N completed backups and N failed attempts for one
 * volume. Older finished rows and files are deleted; running snapshots are
 * untouched. Called after a successful backup.
 *
 * Exported for the scheduled-job path — a `kind: 'backup'` cron also
 * calls this so the schedule doesn't pile up duplicates.
 */
export async function pruneOldBackups(
  db: Parameters<FastifyPluginAsync>[0]['db'],
  volumeName: string,
  log: (line: string) => void = () => undefined,
  // 0.16 T5: retention is per host — a node's copies never push the panel
  // host's out, nor the other way round. null = the panel host (every
  // pre-0.16 row), so the panel host's retention is unchanged.
  serverId: number | null = null,
): Promise<{ deleted: number; kept: number }> {
  const keep = config.volumeBackupRetainCount;
  const rows = (
    await db
      .select()
      .from(backups)
      .where(and(eq(backups.volumeName, volumeName), eq(backups.scope, 'volumes')))
      .orderBy(desc(backups.createdAt))
  ).filter((row) => (row.serverId ?? null) === serverId);
  // Preserve recovery points independently from failed attempts, and never
  // unlink a running snapshot while another backup is finishing.
  const toDelete = [
    ...rows.filter((row) => row.status === 'completed').slice(keep),
    ...rows.filter((row) => row.status === 'failed').slice(keep),
  ];
  if (toDelete.length === 0) return { deleted: 0, kept: rows.length };
  let deleted = 0;
  for (const row of toDelete) {
    try { unlinkSync(row.path); } catch { /* file may already be gone */ }
    // F181: the row is the only pointer to its remote object — drop it only
    // once the recorded destination confirmed the delete (r542 contract);
    // a failure or an unknown destination keeps it for the next sweep.
    if (row.remoteKey) {
      const outcome = await deleteRemoteBackupForRetention(db, row).catch((err: unknown) => {
        log(`warning: remote retention delete failed for ${row.remoteKey}: ${err instanceof Error ? err.message : String(err)}`);
        return 'failed' as const;
      });
      if (outcome !== 'deleted') continue;
    }
    await db.delete(backups).where(eq(backups.id, row.id));
    deleted++;
  }
  const kept = rows.length - deleted;
  log(`Pruned ${deleted} old backup(s) for ${volumeName}${serverId === null ? '' : ` on node #${serverId}`} (kept ${kept})`);
  return { deleted, kept };
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

  // ── 0.16 T5 node volumes ──
  // A service on a node keeps its volumes there (design §4.2): they are
  // streamed through the node's agent, never confused with a panel-host
  // namesake.
  if (svc.serverId != null) return backupNodeServiceVolumes(app, svc.serverId, unique, log);
  // ── end 0.16 T5 ──

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
      await pruneOldBackups(app.db, name, log).catch((err: unknown) => {
        log(`warning: backup retention failed: ${err instanceof Error ? err.message : String(err)}`);
      });
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

// ── 0.16 T5 node volumes ──
/**
 * Back one node volume up: the row (with `server_id`) is reserved first, the
 * archive streams into the panel's backups directory, then the off-site copy
 * and the per-host retention run exactly as for a panel-host backup.
 */
async function backupVolumeOnNode(
  app: Parameters<FastifyPluginAsync>[0],
  serverId: number,
  name: string,
  label: string | undefined,
  log: (line: string) => void,
  userId: number | null,
): Promise<typeof backups.$inferSelect> {
  // Refused before a row exists or anything but `agent.ping` is sent.
  await assertNodeCapability(app.db, serverId, { cap: [...NODE_STREAM_CAPS], feature: 'export a volume', sealedRequired: true });
  const { file } = newBackupFile(name, label);
  const rowLabel = label?.trim() || 'manual';
  const [row] = await app.db
    .insert(backups)
    .values({ databaseId: null, volumeName: name, scope: 'volumes', status: 'running', path: file, label: rowLabel, serverId })
    .returning();
  try {
    await backupNodeVolume(app.db, serverId, name, file, log);
    const sizeBytes = existsSync(file) ? statSync(file).size : 0;
    await app.db.update(backups).set({ status: 'completed', sizeBytes }).where(eq(backups.id, row!.id));
    // F180: an upload failure never fails a completed snapshot.
    await uploadBackup(app.db, row!.id, file, log).catch((err: unknown) => {
      log(`warning: remote upload failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    await pruneOldBackups(app.db, name, log, serverId).catch((err: unknown) => {
      log(`warning: backup retention failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  } catch (err) {
    await app.db.update(backups).set({ status: 'failed' }).where(eq(backups.id, row!.id));
    try { unlinkSync(file); } catch { /* best-effort */ }
    if (err instanceof HttpError) throw err;
    throw badRequest(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const updated = await app.db.query.backups.findFirst({ where: eq(backups.id, row!.id) });
  void audit(app.db, userId, 'volume.backup.create', `${name} on node #${serverId} → ${path.basename(file)}`);
  return updated!;
}

/** The scheduled sweep for a service on a node: one row per volume, failures counted, never thrown. */
async function backupNodeServiceVolumes(
  app: Parameters<FastifyPluginAsync>[0],
  serverId: number,
  names: string[],
  log: (line: string) => void,
): Promise<{ created: number; failed: number }> {
  if (names.length === 0) return { created: 0, failed: 0 };
  const caller = (op: string, params: Record<string, unknown>, sink: (line: string) => void) => agentOp(app.db, serverId, op, params, sink);
  const refusal = await capabilityRefusal(caller, await nodeLabel(app.db, serverId), await agentTransportSealed(app.db, serverId), {
    cap: [...NODE_STREAM_CAPS],
    feature: 'export a volume',
    sealedRequired: true,
    persist: { db: app.db, serverId },
  });
  if (refusal) {
    log(`Skipping ${names.join(', ')} on node #${serverId}: ${refusal.message}`);
    return { created: 0, failed: names.length };
  }
  let created = 0;
  let failed = 0;
  for (const name of names) {
    try {
      if (!(await nodeVolumeExists(app.db, serverId, name))) {
        log(`Skipping ${name} — not on node #${serverId}`);
        failed++;
        continue;
      }
      await backupVolumeOnNode(app, serverId, name, `schedule-${new Date().toISOString().slice(0, 10)}`, log, null);
      created++;
    } catch (err) {
      log(`Scheduled backup of ${name} on node #${serverId} failed: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  return { created, failed };
}
// ── end 0.16 T5 ──

/** Mark unused imports so a future tree-shake doesn't drop them. */
void isNotNull;
void assertMayUseHostPrivilege;
