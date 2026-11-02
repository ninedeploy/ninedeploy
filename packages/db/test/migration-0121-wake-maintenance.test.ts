import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { expect, it } from 'vitest';
import { createDb } from '../src/index.js';

it('upgrades from 120 and retains a unique maintenance intent and precise lease after node deletion', async () => {
  const folder = fileURLToPath(new URL('../src/migrations', import.meta.url)), scratch = mkdtempSync(join(tmpdir(), 'nd-0121-'));
  const c = createDb({ url: 'file::memory:' }); await c.ready;
  try {
    cpSync(folder, scratch, { recursive: true }); const path = join(scratch, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: { tag: string }[] };
    const at = journal.entries.findIndex(entry => entry.tag === '0121_node_wake_maintenance'); expect(at).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, at); writeFileSync(path, JSON.stringify(journal));
    await migrate(c.db, { migrationsFolder: scratch });
    await c.client!.execute("INSERT INTO servers(id,name,host,token_encrypted) VALUES (4,'node','node.test','fixture')");
    await c.client!.execute("INSERT INTO services(id,name,slug) VALUES (1,'web','web')");
    await migrate(c.db, { migrationsFolder: folder });
    const insert = "INSERT INTO node_wake_maintenance(server_id,generation,request_id,binding,phase,snapshot,worker_token,lease_until) VALUES (?,1,?,'binding','preparing','[]','worker',12345)";
    await c.client!.execute({ sql: insert, args: [4, 'request'] });
    expect((await c.db.query.nodeWakeMaintenance.findFirst())!.leaseUntil!.getTime()).toBe(12345);
    await expect(c.client!.execute({ sql: insert, args: [5, 'request'] })).rejects.toThrow(/UNIQUE/);
    await c.client!.execute('DELETE FROM servers WHERE id=4');
    await migrate(c.db, { migrationsFolder: folder });
    expect((await c.client!.execute('SELECT server_id,generation,phase FROM node_wake_maintenance')).rows).toEqual([{ server_id: 4, generation: 1, phase: 'preparing' }]);
    expect((await c.client!.execute('SELECT slug FROM services')).rows).toEqual([{ slug: 'web' }]);
  } finally { c.client?.close(); rmSync(scratch, { recursive: true, force: true }); }
});
