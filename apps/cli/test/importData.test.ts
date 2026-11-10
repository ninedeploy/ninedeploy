import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportReceipt } from '../src/commands/importApply.js';
import { CUTOVER_ORDER, type DataClient, dumpCommand, importData, importDataAction, renderDataPreview } from '../src/commands/importData.js';
import type { ImportPlan, PlanDatabase } from '../src/lib/importers/plan.js';

const PANEL = 'https://panel.example';
const SHA = 'a'.repeat(64);
const db = (over: Partial<PlanDatabase>): PlanDatabase => ({ ref: 'pg', name: 'pg', engine: 'postgres', image: 'postgres:16', runtime: { kind: 'swarm-service', name: 'srv-captain--pg' }, issues: [], ...over });

function plan(databases: PlanDatabase[], kind: ImportPlan['source']['kind'] = 'caprover'): ImportPlan {
  return { planVersion: 1, source: { kind, url: 'http://src.example', version: null, scope: '' }, generatedAt: '', services: [], databases, notes: [] };
}
function receipt(items: ImportReceipt['items'] = {}, kind = 'caprover'): ImportReceipt {
  return { receiptVersion: 1, panel: PANEL, source: { kind, url: 'http://src.example' }, items };
}
const created = (ref: string, id: number) => ({ [`database:${ref}`]: { kind: 'database' as const, ref, name: ref, state: 'done' as const, id, at: 't', notes: [] } });

/** A panel whose import upload calls onCreated, then finishes with `status`. */
function fakePanel(status: string = 'completed') {
  const calls: Array<{ id: number; opts: Record<string, unknown> }> = [];
  const client: DataClient = {
    databases: {
      importFile: vi.fn(async (id, _data, opts) => {
        calls.push({ id, opts: opts as Record<string, unknown> });
        const row = { id: opts?.resumeImportId ?? 900 + calls.length, status: 'pending' } as never;
        if (opts?.resumeImportId === undefined) opts?.onCreated?.(row);
        return row;
      }),
      imports: {
        get: vi.fn(async (_id, importId) => ({ id: importId, status: 'uploading' }) as never),
        wait: vi.fn(async (_id, importId) => ({ id: importId, status }) as never),
      },
    },
    volumeImports: {
      importFile: vi.fn(async () => ({ id: 77, status: 'running' }) as never),
      get: vi.fn(async () => ({ id: 77, status: 'running' }) as never),
      wait: vi.fn(async () => ({ id: 77, status: 'completed', volumeName: 'nd-svc-x-data', safetyBackupId: null }) as never),
    },
  };
  return { client, calls };
}
const deps = (client: DataClient, r: ImportReceipt, hash = { sha256: SHA, bytes: 1234 }) => ({
  client, receipt: r, save: vi.fn(), hashFile: vi.fn(async () => hash),
  open: () => async function* () { yield new Uint8Array([1]); }, now: () => new Date('2026-11-10T00:00:00Z'),
});

