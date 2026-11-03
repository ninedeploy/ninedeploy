import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { expect, it } from 'vitest';
import { createDb } from '../src/index.js';

it('upgrades existing sleep and maintenance bindings from 121 without losing legacy routing identity', async () => {
  const folder = fileURLToPath(new URL('../src/migrations', import.meta.url)), scratch = mkdtempSync(join(tmpdir(), 'nd-0122-'));
  const c = createDb({ url: 'file::memory:' }); await c.ready;
  try {
    cpSync(folder, scratch, { recursive: true }); const journalPath = join(scratch, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    const at = journal.entries.findIndex(entry => entry.tag === '0122_node_wake_catcher_names'); expect(at).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, at); writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(c.db, { migrationsFolder: scratch });
    await c.client!.execute("INSERT INTO services(id,name,slug) VALUES (1,'web','web')");
    await c.client!.execute("INSERT INTO node_sleep_transitions(service_id,server_id,deployment_id,runtime_id,owner_epoch,request_id,action,phase,configuration,binding,watermark,wake_token,targets,idle_evidence,catcher_id,catcher_image) VALUES (1,4,9,'web-9',1,'request','sleep','asleep','config','binding',9,'token','[]','{}','old-id','old-image')");
    await c.client!.execute("INSERT INTO node_wake_maintenance(server_id,generation,request_id,binding,phase,snapshot,catcher_id,catcher_image) VALUES (4,1,'maintenance','binding','routing','[]','candidate-id','candidate-image')");
    await migrate(c.db, { migrationsFolder: folder });
    expect((await c.db.query.nodeSleepTransitions.findFirst())!).toMatchObject({ catcherId: 'old-id', catcherImage: 'old-image', catcherName: 'ninedeploy-wake' });
    expect((await c.db.query.nodeWakeMaintenance.findFirst())!).toMatchObject({ catcherId: 'candidate-id', phase: 'routing', catcherName: 'ninedeploy-wake' });
    const name = `ninedeploy-wake-g-${'a'.repeat(32)}`;
    await c.client!.execute({ sql: 'UPDATE node_sleep_transitions SET catcher_name=?', args: [name] });
    await c.client!.execute({ sql: 'UPDATE node_wake_maintenance SET catcher_name=?', args: [name] });
    await migrate(c.db, { migrationsFolder: folder });
    expect((await c.db.query.nodeSleepTransitions.findFirst())!.catcherName).toBe(name);
    expect((await c.db.query.nodeWakeMaintenance.findFirst())!.catcherName).toBe(name);
  } finally { c.client?.close(); rmSync(scratch, { recursive: true, force: true }); }
});
