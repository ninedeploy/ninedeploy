import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createDb, runMigrations } from '../src/index.js';

it('adds empty error issue and event tables that cascade with their service and leave deployments alone', async () => {
  const scratch = resolve(mkdtempSync(join(tmpdir(), 'nd-error-ingest-migration-')));
  if (!scratch.startsWith(resolve(tmpdir()) + sep) || !scratch.includes('nd-error-ingest-migration-')) throw Error('Unsafe migration scratch');
  const c = createDb({ url: 'file::memory:' });
  try {
    const previous = join(scratch, 'migrations');
    cpSync(fileURLToPath(new URL('../src/migrations', import.meta.url)), previous, { recursive: true });
    const journalPath = join(previous, 'meta/_journal.json'), journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const index = journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0105_error_ingest');
    expect(index).toBeGreaterThan(0); journal.entries = journal.entries.slice(0, index); writeFileSync(journalPath, JSON.stringify(journal));
    await c.ready; await runMigrations(c.db, previous);
    await c.client!.execute("INSERT INTO services(id,name,slug,type,status) VALUES(1,'Web','web','docker','running')");
    await c.client!.execute("INSERT INTO deployments(id,service_id,status) VALUES(9,1,'running')");
    const work = (await c.client!.execute('SELECT * FROM deployments')).rows;
    await runMigrations(c.db); await runMigrations(c.db);
    expect((await c.client!.execute('SELECT * FROM deployments')).rows).toEqual(work);
    expect((await c.client!.execute('SELECT * FROM error_issues')).rows).toEqual([]);
    await c.client!.execute("INSERT INTO error_issues(id,service_id,fingerprint,title,first_deployment_id) VALUES(1,1,'f','TypeError',9)");
    await c.client!.execute("INSERT INTO error_events(issue_id,payload,deployment_id) VALUES(1,'{}',9)");
    await c.client!.execute('DELETE FROM deployments WHERE id=9');
    expect((await c.client!.execute('SELECT first_deployment_id FROM error_issues')).rows).toEqual([{ first_deployment_id: null }]);
    expect((await c.client!.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
    await c.client!.execute('DELETE FROM services WHERE id=1');
    expect((await c.client!.execute('SELECT COUNT(*) AS n FROM error_events')).rows).toEqual([{ n: 0 }]);
  } finally { c.client!.close(); rmSync(scratch, { recursive: true, force: true }); }
});
