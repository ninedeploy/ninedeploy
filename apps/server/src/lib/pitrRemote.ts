/** Panel-host remote checkpoints and continuous WAL archives with verified publication. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { backupDestinations, databases, settings, type Database, type DB } from '@ninedeploy/db';
import { config } from '../config.js';
import { createPitrCheckpoint, hashCheckpointFile, importPitrCheckpoint, unpackCheckpoint } from '../engine/pitrCheckpoint.js';
import { recoverPostgresToPoint, PitrRefusal } from '../engine/postgresPitr.js';
import { pitrArchiveVolume } from '../engine/pitrArchive.js';
import { volumeExists } from '../engine/database.js';
import { capture } from './exec.js';
import { decryptPanelBackupFile, encryptPanelBackupFile } from './panelBackup.js';
import { decrypt, encrypt, secretEquals } from './crypto.js';
import { HttpError, unprocessable } from './errors.js';
import { getSettingJson, getSettingString } from './settings.js';
import { pitrUnavailable, withPitrArchiveRead, pitrDatabases } from './pitr.js';
import { pitrRemoteConfig, pitrRemoteState, pitrStreamState, type PitrRemoteConfig, type PitrRemoteState, type PitrStreamState } from './pitrRemoteState.js';
import { loadContinuousPitr, runContinuousPitr } from './pitrContinuous.js';
import { nodePitrInventory, nodePitrCheckpoint, nodePitrWal, assertNodePitrCapable } from './nodePitr.js';
import { continuousPitrDeps } from './pitrContinuous.js';
import { safeStreamRoot } from './pitrStreamCatalog.js';
import { s3GetToFile, s3PutFile, type S3Config } from './s3.js';
import { audit } from './audit.js';

async function store(tx: Pick<DB, 'insert'>, key: string, value: unknown): Promise<void> {
  await tx.insert(settings).values({ key, value: value as boolean, updatedAt: new Date() }).onConflictDoUpdate({ target: settings.key, set: { value: value as boolean, updatedAt: new Date() } });
}
const running = new Set<number>();
const editing = new Set<number>();
const admittedTasks = new Set<Promise<unknown>>();

export async function drainRemotePitrCheckpoints(): Promise<void> {
  await Promise.allSettled([...admittedTasks]);
}
export const remotePitrBusy = (id: number) => running.has(id);
const configKey = (id: number) => `pitr_remote:${id}`;
const stateKey = (id: number) => `pitr_remote_state:${id}`;
const secretKey = (id: number) => `pitr_remote_passphrase:${id}`;
const streamKey = (id: number) => `pitr_stream_state:${id}`;
const refuseBusy = (id: number) => { if (running.has(id) || editing.has(id)) throw new HttpError(409, 'pitr_remote_busy', 'A remote checkpoint or configuration change is running; try again when it finishes.'); };

async function destination(db: DB, id: number) {
  const d = await db.query.backupDestinations.findFirst({ where: eq(backupDestinations.id, id) });
  if (!d) throw unprocessable('The remote backup destination no longer exists.', 'pitr_remote_destination');
  const cfg: S3Config = { endpoint: d.endpoint, region: d.region, bucket: d.bucket, accessKeyId: d.accessKeyId, secretAccessKey: decrypt(d.secretKeyEncrypted) };
  if (new URL(cfg.endpoint).protocol !== 'https:') throw unprocessable('Remote PITR requires an HTTPS S3-compatible destination.', 'pitr_remote_https');
  return { cfg, basePrefix: d.prefix, prefix: `${d.prefix.replace(/^\/+|\/+$/g, '')}${d.prefix.replace(/^\/+|\/+$/g, '') ? '/' : ''}pitr-checkpoints/` };
}

export async function remotePitrStatus(db: DB, id: number) {
  const raw = await getSettingJson(db, configKey(id), null);
  const cfg = raw === null ? null : pitrRemoteConfig.parse(raw);
  const value = await getSettingJson(db, stateKey(id), null);
  let state = value === null ? null : pitrRemoteState.parse(value);
  if (state?.status === 'running' && (!running.has(id) || cfg?.mode === 'continuous')) state = { ...state, status: 'failed', error: 'The panel restarted before the checkpoint was verified.' };
  const streamValue = await getSettingJson(db, streamKey(id), null);
  let stream = streamValue === null ? null : pitrStreamState.parse(streamValue);
  if (stream?.archiveId !== cfg?.archiveId) stream = null;
  if (stream?.status === 'running' && !running.has(id)) stream = { ...stream, status: 'failed', error: 'The panel restarted before the WAL shipping pass finished.' };
  const success = state?.lastSuccess;
  const through = cfg?.mode === 'continuous' ? stream?.protection?.through : success?.through;
  return { settings: cfg, hasPassphrase: !!await getSettingString(db, secretKey(id), null), running: running.has(id), state, stream,
    archiveLagSeconds: through ? Math.max(0, Math.floor((Date.now() - Date.parse(through)) / 1000)) : null,
    retention: cfg?.mode === 'continuous' ? `Continuous archive: ${cfg.remoteRetentionDays ?? 7} day(s), protected boundary base and one-hour deletion grace.` : 'Remote checkpoints are not deleted automatically.' };
}

export async function configureRemotePitr(db: DB, d: Database, input: Omit<PitrRemoteConfig, 'archiveId'> & { passphrase?: string; resetStream?: boolean }, actor: number) {
  refuseBusy(d.id);
  editing.add(d.id);
  try {
  const { passphrase, resetStream, ...rest } = input;
  const cfg = pitrRemoteConfig.parse(rest);
  if (cfg.collectOrphans && cfg.mode !== 'continuous') throw unprocessable('Abandoned upload collection requires continuous mode.', 'pitr_remote_orphans');
  const storedConfig = await getSettingJson(db, configKey(d.id), null);
  const previous = storedConfig === null ? null : pitrRemoteConfig.parse(storedConfig);
  if (cfg.mode === 'continuous') {
    const oldSecret = await getSettingString(db, secretKey(d.id), null);
    const changedPassphrase = passphrase !== undefined && (!oldSecret || !secretEquals(decrypt(oldSecret), passphrase));
    cfg.archiveId = !resetStream && !changedPassphrase && previous?.mode === 'continuous' && previous.destinationId === cfg.destinationId && previous.archiveId ? previous.archiveId : randomUUID();
    cfg.remoteRetentionDays ??= 7;
  }
  if (cfg.enabled) {
    const why = pitrUnavailable(d);
    if (why || !d.pitrEnabled) throw unprocessable(why ?? 'Enable local PITR first.', 'pitr_remote_unavailable');
    await assertNodePitrCapable(db, d);
    const dest = await destination(db, cfg.destinationId);
    if (cfg.mode === 'continuous') {
      const endpoint = new URL(dest.cfg.endpoint);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(dest.cfg.bucket)) throw unprocessable('Continuous archives require an HTTPS S3 endpoint and a plain bucket name.', 'pitr_remote_destination');
      try { safeStreamRoot(dest.basePrefix, cfg.archiveId!); }
      catch { throw unprocessable('Continuous archive prefixes must not contain traversal components or backslashes.', 'pitr_remote_destination'); }
    }
    if (!passphrase && !await getSettingString(db, secretKey(d.id), null)) throw unprocessable('Set and keep an off-host recovery passphrase.', 'pitr_remote_passphrase');
  }
  if (passphrase !== undefined) {
    if (passphrase.length < 16 || passphrase.length > 1024) throw unprocessable('Use a recovery passphrase of 16–1024 characters.', 'pitr_remote_passphrase');
  }
  await db.transaction(async (tx) => {
    if (!await tx.query.databases.findFirst({ where: eq(databases.id, d.id) })) throw new HttpError(404, 'not_found', 'Database not found');
    if (passphrase !== undefined) await store(tx, secretKey(d.id), encrypt(passphrase));
    await store(tx, configKey(d.id), cfg);
  });
  void audit(db, actor, 'database.pitr_remote_config', `${d.name}: remote checkpoints ${cfg.enabled ? 'enabled' : 'disabled'}`);
  } finally { editing.delete(d.id); }
  return remotePitrStatus(db, d.id);
}

async function writeState(db: DB, id: number, value: PitrRemoteState): Promise<void> {
  await db.transaction(async (tx) => {
    if (!await tx.query.databases.findFirst({ where: eq(databases.id, id) })) throw new HttpError(404, 'not_found', 'Database not found');
    await store(tx, stateKey(id), value);
  });
}

async function writeStreamState(db: DB, id: number, value: PitrStreamState): Promise<void> {
  await db.transaction(async (tx) => {
    if (!await tx.query.databases.findFirst({ where: eq(databases.id, id) })) throw new HttpError(404, 'not_found', 'Database not found');
    const configured = await tx.query.settings.findFirst({ where: eq(settings.key, configKey(id)) });
    if (pitrRemoteConfig.parse(configured?.value).archiveId !== value.archiveId) throw new Error('Remote archive configuration changed');
    const old = await tx.query.settings.findFirst({ where: eq(settings.key, streamKey(id)) });
    const parsed = old ? pitrStreamState.parse(old.value) : null;
    if (parsed?.archiveId === value.archiveId && parsed.protection && parsed.protection.sequence > (value.protection?.sequence ?? 0)) value = { ...value, protection: parsed.protection };
    await store(tx, streamKey(id), value);
  });
}

export const remotePitrDeps = {
  create: createPitrCheckpoint, seal: encryptPanelBackupFile, put: s3PutFile, get: s3GetToFile, hash: hashCheckpointFile,
};

export async function runRemotePitrCheckpoint(db: DB, d: Database, log: (line: string) => void, deps = remotePitrDeps, onAdmitted?: () => void, clock?: () => Date) {
  refuseBusy(d.id); running.add(d.id);
  let dir: string | undefined;
  let previous: PitrRemoteState['lastSuccess'] = null;
  let admitted = false;
  const attemptedAt = new Date().toISOString();
  try {
    const why = pitrUnavailable(d);
    if (why || !d.pitrEnabled) throw unprocessable(why ?? 'Enable local PITR first.', 'pitr_remote_unavailable');
    const stored = await getSettingJson(db, configKey(d.id), null);
    if (stored === null) throw unprocessable('Configure remote checkpoints first.', 'pitr_remote_disabled');
    const cfg = pitrRemoteConfig.parse(stored);
    if (!cfg.enabled) throw unprocessable('Remote checkpoints are disabled.', 'pitr_remote_disabled');
    const secret = await getSettingString(db, secretKey(d.id), null);
    if (!secret) throw unprocessable('No remote recovery passphrase is set.', 'pitr_remote_passphrase');
    const passphrase = decrypt(secret);
    await assertNodePitrCapable(db, d);
    const dest = await destination(db, cfg.destinationId);
    if (cfg.mode === 'continuous') {
      if (!cfg.archiveId) throw unprocessable('Save continuous archive settings to allocate an archive identity.', 'pitr_remote_unavailable');
      const raw = await getSettingJson(db, streamKey(d.id), null);
      const result = await runContinuousPitr(d, { cfg: dest.cfg, prefix: dest.basePrefix, archiveId: cfg.archiveId, passphrase, retentionDays: cfg.remoteRetentionDays ?? 7,
        previous: raw === null ? null : pitrStreamState.parse(raw), save: (value) => writeStreamState(db, d.id, value), onAdmitted, now: clock, collectOrphans: cfg.collectOrphans }, log, d.serverId == null ? continuousPitrDeps : { ...continuousPitrDeps,
          inventory: (row) => nodePitrInventory(db, row), anchor: (row, dir, log, snapshot) => nodePitrCheckpoint(db, row, dir, log, snapshot),
          wal: (row, names, dir, log, base) => nodePitrWal(db, row, names, dir, log, base) });
      void audit(db, null, 'database.pitr_remote_shipping', `${d.name}: WAL archive index verified`);
      // Preserve the legacy return shape for callers that only need the recovery key.
      return { key: result.headKey, destinationId: cfg.destinationId, verifiedAt: result.verifiedAt, from: result.from, through: result.through, sha256: result.headSha256, bytes: result.headBytes };
    }
    const old = await getSettingJson(db, stateKey(d.id), null);
    previous = old === null ? null : pitrRemoteState.parse(old).lastSuccess;
    await writeState(db, d.id, { status: 'running', attemptedAt, error: null, missingSegment: null, lastSuccess: previous });
    admitted = true;
    onAdmitted?.();
    const scratch = path.join(config.paths.dataDir, 'pitr-checkpoints');
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    dir = await mkdtemp(path.join(scratch, 'run-'));
    // The archive is pinned only while copying. Uploads need no source volume and cannot block retention.
    const built = await withPitrArchiveRead(d, () => d.serverId == null ? deps.create(d, dir!, log) : nodePitrCheckpoint(db, d, dir!, log));
    const sealed = path.join(dir, 'sealed');
    await deps.seal(built.file, sealed, passphrase);
    const sha256 = await deps.hash(sealed);
    const key = `${dest.prefix}${d.slug}/${new Date().toISOString().replace(/[:.]/g, '')}-${randomUUID()}.ndpc`;
    await deps.put(dest.cfg, key, sealed);
    const checked = path.join(dir, 'read-back');
    await deps.get(dest.cfg, key, checked);
    if (await deps.hash(checked) !== sha256) throw new Error('Remote checkpoint read-back differs');
    const lastSuccess = { key, destinationId: cfg.destinationId, verifiedAt: new Date().toISOString(), from: built.manifest.base.finishedAt,
      through: built.manifest.segments.at(-1)!.archivedAt, sha256, bytes: (await stat(sealed)).size };
    await writeState(db, d.id, { status: 'completed', attemptedAt, error: null, missingSegment: null, lastSuccess });
    void audit(db, null, 'database.pitr_remote_checkpoint', `${d.name}: remote checkpoint verified`);
    return lastSuccess;
  } catch (err) {
    if (admitted) {
      const error = err instanceof PitrRefusal ? err.message : 'The remote checkpoint failed; check destination access, disk space and the panel log.';
      await writeState(db, d.id, { status: 'failed', attemptedAt, error, missingSegment: err instanceof PitrRefusal ? /Segment ([0-9A-F]{24}) is missing/.exec(err.message)?.[1] ?? null : null, lastSuccess: previous }).catch(() => undefined);
    }
    throw err;
  } finally {
    try { if (dir) await rm(dir, { recursive: true, force: true }); }
    finally { running.delete(d.id); }
  }
}

export function startRemotePitrCheckpoint(db: DB, d: Database, log: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const task = runRemotePitrCheckpoint(db, d, log, remotePitrDeps, resolve);
    admittedTasks.add(task);
    void task.then(() => { admittedTasks.delete(task); }, (err: unknown) => {
      admittedTasks.delete(task);
      reject(err);
      log(`Remote PITR checkpoint failed for database #${d.id}; check its status.`);
    });
  });
}

/** Minute tick; bounded to one checkpoint per database and serial transfers across the panel. */
export async function remotePitrTick(db: DB, log: (line: string) => void, stopped = () => false): Promise<void> {
  for (const d of await pitrDatabases(db)) {
    if (stopped()) break;
    const cfg = await getSettingJson(db, configKey(d.id), null);
    if (cfg === null || !pitrRemoteConfig.parse(cfg).enabled || running.has(d.id)) continue;
    const state = await remotePitrStatus(db, d.id);
    const attemptedAt = cfg && pitrRemoteConfig.parse(cfg).mode === 'continuous' ? state.stream?.attemptedAt : state.state?.attemptedAt;
    const interval = state.settings!.mode === 'continuous' ? 60_000 : state.settings!.intervalMinutes * 60_000;
    if (attemptedAt && Date.now() - Date.parse(attemptedAt) < interval) continue;
    await runRemotePitrCheckpoint(db, d, log).catch(() => log(`Remote PITR checkpoint failed for database #${d.id}; status contains the diagnostic.`));
  }
}

