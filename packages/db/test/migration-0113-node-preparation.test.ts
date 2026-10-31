import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createDb, runMigrations } from '../src/index.js';

function cleanupScratch(scratch: string) {
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
  catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
}

it('upgrades existing work and persists node preparation receipts across reopen', async () => {
  const scratch = resolve(mkdtempSync(join(tmpdir(), 'nd-node-preparation-migration-')));
  if (!scratch.startsWith(resolve(tmpdir()) + sep) || !scratch.includes('nd-node-preparation-migration-')) throw new Error('Unsafe migration scratch');
  const url = `file:${join(scratch, 'state.db').split(sep).join('/')}`;
  let c = createDb({ url });
  try {
    const previous = join(scratch, 'migrations');
    cpSync(fileURLToPath(new URL('../src/migrations', import.meta.url)), previous, { recursive: true });
    const journalPath = join(previous, 'meta/_journal.json'), journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const index = journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0113_node_deployment_preparations');
    expect(index).toBeGreaterThan(0); journal.entries = journal.entries.slice(0, index); writeFileSync(journalPath, JSON.stringify(journal));
    await c.ready; await runMigrations(c.db, previous);
    await c.client!.execute("INSERT INTO servers(id,name,host,token_encrypted) VALUES(4,'Node','node.test','fixture')");
    await c.client!.execute("INSERT INTO services(id,name,slug,type,server_id,status,runtime_id) VALUES(1,'Web','web','docker',4,'running','web-9')");
    await c.client!.execute("INSERT INTO deployments(id,service_id,status,config_snapshot) VALUES(9,1,'running','retained')");
    const before = (await c.client!.execute('SELECT * FROM deployments')).rows;
    await runMigrations(c.db);
    expect((await c.client!.execute('SELECT * FROM deployments')).rows).toEqual(before);
    expect((await c.client!.execute('SELECT * FROM node_deployment_preparations')).rows).toEqual([]);
    await c.client!.execute({ sql: "INSERT INTO node_deployment_preparations(deployment_id,service_id,server_id,epoch,request_id,runtime_id,image_id,serving,capacity,phase,targets) VALUES(9,1,4,1,?,'web-9',?,1,1,'prepared',?)",
      args: ['a'.repeat(32), `sha256:${'f'.repeat(64)}`, JSON.stringify([{ name: 'web-9', id: 'b'.repeat(64) }])] });
    await runMigrations(c.db);
    c.client!.close(); c = createDb({ url }); await c.ready;
    expect((await c.client!.execute('SELECT deployment_id,phase,targets FROM node_deployment_preparations')).rows)
      .toEqual([{ deployment_id: 9, phase: 'prepared', targets: JSON.stringify([{ name: 'web-9', id: 'b'.repeat(64) }]) }]);
    expect((await c.client!.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
    await c.client!.execute('DELETE FROM deployments WHERE id=9');
    expect((await c.client!.execute('SELECT * FROM node_deployment_preparations')).rows).toEqual([]);
  } finally {
    c.client?.close();
    cleanupScratch(scratch);
  }
});
