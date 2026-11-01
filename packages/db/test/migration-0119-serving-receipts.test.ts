import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { expect, it } from 'vitest';
import { createDb } from '../src/index.js';

it('upgrades an existing deployment with replay-safe receipt constraints and cascading retirement', async () => {
  const migrations = fileURLToPath(new URL('../src/migrations', import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), 'nd-0119-'));
  const c = createDb({ url: ':memory:' }); await c.ready;
  try {
    cpSync(migrations, scratch, { recursive: true });
    const journalPath = join(scratch, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
    const at = journal.entries.findIndex(entry => entry.tag === '0119_node_serving_traffic_receipts');
    expect(at).toBeGreaterThan(0); journal.entries = journal.entries.slice(0, at);
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(c.db, { migrationsFolder: scratch });
    await c.client!.execute("INSERT INTO services (id, name, slug) VALUES (1, 'web', 'web')");
    await c.client!.execute("INSERT INTO deployments (id, service_id, status) VALUES (9, 1, 'running')");
    await migrate(c.db, { migrationsFolder: migrations }); await migrate(c.db, { migrationsFolder: migrations });
    expect((await c.client!.execute('SELECT runtime_id FROM services WHERE id=1')).rows).toHaveLength(1);
    const insert = `INSERT INTO node_serving_traffic_receipts (node_id,service_id,deployment_id,request_id,window_id,source_id,proxy_id,epoch,target_hash,routing_generation,start_counter,end_counter,requests,elapsed_ms,replicas,observed_at_ms,consumed_at_ms) VALUES (4,1,9,?,?, 'source','proxy','epoch','target','route','00000000000000000010','00000000000000000011',0,1000,1,1000,1000)`;
    await c.client!.execute({ sql: insert, args: ['request', 'window'] });
    await expect(c.client!.execute({ sql: insert, args: ['request', 'other-window'] })).rejects.toThrow(/UNIQUE/);
    await expect(c.client!.execute({ sql: insert, args: ['other-request', 'window'] })).rejects.toThrow(/UNIQUE/);
    const plan = await c.client!.execute("EXPLAIN QUERY PLAN SELECT end_counter FROM node_serving_traffic_receipts WHERE service_id=1 AND node_id=4 AND source_id='source' ORDER BY end_counter DESC LIMIT 1");
    expect(plan.rows.map(row => String(row.detail)).join(' ')).toMatch(/COVERING INDEX node_serving_traffic_source_idx/);
    await c.client!.execute('DELETE FROM deployments WHERE id=9');
    expect((await c.client!.execute('SELECT * FROM node_serving_traffic_receipts')).rows).toHaveLength(0);
  } finally { c.client?.close(); rmSync(scratch, { recursive: true, force: true }); }
});
