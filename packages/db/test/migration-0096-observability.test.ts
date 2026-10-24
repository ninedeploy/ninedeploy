import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../src/index.js';

describe('observability upgrade from migration 0095', () => {
  it('preserves existing data and supports queue/history writes with foreign-key cleanup', async () => {
    const source = fileURLToPath(new URL('../src/migrations', import.meta.url));
    const scratch = mkdtempSync(join(tmpdir(), 'nd-observability-migration-'));
    const target = resolve(scratch), root = resolve(tmpdir());
    if (!target.startsWith(root + (process.platform === 'win32' ? '\\' : '/')) || !target.includes('nd-observability-migration-')) throw new Error('Unexpected migration scratch path');
    const before = join(scratch, 'migrations');
    const connection = createDb({ url: 'file::memory:' });
    try {
      await connection.ready;
      cpSync(source, before, { recursive: true });
      const journalPath = join(before, 'meta/_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
      const boundary = journal.entries.findIndex((entry) => entry.tag === '0096_observability_delivery');
      expect(boundary).toBeGreaterThan(0);
      journal.entries = journal.entries.slice(0, boundary);
      writeFileSync(journalPath, JSON.stringify(journal));
      await runMigrations(connection.db, before);
      const client = connection.client!;
      await client.execute("INSERT INTO services(id,name,slug) VALUES (7,'Existing app','existing')");
      await client.execute("INSERT INTO metrics(service_id,kind,value,ts) VALUES (7,'cpu',1250,1792681200)");
      await client.execute("INSERT INTO log_drains(id,name,url) VALUES (3,'Existing receiver','https://logs.example/ingest')");
      await client.execute("INSERT INTO config_entries(key,value,is_secret) VALUES ('existing.secret','v1:opaque-preserved',1)");
      const tables = (await client.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows;
      expect(tables.some((row) => row.name === 'log_drain_batches')).toBe(false);

      await runMigrations(connection.db, source);
      await runMigrations(connection.db, source);
      expect((await client.execute('SELECT name,slug FROM services WHERE id=7')).rows).toEqual([{ name: 'Existing app', slug: 'existing' }]);
      expect((await client.execute('SELECT value,ts FROM metrics WHERE service_id=7')).rows).toEqual([{ value: 1250, ts: 1792681200 }]);
      expect((await client.execute("SELECT value,is_secret FROM config_entries WHERE key='existing.secret'")).rows).toEqual([{ value: 'v1:opaque-preserved', is_secret: 1 }]);
      expect((await client.execute('SELECT * FROM log_drain_batches')).rows).toEqual([]);
      expect((await client.execute("SELECT * FROM config_entries WHERE key='observability.settings'")).rows).toEqual([]);
      await client.execute("INSERT INTO metric_rollups(service_id,kind,bucket_seconds,ts,sum,samples,min,max) VALUES (7,'cpu',300,1792681200,1250,1,1250,1250)");
      await client.execute("INSERT INTO log_drain_cursors(drain_id,service_id,runtime_key,binding,last_timestamp,updated_at) VALUES (3,7,'panel:web','binding','2026-10-22T15:00:00Z',1792681200)");
      await client.execute("INSERT INTO log_drain_batches(drain_id,service_id,runtime_key,binding,payload_encrypted,entry_count,payload_bytes,next_attempt_at,created_at) VALUES (3,7,'panel:web','binding','v1:opaque',1,64,1792681200,1792681200)");
      await client.execute('DELETE FROM services WHERE id=7');
      for (const table of ['metric_rollups', 'log_drain_cursors', 'log_drain_batches']) expect((await client.execute('SELECT * FROM ' + table)).rows).toEqual([]);
      expect((await client.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
    } finally {
      connection.client!.close();
      rmSync(target, { recursive: true, force: true });
    }
  });
});
