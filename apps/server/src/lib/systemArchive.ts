import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { count, sql } from 'drizzle-orm';
import { databases, deployments, services, users, type DB } from '@ninedeploy/db';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { audit } from './audit.js';

/**
 * The panel's own full-state archive: the format `GET /system/export` streams
 * and `POST /system/import` restores, and the payload a panel self-backup
 * seals and uploads. One builder and one importer, so the scheduled backup can
 * never drift into a second format the import does not understand.
 *
 * Archive members (all at the top level, relative to the data dir):
 *   _db-<stamp>.db     consistent `VACUUM INTO` snapshot of the panel database
 *   master.key         the instance master key file, when one exists
 *   _env-<stamp>       a copy of the process cwd's `.env`, when present
 *   traefik/           the panel's Traefik config directory, when present
 *   _meta-<stamp>.json version, timestamp, row counts and the member list
 */

export interface SystemArchive {
  /** Absolute path of the finished `.tar.gz` (inside the data dir). */
  archive: string;
  size: number;
  meta: Record<string, unknown>;
  /** Removes the archive and every stamped intermediate. Idempotent. */
  cleanup: () => void;
}

/**
 * Build the full-state archive. On any failure every intermediate is removed
 * before the error propagates; on success the caller owns `cleanup()`.
 */
