import { existsSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { backups, databases } from '@ninedeploy/db';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { backupDatabase } from '../engine/database.js';
import { uploadBackup } from '../lib/backupRemote.js';
import { audit } from '../lib/audit.js';

const KEEP_PER_DB = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A running database whose newest scheduled backup is older than this is in
 *  the "missed" state: the pipeline has silently stopped covering it (panel
 *  was down over the tick, the tick itself errored, …). */
const MISSED_AFTER_MS = 2 * DAY_MS;

/** Databases (running) whose newest scheduled backup is older than
 *  `missedAfterMs` — or that have no scheduled backup despite existing
 *  longer than that. Newborn databases are exempt until the first window
 *  passes; non-running ones are not on the backup story at all. */
export function missedBackupsFrom(
  running: Array<{ id: number; name: string; status: string; createdAt: Date }>,
  scheduled: Array<{ databaseId: number | null; scope: string; createdAt: Date }>,
  opts: { missedAfterMs: number; now: number },
): Array<{ id: number; name: string; days: number }> {
  // Newest-first: the first scheduled row per database is its latest one.
  const newestByDb = new Map<number, number>();
  for (const r of scheduled) {
    if (r.databaseId == null || r.scope !== 'scheduled' || newestByDb.has(r.databaseId)) continue;
    newestByDb.set(r.databaseId, new Date(r.createdAt).getTime());
  }
  const out: Array<{ id: number; name: string; days: number }> = [];
  for (const d of running) {
    if (d.status !== 'running') continue;
    const lastCovered = newestByDb.get(d.id) ?? d.createdAt.getTime();
    const behind = opts.now - lastCovered;
    if (behind < opts.missedAfterMs) continue;
    out.push({ id: d.id, name: d.name, days: Math.max(1, Math.floor(behind / DAY_MS)) });
  }
  return out;
}

/** Backs up every running database once a day, keeping the latest KEEP_PER_DB per database. */
export default fp(
  async (fastify) => {
    let running = true;
    let timer: NodeJS.Timeout | undefined;
    /** Databases already notified about a missed backup — one notification
     *  per incident, cleared as soon as a backup covers them again. */
    const missedNotified = new Set<number>();

    const tick = async () => {
      try {
        const dbs = (await fastify.db.select().from(databases)).filter((d) => d.status === 'running');
        // Missed-backup watchdog: fires BEFORE this tick's backups so it sees
        // the true age of the pipeline's last output. Covers the case the
        // per-run failure audit cannot — the scheduler not having run at all.
        try {
          const scheduled = await fastify.db.query.backups.findMany({
            where: eq(backups.scope, 'scheduled'),
            orderBy: desc(backups.createdAt),
          });
          const missed = missedBackupsFrom(dbs, scheduled, { missedAfterMs: MISSED_AFTER_MS, now: Date.now() });
          for (const m of missed) {
            if (missedNotified.has(m.id)) continue;
            missedNotified.add(m.id);
            fastify.log.warn({ databaseId: m.id, days: m.days }, 'scheduled backup missing');
            void audit(fastify.db, null, 'backup.missed', `${m.name}: no scheduled backup for ${m.days} day(s)`);
          }
        } catch {
          /* the watchdog must never break the tick */
        }
        for (const d of dbs) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const file = path.join(config.paths.backupsDir, `${d.slug}-${ts}.dump`);
          const log = (line: string) => fastify.log.info({ component: 'backup' }, line);
          try {
            await backupDatabase(d, file, log);
            const [row] = await fastify.db
              .insert(backups)
              .values({
                databaseId: d.id,
                scope: 'scheduled',
                status: 'completed',
                path: file,
                sizeBytes: existsSync(file) ? statSync(file).size : 0,
              })
              .returning({ id: backups.id });
            // Remote copy (best-effort, same as manual backups).
            if (row) await uploadBackup(fastify.db, row.id, file, log);
            // Covered again — clear any outstanding missed-backup incident.
            missedNotified.delete(d.id);
          } catch (err) {
            fastify.log.error({ err }, `scheduled backup failed for ${d.name}`);
            // A scheduled failure must not be log-only: record the failed row
            // (visible in the backups UI) and audit it — the audit bridge fans
            // out to the notification channels, so an operator learns about a
            // silently-broken backup pipeline the same way they learn about a
            // failed deploy. System-initiated: actor null (operator-scoped).
            // The insert itself is best-effort — never mask the tick loop.
            try {
              await fastify.db.insert(backups).values({
                databaseId: d.id,
                scope: 'scheduled',
                status: 'failed',
                path: file,
                sizeBytes: 0,
              });
            } catch {
              /* the failure row is cosmetic; the audit below still fires */
            }
            void audit(fastify.db, null, 'backup.schedule_failed', `${d.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
          // Prune the latest KEEP_PER_DB SCHEDULED backups for this database.
          // Manual (user-initiated) backups are never touched by the scheduler
          // and must be deleted explicitly from the UI.
          const rows = await fastify.db.query.backups.findMany({
            where: eq(backups.databaseId, d.id),
            orderBy: desc(backups.createdAt),
          });
          const scheduled = rows.filter((r) => r.scope === 'scheduled');
          for (const stale of scheduled.slice(KEEP_PER_DB)) {
            try {
              if (existsSync(stale.path)) unlinkSync(stale.path);
            } catch {
              /* file may be unreadable — still drop the row */
            }
            await fastify.db.delete(backups).where(eq(backups.id, stale.id));
          }
        }
      } catch (err) {
        fastify.log.error({ err }, 'backup scheduler tick failed');
      } finally {
        if (running) {
          timer = setTimeout(() => void tick(), DAY_MS);
          timer.unref?.();
        }
      }
    };

    fastify.addHook('onClose', async () => {
      running = false;
      clearTimeout(timer);
    });
    // First run in 24h (manual backups cover immediate needs); then daily.
    timer = setTimeout(() => void tick(), DAY_MS);
    timer.unref?.();
    fastify.log.info('backup scheduler armed (daily)');
  },
  { name: 'ninedeploy-backups' },
);
