import { existsSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import { desc, eq } from 'drizzle-orm';
import { backups, type DatabaseBackupPolicy, databases } from '@ninedeploy/db';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { backupDatabase } from '../engine/database.js';
import { deleteRemoteBackupForRetention, uploadBackup } from '../lib/backupRemote.js';
import { audit } from '../lib/audit.js';
import { backupPolicyEvents, cronPeriodMs, loadBackupPolicies, planRetention } from '../lib/backupPolicy.js';

/** Built-in retention for a database without a backup policy (0.12). */
const KEEP_PER_DB = 7;
/** r542: at most this many remote (S3) deletes per tick — raised to two per
 *  database so a steady state of one new remote backup per database per day
 *  always converges. The first sweep after an upgrade meets every remote row
 *  retention ever skipped; it works that backlog down over several ticks
 *  instead of firing thousands of S3 requests at once. */
const REMOTE_PRUNES_PER_TICK = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A running database whose newest scheduled backup is older than this is in
 *  the "missed" state: the pipeline has silently stopped covering it (panel
 *  was down over the tick, the tick itself errored, …). */
const MISSED_AFTER_MS = 2 * DAY_MS;
/** Never run the first tick sooner than this after boot. */
const STARTUP_GRACE_MS = 5 * 60 * 1000;

/**
 * Delay until the first scheduled tick after boot (r170): a day after the
 * newest scheduled backup — or, with none yet, a day after the oldest running
 * database appeared — clamped to [grace, 1 day]. It used to be a flat 24h
 * FROM BOOT, so a panel restarted more often than daily (auto-updates, panel
 * redeploys, crashes) never took a scheduled backup, and the missed-backup
 * watchdog living inside that same tick never fired either.
 */
export function firstTickDelay(
  newestScheduledAt: number | null,
  oldestRunningDbAt: number | null,
  now: number,
): number {
  const anchor = newestScheduledAt ?? oldestRunningDbAt ?? now;
  return Math.min(DAY_MS, Math.max(STARTUP_GRACE_MS, anchor + DAY_MS - now));
}

/** Databases (running) whose newest scheduled backup is older than
 *  `missedAfterMs` — or that have no scheduled backup despite existing
 *  longer than that. Newborn databases are exempt until the first window
 *  passes; non-running ones are not on the backup story at all. */
export function missedBackupsFrom(
  running: Array<{ id: number; name: string; status: string; createdAt: Date }>,
  scheduled: Array<{ databaseId: number | null; scope: string; createdAt: Date }>,
  opts: {
    missedAfterMs: number;
    now: number;
    /** 0.12: a per-database threshold (a weekly policy is not "missed" after
     *  two days); null exempts the database (its policy is disabled). */
    thresholdFor?: (databaseId: number) => number | null;
  },
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
    const threshold = opts.thresholdFor ? opts.thresholdFor(d.id) : opts.missedAfterMs;
    if (threshold == null) continue;
    const lastCovered = newestByDb.get(d.id) ?? d.createdAt.getTime();
    const behind = opts.now - lastCovered;
    if (behind < threshold) continue;
    out.push({ id: d.id, name: d.name, days: Math.max(1, Math.floor(behind / DAY_MS)) });
  }
  return out;
}

type DatabaseRow = typeof databases.$inferSelect;
type BackupRow = typeof backups.$inferSelect;
/** Remote-delete allowance shared by one run (r542). */
interface RemoteBudget {
  remaining: number;
  deferred: number;
}

/** How often policy crons are re-synced from the table — a safety net under
 *  the in-process change signal (a boot-time read error, a row written by
 *  another process). */
const POLICY_RESYNC_MS = 15 * 60 * 1000;

/**
 * Backs up every running database.
 *
 * A database WITHOUT a `database_backup_policies` row is on the built-in
 * daily tick: KEEP_PER_DB completed scheduled dumps kept, remote copy on the
 * active destination — unchanged since before 0.12, so an upgrade changes
 * nothing until an operator saves a policy.
 *
 * A database WITH a policy gets its own cron (server local time); its
 * retention and destination come from the row, and saving the policy re-arms
 * it at once (`notifyBackupPolicyChanged`). A disabled policy takes no
 * scheduled backups at all.
 */
