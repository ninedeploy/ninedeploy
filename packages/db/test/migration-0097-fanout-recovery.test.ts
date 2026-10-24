import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createDb, runMigrations } from '../src/index.js';

it('adds a unique recovery journal without losing existing target data on repeated migrations', async () => {
  const source = fileURLToPath(new URL('../src/migrations', import.meta.url));
  const scratch = resolve(mkdtempSync(join(tmpdir(), 'nd-fanout-migration-')));
  if (!scratch.startsWith(resolve(tmpdir()) + sep) || !scratch.includes('nd-fanout-migration-')) throw new Error('Unexpected migration scratch path');
  const c = createDb({ url: 'file::memory:' });
  try {
    const previous = join(scratch, 'migrations'); cpSync(source, previous, { recursive: true });
    const journalPath = join(previous, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
    const boundary = journal.entries.findIndex(entry => entry.tag === '0097_fanout_recovery');
    expect(boundary).toBeGreaterThan(0); journal.entries = journal.entries.slice(0, boundary);
    writeFileSync(journalPath, JSON.stringify(journal));
    await c.ready; await runMigrations(c.db, previous);
    expect((await c.client!.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='fanout_transitions'")).rows).toHaveLength(0);
    await c.client!.execute("INSERT INTO services(id,name,slug) VALUES (7,'Existing','existing')");
    await c.client!.execute("INSERT INTO servers(id,name,host,token_encrypted) VALUES (5,'Edge','edge.test','fixture')");
    await c.client!.execute("INSERT INTO service_targets(id,service_id,server_id,runtime_id,status) VALUES (3,7,5,'existing-t5-8','running')");
    await runMigrations(c.db);
    expect((await c.client!.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='fanout_transitions'")).rows).toHaveLength(1);
    await c.client!.execute("INSERT INTO fanout_transitions(service_id,server_id,target_id,deployment_id,primary_runtime_id,previous_runtime_id,candidate_runtime_id,port,phase) VALUES (7,5,3,9,'existing-9','existing-t5-8','existing-t5-9',8080,'retained')");
    await runMigrations(c.db);
    expect((await c.client!.execute('SELECT runtime_id,status FROM service_targets WHERE id=3')).rows).toEqual([{ runtime_id: 'existing-t5-8', status: 'running' }]);
    expect((await c.client!.execute('SELECT previous_runtime_id,candidate_runtime_id,phase FROM fanout_transitions')).rows).toEqual([{ previous_runtime_id: 'existing-t5-8', candidate_runtime_id: 'existing-t5-9', phase: 'retained' }]);
    await expect(c.client!.execute("INSERT INTO fanout_transitions(service_id,server_id,target_id,deployment_id,primary_runtime_id,candidate_runtime_id,port) VALUES (7,5,3,10,'existing-10','existing-t5-10',8080)")).rejects.toThrow(/UNIQUE/);
    await c.client!.execute('DELETE FROM service_targets WHERE id=3');
    expect((await c.client!.execute('SELECT id FROM fanout_transitions')).rows).toHaveLength(1);
    await c.client!.execute('DELETE FROM servers WHERE id=5');
    expect((await c.client!.execute('SELECT id FROM fanout_transitions')).rows).toHaveLength(0);
    await c.client!.execute("INSERT INTO servers(id,name,host,token_encrypted) VALUES (6,'Other','other.test','fixture')");
    await c.client!.execute("INSERT INTO fanout_transitions(service_id,server_id,target_id,deployment_id,primary_runtime_id,candidate_runtime_id,port) VALUES (7,6,4,10,'existing-10','existing-t6-10',8080)");
    await c.client!.execute('DELETE FROM services WHERE id=7');
    expect((await c.client!.execute('SELECT id FROM fanout_transitions')).rows).toHaveLength(0);
    expect((await c.client!.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
  } finally { c.client!.close(); rmSync(scratch, { recursive: true, force: true }); }
});
