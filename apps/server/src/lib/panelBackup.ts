import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type ScryptOptions } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import { backupDestinations, type DB } from '@ninedeploy/db';
import {
  PANEL_BACKUP_DEFAULT_CRON,
  PANEL_BACKUP_DEFAULT_RETAIN,
  PANEL_BACKUP_RETAIN_MAX,
  PANEL_BACKUP_RETAIN_MIN,
  type PanelBackupObject,
  type PanelBackupRunState,
  type PanelBackupStatus,
} from '@ninedeploy/schemas';
import { Cron } from 'croner';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { VERSION } from '../version.js';
import { audit } from './audit.js';
import { decrypt, encrypt } from './crypto.js';
import { badRequest, conflict } from './errors.js';
import { s3Delete, s3GetToFile, s3List, s3PutFile, type S3Config } from './s3.js';
import { getSettingJson, getSettingString, setSettingJson, setSettingString } from './settings.js';
import { createSystemArchive, importSystemArchive, systemImportInFlight, type SystemArchive, type SystemImportOutcome } from './systemArchive.js';

/**
 * Panel self-backup (0.12): the `/system/export` archive — database snapshot,
 * master key, .env and Traefik config — sealed with an operator-held recovery
 * passphrase and written to a `backup_destinations` bucket on a schedule.
 *
 * Why a passphrase and not the master key (which seals database dumps): the
 * archive CONTAINS the master key, and the whole point is restoring on a new
 * server after this one — and its key — are gone. A backup only the lost key
 * could open would be no backup. The passphrase is stored here sealed under
 * the master key (so scheduled runs are unattended) and must ALSO be kept by
 * the operator, off this server.
 *
 * Everything lives in the `settings` key-value table (no migration):
 *   panel_backup                       {enabled, cron, destinationId, retain}
 *   panel_backup_passphrase_encrypted  recovery passphrase, under the master key
 *   panel_backup_state                 {lastRun, lastSuccessAt}
 * No row = disabled: an upgraded install changes nothing until an operator
 * turns it on.
 */

export const PANEL_BACKUP_SETTINGS_KEY = 'panel_backup';
export const PANEL_BACKUP_STATE_KEY = 'panel_backup_state';
/** Sub-prefix under the destination's own prefix. */
export const PANEL_BACKUP_FOLDER = 'panel-backups';
/** `ninedeploy-panel-20261008T030000Z-1a2b3c.ndpb` — UTC stamp, so names sort chronologically. */
export const PANEL_BACKUP_OBJECT_RE = /^ninedeploy-panel-\d{8}T\d{6}Z(?:-[0-9a-f]{6})?\.ndpb$/;

export interface PanelBackupConfig {
  enabled: boolean;
  cron: string;
  destinationId: number | null;
  retain: number;
}

interface StoredState {
  lastRun: PanelBackupRunState | null;
  lastSuccessAt: string | null;
}

const DEFAULTS: PanelBackupConfig = {
  enabled: false,
  cron: PANEL_BACKUP_DEFAULT_CRON,
  destinationId: null,
  retain: PANEL_BACKUP_DEFAULT_RETAIN,
};

/** Validate a 5-field cron expression (F240: croner's 'auto' mode would also
 *  take a seconds field, firing every second). Same rule as scheduled jobs. */
export function isValidPanelBackupCron(expr: string): boolean {
  try {
    new Cron(expr, { paused: true, unref: true, mode: '5-part' });
    return true;
  } catch {
    return false;
  }
}

