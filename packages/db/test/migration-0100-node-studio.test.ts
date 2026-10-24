import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createDb, runMigrations } from '../src/index.js';

it('adds nullable node Studio identity without changing local ports, node placement or stored credentials', async () => {
  const source = fileURLToPath(new URL('../src/migrations', import.meta.url));
  const scratch = resolve(mkdtempSync(join(tmpdir(), 'nd-node-studio-migration-')));
  if (!scratch.startsWith(resolve(tmpdir()) + sep) || !scratch.includes('nd-node-studio-migration-')) throw new Error('Unexpected migration scratch path');
  const c = createDb({ url: 'file::memory:' });
  try {
    const previous = join(scratch, 'migrations'); cpSync(source, previous, { recursive: true });
    const journalPath = join(previous, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
    const boundary = journal.entries.findIndex(entry => entry.tag === '0100_node_studio_identity');
    expect(boundary).toBeGreaterThan(0); journal.entries = journal.entries.slice(0, boundary);
    writeFileSync(journalPath, JSON.stringify(journal));
    await c.ready; await runMigrations(c.db, previous);
    await c.client!.execute("INSERT INTO servers(id,name,host,token_encrypted) VALUES (7,'Existing node','node.test','opaque-node-credential')");
    await c.client!.execute("INSERT INTO databases(id,name,slug,engine,status,password_encrypted,web_gui_enabled,web_gui_port) VALUES (1,'Local','local','postgres','running','opaque-local-credential',1,18077)");
    await c.client!.execute("INSERT INTO databases(id,name,slug,engine,status,password_encrypted,server_id,node_container_name) VALUES (2,'Remote','remote','redis','running','opaque-db-credential',7,'nd-db-remote')");
    await runMigrations(c.db);
    expect((await c.client!.execute('SELECT id,web_gui_port,node_studio_identity,password_encrypted,server_id FROM databases ORDER BY id')).rows).toEqual([
      { id: 1, web_gui_port: 18077, node_studio_identity: null, password_encrypted: 'opaque-local-credential', server_id: null },
      { id: 2, web_gui_port: null, node_studio_identity: null, password_encrypted: 'opaque-db-credential', server_id: 7 },
    ]);
    const metadata = JSON.stringify({ containerId: 'd'.repeat(64), databaseContainerId: 'a'.repeat(64), networkId: 'b'.repeat(64) });
    await c.client!.execute({ sql: 'UPDATE databases SET node_studio_identity=? WHERE id=2', args: [metadata] });
    await runMigrations(c.db);
    expect((await c.client!.execute('SELECT node_studio_identity,web_gui_port FROM databases WHERE id=2')).rows).toEqual([{ node_studio_identity: metadata, web_gui_port: null }]);
    // An older panel's explicit columns remain readable; it cannot proxy a
    // node Studio through a panel-host port because that port stays NULL.
    expect((await c.client!.execute('SELECT name,engine,server_id,node_container_name FROM databases WHERE id=2')).rows).toEqual([{ name: 'Remote', engine: 'redis', server_id: 7, node_container_name: 'nd-db-remote' }]);
    expect((await c.client!.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
  } finally { c.client!.close(); rmSync(scratch, { recursive: true, force: true }); }
});
