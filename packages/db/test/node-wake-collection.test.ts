import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('reopens standalone catcher retirement targets without invented service authority or a schema migration', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'nd-wake-collection-')), url = `file:${join(folder, 'panel.db')}`;
  if (dirname(resolve(folder)) !== resolve(tmpdir())) throw new Error('Refuse cleanup outside the owned temporary directory');
  const snapshot = [{ catcherId: 'a'.repeat(64), catcherName: `ninedeploy-wake-g-${'b'.repeat(32)}`, retirementOnly: true as const }];
  const run = (write: boolean) => JSON.parse(execFileSync(process.execPath, ['--max-old-space-size=256', '--input-type=module', '-e', `
    import { createClient } from '@libsql/client';
    import { drizzle } from 'drizzle-orm/libsql';
    import { migrate } from 'drizzle-orm/libsql/migrator';
    const client = createClient({ url: ${JSON.stringify(url)} });
    try {
      await migrate(drizzle(client), { migrationsFolder: ${JSON.stringify(fileURLToPath(new URL('../src/migrations', import.meta.url)))} });
      const count = (await client.execute('SELECT count(*) AS count FROM __drizzle_migrations')).rows;
      if (${write}) await client.execute({ sql: "INSERT INTO node_wake_maintenance(server_id,generation,request_id,binding,phase,snapshot) VALUES(4,1,?,?,'collecting',?)",
        args: [${JSON.stringify('c'.repeat(32))}, ${JSON.stringify('d'.repeat(64))}, ${JSON.stringify(JSON.stringify(snapshot))}] });
      const row = (await client.execute('SELECT phase,snapshot,catcher_id,worker_token FROM node_wake_maintenance')).rows[0];
      console.log(JSON.stringify({ count, row: { ...row, snapshot: JSON.parse(row.snapshot) } }));
    } finally { client.close(); }
  `], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 20_000, windowsHide: true }));
  try {
    const before = run(true), reopened = run(false);
    expect(reopened.row).toEqual({ phase: 'collecting', snapshot, catcher_id: null, worker_token: null });
    expect(reopened.count).toEqual(before.count);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