export async function createSystemArchive(
  db: DB,
  opts: { warn?: (msg: string) => void; extraMeta?: Record<string, unknown> } = {},
): Promise<SystemArchive> {
  const files: string[] = [];
  // Unique temp names so two concurrent exports can't delete each other's
  // artifacts mid-stream via the cleanup. pid+ms alone is not unique: two
  // requests handled in the same millisecond collided (F557).
  const stamp = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const archive = path.join(config.paths.dataDir, `ninedeploy-backup-${stamp}.tar.gz`);
  const envTmp = `_env-${stamp}`;
  const metaTmp = `_meta-${stamp}.json`;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { unlinkSync(path.join(config.paths.dataDir, envTmp)); } catch { /* */ }
    try { unlinkSync(path.join(config.paths.dataDir, metaTmp)); } catch { /* */ }
    try { unlinkSync(path.join(config.paths.dataDir, `_db-${stamp}.db`)); } catch { /* */ }
    try { unlinkSync(archive); } catch { /* */ }
  };

  try {
    // Tar'ing the LIVE database races concurrent writes: a transaction
    // overlapping the archive yields a torn or journal-orphaned file that
    // fails integrity on import — silently corrupting the primary DR
    // artifact. `VACUUM INTO` produces a fully self-contained snapshot
    // while the server keeps serving.
    const dbRel = path.relative(config.paths.dataDir, config.paths.dbFile);
    if (existsSync(config.paths.dbFile)) {
      const dbSnapshot = `_db-${stamp}.db`;
      const dbSnapshotPath = path.join(config.paths.dataDir, dbSnapshot);
      // VACUUM INTO refuses to overwrite; clear any orphan from a crash
      // between VACUUM and the cleanup.
      try { unlinkSync(dbSnapshotPath); } catch { /* first run */ }
      await db.run(sql`VACUUM INTO ${dbSnapshotPath}`);
      if (existsSync(dbSnapshotPath)) {
        files.push(dbSnapshot);
      } else {
        // libsql either writes the snapshot or throws; a resolved run with
        // no file only happens under test doubles — fall back to the live
        // file rather than shipping an archive with no database at all.
        opts.warn?.('VACUUM INTO produced no snapshot file; archiving the live database file');
        files.push(dbRel);
      }
    }
    if (existsSync(config.paths.masterKeyFile)) files.push(path.relative(config.paths.dataDir, config.paths.masterKeyFile));
    const envFile = path.join(process.cwd(), '.env');
    if (existsSync(envFile)) {
      writeFileSync(path.join(config.paths.dataDir, envTmp), readFileSync(envFile, 'utf8'));
      files.push(envTmp);
    }
    const traefikDir = path.join(config.paths.dataDir, 'traefik');
    if (existsSync(traefikDir)) files.push('traefik');

    const [s, d, dep, u] = await Promise.all([
      db.select({ n: count() }).from(services),
      db.select({ n: count() }).from(databases),
      db.select({ n: count() }).from(deployments),
      db.select({ n: count() }).from(users),
    ]);
    const meta: Record<string, unknown> = {
      version: '1.0.0', exportedAt: new Date().toISOString(),
      stats: { services: s[0]?.n ?? 0, databases: d[0]?.n ?? 0, deployments: dep[0]?.n ?? 0, users: u[0]?.n ?? 0 },
      ...(opts.extraMeta ?? {}),
      files,
    };
    writeFileSync(path.join(config.paths.dataDir, metaTmp), JSON.stringify(meta, null, 2));
    files.push(metaTmp);

    await new Promise<void>((resolve, reject) => {
      // Run tar with cwd + RELATIVE names: GNU tar on Windows mistakes
      // `D:\path` (drive-letter colon) for a remote-host spec, so absolute
      // Windows paths break every tar flag that takes a file (-f/-C).
      const child = spawn('tar', ['-czf', path.basename(archive), ...files.map((f) => f.split(path.sep).join('/'))], {
        cwd: config.paths.dataDir,
      });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
    });

    return { archive, size: statSync(archive).size, meta, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Outcome of an import: the HTTP status and body the route answers with. */
export interface SystemImportOutcome {
  status: number;
  body: unknown;
}

/**
 * r454: the extraction uses one FIXED scratch dir, so two concurrent imports
 * would delete each other's in-flight files (the second request's up-front
 * `rmSync` wipes the first's archive mid-extraction). Single-panel is
 * single-process — this mutex serializes every import path (the upload route
 * and a panel-backup restore alike) and the loser gets an explicit 409.
 */
let importInFlight: Promise<unknown> | null = null;

/** True while an import is swapping files — callers report it as a 409. */
export function systemImportInFlight(): boolean {
  return importInFlight !== null;
}

/**
 * Restore a full-state archive (the `createSystemArchive` format) over this
 * panel's data dir. `source` is the archive bytes, or a file the archive is
 * copied from (the caller keeps ownership of that file).
 *
 * Unexpected failures (tar could not run, a move failed) throw, after the
 * original files were put back; refusals answer a 4xx outcome.
 */
export async function importSystemArchive(
  app: FastifyInstance,
  source: Buffer | { file: string },
  actorUserId: number | null,
): Promise<SystemImportOutcome> {
  if (importInFlight) {
    return {
      status: 409,
      body: { error: { code: 'conflict', message: 'Another import is already running — wait for it to finish' } },
    };
  }
  let release: () => void = () => {};
  importInFlight = new Promise<void>((r) => (release = r));
  try {

  const tmpDir = path.join(config.paths.dataDir, '_import');
  const archivePath = path.join(tmpDir, 'upload.tar.gz');
  // A previous import that crashed (or hit one of the early throws below)
  // leaves its extracted `_db-<stamp>.db` / `_meta-<stamp>.json` behind, and
  // the prefix finds further down would pick the STALE files over the new
  // archive's — silently restoring the wrong database. Clear the scratch
  // dir before reusing it; a leftover can only come from a dead request.
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  if (Buffer.isBuffer(source)) writeFileSync(archivePath, source);
  else copyFileSync(source.file, archivePath);

  const badRequest = (message: string): SystemImportOutcome => {
    rmSync(tmpDir, { recursive: true, force: true });
    return { status: 400, body: { error: { code: 'bad_request', message } } };
  };

  // Tar-slip guard: list the members FIRST and refuse anything that would
  // escape the extraction dir (absolute paths, .., or a parent ref) — GNU tar
  // strips leading '/' but happily extracts '../..' entries.
  const listing = await new Promise<string>((resolve, reject) => {
    let out = '';
    // Relative -f + cwd: see the export builder note about drive-letter colons.
    const child = spawn('tar', ['-tzf', path.basename(archivePath)], { cwd: tmpDir });
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`tar list exited ${code}`))));
  });
  const safe = (name: string) =>
    !name.startsWith('/') && !name.split('/').includes('..') && !path.isAbsolute(name);
  for (const member of listing.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (!safe(member)) return badRequest(`Invalid archive: unsafe member ${JSON.stringify(member)}`);
  }

  // Member-TYPE guard. The name check above cannot see a symlink: an archive
  // holding `data -> /etc` followed by `data/passwd` has two innocent-looking
  // names but writes outside the extraction dir. Verbose listing puts the type
  // in column 0 (`-` regular, `d` directory, `l` symlink, `h` hardlink, and
  // c/b/p/s for devices/fifos/sockets); only the first two are accepted.
  const verbose = await new Promise<string>((resolve, reject) => {
    let out = '';
    const child = spawn('tar', ['-tvzf', path.basename(archivePath)], { cwd: tmpDir });
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`tar list exited ${code}`))));
  });
  for (const entry of verbose.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const type = entry[0]!;
    if (type !== '-' && type !== 'd') {
      return badRequest(`Invalid archive: only regular files and directories are allowed (found ${JSON.stringify(entry)})`);
    }
  }

  await new Promise<void>((resolve, reject) => {
    // Relative -f + cwd: see the export builder note about drive-letter colons.
    // --no-same-owner / --no-same-permissions: never let an archive restore
    // setuid bits or hand extracted files to another uid. --no-overwrite-dir
    // keeps an existing directory's mode instead of adopting the archive's.
    const child = spawn(
      'tar',
      ['-xzf', path.basename(archivePath), '--no-same-owner', '--no-same-permissions', '-C', '.'],
      { cwd: tmpDir },
    );
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar extract exited ${code}`))));
  });

  const extractedFiles = readdirSync(tmpDir);
  const metaFilename = extractedFiles.find((f) => f === '_meta.json' || (f.startsWith('_meta') && f.endsWith('.json')));
  if (!metaFilename) return badRequest('Invalid archive: no _meta.json');
  const metaPath = path.join(tmpDir, metaFilename);
  // A malformed _meta.json must clean the scratch dir too — leaving it
  // behind poisons the next import's prefix finds (see the note at the top
  // of this function).
  let meta: unknown;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return badRequest('Invalid archive: _meta.json is not valid JSON');
  }

  // Audited BEFORE the swap: once the imported database is in place this
  // connection's file is the backup. The event still fans out live.
  void audit(app.db, actorUserId, 'system.import', String((meta as { exportedAt?: string } | null)?.exportedAt ?? 'unknown export'));
  try { const inst = app as unknown as { worker?: { stop: () => Promise<void> } }; if (inst.worker) await inst.worker.stop(); } catch { /* */ }

  const backupDir = path.join(config.paths.dataDir, `_backup-${Date.now()}`);

  // Restore-from-backup: if any move fails midway (e.g. a read-only cwd), put
  // the ORIGINAL files back so we never leave a moved DB with an old key
  // (which would make every secret undecryptable).
  const restoreFrom = (dir: string) => {
    // No per-file try/catch: anything that could be moved INTO the backup can
    // be moved back (same filesystem); letting an error surface here is more
    // honest than silently skipping a restore step.
    for (const name of ['ninedeploy.db', 'master.key', '.env', 'traefik']) {
      const b = path.join(dir, name);
      if (!existsSync(b)) continue;
      if (name === 'ninedeploy.db') renameSync(b, config.paths.dbFile);
      else if (name === 'master.key') renameSync(b, config.paths.masterKeyFile);
      else if (name === '.env') renameSync(b, path.join(process.cwd(), '.env'));
      else {
        // The half-imported traefik dir may occupy the target — rename(2)
        // cannot replace a non-empty directory, so clear it first (rmSync
        // with force is a no-op when the target is already gone).
        const target = path.join(config.paths.dataDir, 'traefik');
        rmSync(target, { recursive: true, force: true });
        renameSync(b, target);
      }
    }
  };

  try {
    // Exports store the db under its data-dir-relative name (legacy
    // archives) or as `_db-<stamp>.db` — the consistent VACUUM INTO
    // snapshot taken at export time (see createSystemArchive). Prefix-matching
    // mirrors how the stamped `_env-` file is located below.
    const dbRel = path.relative(config.paths.dataDir, config.paths.dbFile);
    const dbFilename = extractedFiles.find((f) => f === dbRel || f.startsWith('_db-'));
    const importedDb = dbFilename ? path.join(tmpDir, dbFilename) : null;
    if (importedDb && existsSync(importedDb)) {
      mkdirSync(backupDir, { recursive: true });
      if (existsSync(config.paths.dbFile)) renameSync(config.paths.dbFile, path.join(backupDir, 'ninedeploy.db'));
      renameSync(importedDb, config.paths.dbFile);
    }

    const importedKey = path.join(tmpDir, path.relative(config.paths.dataDir, config.paths.masterKeyFile));
    if (existsSync(importedKey)) {
      mkdirSync(backupDir, { recursive: true });
      if (existsSync(config.paths.masterKeyFile)) renameSync(config.paths.masterKeyFile, path.join(backupDir, 'master.key'));
      renameSync(importedKey, config.paths.masterKeyFile);
    }

    const importedTraefik = path.join(tmpDir, 'traefik');
    if (existsSync(importedTraefik)) {
      mkdirSync(backupDir, { recursive: true });
      const traefikDir = path.join(config.paths.dataDir, 'traefik');
      if (existsSync(traefikDir)) renameSync(traefikDir, path.join(backupDir, 'traefik'));
      renameSync(importedTraefik, traefikDir);
    }

    const envFilename = extractedFiles.find((f) => f === '_env' || f.startsWith('_env-'));
    const importedEnv = envFilename ? path.join(tmpDir, envFilename) : null;
    if (importedEnv && existsSync(importedEnv)) {
      mkdirSync(backupDir, { recursive: true });
      const envPath = path.join(process.cwd(), '.env');
      if (existsSync(envPath)) renameSync(envPath, path.join(backupDir, '.env'));
      copyFileSync(importedEnv, envPath);
    }
  } catch (err) {
    restoreFrom(backupDir);
    rmSync(tmpDir, { recursive: true, force: true });
    // F828: the original files are back and the panel keeps serving — resume
    // the deploy worker stopped above, or queued deploys never run again
    // until a restart. (A throwing restoreFrom leaves it stopped: unknown state.)
    try { (app as unknown as { worker?: { start?: () => void } }).worker?.start?.(); } catch { /* */ }
    throw err;
  }

  rmSync(tmpDir, { recursive: true, force: true });

  return {
    status: 200,
    body: {
      ok: true,
      message: 'System state imported. Restart NineDeploy for changes to take effect.',
      meta,
      backupPath: backupDir,
    },
  };
  } catch (err) {
    // F556: a THROW before the swap (tar list/extract failure on a truncated
    // or non-archive upload) skipped every per-branch cleanup and left the
    // uploaded archive — DB + master key + .env — in the scratch dir.
    rmSync(path.join(config.paths.dataDir, '_import'), { recursive: true, force: true });
    throw err;
  } finally {
    release();
    importInFlight = null;
  }
}
