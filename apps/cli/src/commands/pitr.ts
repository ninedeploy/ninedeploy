/**
 * `ninedeploy databases pitr …` — R3 PostgreSQL point-in-time recovery.
 *
 *   status <dbId>                          settings, archiving health, recoverable window, base backups
 *   enable <dbId> [--retention <days>]     restart with WAL archiving; the first base backup follows
 *   disable <dbId> [--yes]                 restart without it and DELETE the archive
 *   base-backup <dbId>                     take a base backup now
 *   recover <dbId> --name <n> [--to <time>] [--no-wait]
 *                                          recover into a NEW database (the source is never touched)
 *   recoveries <dbId>                      recovery history
 */
import type { NineDeployClient } from '../client.js';
import { prompt } from '../prompts.js';
import { c, error, fmtBytes, header, info, kv, spinner, success, table } from '../lib/format.js';

const num = (v: string, usage: string): number | null => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    error(usage);
    process.exitCode = 1;
    return null;
  }
  return n;
};
const fail = (err: unknown): void => {
  error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
};

export async function pitrStatus(client: NineDeployClient, dbIdStr: string): Promise<void> {
  const id = num(dbIdStr, 'Usage: ninedeploy databases pitr status <dbId>');
  if (id === null) return;
  let s: Awaited<ReturnType<NineDeployClient['databases']['pitr']['get']>>;
  try { s = await spinner('Reading point-in-time recovery', () => client.databases.pitr.get(id)); } catch (err) { fail(err); return; }
  header('Point-in-time recovery');
  if (!s.available) {
    info(s.unavailableReason ?? 'Not available for this database.');
    return;
  }
  kv('Enabled', s.enabled ? 'yes' : 'no');
  if (!s.enabled) {
    info(`Turn it on with: ninedeploy databases pitr enable ${id}`);
    return;
  }
  kv('Retention', `${s.retentionDays} day(s)`);
  kv('Last base backup', s.lastBaseBackupAt ?? c.yellow('none yet'));
  if (s.baseBackupRunning) kv('Base backup', 'running');
  if (s.archiving) {
    kv('Archiving', s.archiving.failing ? c.red(`FAILING since ${s.archiving.lastFailedAt}`) : `ok (${s.archiving.archivedCount} segment(s), last ${s.archiving.lastArchivedAt ?? 'never'})`);
  }
  kv('Archive', `${fmtBytes(s.archiveBytes)} in ${s.segmentCount} segment(s)`);
  if (s.lastError) console.log(`  ${c.yellow('!')} ${c.yellow(s.lastError)}`);
  if (s.recoverable.length) {
    console.log(`  ${c.dim('Recoverable:')}`);
    for (const r of s.recoverable) console.log(`    ${r.from} → ${r.to}`);
  } else info('Nothing is recoverable yet: the first base backup has not finished.');
  if (s.baseBackups.length) {
    table(s.baseBackups.map((b) => ({ label: b.label, finished: b.finishedAt, size: fmtBytes(b.sizeBytes) })));
  }
}

export async function pitrEnable(client: NineDeployClient, dbIdStr: string, opts: { retention?: string } = {}): Promise<void> {
  const id = num(dbIdStr, 'Usage: ninedeploy databases pitr enable <dbId> [--retention <days>]');
  if (id === null) return;
  const retentionDays = opts.retention === undefined ? undefined : Number(opts.retention);
  if (retentionDays !== undefined && (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 35)) {
    error('--retention must be a whole number of days between 1 and 35');
    process.exitCode = 1;
    return;
  }
  try {
    const s = await spinner('Restarting the database with WAL archiving', () =>
      client.databases.pitr.set(id, retentionDays === undefined ? { enabled: true } : { enabled: true, retentionDays }));
    success(`Point-in-time recovery is on (retention ${s.retentionDays} day(s)). The first base backup is running; see it with: ninedeploy databases pitr status ${id}`);
  } catch (err) { fail(err); }
}

