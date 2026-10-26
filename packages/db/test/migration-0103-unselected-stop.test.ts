import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createDb, runMigrations } from '../src/index.js';

it.each([true, false])('preserves old commands and pruned sequence through nullable Stop upgrade; retained=%s', async retained => {
  const scratch = resolve(mkdtempSync(join(tmpdir(), 'nd-unselected-stop-migration-')));
  if (!scratch.startsWith(resolve(tmpdir()) + sep) || !scratch.includes('nd-unselected-stop-migration-')) throw Error('Unsafe migration scratch');
  const c = createDb({ url: 'file::memory:' });
  try {
    const previous = join(scratch, 'migrations');
    cpSync(fileURLToPath(new URL('../src/migrations', import.meta.url)), previous, { recursive: true });
    const journalPath = join(previous, 'meta/_journal.json'), journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const boundary = journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0103_generation_independent_stop');
    expect(boundary).toBeGreaterThan(0); journal.entries = journal.entries.slice(0, boundary); writeFileSync(journalPath, JSON.stringify(journal));
    await c.ready; await runMigrations(c.db, previous);
    await c.client!.execute("INSERT INTO servers(id,name,host,token_encrypted) VALUES (4,'Node','node.test','opaque')");
    await c.client!.execute("INSERT INTO services(id,name,slug,type,status,server_id,runtime_id) VALUES (1,'Web','web','docker','stopped',4,'web-9')");
    const insert = (id: number, phase: string, nonce: string) => c.client!.execute({ sql: "INSERT INTO node_lifecycle_intents(id,service_id,server_id,runtime_id,deployment_id,action,request_id,phase,snapshot,owner_token,lease_until) VALUES (?,1,4,'web-9',9,'stop',?,?,?, 'owner',1793040000)", args: [id, nonce, phase, '{"serving":2,"capacity":3}'] });
    if (retained) await insert(900, 'applying', 'a'.repeat(32));
    await insert(2000, 'completed', 'b'.repeat(32)); await c.client!.execute('DELETE FROM node_lifecycle_intents WHERE id=2000');
    await runMigrations(c.db); await runMigrations(c.db);
    const old = await c.client!.execute('SELECT id,runtime_id,deployment_id,phase,owner_token,lease_until,snapshot FROM node_lifecycle_intents');
    expect(old.rows).toEqual(retained ? [{ id: 900, runtime_id: 'web-9', deployment_id: 9, phase: 'applying', owner_token: 'owner', lease_until: 1793040000, snapshot: '{"serving":2,"capacity":3}' }] : []);
    if (retained) await c.client!.execute("UPDATE node_lifecycle_intents SET phase='superseded' WHERE id=900");
    await c.client!.execute({ sql: "INSERT INTO node_lifecycle_intents(service_id,server_id,runtime_id,deployment_id,action,request_id,phase,snapshot) VALUES (1,4,NULL,NULL,'stop',?,'fencing','{}')", args: ['c'.repeat(32)] });
    const row = (await c.client!.execute("SELECT id,runtime_id,deployment_id FROM node_lifecycle_intents WHERE phase='fencing'")).rows[0]!;
    expect(Number(row.id)).toBeGreaterThan(2000); expect(row.runtime_id).toBeNull(); expect(row.deployment_id).toBeNull();
    for (const [index, action, runtime, deployment] of [[1, 'start', null, null], [2, 'restart', null, null], [3, 'stop', 'web-9', null], [4, 'stop', null, 9]] as const) {
      await expect(c.client!.execute({ sql: "INSERT INTO node_lifecycle_intents(service_id,server_id,runtime_id,deployment_id,action,request_id,phase,snapshot) VALUES (1,4,?,?,?,?,'completed','{}')", args: [runtime, deployment, action, String(index).repeat(32)] })).rejects.toThrow(/CHECK/);
    }
    expect((await c.client!.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
    await c.client!.execute('DELETE FROM services WHERE id=1'); expect((await c.client!.execute('SELECT * FROM node_lifecycle_intents')).rows).toEqual([]);
  } finally { c.client!.close(); rmSync(scratch, { recursive: true, force: true }); }
});
