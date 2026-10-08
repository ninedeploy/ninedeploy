/**
 * Panel self-backup (0.12): the sealed `/system/export` archive on a schedule.
 *
 * Runs against a REAL migrated SQLite (the VACUUM INTO snapshot, the settings
 * rows and the audit rows are the real thing) and real `tar`; only the S3
 * client is replaced by an in-memory bucket. Nothing here reaches Docker,
 * pm2 or the network.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, backupDestinations, createDb, settings, users, type DB } from '@ninedeploy/db';
import { asUser, buildTestApp } from './helpers.js';

const hoisted = vi.hoisted(() => ({
  paths: { dataDir: '', dbFile: '', masterKeyFile: '', backupsDir: '' },
  bucket: new Map<string, Buffer>(),
  /** When set, s3PutFile waits for this promise (overlap tests). */
  putGate: null as Promise<void> | null,
  failPut: null as string | null,
  failDelete: null as string | null,
}));

vi.mock('../src/config.js', async (orig) => {
  const real = await orig<typeof import('../src/config.js')>();
  return { config: { ...real.config, paths: hoisted.paths } };
});

vi.mock('../src/lib/s3.js', async () => {
  const fs = await import('node:fs');
  return {
    s3PutFile: async (_cfg: unknown, key: string, file: string) => {
      if (hoisted.putGate) await hoisted.putGate;
      if (hoisted.failPut) throw new Error(hoisted.failPut);
      hoisted.bucket.set(key, fs.readFileSync(file));
    },
    s3GetToFile: async (_cfg: unknown, key: string, file: string) => {
      const body = hoisted.bucket.get(key);
      if (!body) throw new Error('S3 download failed (404)');
      fs.writeFileSync(file, body);
    },
    s3Delete: async (_cfg: unknown, key: string) => {
      if (hoisted.failDelete) throw new Error(hoisted.failDelete);
      hoisted.bucket.delete(key);
    },
    s3List: async (_cfg: unknown, prefix: string) =>
      [...hoisted.bucket.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, body]) => ({ key, sizeBytes: body.length, lastModified: '2026-10-08T00:00:00.000Z' })),
  };
});

const { encrypt } = await import('../src/lib/crypto.js');
const lib = await import('../src/lib/panelBackup.js');
const { panelBackupRoutes } = await import('../src/modules/panelBackup.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const PASS = 'correct horse battery staple';
const PREFIX = 'nd/panel-backups/';

let root: string;
let db: DB;
let closeDb: () => void = () => undefined;

const originalCwd = process.cwd();

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'nd-panel-backup-'));
  // The archive carries the process cwd's `.env` and an import REPLACES it:
  // run from a scratch cwd so the repository's own .env is never read or moved.
  const cwd = path.join(root, 'cwd');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(path.join(cwd, '.env'), 'PANEL_ENV=from-backup');
  process.chdir(cwd);
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  Object.assign(hoisted.paths, {
    dataDir,
    // The archived/imported database file. The live connection below uses its
    // own file: the import renames this one, which Windows refuses for an open
    // file. VACUUM INTO still snapshots the LIVE connection.
    dbFile: path.join(dataDir, 'ninedeploy.db'),
    masterKeyFile: path.join(dataDir, 'master.key'),
    backupsDir: path.join(dataDir, 'backups'),
  });
  const created = createDb({ url: `file:${path.join(root, 'live.db').split(path.sep).join('/')}` });
  closeDb = () => created.client?.close();
  await migrate(created.db, { migrationsFolder: MIGRATIONS });
  db = created.db as DB;
  // The operator the routes act as (audit_log.user_id references users).
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'x' });
});

afterAll(() => {
  process.chdir(originalCwd);
  closeDb();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows file lock */ }
});

beforeEach(async () => {
  hoisted.bucket.clear();
  hoisted.putGate = null;
  hoisted.failPut = null;
  hoisted.failDelete = null;
  writeFileSync(hoisted.paths.dbFile, 'placeholder-db');
  await db.delete(settings);
  await db.delete(backupDestinations);
  await db.delete(auditLog);
});

afterEach(async () => {
  // Never leave a background run behind for the next case.
  for (let i = 0; i < 400 && lib.panelBackupBusy(); i++) await new Promise((r) => setTimeout(r, 10));
});

