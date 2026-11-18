/** Real routes, migrated SQLite, file framing, encryption and SigV4; only Docker and HTTP are replaced. */
import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupDestinations, databases, settings, users, type Database, type DB } from '@ninedeploy/db';
import { migratedDb, closeMigratedDb } from './githubAppKit.js';

const h = vi.hoisted(() => ({ copies: new Map<string, Buffer>(), listing: '', calls: [] as string[][], corrupt: false, failPut: false, gate: null as Promise<void> | null, entered: null as (() => void) | null }));
vi.mock('../../src/lib/exec.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/exec.js')>('../../src/lib/exec.js');
  return { ...actual,
    capture: vi.fn(async (_cmd: string, args: string[]) => {
      h.calls.push(args);
      if (args[0] === 'volume') return '[{}]';
      if (args[0] === 'inspect') return 'exited';
      if (args.includes('-c') && args.some((s) => s.includes('stat -c "W %n %s %Y"'))) return h.listing;
      return '';
    }),
    run: vi.fn(async (_cmd: string, args: string[]) => {
      h.calls.push(args);
      if (args[0] === 'cp') {
        h.entered?.(); if (h.gate) await h.gate;
        const name = args[1]!.split('/nd-wal-archive/')[1]!;
        const data = h.copies.get(name); if (!data) throw new Error('missing archive file');
        await writeFile(args[2]!, data);
      }
    }),
  };
});
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

import { configureRemotePitr, drainRemotePitrCheckpoints, remotePitrStatus, runRemotePitrCheckpoint, remotePitrTick, remotePitrBusy } from '../../src/lib/pitrRemote.js';
import { pitrDeps, pitrMaintenance, setPitr, runPitrBaseBackup, withPitrArchiveRead } from '../../src/lib/pitr.js';
import { encrypt, decrypt } from '../../src/lib/crypto.js';
import { setSettingJson } from '../../src/lib/settings.js';
import { buildTestApp, asUser } from '../helpers.js';
import { pitrRoutes } from '../../src/modules/pitr.js';
import { audit } from '../../src/lib/audit.js';

let db: DB, d: Database, dest: number, actor: number;
const passphrase = 'operator-kept-off-host-passphrase';
const input = () => ({ enabled: true, destinationId: dest, intervalMinutes: 15, passphrase });
const objects = new Map<string, Buffer>();
const segment = '000000010000000000000003';
const label = 'nd-20261117T090000000Z';

