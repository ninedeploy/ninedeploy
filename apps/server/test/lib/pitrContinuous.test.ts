/** Full producer/reader with real SQLite, crypto and framing; only Docker and S3 HTTP are replaced. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupDestinations, databases, settings, users, type Database, type DB } from '@ninedeploy/db';
import { migratedDb, closeMigratedDb } from './githubAppKit.js';

const h = vi.hoisted(() => ({ listing: '', copies: new Map<string, Buffer>(), copyLog: [] as string[], failCopy: false }));
vi.mock('../../src/lib/exec.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/exec.js')>('../../src/lib/exec.js');
  return { ...actual,
    capture: vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'volume') return '[{}]';
      if (args[0] === 'inspect') return 'exited';
      if (args.includes('-c') && args.some((s) => s.includes('stat -c "W %n %s %Y"'))) return h.listing;
      return '';
    }),
    run: vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'cp') {
        const name = args[1]!.split('/nd-wal-archive/')[1]!;
        h.copyLog.push(name); if (h.failCopy) throw new Error('copy unavailable');
        const data = h.copies.get(name); if (!data) throw new Error('missing archive file');
        await writeFile(args[2]!, data);
      }
    }),
  };
});
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

import { runContinuousPitr, loadContinuousPitr } from '../../src/lib/pitrContinuous.js';
import { configureRemotePitr, remotePitrStatus, runRemotePitrCheckpoint } from '../../src/lib/pitrRemote.js';
import { pitrMaintenance, pitrDeps } from '../../src/lib/pitr.js';
import { pitrStreamStorage } from '../../src/lib/pitrStreamIO.js';
import { safeStreamRoot, validateStreamCatalog } from '../../src/lib/pitrStreamCatalog.js';
import { encrypt } from '../../src/lib/crypto.js';
import { setSettingJson } from '../../src/lib/settings.js';
import type { PitrStreamState } from '../../src/lib/pitrRemoteState.js';
import { buildTestApp, asUser } from '../helpers.js';
import { pitrRoutes } from '../../src/modules/pitr.js';

let db: DB, d: Database, actor: number, destinationId: number, directory: string;
let archiveId: string, state: PitrStreamState | null, clock: Date;
const passphrase = 'operator-held-stream-passphrase';
const cfg = { endpoint: 'https://store.example.test', bucket: 'archive', region: 'us-east-1', accessKeyId: 'fixture', secretAccessKey: 'fixture' };
const objects = new Map<string, Buffer>();
const modified = new Map<string, string>();
const listCalls: URLSearchParams[] = [];
let collectOrphans = false, listFault = '';
const putLog: string[] = [], deletes: string[] = [];
const epoch = Date.parse('2026-11-01T09:00:00.000Z');
let failPut = false, failDelete = false, corruptRead = false, conflict = false, ignoreConditions = false;
let baseNumber = 0, newest = 4;
const etag = (b: Buffer) => `"${createHash('sha256').update(b).digest('hex')}"`;
const seg = (n: number) => `0000000100000000${n.toString(16).toUpperCase().padStart(8, '0')}`;
const baseLabel = (day: number) => `nd-202611${String(day + 1).padStart(2, '0')}T090000000Z`;
const at = (day: number, seconds: number) => new Date(epoch + day * 86_400_000 + seconds * 1000);

function source(day = baseNumber, end = newest) {
  baseNumber = day; newest = end;
  for (let n = 3; n <= end; n++) if (!h.copies.has(`wal/${seg(n)}.gz`)) h.copies.set(`wal/${seg(n)}.gz`, gzipSync(Buffer.alloc(16 * 1024 * 1024, n)));
  const lines: string[] = [];
  for (let n = 3; n <= end; n++) {
    const dayFor = Math.floor((n - 3) / 4);
    lines.push(`W wal/${seg(n)}.gz ${h.copies.get(`wal/${seg(n)}.gz`)!.length} ${Math.floor(at(dayFor, 30 + n).getTime() / 1000)}`);
  }
  for (let dayIndex = 0; dayIndex <= day; dayIndex++) {
    const label = baseLabel(dayIndex), start = seg(3 + dayIndex * 4);
    const base = gzipSync(Buffer.from(`base-${dayIndex}`));
    h.copies.set(`base/${label}/base.tar.gz`, base);
    if (!h.copies.has(`base/${label}/backup_manifest`)) h.copies.set(`base/${label}/backup_manifest`, Buffer.from('{"System-Identifier":12345678901234567890,"Files":[]}'));
    h.copies.set(`wal/${start}.00000028.backup.gz`, gzipSync(Buffer.from('history')));
    lines.push(`B base/${label}/base.tar.gz ${base.length} ${Math.floor(at(dayIndex, 10).getTime() / 1000)}`, `H wal/${start}.00000028.backup.gz`, `| START WAL LOCATION: 0/3000028 (file ${start})`, `| START TIME: 2026-11-${String(dayIndex + 1).padStart(2, '0')} 09:00:00 UTC`, `| LABEL: ${label}`, `| STOP TIME: 2026-11-${String(dayIndex + 1).padStart(2, '0')} 09:00:10 UTC`);
  }
  h.listing = lines.join('\n');
}

const root = () => safeStreamRoot('nine', archiveId);
const storage = () => pitrStreamStorage(cfg, root(), archiveId, passphrase, directory);
const sync = async (retentionDays = 7, save?: (s: PitrStreamState) => Promise<void>) => runContinuousPitr(d, { cfg, prefix: 'nine', archiveId, passphrase, retentionDays, previous: state,
  now: () => clock, collectOrphans, save: save ?? (async (next) => { state = next; await setSettingJson(db, `pitr_stream_state:${d.id}`, next); }) }, () => undefined);
const catalog = async () => (await storage().load())!.catalog;
const archiveDeletes = () => deletes.filter((key) => !key.includes('/probe/'));

beforeEach(async () => {
  db = await migratedDb(); directory = await mkdtemp(path.join(tmpdir(), 'nd-stream-'));
  actor = (await db.insert(users).values({ email: 'operator@stream.test', passwordHash: 'x', isInstanceOperator: true }).returning())[0]!.id;
  d = (await db.insert(databases).values({ name: 'main', slug: 'main', engine: 'postgres', status: 'running', pitrEnabled: true, pitrBaseBackupAt: new Date(), containerName: 'nd-db-main', volumeName: 'nd-db-main-data', passwordEncrypted: encrypt('source'), ownerUserId: actor }).returning())[0]!;
  destinationId = (await db.insert(backupDestinations).values({ name: 'remote', ...cfg, prefix: 'nine', secretKeyEncrypted: encrypt(cfg.secretAccessKey) }).returning())[0]!.id;
  h.copies.clear(); h.copyLog = []; h.failCopy = false; objects.clear(); modified.clear(); listCalls.length = 0; collectOrphans = false; listFault = ''; putLog.length = 0; deletes.length = 0;
  failPut = false; failDelete = false; corruptRead = false; conflict = false; ignoreConditions = false; state = null; clock = at(0, 60); source(0, 4);
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, opts: RequestInit) => {
    const parsed = new URL(url), query = parsed.searchParams;
    if (query.get('list-type') === '2') {
      listCalls.push(query);
      if (listFault === 'denied') return new Response('denied', { status: 403 });
      if (listFault === 'malformed') return new Response('<broken>');
      const prefix = query.get('prefix')!, cursor = query.get('continuation-token'), start = Number(cursor ?? 0);
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort(), page = keys.slice(start, start + 200);
      const more = start + 200 < keys.length;
      const body = `<ListBucketResult><Name>archive</Name><Prefix>${encodeURIComponent(listFault === 'wrong prefix' ? 'foreign/' : prefix)}</Prefix><EncodingType>url</EncodingType><MaxKeys>200</MaxKeys><KeyCount>${page.length}</KeyCount><IsTruncated>${more}</IsTruncated>${cursor ? `<ContinuationToken>${cursor}</ContinuationToken>` : ''}${more ? `<NextContinuationToken>${start + 200}</NextContinuationToken>` : ''}${page.map(k => `<Contents><Key>${encodeURIComponent(k)}</Key><LastModified>${modified.get(k) ?? clock.toISOString()}</LastModified></Contents>`).join('')}</ListBucketResult>`;
      return new Response(body);
    }
    const key = decodeURIComponent(parsed.pathname.slice('/archive/'.length));
    const current = objects.get(key);
    if (opts.method === 'PUT') {
      const headers = opts.headers as Record<string, string>;
      if (failPut) return new Response('unavailable', { status: 503 });
      if (conflict && key.endsWith('/head.ndpi') || !ignoreConditions && (headers['if-none-match'] === '*' && current || headers['if-match'] && (!current || headers['if-match'] !== etag(current)))) return new Response(null, { status: 412 });
      const data = Buffer.from(opts.body as Uint8Array); objects.set(key, data); modified.set(key, clock.toISOString()); putLog.push(key);
      return new Response('', { headers: { etag: etag(data) } });
    }
    if (opts.method === 'DELETE') {
      if (failDelete && !key.includes('/probe/')) return new Response('unavailable', { status: 503 });
      deletes.push(key); objects.delete(key); return new Response(null, { status: 204 });
    }
    if (!current) return new Response(null, { status: 404 });
    const data = corruptRead && opts.method === 'GET' && !key.endsWith('/head.ndpi') ? Buffer.from('corrupt') : current;
    return new Response(opts.method === 'HEAD' ? null : new Uint8Array(data), { headers: { etag: etag(data), 'content-length': String(data.length) } });
  }));
  await configureRemotePitr(db, d, { enabled: true, destinationId, intervalMinutes: 15, mode: 'continuous', remoteRetentionDays: 7, passphrase }, actor);
  archiveId = (await remotePitrStatus(db, d.id)).settings!.archiveId!;
});
afterEach(async () => { vi.unstubAllGlobals(); closeMigratedDb(db); await rm(directory, { recursive: true, force: true }); });

describe('continuous remote WAL', () => {
  it('stages old unpublished data/catalogs, commits a fence, waits for grace and preserves recovery', async () => {
    await sync(); expect(listCalls).toHaveLength(0);
    const orphan = `${root()}g/${randomUUID()}/anchor-${randomUUID()}.ndpc`, orphanCatalog = `${root()}catalog/${randomUUID()}.ndcat`, fresh = `${root()}g/${randomUUID()}/anchor-${randomUUID()}.ndpc`;
    for (const k of [orphan, orphanCatalog, fresh, `${root()}notes.txt`, 'nine/pitr-checkpoints/unrelated.ndpc']) { objects.set(k, Buffer.from('abandoned')); modified.set(k, at(0, 0).toISOString()); }
    clock = at(2, 60); modified.set(fresh, clock.toISOString()); collectOrphans = true;
    await sync(35); const c = await catalog();
    expect(c.garbage.filter(g => [orphan, orphanCatalog].includes(g.key))).toHaveLength(2);
    expect(archiveDeletes()).not.toContain(orphan); expect(objects.has(orphan)).toBe(true);
    expect(state!.orphanSweep).toMatchObject({ cursor: null, found: 2 });
    clock = new Date(clock.getTime() + 60 * 60_000 + 1); await sync(35);
    expect(objects.has(orphan)).toBe(false); expect(objects.has(orphanCatalog)).toBe(false); expect(objects.has(fresh)).toBe(true);
    expect((await catalog()).garbage.some(g => [orphan, orphanCatalog].includes(g.key))).toBe(false);
    expect(objects.has(`${root()}notes.txt`)).toBe(true); expect(objects.has('nine/pitr-checkpoints/unrelated.ndpc')).toBe(true);
    const recovered = await loadContinuousPitr({ cfg, key: `${root()}head.ndpi`, passphrase, targetTime: null }, path.join(directory, 'orphan-recovery'));
    expect(recovered.manifest.segments.at(-1)!.name).toBe(seg(4));
  });
  it('fences a stalled producer that still wants to publish a staged orphan as live data', async () => {
    await sync(); const store = storage(), stale = (await store.load())!;
    const sealed = path.join(directory, 'old-anchor-sealed'), plain = path.join(directory, 'old-anchor');
    await store.getObject(stale.catalog.generations[0]!.anchor, sealed); await store.open(sealed, plain);
    const orphan = await store.upload(plain, `${root()}g/${stale.catalog.generations[0]!.id}/anchor-${randomUUID()}.ndpc`);
    clock = at(2, 60); collectOrphans = true; await sync(35);
    expect((await catalog()).garbage.some(g => g.key === orphan.key)).toBe(true);
    stale.catalog.revision = randomUUID(); stale.catalog.sequence++;
    stale.catalog.generations[0]!.anchor = orphan;
    await expect(store.publish(stale.catalog, stale.etag)).rejects.toThrow(/index changed/);
    clock = new Date(clock.getTime() + 60 * 60_000 + 1); await sync(35);
    expect(objects.has(orphan.key)).toBe(false); await store.verifyReference((await catalog()).generations[0]!.anchor);
  });
  it('stops listing when disabled but still consumes previously committed cleanup intents', async () => {
    await sync(); const orphan = `${root()}g/${randomUUID()}/anchor-${randomUUID()}.ndpc`;
    objects.set(orphan, Buffer.from('orphan')); modified.set(orphan, at(0, 0).toISOString());
    clock = at(2, 60); collectOrphans = true; await sync(35); expect(listCalls).toHaveLength(1);
    collectOrphans = false; listFault = 'denied'; clock = new Date(clock.getTime() + 60 * 60_000 + 1); await sync(35);
    expect(objects.has(orphan)).toBe(false); expect(listCalls).toHaveLength(1); expect(state!.orphanSweep).toBeUndefined();
  });
  it('preserves a candidate that another producer publishes before the collector can commit', async () => {
    await sync(); const store = storage(), loaded = (await store.load())!;
    const sealed = path.join(directory, 'winning-anchor-sealed'), plain = path.join(directory, 'winning-anchor');
    await store.getObject(loaded.catalog.generations[0]!.anchor, sealed); await store.open(sealed, plain);
    const candidate = await store.upload(plain, `${root()}g/${loaded.catalog.generations[0]!.id}/anchor-${randomUUID()}.ndpc`);
    const winner = structuredClone(loaded.catalog); winner.revision = randomUUID(); winner.sequence++; winner.generations[0]!.anchor = candidate;
    const network = globalThis.fetch; let racing = true;
    vi.stubGlobal('fetch', async (url: URL | string, opts: RequestInit) => {
      if (racing && opts.method === 'PUT' && String(url).endsWith('/head.ndpi')) { racing = false; await store.publish(winner, loaded.etag); }
      return network(url, opts);
    });
    clock = at(2, 60); collectOrphans = true;
    await expect(sync(35)).rejects.toThrow(/index changed/);
    expect((await catalog()).generations[0]!.anchor.key).toBe(candidate.key); expect(archiveDeletes()).toEqual([]);
    await sync(35); expect((await catalog()).garbage.some(g => g.key === candidate.key)).toBe(false);
    await store.verifyReference(candidate);
  });
  it('does not advance discovery after a failed conditional publication', async () => {
    await sync(); const before = Buffer.from(objects.get(`${root()}head.ndpi`)!);
    for (let i = 0; i < 205; i++) { const k = `${root()}g/${randomUUID()}/anchor-${randomUUID()}.ndpc`; objects.set(k, Buffer.from('orphan')); modified.set(k, at(0, 0).toISOString()); }
    clock = at(2, 60); collectOrphans = true; conflict = true;
    await expect(sync(35)).rejects.toThrow(/index changed/);
    expect(state!.orphanSweep).toBeUndefined(); expect(objects.get(`${root()}head.ndpi`)).toEqual(before); expect(archiveDeletes()).toEqual([]);
    conflict = false; await sync(35); expect(state!.orphanSweep!.cursor).not.toBeNull();
    const cursor = state!.orphanSweep!.cursor; await sync(35); expect(listCalls.at(-1)!.get('continuation-token')).toBe(cursor); expect(state!.orphanSweep!.cursor).toBeNull();
  });
  it.each(['denied', 'malformed', 'wrong prefix'])('holds publication and deletion after a %s listing', async fault => {
    await sync(); source(0, 6); putLog.length = 0; clock = at(2, 60); collectOrphans = true; listFault = fault;
    const before = Buffer.from(objects.get(`${root()}head.ndpi`)!); await expect(sync(35)).rejects.toThrow();
    expect(objects.get(`${root()}head.ndpi`)).toEqual(before); expect(archiveDeletes()).toEqual([]);
    expect(putLog.filter(k => !k.includes('/probe/'))).toEqual([]);
  });
  it('accepts collection only in continuous settings and passes the opt-in through the mounted API', async () => {
    const app = await buildTestApp({ db }); await app.register(pitrRoutes, { prefix: '/databases' });
    try {
      const headers = asUser({ id: actor, isOperator: true });
      const body = { enabled: true, destinationId, intervalMinutes: 15, collectOrphans: true };
      expect((await app.inject({ method: 'PUT', url: `/databases/${d.id}/pitr/remote`, headers, payload: { ...body, mode: 'checkpoint' } })).statusCode).toBe(422);
      const saved = await app.inject({ method: 'PUT', url: `/databases/${d.id}/pitr/remote`, headers, payload: { ...body, mode: 'continuous' } });
      expect(saved.statusCode).toBe(200); expect(saved.json().settings.collectOrphans).toBe(true);
      await runRemotePitrCheckpoint(db, d, () => undefined); await runRemotePitrCheckpoint(db, d, () => undefined);
      expect(listCalls).toHaveLength(1); expect((await remotePitrStatus(db, d.id)).stream!.orphanSweep).toMatchObject({ cursor: null, found: 0 });
    } finally { await app.close(); }
  });
  it('holds publication and retirement when a provider ignores conditional writes', async () => {
    await sync(); const before = Buffer.from(objects.get(`${root()}head.ndpi`)!);
    source(0, 6); ignoreConditions = true;
    await expect(sync()).rejects.toThrow(/does not enforce conditional/);
    expect(objects.get(`${root()}head.ndpi`)).toEqual(before);
    expect(archiveDeletes()).toEqual([]);
    expect(state!.protection!.lastSegment).toBe(seg(4));
  });
  it('ships new closed segments without copying or uploading the base again', async () => {
    const first = await sync(); expect(first.headKey).toBe(`${root()}head.ndpi`);
    source(0, 6); h.copyLog = []; putLog.length = 0; clock = at(0, 80);
    const next = await sync();
    expect(h.copyLog.filter((s) => s.endsWith('base.tar.gz'))).toEqual([]);
    expect(putLog.filter((s) => s.includes('/anchor-'))).toEqual([]);
    expect((await catalog()).generations[0]!.wal.map((w) => w.name)).toEqual([seg(5), seg(6)]);
    expect(next.lastSegment).toBe(seg(6));
    const recovered = await loadContinuousPitr({ cfg, key: first.headKey, passphrase, targetTime: null }, path.join(directory, 'restore'));
    expect(recovered.manifest.segments.map((s) => s.name)).toEqual([seg(3), seg(4), seg(5), seg(6)]);
  });
  it('closes the old generation across a new base and keeps the recovery windows overlapping', async () => {
    await sync(); source(1, 8); clock = at(1, 60); await sync();
    const c = await catalog();
    expect(c.generations).toHaveLength(2);
    expect(c.generations[0]!.sealed).toBe(true);
    expect(c.generations[0]!.wal.map((s) => s.name)).toEqual([seg(5), seg(6), seg(7), seg(8)]);
    const oldPoint = await loadContinuousPitr({ cfg, key: `${root()}head.ndpi`, passphrase, targetTime: at(0, 32) }, path.join(directory, 'old-point'));
    expect(oldPoint.manifest.base.label).toBe(baseLabel(0));
    expect(state!.protection!.ranges).toHaveLength(2);
  });
  it.each(['upload', 'read-back', 'conditional conflict'])('preserves the published index on %s failure', async (fault) => {
    await sync(); const before = Buffer.from(objects.get(`${root()}head.ndpi`)!);
    source(0, 6); failPut = fault === 'upload'; corruptRead = fault === 'read-back'; conflict = fault === 'conditional conflict';
    await expect(sync()).rejects.toThrow();
    expect(objects.get(`${root()}head.ndpi`)).toEqual(before);
    expect(state!.status).toBe('failed'); expect(state!.protection!.lastSegment).toBe(seg(4));
    expect(archiveDeletes()).toEqual([]);
  });
  it('resumes from the remote index after losing local progress, without re-uploading the base', async () => {
    await sync(); source(0, 6); await db.delete(settings).where(eq(settings.key, `pitr_stream_state:${d.id}`)); state = null; h.copyLog = []; await sync();
    expect(h.copyLog.some((s) => s.endsWith('base.tar.gz'))).toBe(false);
    expect(state!.protection!.lastSegment).toBe(seg(6));
  });
  it('refuses an index rollback or missing index instead of recreating it over known progress', async () => {
    await sync(); const first = Buffer.from(objects.get(`${root()}head.ndpi`)!); source(0, 5); await sync();
    objects.set(`${root()}head.ndpi`, first);
    await expect(sync()).rejects.toThrow(/backwards/);
    objects.delete(`${root()}head.ndpi`);
    await expect(sync()).rejects.toThrow(/index is missing/);
    expect(archiveDeletes()).toEqual([]);
  });
  it('rejects damaged or missing remote WAL for latest recovery before staging a data volume', async () => {
    await sync(); source(0, 6); await sync(); const c = await catalog(); const ref = c.generations[0]!.wal[0]!.object;
    const good = objects.get(ref.key)!; objects.set(ref.key, Buffer.from('damaged'));
    await expect(loadContinuousPitr({ cfg, key: `${root()}head.ndpi`, passphrase, targetTime: null }, path.join(directory, 'bad'))).rejects.toThrow(/integrity/);
    objects.delete(ref.key);
    await expect(loadContinuousPitr({ cfg, key: `${root()}head.ndpi`, passphrase, targetTime: null }, path.join(directory, 'missing'))).rejects.toThrow(/404/);
    objects.set(ref.key, good);
    await expect(loadContinuousPitr({ cfg, key: `${root()}head.ndpi`, passphrase, targetTime: null }, path.join(directory, 'good'))).resolves.toBeDefined();
  });
  it.each(['../foreign', 'nested/../foreign', 'nested\\foreign'])('refuses unsafe deletion namespace %s', async (prefix) => {
    await db.update(backupDestinations).set({ prefix }).where(eq(backupDestinations.id, destinationId));
    await expect(configureRemotePitr(db, d, { enabled: true, destinationId, intervalMinutes: 15, mode: 'continuous' }, actor)).rejects.toMatchObject({ statusCode: 422 });
    expect(objects.size).toBe(0);
  });
  it('polls continuous mode at minute cadence even when its legacy checkpoint interval is a day', async () => {
    const remote = await import('../../src/lib/pitrRemote.js');
    await configureRemotePitr(db, d, { enabled: true, destinationId, intervalMinutes: 1440, mode: 'continuous' }, actor);
    await remote.remotePitrTick(db, () => undefined);
    source(0, 5);
    const previous = (await remotePitrStatus(db, d.id)).stream!;
    await setSettingJson(db, `pitr_stream_state:${d.id}`, { ...previous, attemptedAt: new Date(Date.now() - 61_000).toISOString() });
    await remote.remotePitrTick(db, () => undefined);
    expect((await remotePitrStatus(db, d.id)).stream!.protection!.lastSegment).toBe(seg(5));
  });
  it('recovers when publication succeeded but the local completion record was lost', async () => {
    await sync(); const old = structuredClone(state); source(0, 5);
    await expect(sync(7, async (next) => { if (next.status !== 'running') throw new Error('process interrupted'); })).rejects.toThrow();
    expect((await catalog()).sequence).toBe(2); state = old; await sync();
    expect(state!.protection!.sequence).toBe(3); expect(state!.protection!.lastSegment).toBe(seg(5));
  });
  it.each(['gap', 'changed boundary', 'different cluster'])('refuses %s without advancing or deleting', async (fault) => {
    await sync(); source(0, 6); const before = objects.get(`${root()}head.ndpi`);
    if (fault === 'gap') h.listing = h.listing.split('\n').filter((l) => !l.startsWith(`W wal/${seg(5)}.`)).join('\n');
    if (fault === 'changed boundary') h.copies.set(`wal/${seg(4)}.gz`, gzipSync(Buffer.alloc(16 * 1024 * 1024, 99)));
    if (fault === 'different cluster') h.copies.set(`base/${baseLabel(0)}/backup_manifest`, Buffer.from('{"System-Identifier":9999999999999999999,"Files":[]}'));
    await expect(sync()).rejects.toThrow(/missing|differs|identity/);
    expect(objects.get(`${root()}head.ndpi`)).toBe(before); expect(archiveDeletes()).toEqual([]);
  });
  it('holds local retention until the newest base has been published remotely', async () => {
    const prune = vi.fn(async () => ({ removedBases: [] }));
    const actual = await import('../../src/engine/postgresPitr.js');
    const deps = { ...pitrDeps, archiver: async () => null, inventory: async () => actual.parseArchiveListing(h.listing), prune };
    await pitrMaintenance(db, d, () => undefined, deps); expect(prune).not.toHaveBeenCalled();
    await sync(); await pitrMaintenance(db, d, () => undefined, deps); expect(prune).toHaveBeenCalledTimes(1);
    source(1, 8); await pitrMaintenance(db, d, () => undefined, deps); expect(prune).toHaveBeenCalledTimes(1);
    clock = at(1, 60); await sync(); await pitrMaintenance(db, d, () => undefined, deps); expect(prune).toHaveBeenCalledTimes(2);
  });
  it('integrates with the mounted settings/status API and preserves archive identity on routine saves', async () => {
    const app = await buildTestApp({ db }); await app.register(pitrRoutes, { prefix: '/databases' });
    try {
      const headers = asUser({ id: actor, isOperator: true });
      const body = { enabled: true, destinationId, intervalMinutes: 15, mode: 'continuous', remoteRetentionDays: 3 };
      expect((await app.inject({ method: 'PUT', url: `/databases/${d.id}/pitr/remote`, headers, payload: { ...body, archiveId } })).statusCode).toBe(422);
      const saved = await app.inject({ method: 'PUT', url: `/databases/${d.id}/pitr/remote`, headers, payload: body });
      expect(saved.statusCode).toBe(200); expect(saved.json().settings.archiveId).toBe(archiveId);
      const result = await runRemotePitrCheckpoint(db, d, () => undefined); expect(result.key).toBe(`${root()}head.ndpi`);
      const status = await remotePitrStatus(db, d.id); expect(status.stream!.status).toBe('completed'); expect(status.stream!.protection!.lastSegment).toBe(seg(4));
      await configureRemotePitr(db, d, { ...body, mode: 'continuous', resetStream: true }, actor);
      expect((await remotePitrStatus(db, d.id)).settings!.archiveId).not.toBe(archiveId);
      expect(objects.has(`${root()}head.ndpi`)).toBe(true);
    } finally { await app.close(); }
  });
});

async function history() {
  await sync(1); source(1, 8); clock = at(1, 60); await sync(1); source(2, 12); clock = at(2, 60); await sync(1);
  return catalog();
}

describe('safe remote retention', () => {
  it.each(['foreign key', 'live object', 'foreign generation'])('refuses unsafe deletion metadata: %s', async (fault) => {
    await sync(); const c = await catalog();
    if (fault === 'foreign generation') c.generations[0]!.anchor.key = `${root()}g/00000000-0000-4000-8000-000000000001/anchor-00000000-0000-4000-8000-000000000002.ndpc`;
    else c.garbage.push({ key: fault === 'foreign key' ? 'nine/another-project/data' : c.generations[0]!.anchor.key, kind: 'data', notBefore: at(0, 0).toISOString() });
    expect(() => validateStreamCatalog(c, root(), archiveId)).toThrow(/Unsafe|outside|shared/);
    expect(archiveDeletes()).toEqual([]);
  });
  it('publishes retirement first, waits for the grace period and preserves the last base and its complete WAL', async () => {
    const before = await history(); const newestAnchor = before.generations.at(-1)!.anchor.key;
    const retired = before.generations[0]!.anchor.key;
    objects.set('nine/unrelated/keep', Buffer.from('foreign'));
    clock = at(10, 60); await sync(1);
    expect((await catalog()).generations).toHaveLength(1); expect(objects.has(retired)).toBe(true);
    clock = at(10, 7200); await sync(1);
    expect(objects.has(retired)).toBe(false); expect(objects.has(newestAnchor)).toBe(true); expect(objects.has('nine/unrelated/keep')).toBe(true);
    const restored = await loadContinuousPitr({ cfg, key: `${root()}head.ndpi`, passphrase, targetTime: null }, path.join(directory, 'kept'));
    expect(restored.manifest.base.label).toBe(baseLabel(2));
  });
  it('retries interrupted deletion from committed intent without losing the current recovery set', async () => {
    await history(); clock = at(10, 60); await sync(1); clock = at(10, 7200); failDelete = true;
    await expect(sync(1)).rejects.toThrow(/deletion/); expect(state!.protection!.sequence).toBe(5);
    const protectedKey = (await catalog()).generations[0]!.anchor.key; expect(objects.has(protectedKey)).toBe(true);
    failDelete = false; await sync(1); expect(state!.status).toBe('completed'); expect(objects.has(protectedKey)).toBe(true);
  });
  it('holds deletion when a retained incremental WAL object is missing', async () => {
    await history(); source(2, 14); await sync(1); const c = await catalog(); const active = c.generations.at(-1)!;
    objects.delete(active.wal[0]!.object.key); clock = at(10, 60); const oldKeys = c.generations.flatMap((g) => [g.anchor.key, ...g.wal.map((s) => s.object.key)]);
    await expect(sync(1)).rejects.toThrow(/missing|changed/);
    expect(deletes.filter((key) => key.includes('/g/'))).toEqual([]);
    expect(oldKeys.filter((key) => !key.includes('/wal/')).every((key) => objects.has(key))).toBe(true);
  });
  it('keeps the base at the retention boundary even when it is older than the configured days', async () => {
    await history(); clock = at(2, 90); await sync(1);
    const c = await catalog(); expect(c.generations.map((g) => g.manifest.base.label)).toEqual([baseLabel(1), baseLabel(2)]);
    expect(c.generations[0]!.manifest.base.finishedAt).toBe(at(1, 10).toISOString());
  });
  it('preserves the predecessor when the retention boundary falls inside a history timestamp second', async () => {
    await sync(1); source(1, 8); clock = at(1, 60); await sync(1);
    clock = new Date(at(2, 10).getTime() + 500); await sync(1);
    expect((await catalog()).generations).toHaveLength(2);
    clock = at(2, 12); await sync(1);
    expect((await catalog()).generations).toHaveLength(1);
  });
});