async function app() {
  const a = await buildTestApp({ db });
  await a.register(panelBackupRoutes);
  return a;
}

async function destination(): Promise<number> {
  const [row] = await db
    .insert(backupDestinations)
    .values({ name: 'minio', endpoint: 'https://s3.example.com', region: 'us-east-1', bucket: 'b', prefix: 'nd', accessKeyId: 'ak', secretKeyEncrypted: encrypt('sk'), active: true })
    .returning();
  return row!.id;
}

async function enable(retain = 7): Promise<number> {
  const id = await destination();
  const a = await app();
  const res = await a.inject({ method: 'PUT', url: '/', headers: asUser(), payload: { enabled: true, destinationId: id, retain, passphrase: PASS } });
  expect(res.statusCode).toBe(200);
  return id;
}

async function audits(action: string) {
  // audit() is fire-and-forget; give its insert a turn.
  for (let i = 0; i < 50; i++) {
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, action));
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
  return [];
}

async function waitIdle() {
  for (let i = 0; i < 1000 && lib.panelBackupBusy(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(lib.panelBackupBusy()).toBe(false);
}

function tarList(file: string): string[] {
  const out = spawnSync('tar', ['-tzf', path.basename(file)], { cwd: path.dirname(file), encoding: 'utf8' });
  expect(out.status).toBe(0);
  return out.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

describe('NDPB1 passphrase envelope', () => {
  const plain = () => {
    const f = path.join(root, `plain-${Math.random()}.bin`);
    writeFileSync(f, Buffer.from('database + master key + .env '.repeat(5000)));
    return f;
  };

  it('round-trips under the right passphrase', async () => {
    const src = plain();
    await lib.encryptPanelBackupFile(src, `${src}.ndpb`, PASS);
    expect(readFileSync(`${src}.ndpb`).subarray(0, 13).toString()).toBe('NDPB1:scrypt:');
    expect(readFileSync(`${src}.ndpb`).includes(Buffer.from('master key'))).toBe(false);
    await lib.decryptPanelBackupFile(`${src}.ndpb`, `${src}.out`, PASS);
    expect(readFileSync(`${src}.out`).equals(readFileSync(src))).toBe(true);
  });

  it('a wrong passphrase leaves no plaintext behind', async () => {
    const src = plain();
    await lib.encryptPanelBackupFile(src, `${src}.ndpb`, PASS);
    await expect(lib.decryptPanelBackupFile(`${src}.ndpb`, `${src}.out`, 'not the passphrase')).rejects.toThrow(lib.PANEL_BACKUP_DECRYPT_ERROR);
    expect(existsSync(`${src}.out`)).toBe(false);
  });

  it('authenticates the header: changed KDF parameters fail like a wrong passphrase', async () => {
    const src = plain();
    await lib.encryptPanelBackupFile(src, `${src}.ndpb`, PASS);
    const sealed = readFileSync(`${src}.ndpb`);
    // Same-length edit: r 8 → 9 is still a valid parameter set.
    writeFileSync(`${src}.ndpb`, Buffer.from(sealed.toString('latin1').replace(':32768:8:1:', ':32768:9:1:'), 'latin1'));
    await expect(lib.decryptPanelBackupFile(`${src}.ndpb`, `${src}.out`, PASS)).rejects.toThrow(lib.PANEL_BACKUP_DECRYPT_ERROR);
    expect(existsSync(`${src}.out`)).toBe(false);
  });

  it('refuses a crafted header that would burn memory on the KDF, and non-backups', async () => {
    const crafted = path.join(root, 'crafted.ndpb');
    writeFileSync(crafted, Buffer.concat([Buffer.from(`NDPB1:scrypt:${2 ** 30}:8:1:${Buffer.alloc(16).toString('base64')}:${Buffer.alloc(12).toString('base64')}\n`), Buffer.alloc(64)]));
    await expect(lib.decryptPanelBackupFile(crafted, `${crafted}.out`, PASS)).rejects.toThrow(/Unsupported/);
    const other = path.join(root, 'other.bin');
    writeFileSync(other, 'NDBK1:v0:abc\nxxxxxxxxxxxxxxxxxxxxxxx');
    await expect(lib.decryptPanelBackupFile(other, `${other}.out`, PASS)).rejects.toThrow(/Not a NineDeploy panel backup/);
  });
});

describe('upgrade safety', () => {
  it('an install with no panel_backup row reports disabled defaults and writes nothing', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      settings: { enabled: false, cron: '0 3 * * *', destinationId: null, retain: 7, hasPassphrase: false },
      running: false,
      lastRun: null,
      lastSuccessAt: null,
      nextRunAt: null,
    });
    expect(await db.select().from(settings)).toEqual([]);
  });

  it('members are refused', async () => {
    const a = await app();
    for (const [method, url] of [['GET', '/'], ['PUT', '/'], ['POST', '/run'], ['GET', '/remote'], ['POST', '/restore']] as const) {
      const res = await a.inject({ method, url, headers: { 'x-test-user': '2', 'x-test-role': 'member' }, payload: method === 'GET' ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});

describe('settings', () => {
  it('validates cron, destination and passphrase before enabling', async () => {
    const a = await app();
    const put = (payload: Record<string, unknown>) => a.inject({ method: 'PUT', url: '/', headers: asUser(), payload });
    expect((await put({ cron: '* * * * * *' })).json().error.message).toMatch(/Invalid cron/);
    expect((await put({ enabled: true })).json().error.message).toMatch(/destination/);
    expect((await put({ destinationId: 999 })).json().error.message).toMatch(/does not exist/);
    const id = await destination();
    expect((await put({ enabled: true, destinationId: id })).json().error.message).toMatch(/recovery passphrase/);
    expect((await put({ passphrase: 'short' })).statusCode).toBe(400);
    expect(await db.select().from(settings)).toEqual([]);
  });

  it('stores the passphrase sealed, never returns it, and audits without it', async () => {
    const id = await enable(3);
    const res = await (await app()).inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.json().settings).toEqual({ enabled: true, cron: '0 3 * * *', destinationId: id, retain: 3, hasPassphrase: true });
    expect(res.json().nextRunAt).toEqual(expect.any(String));
    expect(res.body).not.toContain(PASS);
    const row = (await db.select().from(settings)).find((r) => r.key === 'panel_backup_passphrase_encrypted');
    expect(typeof row?.value).toBe('string');
    expect(String(row!.value)).not.toContain(PASS);
    const [entry] = await audits('backup.panel.settings');
    expect(JSON.stringify(entry)).not.toContain(PASS);
    expect(entry!.meta).toMatchObject({ enabled: true, passphraseChanged: true });
    // Omitted passphrase = keep it.
    const again = await (await app()).inject({ method: 'PUT', url: '/', headers: asUser(), payload: { retain: 5 } });
    expect(again.json().settings).toMatchObject({ retain: 5, hasPassphrase: true });
  });
});

describe('runs', () => {
  it('Back up now uploads a sealed /system/export archive and leaves no plaintext behind', async () => {
    await enable();
    const res = await (await app()).inject({ method: 'POST', url: '/run', headers: asUser() });
    expect(res.statusCode).toBe(202);
    await waitIdle();
    const keys = [...hoisted.bucket.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^nd\/panel-backups\/ninedeploy-panel-\d{8}T\d{6}Z-[0-9a-f]{6}\.ndpb$/);

    const sealed = path.join(root, 'fetched.ndpb');
    writeFileSync(sealed, hoisted.bucket.get(keys[0]!)!);
    const opened = path.join(root, 'opened.tar.gz');
    await lib.decryptPanelBackupFile(sealed, opened, PASS);
    const members = tarList(opened);
    // The CLI's offline reader (`ninedeploy system panel-backup decrypt`) opens
    // the very same server-written object byte for byte.
    const { decryptPanelBackup } = await import('../../cli/src/lib/panelBackupFile.js');
    await decryptPanelBackup(sealed, `${opened}.cli`, PASS);
    expect(readFileSync(`${opened}.cli`).equals(readFileSync(opened))).toBe(true);
    expect(members.some((m) => /^_db-.*\.db$/.test(m))).toBe(true);
    expect(members).toContain('master.key');
    const metaName = members.find((m) => m.startsWith('_meta-'))!;
    const x = path.join(root, 'x');
    mkdirSync(x, { recursive: true });
    spawnSync('tar', ['-xzf', path.relative(x, opened).split(path.sep).join('/'), metaName], { cwd: x });
    expect(JSON.parse(readFileSync(path.join(x, metaName), 'utf8'))).toMatchObject({ kind: 'panel-backup', masterKeyFromEnv: false });

    const status = (await (await app()).inject({ method: 'GET', url: '/', headers: asUser() })).json();
    expect(status.lastRun).toMatchObject({ status: 'completed', trigger: 'manual', key: keys[0], error: null });
    expect(status.lastSuccessAt).toEqual(status.lastRun.finishedAt);
    const [done] = await audits('backup.panel.completed');
    expect(done!.userId).toBe(1);
    // No plaintext archive, snapshot or sealed copy outlives the run.
    expect(readdirSync(hoisted.paths.dataDir).filter((f) => /^(ninedeploy-backup-|_db-|_meta-|_env-)/.test(f))).toEqual([]);
    expect(readdirSync(path.join(hoisted.paths.dataDir, '_panel-backup'))).toEqual([]);
  });

  it('a run never overlaps another: the API answers 409, the scheduler path skips and audits it', async () => {
    await enable();
    let release!: () => void;
    hoisted.putGate = new Promise<void>((r) => (release = r));
    const a = await app();
    expect((await a.inject({ method: 'POST', url: '/run', headers: asUser() })).statusCode).toBe(202);
    for (let i = 0; i < 500 && !(await a.inject({ method: 'GET', url: '/', headers: asUser() })).json().running; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await a.inject({ method: 'POST', url: '/run', headers: asUser() })).statusCode).toBe(409);
    expect(await lib.runPanelBackup(db, { trigger: 'schedule', actorUserId: null })).toMatchObject({ status: 'skipped' });
    expect(await audits('backup.panel.skipped')).toHaveLength(1);
    release();
    await waitIdle();
    expect(hoisted.bucket.size).toBe(1);
  });

  it('retention keeps the newest N (the new one always), and never touches foreign objects', async () => {
    await enable(2);
    const old = ['20260101T030000Z-aaaaaa', '20260102T030000Z-bbbbbb', '20260103T030000Z-cccccc'].map((s) => `${PREFIX}ninedeploy-panel-${s}.ndpb`);
    for (const k of old) hoisted.bucket.set(k, Buffer.from('old'));
    hoisted.bucket.set(`${PREFIX}notes.txt`, Buffer.from('mine'));
    hoisted.bucket.set('nd/postgres-1.dump', Buffer.from('db dump'));
    const result = await lib.runPanelBackup(db, { trigger: 'manual', actorUserId: 1 });
    expect(result).toMatchObject({ status: 'completed', pruned: 2 });
    const left = [...hoisted.bucket.keys()].sort();
    expect(left).toContain(old[2]);
    expect(left).not.toContain(old[0]);
    expect(left).not.toContain(old[1]);
    expect(left).toContain(`${PREFIX}notes.txt`);
    expect(left).toContain('nd/postgres-1.dump');
    expect(left.filter((k) => k.endsWith('.ndpb'))).toHaveLength(2);
  });

  it('a retention failure does not fail the run: the new backup is kept and the warning recorded', async () => {
    await enable(1);
    hoisted.bucket.set(`${PREFIX}ninedeploy-panel-20260101T030000Z-aaaaaa.ndpb`, Buffer.from('old'));
    hoisted.failDelete = 'S3 delete failed (503)';
    const result = await lib.runPanelBackup(db, { trigger: 'manual', actorUserId: 1 });
    expect(result).toMatchObject({ status: 'completed', pruned: 0 });
    expect((result as { warning: string }).warning).toMatch(/503/);
    expect(hoisted.bucket.size).toBe(2);
  });

  it('a failed upload is recorded, audited for the notification fan-out, and prunes nothing', async () => {
    await enable(1);
    const existing = `${PREFIX}ninedeploy-panel-20260101T030000Z-aaaaaa.ndpb`;
    hoisted.bucket.set(existing, Buffer.from('last good'));
    hoisted.failPut = 'S3 upload failed (403): AccessDenied';
    const result = await lib.runPanelBackup(db, { trigger: 'schedule', actorUserId: null });
    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('AccessDenied') });
    expect([...hoisted.bucket.keys()]).toEqual([existing]);
    const [failed] = await audits('backup.panel.failed');
    expect(failed!.entity).toContain('AccessDenied');
    expect(failed!.userId).toBeNull();
    const status = await lib.getPanelBackupStatus(db);
    expect(status.lastRun).toMatchObject({ status: 'failed', trigger: 'schedule' });
    expect(status.lastSuccessAt).toBeNull();
  });

  it('a run with no destination or passphrase fails loudly instead of silently doing nothing', async () => {
    const result = await lib.runPanelBackup(db, { trigger: 'schedule', actorUserId: null });
    expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(/No destination/) });
    expect(await audits('backup.panel.failed')).toHaveLength(1);
  });
});

