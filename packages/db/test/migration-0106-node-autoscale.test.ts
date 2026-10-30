import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createDb, runMigrations } from '../src/index.js';

function cleanupScratch(scratch: string) {
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
  catch (error) {
    // libsql may hold its closed file until process exit on Windows.
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

it('upgrades without changing existing work and retains the unique scale decision across database reopen', async () => {
  const scratch = resolve(mkdtempSync(join(tmpdir(), 'nd-node-autoscale-migration-')));
  if (!scratch.startsWith(resolve(tmpdir()) + sep) || !scratch.includes('nd-node-autoscale-migration-')) throw Error('Unsafe migration scratch');
  const url = `file:${join(scratch, 'state.db').split(sep).join('/')}`;
  let c = createDb({ url });
  try {
    const previous = join(scratch, 'migrations');
    cpSync(fileURLToPath(new URL('../src/migrations', import.meta.url)), previous, { recursive: true });
    const journalPath = join(previous, 'meta/_journal.json'), journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const index = journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0106_node_autoscale_transitions');
    expect(index).toBeGreaterThan(0); journal.entries = journal.entries.slice(0, index); writeFileSync(journalPath, JSON.stringify(journal));
    await c.ready; await runMigrations(c.db, previous);
    await c.client!.execute("INSERT INTO servers(id,name,host,token_encrypted) VALUES(4,'Node','node.test','fixture')");
    await c.client!.execute("INSERT INTO services(id,name,slug,type,server_id,status,runtime_id) VALUES(1,'Web','web','docker',4,'running','web-9')");
    await c.client!.execute("INSERT INTO deployments(id,service_id,status,config_snapshot) VALUES(9,1,'running','{\"build\":\"retained\"}')");
    const before = (await c.client!.execute('SELECT * FROM deployments')).rows;
    await runMigrations(c.db);
    const journalAfterUpgrade = (await c.client!.execute('SELECT * FROM __drizzle_migrations ORDER BY id')).rows;
    await runMigrations(c.db);
    expect((await c.client!.execute('SELECT * FROM __drizzle_migrations ORDER BY id')).rows).toEqual(journalAfterUpgrade);
    expect((await c.client!.execute('SELECT * FROM deployments')).rows).toEqual(before);
    expect((await c.client!.execute('SELECT * FROM node_autoscale_transitions')).rows).toEqual([]);
    await c.client!.execute({ sql: "INSERT INTO node_autoscale_transitions(service_id,owner_epoch,request_id,server_id,runtime_id,from_replicas,to_replicas,watermark,targets) VALUES(1,4,?,4,'web-9',1,2,9,'[]')", args: ['a'.repeat(32)] });
    await expect(c.client!.execute({ sql: "INSERT INTO node_autoscale_transitions(service_id,owner_epoch,request_id,server_id,runtime_id,from_replicas,to_replicas,watermark,targets) VALUES(1,5,?,4,'web-9',1,3,9,'[]')", args: ['b'.repeat(32)] })).rejects.toThrow();
    c.client!.close(); c = createDb({ url }); await c.ready;
    expect((await c.client!.execute('SELECT service_id,owner_epoch,request_id,from_replicas,to_replicas,phase FROM node_autoscale_transitions')).rows)
      .toEqual([{ service_id: 1, owner_epoch: 4, request_id: 'a'.repeat(32), from_replicas: 1, to_replicas: 2, phase: 'accepted' }]);
    expect((await c.client!.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
    await c.client!.execute('DELETE FROM services WHERE id=1');
    expect((await c.client!.execute('SELECT * FROM node_autoscale_transitions')).rows).toEqual([]);
  } finally {
    c.client?.close();
    cleanupScratch(scratch);
  }
});

it('retains a pre-configuration scale decision while leaving its configuration unconfirmed on upgrade', async () => {
  const scratch = resolve(mkdtempSync(join(tmpdir(), 'nd-node-autoscale-migration-')));
  if (!scratch.startsWith(resolve(tmpdir()) + sep) || !scratch.includes('nd-node-autoscale-migration-')) throw Error('Unsafe migration scratch');
  const c = createDb({ url: `file:${join(scratch, 'state.db').split(sep).join('/')}` });
  try {
    const previous = join(scratch, 'migrations');
    cpSync(fileURLToPath(new URL('../src/migrations', import.meta.url)), previous, { recursive: true });
    const journalPath = join(previous, 'meta/_journal.json'), journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const index = journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0107_node_autoscale_configuration');
    expect(index).toBeGreaterThan(0); journal.entries = journal.entries.slice(0, index); writeFileSync(journalPath, JSON.stringify(journal));
    await c.ready; await runMigrations(c.db, previous);
    await c.client!.execute("INSERT INTO servers(id,name,host,token_encrypted) VALUES(4,'Node','node.test','fixture')");
    await c.client!.execute("INSERT INTO services(id,name,slug,type,server_id,status,runtime_id) VALUES(1,'Web','web','docker',4,'running','web-9')");
    await c.client!.execute({ sql: "INSERT INTO node_autoscale_transitions(service_id,owner_epoch,request_id,server_id,runtime_id,from_replicas,to_replicas,watermark,targets) VALUES(1,4,?,4,'web-9',1,2,9,'[]')", args: ['a'.repeat(32)] });
    await runMigrations(c.db);
    expect((await c.client!.execute('SELECT service_id,request_id,configuration,worker_token,lease_until FROM node_autoscale_transitions')).rows)
      .toEqual([{ service_id: 1, request_id: 'a'.repeat(32), configuration: '', worker_token: null, lease_until: null }]);
  } finally {
    c.client?.close();
    cleanupScratch(scratch);
  }
});