export default fp(
  async (fastify) => {
    let running = true;
    let timer: NodeJS.Timeout | undefined;
    let resyncTimer: NodeJS.Timeout | undefined;
    /** Databases already notified about a missed backup — one notification
     *  per incident, cleared as soon as a backup covers them again. */
    const missedNotified = new Set<number>();
    /** Armed policy crons, with the (enabled, cron) they were armed from. */
    const policyCrons = new Map<number, { cron: Cron; signature: string }>();
    /** Databases with a scheduled backup in progress — a slow dump never
     *  overlaps the next fire of the same database. */
    const inFlight = new Set<number>();

    /** Dump one database, record it, upload it, audit it, then apply
     *  retention. `policy` null = the built-in rules. Never throws. */
    const backupOne = async (d: DatabaseRow, policy: DatabaseBackupPolicy | null, budget: RemoteBudget) => {
      if (inFlight.has(d.id)) {
        fastify.log.warn({ databaseId: d.id }, `scheduled backup for ${d.name} skipped: the previous one is still running`);
        return;
      }
      inFlight.add(d.id);
      try {
        await dumpOne(d, policy);
        await retainOne(d, policy, budget);
      } finally {
        inFlight.delete(d.id);
      }
    };

    const dumpOne = async (d: DatabaseRow, policy: DatabaseBackupPolicy | null) => {
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
        // Remote copy (best-effort, same as manual backups). F97: the dump
        // and its `completed` row are already committed — an upload throw
        // must not reach the failure arm below, which would add a `failed`
        // row owning this same file (failed-row retention then unlinks a
        // retained recovery point) and audit a success as a failure.
        // 0.12: a policy may name the destination, or keep the dump local.
        if (row && !policy?.localOnly) {
          try {
            if (policy) await uploadBackup(fastify.db, row.id, file, log, { destinationId: policy.destinationId ?? null });
            else await uploadBackup(fastify.db, row.id, file, log);
          } catch (err) {
            fastify.log.warn({ err }, `scheduled backup remote upload failed for ${d.name}`);
          }
        }
        // Covered again — clear any outstanding missed-backup incident.
        missedNotified.delete(d.id);
        // r528: audit() is the notification fan-out — without this a
        // daily backup never produced `backup.completed` (the audit bridge
        // maps `backup.create` onto it). Same action/entity as the manual
        // route; system-initiated, so the actor is null.
        void audit(fastify.db, null, 'backup.create', d.name, { scope: 'scheduled' });
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
    };

    /** Delete a row's remote copy for retention. 'kept' = the copy stays
     *  (budget spent, destination unknown, or the delete failed). */
    const pruneRemote = async (stale: BackupRow, budget: RemoteBudget): Promise<'deleted' | 'kept'> => {
      if (!stale.remoteKey) return 'deleted';
      if (budget.remaining <= 0) {
        budget.deferred++;
        return 'kept';
      }
      try {
        const outcome = await deleteRemoteBackupForRetention(fastify.db, stale);
        if (outcome === 'unknown-destination') return 'kept';
        budget.remaining--;
        return 'deleted';
      } catch (err) {
        budget.remaining--;
        fastify.log.warn(
          { err, backupId: stale.id, remoteKey: stale.remoteKey },
          'scheduled backup retention: remote delete failed — row kept, retried next sweep',
        );
        return 'kept';
      }
    };

    const retainOne = async (d: DatabaseRow, policy: DatabaseBackupPolicy | null, budget: RemoteBudget) => {
      // F96: retention is per database too — a prune error (e.g. SQLITE_BUSY
      // on the read or a row delete) used to escape to the tick-level
      // catch and silently skip the backups of every later database.
      try {
        // Manual (user-initiated) backups are never touched by the scheduler
        // and must be deleted explicitly from the UI. Failed attempts are
        // diagnostics, not recovery points: they keep their own bounded
        // history so an outage cannot evict every usable dump. Running
        // operations are never pruned. See planRetention.
        const rows = await fastify.db.query.backups.findMany({
          where: eq(backups.databaseId, d.id),
          orderBy: desc(backups.createdAt),
        });
        const plan = planRetention(
          rows,
          policy
            ? { retainCount: policy.retainCount, retainRemoteCount: policy.retainRemoteCount ?? null }
            : { retainCount: KEEP_PER_DB, retainRemoteCount: null },
        );
        if (plan.size === 0) return;
        const byId = new Map(rows.map((r) => [r.id, r]));
        // Never unlink a file a kept row still points at (the F97 shape: a
        // failed row sharing a completed dump's path).
        const keptPaths = new Set(
          rows.filter((r) => { const a = plan.get(r.id); return a === undefined || a === 'trim-remote'; }).map((r) => r.path),
        );
        const unlinkLocal = (stale: BackupRow) => {
          if (keptPaths.has(stale.path)) return;
          try {
            if (existsSync(stale.path)) unlinkSync(stale.path);
          } catch {
            /* file may be unreadable — still drop the row */
          }
        };
        for (const [id, action] of plan) {
          const stale = byId.get(id);
          if (!stale) continue;
          if (action === 'trim-local') {
            unlinkLocal(stale);
            continue;
          }
          if (action === 'trim-remote') {
            if (stale.remoteKey && (await pruneRemote(stale, budget)) === 'deleted') {
              await fastify.db.update(backups).set({ remoteKey: null, destinationId: null }).where(eq(backups.id, stale.id));
            }
            continue;
          }
          unlinkLocal(stale);
          // r542: remote-backed rows used to be skipped forever, so every
          // scheduled dump uploaded to S3 stayed there (and in this table)
          // for good. They now get the same keep-newest-N retention: the
          // remote object goes first, through the destination the row
          // records, and the row only once that delete succeeded (or the
          // object was already gone). A failure keeps the row for the next
          // sweep; a row whose destination is unknown is kept as before.
          if ((await pruneRemote(stale, budget)) === 'kept') continue;
          await fastify.db.delete(backups).where(eq(backups.id, stale.id));
        }
      } catch (err) {
        fastify.log.error({ err }, `scheduled backup retention failed for ${d.name}`);
      }
    };

    // ── built-in daily tick (databases without a policy) ───────────────────
    const tick = async () => {
      try {
        // Rethrows a real read error (never treat a policy database as
        // built-in — that would prune it to KEEP_PER_DB); empty pre-0067.
        const policies = await loadBackupPolicies(fastify.db);
        const dbs = (await fastify.db.select().from(databases)).filter((d) => d.status === 'running');
        const budget: RemoteBudget = { remaining: Math.max(REMOTE_PRUNES_PER_TICK, 2 * dbs.length), deferred: 0 };
        // Missed-backup watchdog: fires BEFORE this tick's backups so it sees
        // the true age of the pipeline's last output. Covers the case the
        // per-run failure audit cannot — the scheduler not having run at all.
        // Policy databases are judged against their own cadence.
        try {
          const scheduled = await fastify.db.query.backups.findMany({
            where: eq(backups.scope, 'scheduled'),
            orderBy: desc(backups.createdAt),
          });
          const now = Date.now();
          const missed = missedBackupsFrom(dbs, scheduled, {
            missedAfterMs: MISSED_AFTER_MS,
            now,
            thresholdFor: (id) => {
              const p = policies.get(id);
              if (!p) return MISSED_AFTER_MS;
              if (!p.enabled) return null;
              const period = cronPeriodMs(p.cron, new Date(now));
              return period == null ? null : Math.max(MISSED_AFTER_MS, 2 * period);
            },
          });
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
          if (policies.has(d.id)) continue; // on its own cron
          await backupOne(d, null, budget);
        }
        if (budget.deferred > 0) {
          fastify.log.info(
            { deferred: budget.deferred },
            'scheduled backup retention: remote prune budget reached — the rest go on later ticks',
          );
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

    // ── per-database policy crons ──────────────────────────────────────────
    const runPolicy = async (databaseId: number) => {
      if (!running) return;
      try {
        const policies = await loadBackupPolicies(fastify.db);
        const policy = policies.get(databaseId);
        if (!policy?.enabled) {
          armPolicy(databaseId, undefined); // removed or disabled since arming
          return;
        }
        const d = await fastify.db.query.databases.findFirst({ where: eq(databases.id, databaseId) });
        if (!d) {
          armPolicy(databaseId, undefined);
          return;
        }
        if (d.status !== 'running') return;
        const budget: RemoteBudget = { remaining: REMOTE_PRUNES_PER_TICK, deferred: 0 };
        await backupOne(d, policy, budget);
        if (budget.deferred > 0) {
          fastify.log.info(
            { deferred: budget.deferred, databaseId },
            'scheduled backup retention: remote prune budget reached — the rest go on later runs',
          );
        }
      } catch (err) {
        fastify.log.error({ err, databaseId }, 'policy backup run failed');
      }
    };

    /** (Re-)arm one database's cron from its policy row; undefined disarms. */
    function armPolicy(databaseId: number, policy: DatabaseBackupPolicy | undefined): void {
      const signature = policy?.enabled ? policy.cron : null;
      const current = policyCrons.get(databaseId);
      if (current && current.signature === signature) return;
      current?.cron.stop();
      policyCrons.delete(databaseId);
      if (!running || signature == null) return;
      try {
        const cron = new Cron(
          signature,
          { name: `backup-db-${databaseId}`, unref: true, mode: '5-part', protect: true },
          () => void runPolicy(databaseId),
        );
        policyCrons.set(databaseId, { cron, signature });
      } catch (err) {
        fastify.log.warn({ err, databaseId, cron: signature }, 'invalid backup policy cron — policy not armed');
      }
    }

    const resyncPolicies = async () => {
      let policies: Map<number, DatabaseBackupPolicy>;
      try {
        policies = await loadBackupPolicies(fastify.db);
      } catch (err) {
        fastify.log.warn({ err }, 'backup scheduler: could not read backup policies');
        return;
      }
      if (!running) return;
      for (const id of [...policyCrons.keys()]) if (!policies.has(id)) armPolicy(id, undefined);
      for (const [id, p] of policies) armPolicy(id, p);
    };

    const onPolicyChanged = (databaseId: number) => {
      void (async () => {
        try {
          const policies = await loadBackupPolicies(fastify.db);
          armPolicy(databaseId, policies.get(databaseId));
          fastify.log.info({ databaseId }, 'backup policy re-armed');
        } catch (err) {
          fastify.log.warn({ err, databaseId }, 'backup policy re-arm failed — next resync retries');
        }
      })();
    };
    backupPolicyEvents.on('changed', onPolicyChanged);

    fastify.addHook('onClose', async () => {
      running = false;
      clearTimeout(timer);
      clearInterval(resyncTimer);
      backupPolicyEvents.off('changed', onPolicyChanged);
      for (const { cron } of policyCrons.values()) cron.stop();
      policyCrons.clear();
    });
    // First run a day after the last built-in scheduled backup (see
    // firstTickDelay); then daily. Policy databases' dumps do not move the
    // built-in anchor.
    let delay = DAY_MS;
    let bootPolicies = new Map<number, DatabaseBackupPolicy>();
    try {
      bootPolicies = await loadBackupPolicies(fastify.db);
    } catch (err) {
      fastify.log.warn({ err }, 'backup scheduler: could not read backup policies at boot — resync retries');
    }
    try {
      const scheduled = (await fastify.db.query.backups.findMany({
        where: eq(backups.scope, 'scheduled'),
        orderBy: desc(backups.createdAt),
      })) as Array<{ scope?: string; databaseId?: number | null; createdAt: Date | null }>;
      const newest =
        scheduled.find((r) => r.scope === 'scheduled' && r.createdAt && !(r.databaseId != null && bootPolicies.has(r.databaseId)))
          ?.createdAt?.getTime() ?? null;
      const dbRows = (await fastify.db.select().from(databases)) as Array<{ id?: number; status: string; createdAt?: Date | null }>;
      const created = dbRows
        .filter((d) => d.status === 'running' && d.createdAt && !(d.id != null && bootPolicies.has(d.id)))
        .map((d) => (d.createdAt as Date).getTime());
      delay = firstTickDelay(newest, created.length ? Math.min(...created) : null, Date.now());
    } catch (err) {
      fastify.log.warn({ err }, 'backup scheduler: could not read history, first run in 24h');
    }
    timer = setTimeout(() => void tick(), delay);
    timer.unref?.();
    for (const [id, p] of bootPolicies) armPolicy(id, p);
    resyncTimer = setInterval(() => void resyncPolicies(), POLICY_RESYNC_MS);
    resyncTimer.unref?.();
    fastify.log.info('backup scheduler armed (daily)');
    if (policyCrons.size > 0) fastify.log.info({ policies: policyCrons.size }, 'backup policies armed');
  },
  { name: 'ninedeploy-backups' },
);