/** The stored configuration, each field falling back to its default. */
export async function getPanelBackupConfig(db: DB): Promise<PanelBackupConfig> {
  const raw = await getSettingJson<Partial<Record<keyof PanelBackupConfig, unknown>>>(db, PANEL_BACKUP_SETTINGS_KEY, null);
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const retain = typeof raw.retain === 'number' && Number.isInteger(raw.retain) ? raw.retain : DEFAULTS.retain;
  return {
    enabled: raw.enabled === true,
    cron: typeof raw.cron === 'string' && raw.cron.trim() ? raw.cron.trim() : DEFAULTS.cron,
    destinationId: typeof raw.destinationId === 'number' && raw.destinationId > 0 ? raw.destinationId : null,
    retain: Math.min(PANEL_BACKUP_RETAIN_MAX, Math.max(PANEL_BACKUP_RETAIN_MIN, retain)),
  };
}

export async function setPanelBackupConfig(db: DB, cfg: PanelBackupConfig): Promise<void> {
  await setSettingJson(db, PANEL_BACKUP_SETTINGS_KEY, cfg);
}

export async function hasPanelBackupPassphrase(db: DB): Promise<boolean> {
  return !!(await getSettingString(db, 'panel_backup_passphrase_encrypted', null));
}

export async function setPanelBackupPassphrase(db: DB, passphrase: string): Promise<void> {
  await setSettingString(db, 'panel_backup_passphrase_encrypted', encrypt(passphrase));
}

async function getPanelBackupPassphrase(db: DB): Promise<string | null> {
  const sealed = await getSettingString(db, 'panel_backup_passphrase_encrypted', null);
  if (!sealed) return null;
  try {
    return decrypt(sealed);
  } catch {
    throw new Error(
      'The stored recovery passphrase cannot be decrypted with the current master key — set the passphrase again in Settings → Panel backup',
    );
  }
}

async function readState(db: DB): Promise<StoredState> {
  const raw = await getSettingJson<StoredState>(db, PANEL_BACKUP_STATE_KEY, null).catch(() => null);
  return { lastRun: raw?.lastRun ?? null, lastSuccessAt: raw?.lastSuccessAt ?? null };
}

async function writeState(db: DB, state: StoredState): Promise<void> {
  try {
    await setSettingJson(db, PANEL_BACKUP_STATE_KEY, state);
  } catch {
    /* status bookkeeping must never fail the run; the audit row still lands */
  }
}

/** True when the master key is supplied by env instead of the master.key file. */
export function masterKeyFromEnv(): boolean {
  return !!(process.env['NINEDEPLOY_MASTER_KEYS'] || process.env['NINEDEPLOY_MASTER_KEY']);
}

// ── In-process exclusion ─────────────────────────────────────────────────
// A run and a restore both write the panel's scratch dir and read (or replace)
// the live database; neither may overlap the other or itself. The panel is a
// single process, so a module-level flag is the whole lock.
let busy: 'backup' | 'restore' | null = null;

/** True while a backup run or a restore is executing in this process. */
export function panelBackupBusy(): boolean {
  return busy !== null;
}

// ── Schedule wiring ──────────────────────────────────────────────────────
let scheduleListener: (() => void) | null = null;

/** The scheduler plugin registers here so a settings change re-arms at once. */
export function setPanelBackupScheduleListener(fn: (() => void) | null): void {
  scheduleListener = fn;
}

export function notifyPanelBackupScheduleChanged(): void {
  try {
    scheduleListener?.();
  } catch {
    /* the 5-minute reload picks the change up anyway */
  }
}

