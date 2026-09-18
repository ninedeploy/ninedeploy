import { createReadStream, existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { count, sql } from 'drizzle-orm';
import { databases, deployments, services, users } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { capture, run } from '../lib/exec.js';
import { config } from '../config.js';
import { checkForUpdate } from '../lib/updateCheck.js';
import { getSelfUpdateStatus, startSelfUpdate } from '../lib/selfUpdate.js';
import { selfUpdateStart } from '@ninedeploy/schemas';
import { NETWORK } from '../engine/proxy.js';
import { audit } from '../lib/audit.js';

function parseDf(line: string): Record<string, string> | null {
  try { return JSON.parse(line) as Record<string, string>; } catch { return null; }
}

/** Docker resource accounting + image pruning + export/import. Mounted under /system. */
export const systemRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  // System resources, prune, export/import — admin-only (host-level operations).
  app.addHook('preHandler', app.requireAdmin);

  // Latest-release check (GitHub Releases feed, 6h cache; "unknown" when
  // offline or disabled — never throws so the dashboard stays usable).
  app.get('/update-check', async (req) => checkForUpdate((req.query as { force?: string })?.force === '1'));

  // ── Panel self-update ───────────────────────────────────────────────────
  // State/resolution of a one-click upgrade; marker files, not memory — the
  // panel that answers these polls is not the process that started the run.
  app.get('/update-status', async () => getSelfUpdateStatus());

  // Start is pinned to an exact tag on purpose: the operator confirmed that
  // version in the UI, so nothing silently re-resolves to a newer tag that
  // landed between the availability check and the click.
  app.post('/update-start', async (req, reply) => {
    const parsed = selfUpdateStart.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'invalid body' },
      });
    }
    void audit(app.db, req.user?.id ?? null, 'system.update_start', parsed.data.version ?? 'latest');
    return startSelfUpdate(parsed.data.version);
  });

  app.get('/resources', async () => {
    let images: Array<{ repo: string; tag: string; size: string }> = [];
    let summary = { total: '0', active: '0', size: '—', reclaimable: '—' };
    let containers = 0;
    let volumes = 0;

    try {
      const df = await capture('docker', ['system', 'df', '--format', '{{json .}}']);
      for (const line of df.split('\n')) {
        const row = parseDf(line);
        if (row && row['Type'] === 'Images') {
          summary = { total: row['Total'] ?? '0', active: row['Active'] ?? '0', size: row['Size'] ?? '—', reclaimable: row['Reclaimable'] ?? '—' };
        }
      }
    } catch { /* docker unavailable */ }

    try {
      const out = await capture('docker', ['images', '--format', '{{.Repository}}|{{.Tag}}|{{.Size}}']);
      images = out.split('\n').filter(Boolean).map((l) => {
        const [repo, tag, size] = l.split('|');
        return { repo: repo!, tag: tag ?? '', size: size ?? '' };
      }).slice(0, 25);
    } catch { /* ignore */ }

    try {
      containers = (await capture('docker', ['ps', '-q'])).split('\n').filter(Boolean).length;
      volumes = (await capture('docker', ['volume', 'ls', '-q'])).split('\n').filter(Boolean).length;
    } catch { /* ignore */ }

    return { network: NETWORK, containers, volumes, imagesSummary: summary, images };
  });

  app.post('/prune-images', async (req) => {
    const log = (line: string) => req.log.info({ component: 'system' }, line);
    await run('docker', ['image', 'prune', '-f'], {}, log).catch(() => undefined);
    void audit(app.db, req.user?.id ?? null, 'system.prune_images');
    return { ok: true };
  });

  // Recent docker events (single-shot fetch for the Docker dashboard feed —
  // polling this endpoint is simpler and sturdier than a streamed daemon
  // connection). `minutes` caps how far back the daemon is asked to look.
  app.get('/docker-events', async (req) => {
    const minutes = Math.min(Math.max(Number((req.query as { minutes?: string }).minutes) || 60, 1), 1440);
    try {
      const raw = await capture('docker', [
        'events', '--since', `${minutes}m`, '--until', '0s',
        '--format', '{{.Time}}|{{.Type}}|{{.Action}}|{{.Actor.Attributes.name}}',
      ]);
      const events = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const parts = line.split('|');
          // Shared accessor: trailing segments may be missing entirely.
          const cell = (i: number): string => parts[i] ?? '';
          return { time: cell(0), type: cell(1), action: cell(2), name: cell(3) };
        })
        .reverse()
        .slice(0, 200);
      return { events };
    } catch {
      return { events: [] };
    }
  });

  // ── Export: download a tar.gz of the entire system state ──────────────
  app.get('/export', async (req, reply) => {
    // The archive holds the database AND the master key — every secret on the
    // instance. Its download must leave a trail.
    void audit(app.db, req.user?.id ?? null, 'system.export');
    const files: string[] = [];
    // Unique temp names so two concurrent exports can't delete each other's
    // artifacts mid-stream via the finally-cleanup below.
    const stamp = `${process.pid}-${Date.now()}`;
    const archive = path.join(config.paths.dataDir, `ninedeploy-backup-${stamp}.tar.gz`);
    const envTmp = `_env-${stamp}`;
    const metaTmp = `_meta-${stamp}.json`;

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
        // between VACUUM and the finally-cleanup.
        try { unlinkSync(dbSnapshotPath); } catch { /* first run */ }
        await app.db.run(sql`VACUUM INTO ${dbSnapshotPath}`);
        if (existsSync(dbSnapshotPath)) {
          files.push(dbSnapshot);
        } else {
          // libsql either writes the snapshot or throws; a resolved run with
          // no file only happens under test doubles — fall back to the live
          // file rather than shipping an archive with no database at all.
          app.log.warn('VACUUM INTO produced no snapshot file; archiving the live database file');
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
        app.db.select({ n: count() }).from(services),
        app.db.select({ n: count() }).from(databases),
        app.db.select({ n: count() }).from(deployments),
        app.db.select({ n: count() }).from(users),
      ]);
      const meta = {
        version: '1.0.0', exportedAt: new Date().toISOString(),
        stats: { services: s[0]?.n ?? 0, databases: d[0]?.n ?? 0, deployments: dep[0]?.n ?? 0, users: u[0]?.n ?? 0 },
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

      const size = statSync(archive).size;
      reply.type('application/gzip')
        .header('content-disposition', `attachment; filename="ninedeploy-backup-${new Date().toISOString().slice(0, 10)}.tar.gz"`)
        .header('content-length', size);
      return reply.send(createReadStream(archive));
    } finally {
      try { unlinkSync(path.join(config.paths.dataDir, envTmp)); } catch { /* */ }
      try { unlinkSync(path.join(config.paths.dataDir, metaTmp)); } catch { /* */ }
      try { unlinkSync(path.join(config.paths.dataDir, `_db-${stamp}.db`)); } catch { /* */ }
      try { unlinkSync(archive); } catch { /* */ }
    }
  });

  // ── Import: upload a tar.gz and restore system state ──────────────────
  // A backup archive is the sole large request this API accepts. Keep the
  // 256 MB allowance local so login, webhooks and ordinary JSON endpoints
  // cannot allocate a quarter-gigabyte Buffer before authentication runs.
  app.post('/import', { bodyLimit: 256 * 1024 * 1024 }, async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'string') {
      return reply.status(400).send({ error: { code: 'bad_request', message: 'No body received' } });
    }

    const tmpDir = path.join(config.paths.dataDir, '_import');
    const archivePath = path.join(tmpDir, 'upload.tar.gz');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(archivePath, Buffer.from(body, 'binary'));

    // Tar-slip guard: list the members FIRST and refuse anything that would
    // escape the extraction dir (absolute paths, .., or a parent ref) — GNU tar
    // strips leading '/' but happily extracts '../..' entries.
    const listing = await new Promise<string>((resolve, reject) => {
      let out = '';
      // Relative -f + cwd: see the export route note about drive-letter colons.
      const child = spawn('tar', ['-tzf', path.basename(archivePath)], { cwd: tmpDir });
      child.stdout.on('data', (d) => (out += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`tar list exited ${code}`))));
    });
    const safe = (name: string) =>
      !name.startsWith('/') && !name.split('/').includes('..') && !path.isAbsolute(name);
    for (const member of listing.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (!safe(member)) {
        rmSync(tmpDir, { recursive: true, force: true });
        return reply.status(400).send({ error: { code: 'bad_request', message: `Invalid archive: unsafe member ${JSON.stringify(member)}` } });
      }
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
        rmSync(tmpDir, { recursive: true, force: true });
        return reply.status(400).send({
          error: {
            code: 'bad_request',
            message: `Invalid archive: only regular files and directories are allowed (found ${JSON.stringify(entry)})`,
          },
        });
      }
    }

    await new Promise<void>((resolve, reject) => {
      // Relative -f + cwd: see the export route note about drive-letter colons.
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
    if (!metaFilename) {
      rmSync(tmpDir, { recursive: true, force: true });
      return reply.status(400).send({ error: { code: 'bad_request', message: 'Invalid archive: no _meta.json' } });
    }
    const metaPath = path.join(tmpDir, metaFilename);
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

    // Audited BEFORE the swap: once the imported database is in place this
    // connection's file is the backup. The event still fans out live.
    void audit(app.db, req.user?.id ?? null, 'system.import', String(meta?.exportedAt ?? 'unknown export'));
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
      // snapshot taken at export time (see the export route). Prefix-matching
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
      throw err;
    }

    rmSync(tmpDir, { recursive: true, force: true });

    return {
      ok: true,
      message: 'System state imported. Restart NineDeploy for changes to take effect.',
      meta,
      backupPath: backupDir,
    };
  });
};