/** Disaster recovery needs only the remote object, S3 credentials and operator-held passphrase. */
export async function recoverRemotePitrCheckpoint(input: { cfg: S3Config; key: string; passphrase: string; target: Database; targetTime: Date | null }, log: (line: string) => void) {
  if (!input.target.volumeName || await volumeExists(input.target.volumeName)) throw new Error('Recovery requires a new, absent target volume');
  const scratch = path.join(config.paths.dataDir, 'pitr-checkpoints');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(path.join(scratch, 'restore-'));
  const volumeName = `nd-pitr-remote-${randomUUID()}`;
  const archive = pitrArchiveVolume(volumeName);
  let imported = false;
  try {
    let unpacked: Awaited<ReturnType<typeof unpackCheckpoint>>;
    if (input.key.endsWith('/head.ndpi') || input.key.endsWith('.ndcat')) unpacked = await loadContinuousPitr(input, dir);
    else {
      await s3GetToFile(input.cfg, input.key, path.join(dir, 'sealed'));
      await decryptPanelBackupFile(path.join(dir, 'sealed'), path.join(dir, 'plain'), input.passphrase);
      unpacked = await unpackCheckpoint(path.join(dir, 'plain'), path.join(dir, 'files'));
    }
    const source = { ...input.target, ...unpacked.manifest.source, engine: 'postgres', serverId: null, volumeName, containerName: null } as Database;
    imported = true;
    await importPitrCheckpoint(unpacked, archive, log);
    const target = { ...input.target, version: source.version, username: source.username, dbName: source.dbName, engine: 'postgres', serverId: null } as Database;
    return { ...await recoverPostgresToPoint(source, target, input.targetTime, log), version: source.version, username: source.username, dbName: source.dbName };
  } finally {
    if (imported) await capture('docker', ['volume', 'rm', archive], { timeoutMs: 30_000 });
    await rm(dir, { recursive: true, force: true });
  }
}