function nextRunAt(cfg: PanelBackupConfig): string | null {
  if (!cfg.enabled || cfg.destinationId == null) return null;
  try {
    const next = new Cron(cfg.cron, { paused: true, unref: true, mode: '5-part' }).nextRun();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

/** `GET /v1/system/panel-backup`. */
export async function getPanelBackupStatus(db: DB): Promise<PanelBackupStatus> {
  const cfg = await getPanelBackupConfig(db);
  const state = await readState(db);
  let lastRun = state.lastRun;
  // A `running` record with no run in this process was interrupted: the panel
  // restarted mid-run, or this database was restored from a snapshot taken
  // while that run was writing its own status.
  if (lastRun?.status === 'running' && busy !== 'backup') {
    lastRun = {
      ...lastRun,
      status: 'failed',
      error:
        lastRun.error ??
        "Did not finish on this panel — it restarted mid-run, or this database was restored from that run's own snapshot",
    };
  }
  return {
    settings: { ...cfg, hasPassphrase: await hasPanelBackupPassphrase(db) },
    running: busy !== null,
    lastRun,
    lastSuccessAt: state.lastSuccessAt,
    nextRunAt: nextRunAt(cfg),
    masterKeyFromEnv: masterKeyFromEnv(),
  };
}

// ── Passphrase envelope (NDPB1) ──────────────────────────────────────────
// Layout:  "NDPB1:scrypt:<N>:<r>:<p>:<b64 salt>:<b64 iv>\n" + AES-256-GCM
// ciphertext + 16-byte GCM tag. The header line is the GCM AAD, so tampering
// with the KDF parameters or the IV fails authentication like the body does.
// Documented in docs/PANEL_BACKUP.md; `ninedeploy system panel-backup decrypt`
// implements the same reader for offline restores.
const MAGIC = 'NDPB1';
const SCRYPT = { N: 1 << 15, r: 8, p: 1 } as const;
const HEADER_RE = /^NDPB1:scrypt:(\d+):(\d+):(\d+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)\n$/;
const TAG_BYTES = 16;

function scrypt(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const opts: ScryptOptions = { ...params, maxmem: 256 * params.N * params.r + 1024 * 1024 };
  return new Promise((resolve, reject) =>
    scryptCb(passphrase, salt, 32, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Seal `input` into `output` under `passphrase` (output written 0600). */
export async function encryptPanelBackupFile(input: string, output: string, passphrase: string): Promise<void> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.from(`${MAGIC}:scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString('base64')}:${iv.toString('base64')}\n`);
  const key = await scrypt(passphrase, salt, SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  let headerWritten = false;
  const envelope = new Transform({
    transform(chunk: Buffer, _enc, done) {
      if (!headerWritten) {
        this.push(header);
        headerWritten = true;
      }
      done(null, chunk);
    },
    flush(done) {
      if (!headerWritten) this.push(header);
      this.push(cipher.getAuthTag());
      done();
    },
  });
  try {
    await pipeline(createReadStream(input), cipher, envelope, createWriteStream(output, { mode: 0o600 }));
  } catch (err) {
    try { unlinkSync(output); } catch { /* absent */ }
    throw err;
  }
}

/** The error a wrong passphrase (or a damaged / forged object) produces. */
export const PANEL_BACKUP_DECRYPT_ERROR =
  'Could not decrypt the panel backup: the recovery passphrase is wrong, or the file is damaged';

/**
 * Open a sealed panel backup into `output`. Nothing is left at `output` unless
 * the GCM tag authenticated — a wrong passphrase or a tampered object throws
 * {@link PANEL_BACKUP_DECRYPT_ERROR} and removes the partial plaintext.
 */
export async function decryptPanelBackupFile(input: string, output: string, passphrase: string): Promise<void> {
  const handle = await open(input, 'r');
  let header: string;
  let tag: Buffer;
  let size: number;
  try {
    size = (await handle.stat()).size;
    const prefix = Buffer.alloc(Math.min(256, size));
    await handle.read(prefix, 0, prefix.length, 0);
    const nl = prefix.indexOf(0x0a);
    header = nl < 0 ? '' : prefix.subarray(0, nl + 1).toString('utf8');
    tag = Buffer.alloc(TAG_BYTES);
    if (size >= TAG_BYTES) await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  const m = HEADER_RE.exec(header);
  if (!m) throw new Error('Not a NineDeploy panel backup (missing NDPB1 header)');
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // A crafted header must not make the panel burn gigabytes on the KDF.
  if (!(N >= 1 << 14 && N <= 1 << 20 && (N & (N - 1)) === 0) || r < 1 || r > 32 || p < 1 || p > 16) {
    throw new Error('Unsupported panel backup key-derivation parameters');
  }
  const salt = Buffer.from(m[4]!, 'base64');
  const iv = Buffer.from(m[5]!, 'base64');
  const headerBytes = Buffer.byteLength(header);
  if (iv.length !== 12 || salt.length < 16 || size < headerBytes + TAG_BYTES) {
    throw new Error(PANEL_BACKUP_DECRYPT_ERROR);
  }
  const key = await scrypt(passphrase, salt, { N, r, p });
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(header));
  decipher.setAuthTag(tag);
  const dataEnd = size - TAG_BYTES - 1;
  try {
    const source = dataEnd < headerBytes ? Readable.from([]) : createReadStream(input, { start: headerBytes, end: dataEnd });
    await pipeline(source, decipher, createWriteStream(output, { mode: 0o600 }));
  } catch {
    try { unlinkSync(output); } catch { /* absent */ }
    throw new Error(PANEL_BACKUP_DECRYPT_ERROR);
  }
}

// ── Destination ──────────────────────────────────────────────────────────
interface PanelDestination {
  id: number;
  name: string;
  cfg: S3Config;
  /** Object-key prefix for panel backups, ending in `/`. */
  prefix: string;
}

export async function resolvePanelDestination(db: DB, id: number): Promise<PanelDestination> {
  const row = await db.query.backupDestinations.findFirst({ where: eq(backupDestinations.id, id) });
  if (!row) throw badRequest(`Backup destination #${id} does not exist (deleted?) — pick another one`);
  let secretAccessKey: string;
  try {
    secretAccessKey = decrypt(row.secretKeyEncrypted);
  } catch {
    // F288: a key version this process does not hold.
    throw badRequest(`Backup destination "${row.name}" cannot be decrypted with the current master key — re-enter its secret key`);
  }
  const base = row.prefix.replace(/^\/+|\/+$/g, '');
  return {
    id: row.id,
    name: row.name,
    cfg: { endpoint: row.endpoint, region: row.region, bucket: row.bucket, accessKeyId: row.accessKeyId, secretAccessKey },
    prefix: `${base ? `${base}/` : ''}${PANEL_BACKUP_FOLDER}/`,
  };
}

/** Panel backups in a destination, newest first. Foreign objects are ignored. */
async function listObjects(dest: PanelDestination): Promise<PanelBackupObject[]> {
  const objects = await s3List(dest.cfg, dest.prefix);
  return objects
    .filter((o) => o.key.startsWith(dest.prefix) && PANEL_BACKUP_OBJECT_RE.test(o.key.slice(dest.prefix.length)))
    .map((o) => ({ key: o.key, name: o.key.slice(dest.prefix.length), sizeBytes: o.sizeBytes, lastModified: o.lastModified }))
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

export async function listPanelBackups(db: DB, destinationId: number): Promise<PanelBackupObject[]> {
  const dest = await resolvePanelDestination(db, destinationId);
  try {
    return await listObjects(dest);
  } catch (err) {
    throw badRequest(`Could not list "${dest.name}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Keep-newest-N retention, run only after a successful upload. The object just
 * written is always kept (even if the listing does not show it yet), N is at
 * least 1, and a failed run never reaches here — so the last good backup can
 * never be pruned (the F97/F288 rule for database dumps).
 */
export async function prunePanelBackups(dest: PanelDestination, retain: number, justUploaded: string): Promise<number> {
  const names = new Set((await listObjects(dest)).map((o) => o.key));
  names.add(justUploaded);
  const newestFirst = [...names].sort().reverse();
  const keep = new Set(newestFirst.slice(0, Math.max(PANEL_BACKUP_RETAIN_MIN, retain)));
  keep.add(justUploaded);
  let deleted = 0;
  const failures: string[] = [];
  for (const key of newestFirst) {
    if (keep.has(key)) continue;
    try {
      await s3Delete(dest.cfg, key);
      deleted++;
    } catch (err) {
      failures.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} old panel backup(s) could not be deleted (kept for the next run): ${failures[0]}`);
  }
  return deleted;
}

function objectName(at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `ninedeploy-panel-${stamp}-${randomBytes(3).toString('hex')}.ndpb`;
}

function workDir(): string {
  const dir = path.join(config.paths.dataDir, '_panel-backup');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export type PanelBackupRunResult =
  | { status: 'completed'; key: string; sizeBytes: number; pruned: number; warning: string | null }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; reason: string };

/**
 * One backup run: snapshot → seal → upload → retention. Never throws; every
 * outcome is audited (`backup.panel.completed` / `backup.panel.failed` /
 * `backup.panel.skipped`), and audit() is the notification fan-out, so a
 * failing schedule reaches the operator's channels.
 */
export async function runPanelBackup(
  db: DB,
  opts: { trigger: 'schedule' | 'manual'; actorUserId: number | null; log?: (line: string) => void },
): Promise<PanelBackupRunResult> {
  const log = opts.log ?? (() => undefined);
  if (busy) {
    const reason = busy === 'restore' ? 'a restore is in progress' : 'the previous run is still in progress';
    log(`panel backup skipped: ${reason}`);
    void audit(db, opts.actorUserId, 'backup.panel.skipped', reason, { trigger: opts.trigger });
    return { status: 'skipped', reason };
  }
  busy = 'backup';
  const startedAt = new Date();
  let previous: StoredState = { lastRun: null, lastSuccessAt: null };
  const run: PanelBackupRunState = {
    status: 'running',
    trigger: opts.trigger,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    key: null,
    sizeBytes: null,
    error: null,
    warning: null,
  };
  let built: SystemArchive | null = null;
  let sealed: string | null = null;
  try {
    previous = await readState(db);
    await writeState(db, { ...previous, lastRun: run });
    const cfg = await getPanelBackupConfig(db);
    if (cfg.destinationId == null) throw new Error('No destination is configured for panel backups');
    const passphrase = await getPanelBackupPassphrase(db);
    if (!passphrase) throw new Error('No recovery passphrase is set for panel backups');
    const dest = await resolvePanelDestination(db, cfg.destinationId);

    built = await createSystemArchive(db, {
      warn: log,
      extraMeta: { kind: 'panel-backup', panelVersion: VERSION, masterKeyFromEnv: masterKeyFromEnv() },
    });
    const name = objectName(startedAt);
    sealed = path.join(workDir(), name);
    await encryptPanelBackupFile(built.archive, sealed, passphrase);
    // The plaintext archive (database + master key + .env) goes the moment
    // the sealed copy exists.
    built.cleanup();
    built = null;
    const sizeBytes = statSync(sealed).size;
    const key = `${dest.prefix}${name}`;
    await s3PutFile(dest.cfg, key, sealed);
    log(`panel backup uploaded to ${dest.cfg.bucket}/${key} (${sizeBytes} bytes)`);

    let pruned = 0;
    let warning: string | null = null;
    try {
      pruned = await prunePanelBackups(dest, cfg.retain, key);
    } catch (err) {
      // The new backup is safe; retention retries next run.
      warning = `Retention: ${errMessage(err)}`;
      log(`panel backup ${warning}`);
    }
    const done: PanelBackupRunState = { ...run, status: 'completed', finishedAt: new Date().toISOString(), key, sizeBytes, warning };
    await writeState(db, { lastRun: done, lastSuccessAt: done.finishedAt });
    void audit(db, opts.actorUserId, 'backup.panel.completed', `${name} (${sizeBytes} bytes)`, {
      trigger: opts.trigger,
      destinationId: dest.id,
      key,
      sizeBytes,
      pruned,
      ...(warning ? { warning } : {}),
    });
    return { status: 'completed', key, sizeBytes, pruned, warning };
  } catch (err) {
    const error = errMessage(err);
    log(`panel backup failed: ${error}`);
    await writeState(db, { ...previous, lastRun: { ...run, status: 'failed', finishedAt: new Date().toISOString(), error } });
    void audit(db, opts.actorUserId, 'backup.panel.failed', error, { trigger: opts.trigger });
    return { status: 'failed', error };
  } finally {
    built?.cleanup();
    if (sealed) {
      try { rmSync(sealed, { force: true }); } catch { /* best effort */ }
    }
    busy = null;
  }
}

/**
 * "Back up now": starts a run in the background (a large database can take
 * longer than a proxied request may stay open) and reports whether it began.
 * The outcome lands in the status record and the audit log.
 */
export function startPanelBackup(
  db: DB,
  opts: { actorUserId: number | null; log?: (line: string) => void },
): { started: boolean; promise: Promise<PanelBackupRunResult> | null } {
  if (busy) return { started: false, promise: null };
  const promise = runPanelBackup(db, { trigger: 'manual', ...opts });
  return { started: true, promise };
}

/**
 * Restore a listed panel backup over this panel: download, open with the
 * recovery passphrase (authenticated — a wrong passphrase or a forged object
 * never reaches the import), then the same import `POST /system/import` runs.
 */
export async function restorePanelBackup(
  app: FastifyInstance,
  input: { destinationId?: number; key: string; passphrase: string; confirm: string },
  actorUserId: number | null,
): Promise<SystemImportOutcome> {
  const name = input.key.slice(input.key.lastIndexOf('/') + 1);
  if (!PANEL_BACKUP_OBJECT_RE.test(name)) throw badRequest('That object is not a NineDeploy panel backup');
  if (input.confirm.trim() !== name) {
    throw badRequest(`Type the backup's file name (${name}) to confirm the restore`);
  }
  if (busy) throw conflict('A panel backup or restore is already running — wait for it to finish');
  if (systemImportInFlight()) throw conflict('Another import is already running — wait for it to finish');
  busy = 'restore';
  const dir = workDir();
  const stamp = `${process.pid}-${Date.now()}`;
  const sealed = path.join(dir, `restore-${stamp}.ndpb`);
  const plain = path.join(dir, `restore-${stamp}.tar.gz`);
  try {
    const destinationId = input.destinationId ?? (await getPanelBackupConfig(app.db)).destinationId;
    if (destinationId == null) throw badRequest('Pick the destination that holds the backup');
    const dest = await resolvePanelDestination(app.db, destinationId);
    if (input.key !== `${dest.prefix}${name}`) {
      throw badRequest(`The key must be a panel backup under ${dest.prefix} in "${dest.name}"`);
    }
    try {
      await s3GetToFile(dest.cfg, input.key, sealed);
    } catch (err) {
      throw badRequest(`Could not download ${name} from "${dest.name}": ${errMessage(err)}`);
    }
    try {
      await decryptPanelBackupFile(sealed, plain, input.passphrase);
    } catch (err) {
      void audit(app.db, actorUserId, 'backup.panel.restore_failed', `${name}: ${errMessage(err)}`);
      throw badRequest(errMessage(err));
    }
    rmSync(sealed, { force: true });
    void audit(app.db, actorUserId, 'backup.panel.restore', name, { destinationId: dest.id, key: input.key });
    return await importSystemArchive(app, { file: plain }, actorUserId);
  } finally {
    for (const f of [sealed, plain]) {
      if (existsSync(f)) {
        try { rmSync(f, { force: true }); } catch { /* best effort */ }
      }
    }
    busy = null;
  }
}

/** Remove scratch files a crashed run or restore left behind. Only call when idle. */
export function clearPanelBackupScratch(): void {
  if (busy) return;
  rmSync(path.join(config.paths.dataDir, '_panel-backup'), { recursive: true, force: true });
}