describe('dump commands', () => {
  it('reads the credentials inside the container, never on the command line, per engine', () => {
    expect(dumpCommand(db({}))).toEqual({
      command: `docker exec $(docker ps -q --filter label=com.docker.swarm.service.name=srv-captain--pg | head -n 1) sh -c 'pg_dump -Fc -U "\${POSTGRES_USER:-postgres}" "\${POSTGRES_DB:-\${POSTGRES_USER:-postgres}}"' > pg.dump`,
      file: 'pg.dump', notes: [],
    });
    expect(dumpCommand(db({ engine: 'mysql', name: 'm', runtime: { kind: 'container', name: 'abc123' } }))!.command)
      .toBe(`docker exec abc123 sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers "$MYSQL_DATABASE"' > m.sql`);
    expect(dumpCommand(db({ engine: 'mariadb', runtime: undefined }))!).toMatchObject({ file: 'pg.sql', notes: [expect.stringMatching(/Replace <container>/), expect.stringMatching(/MARIADB_DATABASE/)] });
    expect(dumpCommand(db({ engine: 'mariadb', runtime: undefined }))!.command).toMatch(/^docker exec <container> sh -c 'exec mariadb-dump /);
    // --databases would write CREATE DATABASE/USE, and the panel restores into `app` as the file says.
    for (const engine of ['mysql', 'mariadb'] as const) expect(dumpCommand(db({ engine }))!.command).not.toContain('--databases');
    expect(dumpCommand(db({ engine: 'mongo' }))!.command).toMatch(/'exec mongodump --archive --gzip -u "\$MONGO_INITDB_ROOT_USERNAME" -p "\$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin' > pg\.archive\.gz$/);
    const redis = dumpCommand(db({ engine: 'redis' }))!;
    expect(redis.command).toMatch(/^docker exec -e REDISCLI_AUTH \$\(docker ps .*\) sh -c 'redis-cli --rdb \/tmp\/nd-dump\.rdb >\/dev\/null && cat \/tmp\/nd-dump\.rdb && rm -f \/tmp\/nd-dump\.rdb' > pg\.rdb$/);
    expect(redis.notes[0]).toMatch(/read -rs REDISCLI_AUTH/);
    expect(dumpCommand(db({ engine: 'keydb' }))!.command).toContain("sh -c 'keydb-cli --rdb");
    expect(dumpCommand(db({ engine: 'dragonfly' }))!.notes[1]).toMatch(/Dragonfly images do not always ship redis-cli/);
    expect(dumpCommand(db({ engine: 'clickhouse' }))).toBeNull();
    expect(dumpCommand(db({ engine: null }))).toBeNull();
    for (const engine of ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'] as const) {
      expect(dumpCommand(db({ engine }))!.command).not.toMatch(/PASSWORD=|S3NT1N3L/);
    }
  });

  it('previews the cutover order and each database\'s state', () => {
    const p = plan([
      db({}), db({ ref: 'done', name: 'done' }), db({ ref: 'new', name: 'new' }), db({ ref: 'ch', name: 'ch', engine: 'clickhouse' }),
    ], 'coolify');
    const r = receipt({
      ...created('pg', 1), ...created('done', 2), ...created('ch', 4),
      'data:done': { kind: 'data', ref: 'done', name: 'done', state: 'done', id: 2, importId: 77, sha256: SHA, bytes: 1, at: 't', notes: [] },
    }, 'coolify');
    const out = renderDataPreview(p, r);
    expect(out.startsWith(`Order:\n  1. ${CUTOVER_ORDER[0]}`)).toBe(true);
    expect(out).toContain('  + pg (postgres, NineDeploy database #1):');
    expect(out).toContain('      then: --dump pg=pg.dump');
    expect(out).toContain('  ✓ done: imported (#77, sha256 aaaaaaaaaaaa…)');
    expect(out).toContain('  – new: not created yet (run import apply first)');
    expect(out).toContain('  – ch: the panel has no dump import for clickhouse; move its data by hand');
    expect(out).toContain('The coolify commands follow its source code and have not been run against a live instance yet.');
    expect(renderDataPreview(plan([db({})]), receipt(created('pg', 1)))).not.toContain('have not been run against a live instance');
    expect(renderDataPreview(plan([db({ engine: null })]), receipt(created('pg', 1)))).toContain('no dump import for this engine');
  });
});

describe('import data', () => {
  it('uploads with the sha256 declared, waits, and records id, hash and size', async () => {
    const { client, calls } = fakePanel();
    const r = receipt(created('pg', 5));
    const d = deps(client, r);
    await importData(plan([db({})]), { pg: '/x/pg.dump' }, d);
    expect(calls).toEqual([{ id: 5, opts: expect.objectContaining({ sizeBytes: 1234, sha256: SHA, filename: 'pg.dump', options: {} }) }]);
    expect(r.items['data:pg']).toEqual({ kind: 'data', ref: 'pg', name: 'pg', id: 5, sha256: SHA, bytes: 1234, state: 'done', importId: 901, at: '2026-11-10T00:00:00.000Z', notes: ['Imported: 1234 bytes, sha256 checked by the panel.'] });
    // pending (before the call), pending with the import id (onCreated), done.
    expect(d.save.mock.calls.length).toBe(3);
  });

  it('confirms the replace for an RDB engine, notes warnings, and reports a failed job without the panel\'s message', async () => {
    const warn = fakePanel('completed_with_warnings');
    const r1 = receipt(created('r', 6));
    await importData(plan([db({ ref: 'r', name: 'r', engine: 'redis' })]), { r: 'r.rdb' }, deps(warn.client, r1));
    expect(warn.calls[0]!.opts.options).toEqual({ confirmReplace: true });
    expect(r1.items['data:r']!.notes[0]).toBe('Imported with warnings: 1234 bytes, sha256 checked by the panel.');

    const bad = fakePanel('failed');
    const r2 = receipt(created('pg', 5));
    await importData(plan([db({})]), { pg: 'pg.dump' }, deps(bad.client, r2));
    expect(r2.items['data:pg']).toMatchObject({ state: 'failed', importId: 901, notes: ['Import #901 ended failed. Details: ninedeploy databases imports 5'] });
  });

  it('records an upload error, then resumes the same import on the next run', async () => {
    const { client, calls } = fakePanel();
    const importFile = client.databases.importFile;
    client.databases.importFile = vi.fn(async (_id, _data, opts) => {
      opts?.onCreated?.({ id: 950 } as never);
      throw new Error('fetch failed');
    });
    const r = receipt(created('pg', 5));
    await importData(plan([db({})]), { pg: 'pg.dump' }, deps(client, r));
    expect(r.items['data:pg']).toMatchObject({ state: 'failed', importId: 950, notes: ['fetch failed'] });

    // A caught upload failure must recover from its saved failed state too.
    client.databases.importFile = importFile;
    await importData(plan([db({})]), { pg: 'pg.dump' }, deps(client, r));
    expect(calls[0]!.opts).toMatchObject({ resumeImportId: 950 });
    expect(calls[0]!.opts.options).toBeUndefined();
    expect(r.items['data:pg']!.state).toBe('done');
  });

  it('never imports twice: the same file is skipped, a different one refused before any upload', async () => {
    const { client, calls } = fakePanel();
    const r = receipt({ ...created('pg', 5), 'data:pg': { kind: 'data', ref: 'pg', name: 'pg', state: 'done', id: 5, importId: 1, sha256: SHA, bytes: 1, at: 't', notes: [] } });
    await importData(plan([db({})]), { pg: 'pg.dump' }, deps(client, r));
    expect(calls).toEqual([]);
    await expect(importData(plan([db({})]), { pg: 'other.dump' }, deps(client, r, { sha256: 'b'.repeat(64), bytes: 9 })))
      .rejects.toThrow(/already has a dump imported \(sha256 aaaaaaaaaaaa…\), and this one differs\. .*ninedeploy databases import 5 --file/);
    expect(calls).toEqual([]);
  });

  it('checks every dump before uploading any', async () => {
    const { client, calls } = fakePanel();
    const p = plan([db({}), db({ ref: 'ch', name: 'ch', engine: 'clickhouse' }), db({ ref: 'later', name: 'later' })]);
    const r = receipt({ ...created('pg', 5), ...created('ch', 7) });
    await expect(importData(p, { pg: 'a', nope: 'b' }, deps(client, r))).rejects.toThrow('--dump names no database in the plan: nope.');
    await expect(importData(p, { pg: 'a', later: 'b' }, deps(client, r))).rejects.toThrow(/later has not been created yet: run `ninedeploy import apply` first/);
    await expect(importData(p, { ch: 'b' }, deps(client, r))).rejects.toThrow('The panel has no dump import for ch (clickhouse).');
    await expect(importData(p, { pg: 'a' }, deps(client, r, { sha256: SHA, bytes: 0 }))).rejects.toThrow('a is empty.');
    await expect(importData(p, { pg: 'a' }, deps(client, receipt(created('pg', 5), 'dokploy')))).rejects.toThrow(/receipt is for a plan of dokploy/);
    expect(calls).toEqual([]);
  });
});

describe('ninedeploy import data', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const setup = (r: ImportReceipt | null) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nd-data-'));
    dirs.push(dir);
    const planPath = path.join(dir, 'plan.json');
    writeFileSync(planPath, JSON.stringify(plan([db({})])));
    if (r) writeFileSync(path.join(dir, 'plan.receipt.json'), JSON.stringify(r));
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    return { dir, planPath, logs };
  };

  it('previews without --yes, then imports a real file with its real sha256', async () => {
    const { dir, planPath, logs } = setup(receipt(created('pg', 5)));
    const { client, calls } = fakePanel();
    await importDataAction(planPath, {}, { client, panel: `${PANEL}/` });
    expect(logs.join('\n')).toMatch(/Order:[\s\S]*\+ pg \(postgres, NineDeploy database #5\)/);
    expect(calls).toEqual([]);

    const dump = path.join(dir, 'pg.dump');
    writeFileSync(dump, 'PGDMP fake dump body');
    await importDataAction(planPath, { yes: true, dump: [`pg=${dump}`] }, { client, panel: PANEL });
    const sha = createHash('sha256').update('PGDMP fake dump body').digest('hex');
    expect(calls[0]!.opts).toMatchObject({ sha256: sha, sizeBytes: 20 });
    const saved = JSON.parse(readFileSync(path.join(dir, 'plan.receipt.json'), 'utf8')) as ImportReceipt;
    expect(saved.items['data:pg']).toMatchObject({ state: 'done', sha256: sha, importId: 901 });
    expect(logs.join('\n')).toMatch(/✓ data of pg: done/);
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses without a receipt, for another panel, and a malformed --dump; a failed import sets the exit code', async () => {
    const a = setup(null);
    await importDataAction(a.planPath, {}, { client: fakePanel().client, panel: PANEL });
    expect(a.logs.join('\n')).toMatch(/No receipt at .*plan\.receipt\.json: run `ninedeploy import apply/);
    expect(process.exitCode).toBe(1);

    const b = setup(receipt(created('pg', 5)));
    process.exitCode = undefined;
    await importDataAction(b.planPath, {}, { client: fakePanel().client, panel: 'https://other.example' });
    expect(b.logs.join('\n')).toMatch(/receipt is for https:\/\/panel\.example, but the CLI is signed in to https:\/\/other\.example/);
    for (const spec of ['pg', 'pg=', '=x']) {
      process.exitCode = undefined;
      await importDataAction(b.planPath, { yes: true, dump: [spec] }, { client: fakePanel().client, panel: PANEL });
      expect(b.logs.join('\n')).toMatch(/--dump takes <database>=<file>/);
      expect(process.exitCode).toBe(1);
    }
    const dump = path.join(b.dir, 'pg.dump');
    writeFileSync(dump, 'x');
    process.exitCode = undefined;
    await importDataAction(b.planPath, { yes: true, dump: [`pg=${dump}`] }, { client: fakePanel('failed').client, panel: PANEL });
    expect(b.logs.join('\n')).toMatch(/1 import\(s\) failed/);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await importDataAction(b.planPath, { yes: true, dump: [`pg=${b.dir}`] }, { client: fakePanel().client, panel: PANEL });
    expect(b.logs.join('\n')).toMatch(/is not a regular file/);
  });
});