export async function pitrDisable(client: NineDeployClient, dbIdStr: string, opts: { yes?: boolean } = {}): Promise<void> {
  const id = num(dbIdStr, 'Usage: ninedeploy databases pitr disable <dbId> [--yes]');
  if (id === null) return;
  if (!opts.yes) {
    const answer = await prompt('Type "disable" to turn point-in-time recovery off and DELETE its WAL archive and base backups', '');
    if (answer.trim() !== 'disable') {
      info('Aborted.');
      return;
    }
  }
  try {
    await spinner('Restarting the database without archiving', () => client.databases.pitr.set(id, { enabled: false }));
    success('Point-in-time recovery is off; its archive was deleted.');
  } catch (err) { fail(err); }
}

export async function pitrBaseBackup(client: NineDeployClient, dbIdStr: string): Promise<void> {
  const id = num(dbIdStr, 'Usage: ninedeploy databases pitr base-backup <dbId>');
  if (id === null) return;
  try {
    await spinner('Starting a base backup', () => client.databases.pitr.baseBackup(id));
    success(`Base backup started. See it with: ninedeploy databases pitr status ${id}`);
  } catch (err) { fail(err); }
}

export async function pitrRecover(
  client: NineDeployClient,
  dbIdStr: string,
  opts: { name?: string; to?: string; wait?: boolean; pollMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const id = num(dbIdStr, 'Usage: ninedeploy databases pitr recover <dbId> --name <new database> [--to <time>]');
  if (id === null) return;
  if (!opts.name?.trim()) {
    error('--name is required: the recovery creates a new database with this name.');
    process.exitCode = 1;
    return;
  }
  let targetTime: string | null = null;
  if (opts.to !== undefined) {
    const at = new Date(opts.to);
    // A bare date-time would be read in this machine's zone; the panel needs one.
    if (Number.isNaN(at.getTime()) || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(opts.to.trim())) {
      error('--to must be an ISO 8601 time with a zone, e.g. 2026-11-05T09:30:00Z or 2026-11-05T10:30:00+01:00');
      process.exitCode = 1;
      return;
    }
    targetTime = at.toISOString();
  }
  let admitted: Awaited<ReturnType<NineDeployClient['databases']['pitr']['recover']>>;
  try {
    admitted = await spinner('Starting the recovery', () => client.databases.pitr.recover(id, { name: opts.name!.trim(), targetTime }));
  } catch (err) { fail(err); return; }
  if (opts.wait === false) {
    info(`Recovery #${admitted.recoveryId} started into database #${admitted.databaseId}. See it with: ninedeploy databases pitr recoveries ${id}`);
    return;
  }
  const pollMs = opts.pollMs ?? 3000;
  const deadline = Date.now() + (opts.timeoutMs ?? 6 * 60 * 60_000);
  let recovery: Awaited<ReturnType<NineDeployClient['databases']['pitr']['recovery']>>;
  try {
    recovery = await spinner(targetTime ? `Recovering to ${targetTime}` : 'Recovering to the latest archived point', async () => {
      for (;;) {
        const r = await client.databases.pitr.recovery(id, admitted.recoveryId);
        if (r.status !== 'running') return r;
        if (Date.now() >= deadline) throw new Error(`recovery #${admitted.recoveryId} is still running; see it with: ninedeploy databases pitr recoveries ${id}`);
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    });
  } catch (err) { fail(err); return; }
  if (recovery.status === 'completed') {
    success(`Recovered into database #${recovery.databaseId} in ${recovery.restoreMs ?? '?'} ms (WAL replay).`);
    kv('Replay stopped', recovery.recoveredTo ?? '');
    kv('Base backup', recovery.baseBackup ?? '');
    return;
  }
  error(`Recovery #${recovery.id} failed: ${recovery.error ?? 'unknown reason'}`);
}

export async function pitrRecoveries(client: NineDeployClient, dbIdStr: string): Promise<void> {
  const id = num(dbIdStr, 'Usage: ninedeploy databases pitr recoveries <dbId>');
  if (id === null) return;
  let rows: Awaited<ReturnType<NineDeployClient['databases']['pitr']['recoveries']>>;
  try { rows = await client.databases.pitr.recoveries(id); } catch (err) { fail(err); return; }
  if (rows.length === 0) {
    info('No recoveries yet.');
    return;
  }
  table(rows.map((r) => ({
    id: r.id,
    status: r.status,
    target: r.targetTime ?? 'latest',
    database: r.databaseId ?? '',
    'replay stopped': r.recoveredTo ?? '',
    ms: r.restoreMs ?? '',
    error: r.error ?? '',
  })));
}
