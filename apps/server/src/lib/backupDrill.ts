/**
 * `ninedeploy backup drill` — prove a backup is at least
 * restorable without restoring it into a database.
 *
 * A "drill" runs an engine-specific smoke check on the dump
 * file (pg_dump / mysqldump structure, redis-check-rdb inside the
 * database's own image, a full gunzip of the mongodump archive,
 * ...) and records the outcome on a `backup_drills` row —
 * `passed`, `failed`, or (r356) `unverifiable` when the check
 * itself could not run. The result is a *much* weaker guarantee than a real
 * restore-into-container (it does not catch a malformed but
 * well-formed dump, and it cannot catch missing extensions
 * or schema drift) — but it does catch the most common
 * failure mode, a corrupt or truncated file. Engine tools run
 * in a throwaway, network-less container of the database's own
 * image (r356), never as host binaries.
 *
 * The drill never deletes or modifies the source backup.
 * Encrypted envelopes are decrypted to a sibling temp file
 * (and deleted on the way out) via the same flow
 * `engine/database.ts` uses for real restores; remote-only
 * backups are fetched to a local temp first via
 * `lib/backupRemote.ts`.
 */
import { createReadStream } from 'node:fs';
import { open, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { desc, eq } from 'drizzle-orm';
import { backupDrills, backups, databases, type DB } from '@ninedeploy/db';
import { fetchRemoteBackup, type RemoteBackupRef } from './backupRemote.js';
import { decryptBackupFile, isEncryptedBackupFile } from './backupCrypto.js';
import { capture, ExecTimeoutError, run } from './exec.js';
import { ENGINES, readBackupBytes } from '../engine/database.js';

/** Every status a drill row can hold (pending/running/passed/failed, and
 *  r356's `unverifiable`). */
type DrillStatus = (typeof backupDrills.$inferSelect)['status'];

export interface DrillResult {
  drillId: number;
  /** r356: `unverifiable` = the check could not run (docker or the engine
   *  image/tool unavailable, a timeout) — no verdict on the backup. */
  status: 'passed' | 'failed' | 'unverifiable';
  durationMs: number;
  details: Record<string, unknown> | null;
  error: string | null;
}

/**
 * Names of the drill's scratch files. A drill decrypts the backup to
 * `<backup>.<pid>-drill.dec` (PLAINTEXT) and fetches a remote-only backup to
 * `<tmpdir>/nd-drill-<pid>-<ms>.dump`; both are unlinked by the drill's
 * cleanup hook, which never runs when the process dies mid-drill.
 * `pruneDrillLeftovers` (housekeeping) matches the same names.
 */
const DRILL_PLAINTEXT_SUFFIX = '-drill.dec';
const DRILL_FETCH_PREFIX = 'nd-drill-';
const DRILL_FETCH_RE = /^nd-drill-\d+-\d+\.dump$/;

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
  let result: ValidationResult;
  // r356: the image the database runs — engine tools execute inside it.
  const image = ENGINES[dRow.engine]?.image(dRow.version ?? undefined) ?? null;

  try {
    const ctx = await stageForDrill(db, bRow.path, bRow, dRow.engine);
    try {
      result = await validateDump(ctx, image);
    } finally {
      // Every path — passed, failed, unverifiable, or a validator throwing —
      // removes the PLAINTEXT `*-drill.dec` and any fetched copy.
      await ctx.cleanup().catch(() => undefined);
    }
  } catch (err) {
    result = failed(`Drill setup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const completedAt = new Date();
  const durationMs = completedAt.getTime() - startedAt;
  const finalStatus = result.outcome;
  const finalError = result.outcome === 'passed' ? null : result.error;
  const finalDetails = result.details ?? null;
  // `completed_at` is a plain integer (unix seconds); `ts()` would
  // give us a Date, which the column does not accept.
  const completedAtEpoch = Math.floor(completedAt.getTime() / 1000);
  const [updated] = await db
    .update(backupDrills)
    .set({
      status: finalStatus,
      durationMs,
      error: finalError,
      detailsJson: finalDetails ? JSON.stringify(finalDetails) : null,
      completedAt: completedAtEpoch,
    })
    .where(eq(backupDrills.id, row.id))
    .returning();
  return {
    drillId: updated?.id ?? row.id,
    status: finalStatus,
    durationMs,
    details: finalDetails,
    error: finalError,
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
    status: DrillStatus;
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
    fetched = join(tmpdir(), `${DRILL_FETCH_PREFIX}${process.pid}-${Date.now()}.dump`);
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
    const dec = `${source}.${process.pid}${DRILL_PLAINTEXT_SUFFIX}`;
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
    const dec = `${source}.${process.pid}${DRILL_PLAINTEXT_SUFFIX}`;
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
 * r356: the outcome of one engine validator. `unverifiable` is not a verdict
 * on the backup: the check could not run (docker unreachable, the engine
 * image not present locally, the tool missing from it, a timeout). It used to
 * be reported as `failed`, which told the operator a good backup was broken.
 */
type ValidationResult =
  | { outcome: 'passed'; details: Record<string, unknown> }
  | { outcome: 'failed'; error: string; details?: Record<string, unknown> }
  | { outcome: 'unverifiable'; error: string; details?: Record<string, unknown> };

const passed = (details: Record<string, unknown>): ValidationResult => ({ outcome: 'passed', details });
const failed = (error: string, details?: Record<string, unknown>): ValidationResult => ({ outcome: 'failed', error, details });
const unverifiable = (reason: string, details?: Record<string, unknown>): ValidationResult => ({
  outcome: 'unverifiable',
  error: `unverifiable: tool unavailable — ${reason}`,
  details,
});

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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

/** r356: the bounded mirror of {@link readHead} — the last `bytes` of a dump,
 *  where pg_dump and mysqldump write their "the dump finished" trailers. */
async function readTail(file: string, bytes = 4096): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await handle.read(buf, 0, len, size - len);
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
 *
 * r356: `image` is the engine image the database itself runs
 * (`ENGINES[engine].image(version)`) — checks that need an engine tool run
 * inside a throwaway container of it, never against a host binary.
 */
async function validateDump(ctx: DrillContext, image: string | null): Promise<ValidationResult> {
  switch (ctx.engine) {
    case 'postgres':
      return validatePostgres(ctx.file, image);
    case 'mysql':
    case 'mariadb':
      return validateMysql(ctx.file);
    case 'redis':
    case 'valkey':
      return validateRedis(ctx.file, ctx.engine, image);
    case 'mongo':
      return validateMongo(ctx.file);
    default:
      return failed(`Drill not supported for engine "${ctx.engine}"`);
  }
}

// ── r356: engine tools run in the database's own image ────────────────────
//
// The drill used to exec `pg_restore`, `redis-check-rdb` and `bsondump` on
// the HOST — binaries no installer provides, so on a stock host every
// Redis/Mongo drill "failed" with ENOENT. The engine images the databases run
// from carry exactly the right tool at exactly the right version, so the check
// runs in a throwaway container of that image: no network, no capabilities,
// the dump moved in with `docker cp` (not a bind mount — the panel may itself
// be containerised, and a bind source is resolved by the daemon, not by this
// process; same reasoning as the volume sidecars in engine/database.ts).

/** Where the dump lands inside the drill container. */
const DRILL_CONTAINER_DUMP = '/tmp/ninedeploy-drill.dump';
/** Budget for the check itself (and the mongo stream check). A timeout is
 *  `unverifiable`, not `failed`: it says nothing about the dump. */
const DRILL_CHECK_TIMEOUT_MS = 5 * 60_000;
/** Budget for the docker bookkeeping calls (inspect / create / rm). */
const DOCKER_QUICK_TIMEOUT_MS = 30_000;
/** The daemon's words for "the entrypoint binary does not exist in this image". */
const TOOL_MISSING_RE = /executable file not found|OCI runtime (?:create|exec) failed|exec format error/i;
/** Lines of tool output kept for the error / details. */
const OUTPUT_TAIL_LINES = 40;

type ContainerCheck =
  | { kind: 'ok'; output: string[] }
  | { kind: 'rejected'; error: string; output: string[] }
  | { kind: 'unavailable'; reason: string };

/**
 * Run `<tool> <args…>` against the dump inside a throwaway container of
 * `image`. Argv only — no shell on either side. `--pull never`: the drill is a
 * synchronous member-triggered request, and the database's image is already
 * local (the database runs from it); a missing image is `unavailable`, not a
 * multi-minute pull inside a request.
 */
async function checkInEngineImage(image: string, file: string, tool: string, args: string[]): Promise<ContainerCheck> {
  try {
    await capture('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { timeoutMs: DOCKER_QUICK_TIMEOUT_MS });
  } catch (err) {
    return { kind: 'unavailable', reason: `docker or the engine image ${image} is not available on this host (${errText(err)})` };
  }
  let cid: string;
  try {
    cid = (
      await capture(
        'docker',
        [
          'create',
          '--network', 'none',
          '--cap-drop', 'ALL',
          '--security-opt', 'no-new-privileges',
          '--user', '0:0',
          '--pull', 'never',
          '--entrypoint', tool,
          image,
          ...args,
        ],
        { timeoutMs: DOCKER_QUICK_TIMEOUT_MS },
      )
    ).trim();
  } catch (err) {
    return { kind: 'unavailable', reason: `could not create a ${image} drill container (${errText(err)})` };
  }
  const output: string[] = [];
  const sink = (line: string) => {
    output.push(line);
    if (output.length > OUTPUT_TAIL_LINES) output.shift();
  };
  try {
    try {
      await run('docker', ['cp', file, `${cid}:${DRILL_CONTAINER_DUMP}`], { timeoutMs: DRILL_CHECK_TIMEOUT_MS }, sink);
    } catch (err) {
      return { kind: 'unavailable', reason: `could not copy the dump into the drill container (${errText(err)})` };
    }
    output.length = 0;
    try {
      await run('docker', ['start', '-a', cid], { timeoutMs: DRILL_CHECK_TIMEOUT_MS }, sink);
      return { kind: 'ok', output };
    } catch (err) {
      if (err instanceof ExecTimeoutError) {
        return { kind: 'unavailable', reason: `${tool} did not finish within ${DRILL_CHECK_TIMEOUT_MS / 1000}s` };
      }
      if (TOOL_MISSING_RE.test(output.join('\n'))) {
        return { kind: 'unavailable', reason: `${tool} is not present in ${image}` };
      }
      return { kind: 'rejected', error: errText(err), output };
    }
  } finally {
    await run('docker', ['rm', '-f', cid], { timeoutMs: DOCKER_QUICK_TIMEOUT_MS }, () => {}).catch(() => undefined);
  }
}

/** The tail of a tool's output, for an error message. */
function outputTail(output: string[], lines = 5): string {
  const tail = output.slice(-lines).join(' | ').trim();
  return tail ? `: ${tail}` : '';
}

/**
 * Postgres dump validator.
 *
 * r356: `engine/database.ts` writes PLAIN-SQL dumps (`pg_dump --file`, no
 * `-Fc`), which `pg_restore` refuses by design — so the old
 * `pg_restore --list` first step failed on every real backup and the drill
 * fell through to a sniff that passed any file containing the word SET. A
 * plain dump is now checked for what proves pg_dump FINISHED it: the
 * "PostgreSQL database dump" header, the "PostgreSQL database dump complete"
 * trailer (a truncated or half-written dump has no trailer), and — on pg_dump
 * builds that emit them — a `\unrestrict` matching the header's `\restrict`
 * key. Only a custom-format archive (PGDMP magic) goes to
 * `pg_restore --list`, run inside the database's own postgres image.
 */
async function validatePostgres(file: string, image: string | null): Promise<ValidationResult> {
  const head = await readHead(file);
  if (head.startsWith('PGDMP')) {
    if (!image) return unverifiable('no postgres image is known for this database');
    const check = await checkInEngineImage(image, file, 'pg_restore', ['--list', DRILL_CONTAINER_DUMP]);
    if (check.kind === 'unavailable') return unverifiable(check.reason, { tool: 'pg_restore', image });
    if (check.kind === 'rejected') {
      return failed(`pg_restore --list rejected the archive${outputTail(check.output)} (${check.error})`, { tool: 'pg_restore', image });
    }
    // pg_restore --list prints one line per object ("<n>; <oid> <oid> <kind>
    // …") after a `;`-commented header. An empty archive is technically valid
    // but suspicious — surface the count rather than failing.
    const objectCount = check.output.filter((l) => l.trim() && !l.startsWith(';')).length;
    return passed({ tool: 'pg_restore', mode: 'custom', image, objectCount });
  }

  if (!/^-- PostgreSQL database dump\r?$/m.test(head)) {
    return failed('Not a pg_dump dump: no custom-format magic and no "PostgreSQL database dump" header in the first 4 KiB');
  }
  const tail = await readTail(file);
  if (!/^-- PostgreSQL database dump complete\r?$/m.test(tail)) {
    return failed('Truncated pg_dump: the "PostgreSQL database dump complete" trailer is missing — the dump did not finish writing');
  }
  const restrictKey = head.match(/^\\restrict (\S+)/m)?.[1];
  if (restrictKey && !tail.includes(`\\unrestrict ${restrictKey}`)) {
    return failed('Truncated pg_dump: the header\'s \\restrict key has no matching \\unrestrict at the end of the file');
  }
  return passed({ tool: 'pg_dump-structure', mode: 'plain-sql' });
}

/**
 * MySQL / MariaDB dump validator. The canonical client tools
 * (`mysqlcheck`, `mysql --execute`) require a live server, so
 * the check is structural: the mysqldump / mariadb-dump banner
 * in the first 4 KiB, and (r356) the "-- Dump completed" trailer
 * both tools write as their LAST line — without it the dump was
 * cut off, which the banner alone never caught.
 */
async function validateMysql(file: string): Promise<ValidationResult> {
  const head = await readHead(file);
  const banner = /MySQL dump|MariaDB dump/i.test(head) ? head.match(/^(?:-+\s*)?(?:MySQL|MariaDB)\s+dump[\s\S]{0,80}/i)?.[0]?.trim() ?? null : null;
  if (!banner) {
    return failed('No mysqldump / mariadb-dump banner found in first 4 KiB');
  }
  if (!/^-- Dump completed\b/m.test(await readTail(file))) {
    return failed('Truncated dump: the "-- Dump completed" trailer is missing — the dump did not finish writing', { banner });
  }
  return passed({ tool: 'mysqldump-structure', banner });
}

/**
 * Redis / Valkey RDB validator. `redis-check-rdb` (`valkey-check-rdb` in the
 * valkey image) parses the binary header and every object entry, and exits
 * non-zero on the first malformed byte.
 *
 * r356: it runs inside the database's own image — the host has no such
 * binary (no installer provides one), and the image's copy understands
 * exactly the RDB version that server wrote.
 */
async function validateRedis(file: string, engine: string, image: string | null): Promise<ValidationResult> {
  const tool = engine === 'valkey' ? 'valkey-check-rdb' : 'redis-check-rdb';
  if (!image) return unverifiable(`no ${engine} image is known for this database`);
  const check = await checkInEngineImage(image, file, tool, [DRILL_CONTAINER_DUMP]);
  if (check.kind === 'unavailable') return unverifiable(check.reason, { tool, image });
  if (check.kind === 'rejected') {
    return failed(`${tool} rejected the file${outputTail(check.output)} (${check.error})`, { tool, image });
  }
  return passed({ tool, image });
}

/** mongo-tools archive magic (0x8199e26d, little-endian) and the int32 -1
 *  terminator the prelude and every namespace's EOF block end with. */
const MONGO_ARCHIVE_MAGIC = Buffer.from([0x6d, 0xe2, 0x99, 0x81]);
const MONGO_ARCHIVE_TERMINATOR = Buffer.from([0xff, 0xff, 0xff, 0xff]);

/**
 * Mongo archive validator.
 *
 * r356: backups are `mongodump --archive --gzip` — ONE gzip stream wrapping
 * the mongo-tools archive format. The old `bsondump` could never read that
 * (it decodes bare .bson files), so every Mongo drill "failed" on a good
 * backup. `mongorestore --dryRun` is no substitute: it needs a live server to
 * connect to before doing anything, and returns after reading only the
 * archive prelude, so it cannot see a truncated body.
 *
 * The check needs no tool at all: the whole file is streamed through gunzip,
 * which verifies the gzip CRC32 and length trailer (a truncated or bit-rotted
 * dump fails there), and the decompressed stream must start with the archive
 * magic and end with the terminator mongodump writes last. Bounded memory
 * (only the first and last 4 bytes are kept) regardless of dump size.
 */
async function validateMongo(file: string): Promise<ValidationResult> {
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let archiveBytes = 0;
  const probe = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (head.length < 4) head = Buffer.concat([head, chunk.subarray(0, 4)]).subarray(0, 4);
      tail = Buffer.concat([tail, chunk.subarray(-4)]).subarray(-4);
      archiveBytes += chunk.length;
      cb();
    },
  });
  try {
    await pipeline(createReadStream(file), createGunzip(), probe, { signal: AbortSignal.timeout(DRILL_CHECK_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      return unverifiable(`the archive could not be read within ${DRILL_CHECK_TIMEOUT_MS / 1000}s`);
    }
    return failed(`Not a complete mongodump --gzip archive: ${errText(err)}`);
  }
  if (!head.equals(MONGO_ARCHIVE_MAGIC)) {
    return failed('The decompressed stream does not start with the mongodump archive magic');
  }
  if (!tail.equals(MONGO_ARCHIVE_TERMINATOR)) {
    return failed('Truncated mongodump archive: the stream does not end with the archive terminator');
  }
  return passed({ tool: 'gzip+archive-structure', archiveBytes });
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
  status: DrillStatus;
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

/**
 * r302: delete drill scratch files a crashed drill left behind — the
 * PLAINTEXT `*-drill.dec` decryptions next to the backups, and the
 * `nd-drill-*.dump` copies fetched from a destination. The drill's own
 * cleanup hook is the normal path; this is for a process that died (OOM,
 * restart, an update of the panel itself) between staging and cleanup, which
 * otherwise left a decrypted database dump on disk forever — outside the
 * encryption the operator turned on for backups.
 *
 * Only files older than `maxAgeMs` go, so a drill still validating a large
 * dump is not pulled out from under. Non-recursive and best-effort: a missing
 * directory or a file that vanished mid-scan is not an error. Returns the
 * count removed.
 */
export async function pruneDrillLeftovers(dirs: readonly string[], maxAgeMs: number): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(DRILL_PLAINTEXT_SUFFIX) && !DRILL_FETCH_RE.test(name)) continue;
      const file = join(dir, name);
      try {
        const st = await stat(file);
        if (!st.isFile() || st.mtimeMs >= cutoff) continue;
        await unlink(file);
        removed++;
      } catch {
        /* best effort */
      }
    }
  }
  return removed;
}
