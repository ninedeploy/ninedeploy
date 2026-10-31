import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { expect, it } from 'vitest';
import { createDb } from '../src/index.js';

it('upgrades existing node preparation and capacity receipts without losing their identities', async () => {
  const migrations = fileURLToPath(new URL('../src/migrations', import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), 'nd-0116-'));
  const { db, client } = createDb({ url: ':memory:' });
  try {
    cpSync(migrations, scratch, { recursive: true });
    const journalPath = join(scratch, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
    const at = journal.entries.findIndex(entry => entry.tag === '0116_brainy_carmella_unuscione');
    expect(at).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, at);
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: scratch });
    await client!.execute("INSERT INTO services (id, name, slug) VALUES (1, 'web', 'web')");
    await client!.execute("INSERT INTO deployments (id, service_id, status) VALUES (9, 1, 'running')");
    await client!.execute("INSERT INTO node_autoscale_capacity (deployment_id, service_id, server_id, runtime_id, image_id, targets) VALUES (9, 1, 4, 'web-9', 'image', '[]')");
    await client!.execute("INSERT INTO node_deployment_preparations (deployment_id, service_id, server_id, epoch, request_id, runtime_id, image_id, serving, capacity) VALUES (9, 1, 4, 1, 'request', 'web-9', 'image', 1, 2)");
    await migrate(db, { migrationsFolder: migrations });
    for (const table of ['node_autoscale_capacity', 'node_deployment_preparations']) {
      const result = await client!.execute(`SELECT deployment_id, runtime_id, database_networks FROM ${table}`);
      expect(result.rows).toMatchObject([{ deployment_id: 9, runtime_id: 'web-9', database_networks: '[]' }]);
    }
  } finally { client?.close(); rmSync(scratch, { recursive: true, force: true }); }
});
