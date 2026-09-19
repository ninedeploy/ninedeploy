/**
 * `ninedeploy backup drill` — prove a backup is at least
 * restorable without spinning up a real database container.
 *
 * A "drill" runs an engine-specific smoke check on the dump
 * file (pg_restore --list, redis-check-rdb, mysqldump header
 * parse, ...) and records the outcome on a `backup_drills`
 * row. The result is a *much* weaker guarantee than a real
 * restore-into-container (it does not catch a malformed but
 * well-formed dump, and it cannot catch missing extensions
 * or schema drift) — but it does catch the most common
 * failure mode, a corrupt or truncated file, and it does so
 * in under a second on the local disk.
 *
 * The drill never deletes or modifies the source backup.
 * Encrypted envelopes are decrypted to a sibling temp file
 * (and deleted on the way out) via the same flow
 * `engine/database.ts` uses for real restores; remote-only
 * backups are fetched to a local temp first via
 * `lib/backupRemote.ts`.
 */
import { open, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { backupDrills, backups, databases, type DB } from '@ninedeploy/db';
import { fetchRemoteBackup, type RemoteBackupRef } from './backupRemote.js';
import { decryptBackupFile, isEncryptedBackupFile } from './backupCrypto.js';
import { capture, run } from './exec.js';
import { readBackupBytes } from '../engine/database.js';

export interface DrillResult {
  drillId: number;
  status: 'passed' | 'failed';
  durationMs: number;
  details: Record<string, unknown> | null;
  error: string | null;
}

interface DrillContext {
  /** Host path to a plaintext dump ready for the engine-specific
   *  validator. Caller is responsible for cleanup. */
  file: string;
  /** Engine to dispatch to. */
  engine: string;
  /** Cleanup hook (delete temp files, etc.). */
  cleanup: () => Promise<void>;
}

/**
 * Run a drill on a specific backup of a specific database and
 * record the outcome. The function is idempotent: re-running
 * a drill on the same `backupId` creates a new row, never
 * mutates an old one.
 */
export async function runBackupDrill(
  db: DB,
  databaseId: number,
  backupId: number,
): Promise<DrillResult> {
  const dRow = await db.query.databases.findFirst({ where: eq(databases.id, databaseId) });
  if (!dRow) throw new Error(`Database ${databaseId} not found`);
  const bRow = await db.query.backups.findFirst({ where: eq(backups.id, backupId) });
  if (!bRow) throw new Error(`Backup ${backupId} not found`);
  if (bRow.databaseId !== dRow.id) {
    throw new Error(`Backup ${backupId} does not belong to database ${databaseId}`);
  }

  // Insert a 'running' row first so the operator sees the
  // attempt in the history list even if the process is
  // killed mid-drill (the row's status stays 'running' as a
  // signal that something went sideways, not a clean
  // 'failed' that would otherwise suggest a deterministic
  // problem with the backup).
  const [row] = await db
    .insert(backupDrills)
    .values({
      databaseId: dRow.id,
      backupId: bRow.id,
      status: 'running',
      engine: dRow.engine,
    })
    .returning();
  if (!row) throw new Error('Failed to insert backup_drills row');

  const startedAt = Date.now();
  let result: { passed: true; details: Record<string, unknown> } | { passed: false; error: string; details?: Record<string, unknown> };

  try {
    const ctx = await stageForDrill(db, bRow.path, bRow, dRow.engine);
    try {
      result = await validateDump(ctx);
    } finally {
      await ctx.cleanup().catch(() => undefined);
    }
  } catch (err) {
    result = {
      passed: false,
      error: `Drill setup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const completedAt = new Date();
  const durationMs = completedAt.getTime() - startedAt;
  const finalStatus = result.passed ? 'passed' : 'failed';
  // `completed_at` is a plain integer (unix seconds); `ts()` would
  // give us a Date, which the column does not accept.
  const completedAtEpoch = Math.floor(completedAt.getTime() / 1000);
  const [updated] = await db
    .update(backupDrills)
    .set({
      status: finalStatus,
      durationMs,
      error: result.passed ? null : result.error,
      detailsJson: result.details ? JSON.stringify(result.details) : null,
      completedAt: completedAtEpoch,
    })
    .where(eq(backupDrills.id, row.id))
    .returning();
  return {
    drillId: updated?.id ?? row.id,
    status: finalStatus,
    durationMs,
    details: result.passed ? result.details : (result.details ?? null),
    error: result.passed ? null : result.error,
  };
}

/**
 * List past drills for a database, newest first. The list is
 * capped at `limit` rows so the panel can render a compact
 * history without paging.
 */
export async function listBackupDrills(
  db: DB,
  databaseId: number,
  limit = 25,
): Promise<
  Array<{
    id: number;
    backupId: number;
    status: 'pending' | 'running' | 'passed' | 'failed';
    engine: string;
    durationMs: number;
    error: string | null;
    details: Record<string, unknown> | null;
    startedAt: number;
    completedAt: number | null;
  }>
> {
  const rows = await db
    .select()
    .from(backupDrills)
    .where(eq(backupDrills.databaseId, databaseId))
    .orderBy(desc(backupDrills.startedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    backupId: r.backupId,
    status: r.status,
    engine: r.engine,
    durationMs: r.durationMs,
    error: r.error,
    details: r.detailsJson ? (JSON.parse(r.detailsJson) as Record<string, unknown>) : null,
    startedAt: r.startedAt instanceof Date ? r.startedAt.getTime() : Number(r.startedAt),
    completedAt: r.completedAt != null ? Number(r.completedAt) : null,
  }));
}

// ── staging ────────────────────────────────────────────────────────────────

/**
 * Prepare a plaintext dump file for the engine-specific
 * validator. Mirrors `engine/database.ts`'s `stageForRestore`
 * for encrypted backups and adds the remote-fetch step the
 * restore route does inline. The returned `cleanup` is
 * always best-effort — a partial file left on disk is
 * preferable to a hard fail on the drill row.
 */
async function stageForDrill(
  db: DB,
  path: string,
  remote: RemoteBackupRef,
  _engine: string,
): Promise<DrillContext> {
  // Remote-only backup: pull to a local temp file first.
  let source = path;
  let fetched: string | null = null;
  if (!await fileExists(path).catch(() => false)) {
    if (!remote.remoteKey) {
      throw new Error('Backup file is missing on disk and no remote key is recorded');
    }
    fetched = join(tmpdir(), `nd-drill-${process.pid}-${Date.now()}.dump`);
    await fetchRemoteBackup(db, remote, fetched);
    source = fetched;
  }
  const dropFetched = async () => {
    if (fetched) await unlink(fetched).catch(() => undefined);
  };

  // r189: the fetched object goes through the SAME decryption as a local
  // file. The remote copy is the on-disk file uploaded as-is — an encrypted
  // NDBK1 envelope — and it used to be handed straight to the validator,
  // so every drill of a pruned-locally backup "failed" on ciphertext.
  if (await isEncryptedBackupFile(source)) {
    const dec = `${source}.${process.pid}-drill.dec`;
    await decryptBackupFile(source, dec);
    return {
      file: dec,
      engine: _engine,
      cleanup: async () => {
        await unlink(dec).catch(() => undefined);
        await dropFetched();
      },
    };
  }

  // Legacy single-line `v<n>:` envelope (pre-streaming backups), which the
  // restore path still reads: decrypt it the same way restore does.
  if (LEGACY_ENVELOPE_RE.test(await readHead(source, 32).catch(() => ''))) {
    const dec = `${source}.${process.pid}-drill.dec`;
    await writeFile(dec, readBackupBytes(source), { mode: 0o600 });
    return {
      file: dec,
      engine: _engine,
      cleanup: async () => {
        await unlink(dec).catch(() => undefined);
        await dropFetched();
      },
    };
  }

  // Plaintext: use in place.
  return { file: source, engine: _engine, cleanup: dropFetched };
}

const LEGACY_ENVELOPE_RE = /^v\d+:/;


async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ── engine-specific validators ────────────────────────────────────────────

/**
 * Read only the first `bytes` of a dump for header sniffing. Dumps scale
 * unbounded with tenant data — `readFile` loaded multi-GB dumps into heap
 * just to inspect 4 KiB (r034), so the sniff reads a bounded prefix through
 * an open handle instead.
 */
async function readHead(file: string, bytes = 4096): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Dispatch to the right engine validator. Each validator is
 * a separate function so a future engine (ClickHouse, Meili,
 * RabbitMQ — already in the DB engine enum but not yet wired
 * here) is a single new function rather than a switch arm in
 * a long function.
 */
async function validateDump(
  ctx: DrillContext,
): Promise<{ passed: true; details: Record<string, unknown> } | { passed: false; error: string; details?: Record<string, unknown> }> {
  switch (ctx.engine) {
    case 'postgres':
      return validatePostgres(ctx.file);
    case 'mysql':
    case 'mariadb':
      return validateMysql(ctx.file);
    case 'redis':
    case 'valkey':
      return validateRedis(ctx.file);
    case 'mongo':
      return validateMongo(ctx.file);
    default:
      return {
        passed: false,
        error: `Drill not supported for engine "${ctx.engine}"`,
      };
  }
}

/**
 * Postgres dump validator. Tries `pg_restore --list` first
 * (the canonical "is this pg_dump archive well-formed"
 * check) and falls back to a header sniff for plain-SQL
 * dumps, which `pg_restore` refuses to parse. Both paths
 * must exit 0 / find the expected marker to pass.
 */
async function validatePostgres(
  file: string,
): Promise<{ passed: true; details: Record<string, unknown> } | { passed: false; error: string }> {
  try {
    const out = await capture('pg_restore', ['--list', file]);
    // pg_restore --list exits 0 and prints one line per object
    // ("<n>; <oid> <oid> <kind> <ns> <name> <owner>"). An empty
    // archive is technically valid but suspicious — surface the
    // object count in `details` rather than failing.
    const lines = out.split('\n').filter((l) => l && !l.startsWith(';'));
    return { passed: true, details: { tool: 'pg_restore', objectCount: lines.length } };
  } catch (err) {
    // pg_restore refused — likely a plain-SQL dump. Sniff the
    // header; that's a much weaker guarantee but still
    // proves the file is at least a Postgres SQL script.
    const head = await readHead(file);
    if (/\b(PostgreSQL|pg_dump|SELECT|SET|CREATE|INSERT|\\restrict|\\unrestrict)\b/.test(head)) {
      return { passed: true, details: { tool: 'header-sniff', mode: 'plain-sql' } };
    }
    return {
      passed: false,
      error: `pg_restore --list failed and the file is not a recognised Postgres SQL script: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * MySQL / MariaDB dump validator. The canonical client tools
 * (`mysqlcheck`, `mysql --execute`) require a live server, so
 * the smoke check is a header sniff for the mysqldump banner
 * + a 4 KiB sample of the body, plus a non-zero size.
 */
async function validateMysql(
  file: string,
): Promise<{ passed: true; details: Record<string, unknown> } | { passed: false; error: string }> {
  const head = await readHead(file);
  const banner = /MySQL dump|MariaDB dump/i.test(head) ? head.match(/^(?:-+\s*)?(?:MySQL|MariaDB)\s+dump[\s\S]{0,80}/i)?.[0]?.trim() ?? null : null;
  if (!banner) {
    return { passed: false, error: 'No mysqldump / mariadb-dump banner found in first 4 KiB' };
  }
  return { passed: true, details: { tool: 'header-sniff', banner } };
}

/**
 * Redis / Valkey RDB validator. `redis-check-rdb` is the
 * canonical pre-flight tool: it parses the binary header and
 * every object entry, and exits non-zero with a stderr
 * description on the first malformed byte.
 */
async function validateRedis(
  file: string,
): Promise<{ passed: true; details: Record<string, unknown> } | { passed: false; error: string }> {
  const log = (line: string) => line;
  try {
    // redis-check-rdb writes to stderr; `run` is fine here
    // because we don't care about stdout.
    await run('redis-check-rdb', [file], { timeoutMs: 30_000 }, log);
    return { passed: true, details: { tool: 'redis-check-rdb' } };
  } catch (err) {
    return {
      passed: false,
      error: `redis-check-rdb rejected the file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Mongo BSON archive validator. `bsondump` decodes a BSON
 * file and prints a JSON document per object; the exit code
 * is 0 only when every object parses. This catches the
 * common "truncated mongodump" failure mode where the last
 * few KB were cut off mid-write.
 */
async function validateMongo(
  file: string,
): Promise<{ passed: true; details: Record<string, unknown> } | { passed: false; error: string }> {
  const log = (line: string) => line;
  try {
    await run('bsondump', ['--quiet', file], { timeoutMs: 30_000 }, log);
    return { passed: true, details: { tool: 'bsondump' } };
  } catch (err) {
    return {
      passed: false,
      error: `bsondump rejected the file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── route-friendly helpers (exported for the backup routes module) ────────

/** The full list of (status, engine) pairs, used by the panel
 *  to render a drill history table without a follow-up GET. */
export async function findDrillById(
  db: DB,
  id: number,
): Promise<{
  id: number;
  databaseId: number;
  backupId: number;
  status: 'pending' | 'running' | 'passed' | 'failed';
  engine: string;
  durationMs: number;
  error: string | null;
  details: Record<string, unknown> | null;
  startedAt: number;
  completedAt: number | null;
} | null> {
  const row = await db.query.backupDrills.findFirst({ where: eq(backupDrills.id, id) });
  if (!row) return null;
  return {
    id: row.id,
    databaseId: row.databaseId,
    backupId: row.backupId,
    status: row.status,
    engine: row.engine,
    durationMs: row.durationMs,
    error: row.error,
    details: row.detailsJson ? (JSON.parse(row.detailsJson) as Record<string, unknown>) : null,
    startedAt: row.startedAt instanceof Date ? row.startedAt.getTime() : Number(row.startedAt),
    completedAt: row.completedAt != null ? Number(row.completedAt) : null,
  };
}
