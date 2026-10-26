import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createDb, runMigrations } from '../src/index.js';

it('adds a private empty owner journal without guessing ownership for existing work or changing deployment payloads', async () => {
  const scratch = resolve(mkdtempSync(join(tmpdir(), 'nd-deployment-owner-migration-')));
  if (!scratch.startsWith(resolve(tmpdir()) + sep) || !scratch.includes('nd-deployment-owner-migration-')) throw Error('Unsafe migration scratch');
  const c = createDb({ url: 'file::memory:' });
  try {
    const previous = join(scratch, 'migrations');
    cpSync(fileURLToPath(new URL('../src/migrations', import.meta.url)), previous, { recursive: true });
    const journalPath = join(previous, 'meta/_journal.json'), journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const index = journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0104_deployment_runtime_owners');
    expect(index).toBeGreaterThan(0); journal.entries = journal.entries.slice(0, index); writeFileSync(journalPath, JSON.stringify(journal));
    await c.ready; await runMigrations(c.db, previous);
    await c.client!.execute("INSERT INTO servers(id,name,host,token_encrypted) VALUES(4,'Node','node.test','fixture')");
    await c.client!.execute("INSERT INTO services(id,name,slug,type,server_id,status) VALUES(1,'Web','web','docker',4,'deploying')");
    await c.client!.execute("INSERT INTO deployments(id,service_id,status,config_snapshot) VALUES(9,1,'building','{\"build\":\"retained\"}')");
    await c.client!.execute("INSERT INTO service_runtime_owners(service_id,epoch,kind) VALUES(1,13,'legacy')");
    const columns = (await c.client!.execute('PRAGMA table_info(deployments)')).rows;
    const work = (await c.client!.execute('SELECT * FROM deployments')).rows;
    const authority = (await c.client!.execute('SELECT * FROM service_runtime_owners')).rows;
    await runMigrations(c.db); await runMigrations(c.db);
    expect((await c.client!.execute('PRAGMA table_info(deployments)')).rows).toEqual(columns);
    expect((await c.client!.execute('SELECT * FROM deployments')).rows).toEqual(work);
    expect((await c.client!.execute('SELECT * FROM service_runtime_owners')).rows).toEqual(authority);
    expect((await c.client!.execute('SELECT * FROM deployment_runtime_owners')).rows).toEqual([]);
    await c.client!.execute({ sql: 'INSERT INTO deployment_runtime_owners(deployment_id,service_id,server_id,epoch,request_id) VALUES(9,1,4,14,?)', args: ['a'.repeat(32)] });
    await c.client!.execute('DELETE FROM servers WHERE id=4');
    expect((await c.client!.execute('SELECT server_id FROM deployment_runtime_owners')).rows).toEqual([{ server_id: 4 }]);
    expect((await c.client!.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
    await c.client!.execute('DELETE FROM deployments WHERE id=9');
    expect((await c.client!.execute('SELECT * FROM deployment_runtime_owners')).rows).toEqual([]);
  } finally { c.client!.close(); rmSync(scratch, { recursive: true, force: true }); }
});
