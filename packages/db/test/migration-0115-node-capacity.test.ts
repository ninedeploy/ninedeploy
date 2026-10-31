import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createDb, runMigrations } from '../src/index.js';

let scratch: string;
afterEach(() => {
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
  catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
});

it('adds durable capacity evidence without changing existing deployments', async () => {
  scratch = resolve(mkdtempSync(join(tmpdir(), 'nd-node-capacity-migration-')));
  if (!scratch.startsWith(resolve(tmpdir()) + sep) || !scratch.includes('nd-node-capacity-migration-')) throw Error('Unsafe migration scratch');
  const url = `file:${join(scratch, 'state.db').split(sep).join('/')}`;
  let c = createDb({ url });
  try {
    const previous = join(scratch, 'migrations');
    cpSync(fileURLToPath(new URL('../src/migrations', import.meta.url)), previous, { recursive: true });
    const journalPath = join(previous, 'meta/_journal.json'), journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const index = journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0115_real_jigsaw');
    expect(index).toBeGreaterThan(0); journal.entries = journal.entries.slice(0, index); writeFileSync(journalPath, JSON.stringify(journal));
    await c.ready; await runMigrations(c.db, previous);
    await c.client!.execute("INSERT INTO servers(id,name,host,token_encrypted) VALUES(4,'Node','node.test','fixture')");
    await c.client!.execute("INSERT INTO services(id,name,slug,type,server_id) VALUES(1,'Web','web','docker',4)");
    await c.client!.execute("INSERT INTO deployments(id,service_id,status) VALUES(9,1,'running')");
    const before = (await c.client!.execute('SELECT * FROM deployments')).rows;
    await runMigrations(c.db);
    expect((await c.client!.execute('SELECT * FROM deployments')).rows).toEqual(before);
    await c.client!.execute({ sql: "INSERT INTO node_autoscale_capacity(deployment_id,service_id,server_id,runtime_id,image_id,targets) VALUES(9,1,4,'web-9',?,?)",
      args: [`sha256:${'f'.repeat(64)}`, JSON.stringify([{ name: 'web-9', id: 'b'.repeat(64) }])] });
    c.client!.close(); c = createDb({ url }); await c.ready;
    expect((await c.client!.execute('SELECT deployment_id,runtime_id FROM node_autoscale_capacity')).rows).toEqual([{ deployment_id: 9, runtime_id: 'web-9' }]);
    expect((await c.client!.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
  } finally {
    c.client?.close();
  }
});