beforeEach(async () => {
  vi.mocked(audit).mockClear();
  db = await migratedDb();
  actor = (await db.insert(users).values({ email: 'operator@example.test', passwordHash: 'x', isInstanceOperator: true }).returning())[0]!.id;
  d = (await db.insert(databases).values({ name: 'main', slug: 'main', engine: 'postgres', status: 'running', pitrEnabled: true, pitrBaseBackupAt: new Date(), containerName: 'nd-db-main', volumeName: 'nd-db-main-data', username: 'nine', dbName: 'app', passwordEncrypted: encrypt('source secret'), ownerUserId: actor }).returning())[0]!;
  dest = (await db.insert(backupDestinations).values({ name: 'Off-host', endpoint: 'https://store.example.test', bucket: 'archive', prefix: 'nine', accessKeyId: 'access', secretKeyEncrypted: encrypt('S3 secret') }).returning())[0]!.id;
  const wal = gzipSync(Buffer.alloc(16 * 1024 * 1024));
  const base = gzipSync(Buffer.from('base fixture'));
  h.copies = new Map([[`base/${label}/base.tar.gz`, base], [`base/${label}/backup_manifest`, Buffer.from('{"Files":[]}')], [`wal/${segment}.00000028.backup.gz`, gzipSync(Buffer.from('history'))], [`wal/${segment}.gz`, wal]]);
  h.listing = [`W wal/${segment}.gz ${wal.length} 1794906120`, `B base/${label}/base.tar.gz ${base.length} 1794906060`, `H wal/${segment}.00000028.backup.gz`, `| START WAL LOCATION: 0/3000028 (file ${segment})`, '| START TIME: 2026-11-17 09:00:00 UTC', `| LABEL: ${label}`, '| STOP TIME: 2026-11-17 09:01:00 UTC'].join('\n');
  h.calls = []; h.corrupt = false; h.failPut = false; h.gate = null; h.entered = null; objects.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, opts: RequestInit) => {
    const key = new URL(url).pathname;
    if (opts.method === 'PUT') {
      if (h.failPut) return new Response('unavailable', { status: 503 });
      objects.set(key, Buffer.from(opts.body as Uint8Array)); return new Response('');
    }
    const data = objects.get(key);
    return new Response(data ? new Uint8Array(h.corrupt ? Buffer.from('corrupt') : data) : null, { status: data ? 200 : 404 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); closeMigratedDb(db); });

describe('remote checkpoint lifecycle', () => {
  it('is opt-in, seals the passphrase, uploads ciphertext and reports success only after GET read-back', async () => {
    expect((await remotePitrStatus(db, d.id)).settings).toBeNull();
    await configureRemotePitr(db, d, input(), actor);
    expect(audit).toHaveBeenCalledWith(db, actor, 'database.pitr_remote_config', expect.stringContaining('enabled'));
    const secret = await db.query.settings.findFirst({ where: eq(settings.key, `pitr_remote_passphrase:${d.id}`) });
    expect(secret!.value).not.toBe(passphrase); expect(decrypt(secret!.value as string)).toBe(passphrase);
    const result = await runRemotePitrCheckpoint(db, d, () => undefined);
    expect(result.key).toMatch(/^nine\/pitr-checkpoints\/main\/.+\.ndpc$/);
    expect(objects.values().next().value!.subarray(0, 5).toString()).toBe('NDPB1');
    const status = await remotePitrStatus(db, d.id);
    expect(status.state).toMatchObject({ status: 'completed', error: null, lastSuccess: result });
    expect(JSON.stringify(status)).not.toContain(passphrase);
    expect(status.archiveLagSeconds).toBeTypeOf('number');
    expect(h.calls.some((a) => a[0] === 'create' && a.includes('none') && a.some((v) => v.endsWith(':ro')))).toBe(true);
    expect(h.calls.some((a) => a[0] === 'rm' && a[2]?.startsWith('nd-pitr-export-'))).toBe(true);
  });
  it.each(['PUT failure', 'corrupt read-back'])('keeps the last verified point after %s', async (fault) => {
    await configureRemotePitr(db, d, input(), actor);
    const before = await runRemotePitrCheckpoint(db, d, () => undefined);
    h.failPut = fault === 'PUT failure'; h.corrupt = fault === 'corrupt read-back';
    await expect(runRemotePitrCheckpoint(db, d, () => undefined)).rejects.toThrow();
    expect((await remotePitrStatus(db, d.id)).state).toMatchObject({ status: 'failed', lastSuccess: before });
    expect(remotePitrBusy(d.id)).toBe(false);
  });
  it('refuses missing WAL and records its name instead of publishing an incomplete point', async () => {
    await configureRemotePitr(db, d, input(), actor);
    h.listing += '\nW wal/000000010000000000000005.gz 100 1794906240';
    await expect(runRemotePitrCheckpoint(db, d, () => undefined)).rejects.toThrow(/Segment .* is missing/);
    expect(objects.size).toBe(0);
    expect((await remotePitrStatus(db, d.id)).state).toMatchObject({ status: 'failed', missingSegment: '000000010000000000000004', lastSuccess: null });
  });
  it('refuses a base backup with additional tablespaces instead of publishing only base.tar.gz', async () => {
    await configureRemotePitr(db, d, input(), actor);
    h.copies.set(`base/${label}/backup_manifest`, Buffer.from(JSON.stringify({
      'PostgreSQL-Backup-Manifest-Version': 2,
      Files: [{ Path: 'pg_tblspc/16384/PG_18_202506291/5/16385', Size: 8192 }],
    })));
    await expect(runRemotePitrCheckpoint(db, d, () => undefined)).rejects.toThrow(/tablespace/i);
    expect(objects.size).toBe(0);
  });
  it('refuses damaged compressed WAL without uploading', async () => {
    await configureRemotePitr(db, d, input(), actor); h.copies.set(`wal/${segment}.gz`, Buffer.from('damaged'));
    await expect(runRemotePitrCheckpoint(db, d, () => undefined)).rejects.toThrow(); expect(objects.size).toBe(0);
  });
  it('holds retention, disable, base backups and concurrent checkpoints while the snapshot is copied', async () => {
    await configureRemotePitr(db, d, input(), actor);
    let release!: () => void, entered!: () => void;
    h.gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; }); h.entered = entered;
    const pending = runRemotePitrCheckpoint(db, d, () => undefined);
    try {
      await ready;
      await expect(runRemotePitrCheckpoint(db, d, () => undefined)).rejects.toMatchObject({ statusCode: 409 });
      await expect(configureRemotePitr(db, d, { ...input(), enabled: false }, actor)).rejects.toMatchObject({ statusCode: 409 });
      await expect(setPitr(db, d, { enabled: false }, actor, () => undefined)).rejects.toMatchObject({ code: 'pitr_busy' });
      await expect(runPitrBaseBackup(db, d, actor, () => undefined)).rejects.toMatchObject({ code: 'pitr_busy' });
      const prune = vi.fn(async () => ({ removedBases: [] }));
      await pitrMaintenance(db, d, () => undefined, { ...pitrDeps, archiver: async () => null, prune });
      expect(prune).not.toHaveBeenCalled();
    } finally { release(); await pending; }
  });
  it('refuses the mounted base-backup request while a checkpoint copy pins the archive', async () => {
    const app = await buildTestApp({ db }); await app.register(pitrRoutes, { prefix: '/databases' });
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const reader = withPitrArchiveRead(d.id, async () => { entered(); await blocked; });
    try {
      await ready;
      const response = await app.inject({ method: 'POST', url: `/databases/${d.id}/pitr/base-backup`, headers: asUser({ id: actor, isOperator: true }) });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'pitr_busy' } });
    } finally { release(); await reader; await app.close(); }
  });
  it('releases the archive pin when a copy fails', async () => {
    await expect(withPitrArchiveRead(d.id, async () => { throw new Error('copy failed'); })).rejects.toThrow('copy failed');
    await expect(withPitrArchiveRead(d.id, async () => 42)).resolves.toBe(42);
  });
  it('reports interrupted work as failed after a restart and schedules a later retry', async () => {
    await configureRemotePitr(db, d, input(), actor);
    await setSettingJson(db, `pitr_remote_state:${d.id}`, { status: 'running', attemptedAt: '2026-11-16T09:00:00.000Z', error: null, missingSegment: null, lastSuccess: null });
    expect((await remotePitrStatus(db, d.id)).state).toMatchObject({ status: 'failed', error: expect.stringContaining('restarted') });
    await remotePitrTick(db, () => undefined);
    expect((await remotePitrStatus(db, d.id)).state!.status).toBe('completed');
    const count = objects.size; await remotePitrTick(db, () => undefined); expect(objects.size).toBe(count);
  });
  it.each(['node', 'disabled local PITR', 'HTTP destination', 'missing passphrase'])('rejects %s without a configuration write', async (fault) => {
    const row = { ...d, ...(fault === 'node' ? { serverId: 2 } : {}), ...(fault === 'disabled local PITR' ? { pitrEnabled: false } : {}) };
    if (fault === 'HTTP destination') await db.update(backupDestinations).set({ endpoint: 'http://store.example.test' }).where(eq(backupDestinations.id, dest));
    await expect(configureRemotePitr(db, row, { ...input(), ...(fault === 'missing passphrase' ? { passphrase: undefined } : {}) }, actor)).rejects.toMatchObject({ statusCode: 422 });
    expect((await remotePitrStatus(db, d.id)).settings).toBeNull();
  });
  it('enforces mounted operator authorization and validates bodies', async () => {
    const app = await buildTestApp({ db }); await app.register(pitrRoutes, { prefix: '/databases' });
    try {
      for (const method of ['GET', 'PUT', 'POST'] as const) {
        const url = `/databases/${d.id}/pitr/remote${method === 'POST' ? '/checkpoint' : ''}`;
        expect((await app.inject({ method, url })).statusCode).toBe(401);
        expect((await app.inject({ method, url, headers: asUser({ id: actor, isOperator: false }) })).statusCode).toBe(403);
      }
      const headers = asUser({ id: actor, isOperator: true });
      expect((await app.inject({ method: 'POST', url: `/databases/${d.id}/pitr/remote/checkpoint`, headers })).statusCode).toBe(422);
      expect((await app.inject({ method: 'PUT', url: `/databases/${d.id}/pitr/remote`, headers, payload: { ...input(), intervalMinutes: 1 } })).statusCode).toBe(422);
      expect((await app.inject({ method: 'PUT', url: `/databases/${d.id}/pitr/remote`, headers, payload: input() })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/databases/${d.id}/pitr/remote`, headers })).json()).toMatchObject({ hasPassphrase: true, settings: { enabled: true } });
    } finally { await app.close(); }
  });
  it('answers 202 only after durable admission, then publishes the verified result', async () => {
    await configureRemotePitr(db, d, input(), actor);
    let release!: () => void;
    h.gate = new Promise<void>((resolve) => { release = resolve; });
    const app = await buildTestApp({ db }); await app.register(pitrRoutes, { prefix: '/databases' });
    try {
      const headers = asUser({ id: actor, isOperator: true });
      const response = await app.inject({ method: 'POST', url: `/databases/${d.id}/pitr/remote/checkpoint`, headers });
      expect(response.statusCode).toBe(202);
      expect(audit).toHaveBeenCalledWith(db, actor, 'database.pitr_remote_checkpoint_start', expect.stringContaining('admitted'));
      expect((await remotePitrStatus(db, d.id)).state!.status).toBe('running');
      let drained = false;
      const draining = drainRemotePitrCheckpoints().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      release(); await draining;
      expect(drained).toBe(true);
    } finally { release(); }
    try {
      await vi.waitFor(async () => { expect((await remotePitrStatus(db, d.id)).state!.status).toBe('completed'); }, { timeout: 5000 });
    } finally { await app.close(); }
  });
});
