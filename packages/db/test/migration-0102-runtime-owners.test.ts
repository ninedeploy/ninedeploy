import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createDb, runMigrations } from '../src/index.js';

it('preserves pending wire identity and seeds private ownership above deleted command history when upgrading 0101', async () => {
  const scratch = resolve(mkdtempSync(join(tmpdir(), 'nd-runtime-owner-migration-')));
  if (!scratch.startsWith(resolve(tmpdir()) + sep) || !scratch.includes('nd-runtime-owner-migration-')) throw new Error('Unexpected migration cleanup path');
  const c = createDb({ url: 'file::memory:' });
  try {
    const previous = join(scratch, 'migrations');
    cpSync(fileURLToPath(new URL('../src/migrations', import.meta.url)), previous, { recursive: true });
    const path = join(previous, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: Array<{ tag: string }> };
    const boundary = journal.entries.findIndex(entry => entry.tag === '0102_service_runtime_owners');
    expect(boundary).toBeGreaterThan(0); journal.entries = journal.entries.slice(0, boundary);
    writeFileSync(path, JSON.stringify(journal));
    await c.ready; await runMigrations(c.db, previous);
    await c.client!.execute("INSERT INTO servers(id,name,host,token_encrypted) VALUES (4,'Node','node.test','opaque-fixture')");
    await c.client!.execute("INSERT INTO services(id,name,slug,type,status,server_id,runtime_id) VALUES (1,'Web','web','docker','stopped',4,'web-9'),(2,'Other','other','docker','running',4,'other-10'),(3,'Review','review','docker','stopped',4,'review-11')");
    const snapshot = { status: 'running', serving: 2, capacity: 3, port: 3000, configuration: 'original' };
    const targets = JSON.stringify([{ id: 'a'.repeat(64), name: 'web-9' }]);
    await c.client!.execute({ sql: "INSERT INTO node_lifecycle_intents(id,service_id,server_id,runtime_id,deployment_id,action,request_id,phase,snapshot,targets,owner_token,lease_until) VALUES (7,1,4,'web-9',9,'stop',?,'applying',?,?,?,1790000000)",
      args: ['a'.repeat(32), JSON.stringify(snapshot), targets, 'b'.repeat(32)] });
    await c.client!.execute({ sql: "INSERT INTO node_lifecycle_intents(id,service_id,server_id,runtime_id,deployment_id,action,request_id,phase,snapshot) VALUES (120,2,4,'other-10',10,'stop',?,'completed','{}')", args: ['c'.repeat(32)] });
    await c.client!.execute('DELETE FROM node_lifecycle_intents WHERE id=120');
    await c.client!.execute({ sql: "INSERT INTO node_lifecycle_intents(service_id,server_id,runtime_id,deployment_id,action,request_id,phase,snapshot) VALUES (3,4,'review-11',11,'stop',?,'fencing','not-json')", args: ['d'.repeat(32)] });
    const high = Number((await c.client!.execute("SELECT seq FROM sqlite_sequence WHERE name='node_lifecycle_intents'")).rows[0]!.seq);
    expect(high).toBeGreaterThanOrEqual(120);
    await runMigrations(c.db);
    const row = (await c.client!.execute('SELECT * FROM service_runtime_owners WHERE service_id=1')).rows[0]!;
    expect(row).toMatchObject({ service_id: 1, epoch: high, request_id: 'a'.repeat(32), kind: 'stop' });
    const migrated = (await c.client!.execute('SELECT * FROM node_lifecycle_intents WHERE id=7')).rows[0]!;
    expect(JSON.parse(String(migrated.snapshot))).toEqual({ ...snapshot, mutationEpoch: high });
    expect(migrated).toMatchObject({ request_id: 'a'.repeat(32), phase: 'applying', targets, owner_token: 'b'.repeat(32), lease_until: 1790000000 });
    expect((await c.client!.execute('SELECT snapshot FROM node_lifecycle_intents WHERE service_id=3')).rows[0]!.snapshot).toBe('not-json');
    expect((await c.client!.execute('SELECT * FROM service_runtime_owners WHERE service_id=2')).rows[0]).toMatchObject({ epoch: high, request_id: null, kind: 'legacy' });
    expect((await c.client!.execute('SELECT status,runtime_id FROM services WHERE id=1')).rows[0]).toEqual({ status: 'stopped', runtime_id: 'web-9' });
    await c.client!.execute('UPDATE service_runtime_owners SET epoch=500 WHERE service_id=1');
    await runMigrations(c.db);
    expect((await c.client!.execute('SELECT epoch FROM service_runtime_owners WHERE service_id=1')).rows[0]!.epoch).toBe(500);
    expect((await c.client!.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
    await c.client!.execute('DELETE FROM services WHERE id=1');
    expect((await c.client!.execute('SELECT * FROM service_runtime_owners WHERE service_id=1')).rows).toEqual([]);
  } finally {
    c.client!.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