describe('listing and restore', () => {
  it('lists panel backups newest first with size, ignoring foreign objects', async () => {
    const id = await enable();
    hoisted.bucket.set(`${PREFIX}ninedeploy-panel-20260101T030000Z-aaaaaa.ndpb`, Buffer.from('1'));
    hoisted.bucket.set(`${PREFIX}ninedeploy-panel-20260105T030000Z-bbbbbb.ndpb`, Buffer.from('12345'));
    hoisted.bucket.set(`${PREFIX}random.ndpb`, Buffer.from('x'));
    const res = await (await app()).inject({ method: 'GET', url: `/remote?destinationId=${id}`, headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      destinationId: id,
      items: [
        { key: `${PREFIX}ninedeploy-panel-20260105T030000Z-bbbbbb.ndpb`, name: 'ninedeploy-panel-20260105T030000Z-bbbbbb.ndpb', sizeBytes: 5, lastModified: expect.any(String) },
        { key: `${PREFIX}ninedeploy-panel-20260101T030000Z-aaaaaa.ndpb`, name: 'ninedeploy-panel-20260101T030000Z-aaaaaa.ndpb', sizeBytes: 1, lastModified: expect.any(String) },
      ],
    });
  });

  it('restore needs the typed file name and the right passphrase, then imports the archive', async () => {
    const id = await enable();
    const result = await lib.runPanelBackup(db, { trigger: 'manual', actorUserId: 1 });
    expect(result.status).toBe('completed');
    const key = (result as { key: string }).key;
    const name = key.slice(PREFIX.length);
    const a = await app();
    const restore = (payload: Record<string, unknown>) => a.inject({ method: 'POST', url: '/restore', headers: asUser(), payload });

    const unconfirmed = await restore({ destinationId: id, key, passphrase: PASS, confirm: 'yes' });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error.message).toContain(name);

    const wrong = await restore({ destinationId: id, key, passphrase: 'wrong passphrase!', confirm: name });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.message).toMatch(/passphrase is wrong/);
    expect(readFileSync(hoisted.paths.dbFile, 'utf8')).toBe('placeholder-db');
    expect(await audits('backup.panel.restore_failed')).toHaveLength(1);

    const foreign = await restore({ destinationId: id, key: 'elsewhere/ninedeploy-panel-20260101T030000Z-aaaaaa.ndpb', passphrase: PASS, confirm: 'ninedeploy-panel-20260101T030000Z-aaaaaa.ndpb' });
    expect(foreign.statusCode).toBe(400);

    writeFileSync(path.join(process.cwd(), '.env'), 'PANEL_ENV=changed-since');
    const ok = await restore({ destinationId: id, key, passphrase: PASS, confirm: name });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, meta: { kind: 'panel-backup' } });
    // The placeholder was replaced by the VACUUM INTO snapshot of the live database.
    expect(readFileSync(hoisted.paths.dbFile).subarray(0, 15).toString()).toBe('SQLite format 3');
    expect(readFileSync(path.join(process.cwd(), '.env'), 'utf8')).toBe('PANEL_ENV=from-backup');
    expect(await audits('backup.panel.restore')).toHaveLength(1);
    expect(await audits('system.import')).toHaveLength(1);
    expect(readdirSync(path.join(hoisted.paths.dataDir, '_panel-backup'))).toEqual([]);
  });
});
