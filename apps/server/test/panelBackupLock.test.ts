/**
 * F1024 — `restorePanelBackup` took the process-wide panel-backup lock before
 * its try/finally and only then created its scratch directory. A failing
 * mkdir (disk full, read-only data dir) left the lock held: every later
 * scheduled or manual backup answered "skipped: a restore is in progress" and
 * every restore was refused with 409 until the panel restarted. A regular file
 * where the directory must go makes the mkdir fail the same way on every
 * platform. Real migrated SQLite, temp data dir.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DB } from '@ninedeploy/db';

const root = mkdtempSync(path.join(os.tmpdir(), 'nd-panel-backup-lock-'));
const dataDir = path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });
process.env['NINEDEPLOY_DATA_DIR'] = dataDir;
process.env['NINEDEPLOY_DB_PATH'] = path.join(dataDir, 'ninedeploy.db');
const { panelBackupBusy, restorePanelBackup, runPanelBackup } = await import('../src/lib/panelBackup.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const NAME = 'ninedeploy-panel-20261008T030000Z-1a2b3c.ndpb';

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
  try {
    close();
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows may hold the file a moment longer */
  }
});

const restore = () =>
  restorePanelBackup({ db } as never, { key: `panel-backups/${NAME}`, passphrase: 'x', confirm: NAME, destinationId: 1 }, null);

describe('panel backup lock after a restore that cannot start (F1024)', () => {
  it('frees the lock when the scratch directory cannot be created', async () => {
    const blocker = path.join(dataDir, '_panel-backup');
    writeFileSync(blocker, 'a file where the work directory belongs');
    await expect(restore()).rejects.toThrow(/EEXIST/);
    expect(panelBackupBusy()).toBe(false);
    // the next run answers on its own merits (no destination), not "a restore is in progress"
    expect(await runPanelBackup(db, { trigger: 'schedule', actorUserId: null })).toMatchObject({ status: 'failed' });
    rmSync(blocker, { force: true });
    // and a restore passes the lock again, failing later on the unknown destination
    await expect(restore()).rejects.toThrow(/Backup destination #1 does not exist/);
    expect(panelBackupBusy()).toBe(false);
  });
});
