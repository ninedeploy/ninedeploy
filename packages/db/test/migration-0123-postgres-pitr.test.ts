import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { expect, it } from 'vitest';
import { createDb } from '../src/index.js';

it('upgrades existing databases from 122 with point-in-time recovery off, and records recoveries that outlive both databases', async () => {
  const folder = fileURLToPath(new URL('../src/migrations', import.meta.url)), scratch = mkdtempSync(join(tmpdir(), 'nd-0123-'));
  const c = createDb({ url: 'file::memory:' }); await c.ready;
  try {
    cpSync(folder, scratch, { recursive: true }); const journalPath = join(scratch, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    const at = journal.entries.findIndex(entry => entry.tag === '0123_postgres_pitr'); expect(at).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, at); writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(c.db, { migrationsFolder: scratch });
    await c.client!.execute("INSERT INTO databases(id,name,slug,engine,status,password_encrypted) VALUES (1,'main','main','postgres','running','x'),(2,'copy','copy','postgres','running','x')");
    await migrate(c.db, { migrationsFolder: folder });
    // An upgrade changes nothing until an admin enables it.
    expect((await c.db.query.databases.findFirst())!).toMatchObject({ pitrEnabled: false, pitrRetentionDays: 7, pitrBaseBackupAt: null, pitrLastError: null });
    await c.client!.execute("INSERT INTO pitr_recoveries(id,source_database_id,database_id,target_time) VALUES (1,1,2,1793871094423)");
    const recovery = (await c.db.query.pitrRecoveries.findFirst())!;
    expect(recovery).toMatchObject({ status: 'running', sourceDatabaseId: 1, databaseId: 2, error: null });
    expect(recovery.targetTime?.toISOString()).toBe('2026-11-05T09:31:34.423Z');
    // Deleting either database keeps the evidence.
    await c.client!.execute('PRAGMA foreign_keys = ON');
    await c.client!.execute('DELETE FROM databases WHERE id IN (1, 2)');
    expect((await c.db.query.pitrRecoveries.findFirst())!).toMatchObject({ id: 1, sourceDatabaseId: null, databaseId: null });
  } finally { c.client?.close(); rmSync(scratch, { recursive: true, force: true }); }
});
