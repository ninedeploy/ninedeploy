/**
 * F1023 — building the full-state archive (GET /system/export, every panel
 * self-backup) reads the database snapshot, master.key, .env and traefik/ at
 * different moments, while an import swaps those very files. An import landing
 * between "snapshot" and "tar" produced an archive whose master key no longer
 * opens its database — a DR artifact reported as a success. A build and an
 * import now refuse each other (409), and a scheduled panel backup is skipped
 * while an import runs.
 *
 * Real migrated SQLite (VACUUM INTO) and the system `tar`, in a temp data dir
 * and a temp cwd (so the repo's own `.env` is never read). Completion order is
 * gated, not slept: the build is paused at its first await (the VACUUM), the
 * import runs, then the build is released.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DB } from '@ninedeploy/db';

const root = mkdtempSync(path.join(os.tmpdir(), 'nd-archive-race-'));
const dataDir = path.join(root, 'data');
const cwd = path.join(root, 'cwd');
mkdirSync(dataDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
const originalCwd = process.cwd();
process.chdir(cwd);
process.env['NINEDEPLOY_DATA_DIR'] = dataDir;
process.env['NINEDEPLOY_DB_PATH'] = path.join(dataDir, 'ninedeploy.db');
const { createSystemArchive, importSystemArchive, systemImportInFlight } = await import('../src/lib/systemArchive.js');
const { runPanelBackup } = await import('../src/lib/panelBackup.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const keyFile = path.join(dataDir, 'master.key');

let db: DB;
let close: () => void;

beforeAll(async () => {
  const created = createDb({ url: `file:${path.join(root, 'migrated.db').split(path.sep).join('/')}` });
  await created.ready;
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

afterAll(() => {
  process.chdir(originalCwd);
  try {
    close();
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows may hold the file a moment longer */
  }
});

const tar = (args: string[], cwdDir: string): Buffer => {
  // Relative names + cwd: GNU tar on Windows reads `D:\x` as a remote host.
  const r = spawnSync('tar', args, { cwd: cwdDir, encoding: 'buffer' });
  if (r.status !== 0) throw new Error(`tar ${args.join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout;
};

function importBuffer(newKey: string): Buffer {
  const dir = mkdtempSync(path.join(root, 'imp-'));
  writeFileSync(path.join(dir, '_meta-1.json'), JSON.stringify({ exportedAt: 'test-export' }));
  writeFileSync(path.join(dir, 'master.key'), newKey);
  tar(['-czf', 'imp.tar.gz', '_meta-1.json', 'master.key'], dir);
  return readFileSync(path.join(dir, 'imp.tar.gz'));
}

const keyInArchive = (archive: string): string => tar(['-xzOf', path.basename(archive), 'master.key'], dataDir).toString();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** `real`, except that `run` (the VACUUM INTO) pauses until `release`. */
function pausedAtVacuum(real: DB, release: Promise<void>, reached: () => void): DB {
  return new Proxy(real, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'run') {
        return async (...args: unknown[]) => {
          reached();
          await release;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function reset(): void {
  writeFileSync(path.join(dataDir, 'ninedeploy.db'), 'live-db-placeholder');
  writeFileSync(keyFile, 'OLD-KEY');
}

describe('archive build vs import (F1023)', () => {
  it('an import landing during a build is refused, and the archive keeps the key the build started with', async () => {
    reset();
    const gate = deferred();
    const atVacuum = deferred();
    const building = createSystemArchive(pausedAtVacuum(db, gate.promise, atVacuum.resolve));
    await atVacuum.promise;
    const outcome = await importSystemArchive({ db } as never, importBuffer('NEW-KEY'), null);
    expect(outcome.status).toBe(409);
    expect(readFileSync(keyFile, 'utf8')).toBe('OLD-KEY');
    gate.resolve();
    const built = await building;
    expect(keyInArchive(built.archive)).toBe('OLD-KEY');
    built.cleanup();
  });

  it('a build (or a scheduled panel backup) during an import is refused or skipped, and nothing stays held', async () => {
    reset();
    const gate = deferred();
    const inImport = deferred();
    const slowApp = {
      db,
      worker: {
        stop: () => {
          inImport.resolve();
          return gate.promise;
        },
      },
    } as never;
    const importing = importSystemArchive(slowApp, importBuffer('IMPORTED-KEY'), null);
    await inImport.promise;
    expect(systemImportInFlight()).toBe(true);
    await expect(createSystemArchive(db)).rejects.toMatchObject({ statusCode: 409 });
    expect(await runPanelBackup(db, { trigger: 'schedule', actorUserId: null })).toEqual({
      status: 'skipped',
      reason: 'a system import is in progress',
    });
    gate.resolve();
    expect((await importing).status).toBe(200);
    const built = await createSystemArchive(db);
    built.cleanup();
    writeFileSync(keyFile, 'OLD-KEY');
    expect((await importSystemArchive({ db } as never, importBuffer('NEXT-KEY'), null)).status).toBe(200);
  });
});
