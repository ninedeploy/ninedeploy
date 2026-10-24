import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createDb, runMigrations } from '../src/index.js';

it('creates a bounded primary transition journal without replacing existing service state', async () => {
  const source = fileURLToPath(new URL('../src/migrations', import.meta.url));
  const scratch = resolve(mkdtempSync(join(tmpdir(), 'nd-primary-migration-')));
  if (!scratch.startsWith(resolve(tmpdir()) + sep) || !scratch.includes('nd-primary-migration-')) throw new Error('Unexpected migration scratch path');
  const c = createDb({ url: 'file::memory:' });
  try {
    const previous = join(scratch, 'migrations'); cpSync(source, previous, { recursive: true });
    const journalPath = join(previous, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
    const boundary = journal.entries.findIndex(entry => entry.tag === '0098_primary_recovery');
    expect(boundary).toBeGreaterThan(0); journal.entries = journal.entries.slice(0, boundary);
    writeFileSync(journalPath, JSON.stringify(journal));
    await c.ready; await runMigrations(c.db, previous);
    expect((await c.client!.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='primary_transitions'")).rows).toHaveLength(0);
    await c.client!.execute("INSERT INTO services(id,name,slug,runtime_id,status) VALUES (7,'Existing','existing','existing-8','running')");
    await runMigrations(c.db);
    expect((await c.client!.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='primary_transitions'")).rows).toHaveLength(1);
    await c.client!.execute(`INSERT INTO primary_transitions(service_id,deployment_id,candidate) VALUES (7,9,'{"runtimeId":"existing-9","containers":[]}')`);
    await runMigrations(c.db);
    expect((await c.client!.execute('SELECT runtime_id,status FROM services WHERE id=7')).rows).toEqual([{ runtime_id: 'existing-8', status: 'running' }]);
    await expect(c.client!.execute(`INSERT INTO primary_transitions(service_id,deployment_id,candidate) VALUES (7,10,'{}')`)).rejects.toThrow(/UNIQUE/);
    await c.client!.execute('DELETE FROM services WHERE id=7');
    expect((await c.client!.execute('SELECT id FROM primary_transitions')).rows).toHaveLength(0);
    expect((await c.client!.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
  } finally { c.client!.close(); rmSync(scratch, { recursive: true, force: true }); }
});
