import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createDb, runMigrations } from '../src/index.js';

it('upgrades 0100 without changing deployed services and preserves ordered intents across migration reruns', async () => {
  const scratch = resolve(mkdtempSync(join(tmpdir(), 'nd-lifecycle-migration-')));
  if (!scratch.startsWith(resolve(tmpdir()) + sep) || !scratch.includes('nd-lifecycle-migration-')) throw new Error('Unexpected migration scratch path');
  const c = createDb({ url: 'file::memory:' });
  try {
    const previous = join(scratch, 'migrations');
    cpSync(fileURLToPath(new URL('../src/migrations', import.meta.url)), previous, { recursive: true });
    const journalPath = join(previous, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
    const boundary = journal.entries.findIndex(entry => entry.tag === '0101_node_lifecycle_intents');
    expect(boundary).toBeGreaterThan(0); journal.entries = journal.entries.slice(0, boundary);
    writeFileSync(journalPath, JSON.stringify(journal));
    await c.ready; await runMigrations(c.db, previous);
    await c.client!.execute("INSERT INTO servers(id,name,host,token_encrypted) VALUES (4,'Existing node','node.test','opaque-node-credential')");
    await c.client!.execute("INSERT INTO services(id,name,slug,type,status,server_id,runtime_id,runtime_replicas,replicas) VALUES (1,'Web','web','docker','running',4,'web-9',3,4)");
    await c.client!.execute("INSERT INTO deployments(id,service_id,status) VALUES (9,1,'running')");
    await runMigrations(c.db);
    expect((await c.client!.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='node_lifecycle_intents'")).rows).toEqual([{ name: 'node_lifecycle_intents' }]);
    expect((await c.client!.execute('SELECT status,server_id,runtime_id,runtime_replicas,replicas FROM services WHERE id=1')).rows).toEqual([
      { status: 'running', server_id: 4, runtime_id: 'web-9', runtime_replicas: 3, replicas: 4 },
    ]);
    expect((await c.client!.execute('SELECT status FROM deployments WHERE id=9')).rows).toEqual([{ status: 'running' }]);
    expect((await c.client!.execute('SELECT token_encrypted FROM servers WHERE id=4')).rows).toEqual([{ token_encrypted: 'opaque-node-credential' }]);
    expect((await c.client!.execute('SELECT * FROM node_lifecycle_intents')).rows).toEqual([]);
    const snapshot = JSON.stringify({ status: 'running', serving: 3, capacity: 4, port: 3000 });
    const targets = JSON.stringify([{ id: 'a'.repeat(64), name: 'web-9' }]);
    await c.client!.execute({ sql: "INSERT INTO node_lifecycle_intents(service_id,server_id,runtime_id,deployment_id,action,request_id,phase,snapshot,targets,owner_token,lease_until) VALUES (1,4,'web-9',9,'stop',?,'applying',?,?,?,?)",
      args: ['a'.repeat(32), snapshot, targets, 'b'.repeat(32), 1790000000] });
    await runMigrations(c.db);
    expect((await c.client!.execute('SELECT phase,snapshot,targets,owner_token,lease_until FROM node_lifecycle_intents')).rows).toEqual([
      { phase: 'applying', snapshot, targets, owner_token: 'b'.repeat(32), lease_until: 1790000000 },
    ]);
    expect((await c.client!.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
  } finally { c.client!.close(); rmSync(scratch, { recursive: true, force: true }); }
});

it('enforces one unresolved intent per service, unique requests and non-reused revision IDs', async () => {
  const c = createDb({ url: 'file::memory:' });
  try {
    await c.ready; await runMigrations(c.db);
    await c.client!.execute("INSERT INTO servers(id,name,host,token_encrypted) VALUES (4,'Node','node.test','fixture')");
    await c.client!.execute("INSERT INTO services(id,name,slug,type,server_id) VALUES (1,'First','first','docker',4),(2,'Second','second','docker',4)");
    const insert = (serviceId: number, requestId: string) => c.client!.execute({
      sql: "INSERT INTO node_lifecycle_intents(service_id,server_id,runtime_id,deployment_id,action,request_id,phase,snapshot) VALUES (?,4,'web-9',9,'stop',?,'fencing','{}') RETURNING id",
      args: [serviceId, requestId],
    });
    const first = Number((await insert(1, 'first')).rows[0]!.id);
    await expect(insert(1, 'another')).rejects.toThrow(/UNIQUE/);
    await expect(insert(2, 'first')).rejects.toThrow(/UNIQUE/);
    const independent = Number((await insert(2, 'second')).rows[0]!.id);
    expect(independent).toBeGreaterThan(first);
    await c.client!.execute("UPDATE node_lifecycle_intents SET phase='completed' WHERE service_id=1");
    const second = Number((await insert(1, 'third')).rows[0]!.id);
    expect(second).toBeGreaterThan(independent);
    await c.client!.execute({ sql: "UPDATE node_lifecycle_intents SET phase='superseded' WHERE id=?", args: [second] });
    await insert(1, 'fourth');
    const maximum = Number((await c.client!.execute('SELECT max(id) AS id FROM node_lifecycle_intents')).rows[0]!.id);
    await c.client!.execute('DELETE FROM node_lifecycle_intents');
    expect(Number((await insert(1, 'after-deletion')).rows[0]!.id)).toBeGreaterThan(maximum);
    const indexes = (await c.client!.execute("PRAGMA index_list('node_lifecycle_intents')")).rows.map(row => row.name);
    expect(indexes).toEqual(expect.arrayContaining(['node_lifecycle_service_pending_idx', 'node_lifecycle_request_idx', 'node_lifecycle_retry_idx']));
  } finally { c.client!.close(); }
});

it('cascades intents with deleted services and nodes and refuses unknown parents', async () => {
  const c = createDb({ url: 'file::memory:' });
  try {
    await c.ready; await runMigrations(c.db);
    await c.client!.execute("INSERT INTO servers(id,name,host,token_encrypted) VALUES (4,'Node','node.test','fixture')");
    await c.client!.execute("INSERT INTO services(id,name,slug,type,server_id) VALUES (1,'First','first','docker',4),(2,'Second','second','docker',4)");
    const insert = (serviceId: number, serverId: number) => c.client!.execute({
      sql: "INSERT INTO node_lifecycle_intents(service_id,server_id,runtime_id,deployment_id,action,request_id,phase,snapshot) VALUES (?,?,'web-9',9,'stop',?,'fencing','{}')",
      args: [serviceId, serverId, `${serviceId}-${serverId}`],
    });
    await expect(insert(99, 4)).rejects.toThrow(/FOREIGN KEY/);
    await expect(insert(1, 99)).rejects.toThrow(/FOREIGN KEY/);
    await insert(1, 4); await insert(2, 4);
    await c.client!.execute('DELETE FROM services WHERE id=1');
    expect((await c.client!.execute('SELECT service_id FROM node_lifecycle_intents')).rows).toEqual([{ service_id: 2 }]);
    await c.client!.execute('DELETE FROM servers WHERE id=4');
    expect((await c.client!.execute('SELECT * FROM node_lifecycle_intents')).rows).toEqual([]);
    expect((await c.client!.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
  } finally { c.client!.close(); }
});
