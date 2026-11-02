import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { expect, it } from 'vitest';
import { createDb } from '../src/index.js';

it('upgrades an existing runtime owner, retains sleep journals across deployment pruning and enforces unique request/token identity', async () => {
  const folder = fileURLToPath(new URL('../src/migrations', import.meta.url)), scratch = mkdtempSync(join(tmpdir(), 'nd-0120-'));
  const c = createDb({ url: 'file::memory:' }); await c.ready;
  try {
    cpSync(folder, scratch, { recursive: true }); const journalPath = join(scratch, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
    const at = journal.entries.findIndex(entry => entry.tag === '0120_node_sleep_transitions'); expect(at).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, at); writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(c.db, { migrationsFolder: scratch });
    await c.client!.execute("INSERT INTO services (id,name,slug) VALUES (1,'web','web'),(2,'other','other')");
    await c.client!.execute("INSERT INTO deployments (id,service_id,status) VALUES (9,1,'running')");
    await c.client!.execute({ sql: "INSERT INTO service_runtime_owners (service_id,epoch,request_id,kind) VALUES (1,7,?,'deploy')", args: ['1'.repeat(32)] });
    await migrate(c.db, { migrationsFolder: folder }); await migrate(c.db, { migrationsFolder: folder });
    expect((await c.client!.execute('SELECT epoch,request_id,kind FROM service_runtime_owners')).rows).toEqual([{ epoch: 7, request_id: '1'.repeat(32), kind: 'deploy' }]);
    const insert = "INSERT INTO node_sleep_transitions (service_id,server_id,deployment_id,runtime_id,owner_epoch,request_id,action,phase,configuration,binding,watermark,wake_token,targets,idle_evidence,lease_until) VALUES (?,4,9,'web-9',8,?,'sleep','accepted','hash','binding',9,?,'[]','{}',12345)";
    await c.client!.execute({ sql: insert, args: [1, 'request', 'wake'] });
    expect((await c.db.query.nodeSleepTransitions.findFirst())!.leaseUntil!.getTime()).toBe(12345);
    await expect(c.client!.execute({ sql: insert, args: [2, 'request', 'other-wake'] })).rejects.toThrow(/UNIQUE/);
    await expect(c.client!.execute({ sql: insert, args: [2, 'other-request', 'wake'] })).rejects.toThrow(/UNIQUE/);
    await c.client!.execute('DELETE FROM deployments WHERE id=9');
    expect((await c.client!.execute('SELECT deployment_id FROM node_sleep_transitions')).rows).toEqual([{ deployment_id: 9 }]);
    await c.client!.execute('DELETE FROM services WHERE id=1');
    expect((await c.client!.execute('SELECT * FROM node_sleep_transitions')).rows).toHaveLength(0);
  } finally { c.client?.close(); rmSync(scratch, { recursive: true, force: true }); }
});
