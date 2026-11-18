/** Real controller, SQLite, framing, encryption and S3 client. Only node RPC/stream and HTTP are replaced. */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backups, backupDestinations, databases, servers, settings, users, type Database, type DB } from '@ninedeploy/db';
import { MULTI_NODE_CAPABILITIES } from '@ninedeploy/schemas';
import { migratedDb, closeMigratedDb } from './githubAppKit.js';

const h = vi.hoisted(() => ({ sealed: true, caps: [] as string[], calls: [] as Array<{ op: string; params: Record<string, unknown> }>, streams: [] as Record<string, unknown>[], inventory: {} as unknown, checkpoint: Buffer.alloc(0), fault: '', running: true, archive: true,
  wal: new Map<string, { file: string; size: number; sha256: string; rawSha256: string }>(), dir: '', baseGate: null as Promise<void> | null, started: null as (() => void) | null }));
vi.mock('../../src/lib/exec.js', async (original) => ({ ...await original<typeof import('../../src/lib/exec.js')>(), capture: vi.fn(async () => { throw new Error('Local Docker must never handle node archives'); }), run: vi.fn(async () => { throw new Error('Local Docker must never handle node archives'); }) }));
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/agentClient.js', async (original) => ({ ...await original<typeof import('../../src/lib/agentClient.js')>(),
  agentTransportSealed: async () => h.sealed,
  agentOp: async (_db: unknown, _id: number, op: string, params: Record<string, unknown>) => {
    h.calls.push({ op, params });
    if (h.fault === 'offline') throw new Error('node disconnected');
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: h.fault === 'missing capability' ? '0.18.28' : '0.18.29', caps: h.caps })}`] };
    if (op === 'db.pitr') {
      let value: unknown;
      switch (params['action']) {
        case 'inventory': value = { inventory: h.inventory }; break;
        case 'archiver': value = { archiver: null }; break;
        case 'preflight': value = { refusal: null }; break;
        case 'archiveExists': value = { exists: h.archive }; break;
        case 'prepare': h.archive = true; value = { prepared: true }; break;
        case 'verify': value = { verified: true }; break;
        case 'removeArchive': h.archive = false; value = { removed: true }; break;
        case 'prune': value = { removedBases: [] }; break;
        case 'baseBackup': h.started?.(); if (h.baseGate) await h.baseGate; value = { label: 'nd-20261117T090000000Z' }; break;
      }
      return { exitCode: 0, lines: [h.fault === 'malformed reply' ? 'ND-PITR {}' : `ND-PITR ${JSON.stringify(value)}`] };
    }
    if (op === 'docker.inspect') return { exitCode: 0, lines: [`${h.running ? 'running' : 'exited'}|172.20.0.2`] };
    if (op === 'docker.rm') h.running = false;
    if (op === 'docker.runSpec') h.running = true;
    if (op === 'file.writeEnv') return { exitCode: 0, lines: ['wrote .agent-env/nd-db-main.env'] };
    return { exitCode: 0, lines: [] };
  },
}));
vi.mock('../../src/lib/agentStream.js', async (original) => ({ ...await original<typeof import('../../src/lib/agentStream.js')>(),
  openAgentStream: async (_db: unknown, _id: number, kind: string, params: Record<string, unknown>) => {
    h.streams.push({ kind, ...params });
    if (kind === 'volume.import') {
      const writable = new PassThrough(); let bytes = 0;
      writable.on('data', (chunk) => { bytes += chunk.length; });
      const done = new Promise((resolve) => writable.once('finish', () => resolve({ bytes, sha256: 'verified-volume-transport', result: {} })));
      return { direction: 'panel-to-agent', writable, done, abort: vi.fn() };
    }
    const selection = params['selection'] as { kind: string; names?: string[] };
    let bytes = h.checkpoint;
    if (selection.kind === 'wal') {
      const { packPitrWal } = await import('../../src/engine/pitrWalTransfer.js');
      const file = path.join(h.dir, `transfer-${h.streams.length}`);
      await packPitrWal({ systemIdentifier: '12345678901234567890', files: new Map(selection.names!.map((s) => [s, h.wal.get(s)!])) }, file);
      bytes = await readFile(file);
    }
    if (h.fault === 'truncated') bytes = bytes.subarray(0, bytes.length - 1);
    return { direction: 'agent-to-panel', readable: Readable.from([bytes]), done: Promise.resolve({ bytes: bytes.length, sha256: 'transport-verified', result: {} }), abort: vi.fn() };
  },
}));

import { encrypt } from '../../src/lib/crypto.js';
import { resetNodeCapabilityCache } from '../../src/lib/agentCapabilities.js';
import { packCheckpoint, hashCheckpointFile, walFileDigest, type CheckpointManifest } from '../../src/engine/pitrCheckpoint.js';
import { parseArchiveListing } from '../../src/engine/postgresPitr.js';
import { configureRemotePitr, runRemotePitrCheckpoint, remotePitrStatus } from '../../src/lib/pitrRemote.js';
import { loadContinuousPitr } from '../../src/lib/pitrContinuous.js';
import { nodePitrInventory } from '../../src/lib/nodePitr.js';
import { pitrBusy, withPitrArchiveRead } from '../../src/lib/pitr.js';
import { withNodeDatabaseLifecycle } from '../../src/lib/nodeDatabaseLifecycle.js';
import { pitrRoutes } from '../../src/modules/pitr.js';
import { volumeBackupRoutes } from '../../src/modules/volumeBackups.js';
import { buildTestApp, asUser } from '../helpers.js';

let db: DB, d: Database, actor: number, destinationId: number;
const label = 'nd-20261117T090000000Z', seg = (n: number) => `0000000100000000${n.toString(16).toUpperCase().padStart(8, '0')}`;
const passphrase = 'operator-kept-node-recovery-passphrase';
const cfg = { endpoint: 'https://store.example.test', region: 'us-east-1', bucket: 'archive', accessKeyId: 'access', secretAccessKey: 'S3-secret-stays-on-panel' };
const objects = new Map<string, Buffer>();
const etag = (b: Buffer) => `"${createHash('sha256').update(b).digest('hex')}"`;
const configure = (mode: 'continuous' | 'checkpoint' = 'continuous') => configureRemotePitr(db, d, { enabled: true, destinationId, intervalMinutes: 15, mode, remoteRetentionDays: 7, passphrase }, actor);
const sync = () => runRemotePitrCheckpoint(db, d, () => undefined);

function source(end = 4) {
  const lines = [`B base/${label}/base.tar.gz 0 1794906060`, `H wal/${seg(3)}.00000028.backup.gz`, `| START WAL LOCATION: 0/3000028 (file ${seg(3)})`, '| START TIME: 2026-11-17 09:00:00 UTC', `| LABEL: ${label}`, '| STOP TIME: 2026-11-17 09:01:00 UTC'];
  for (let n = 3; n <= end; n++) lines.push(`W wal/${seg(n)}.gz ${h.wal.get(seg(n))!.size} ${1794906120 + n}`);
  h.inventory = parseArchiveListing(lines.join('\n'));
}
beforeEach(async () => {
  db = await migratedDb(); h.dir = await mkdtemp(path.join(tmpdir(), 'nd-node-pitr-panel-')); h.calls = []; h.streams = []; h.wal.clear(); h.caps = [...MULTI_NODE_CAPABILITIES]; h.sealed = true; h.fault = ''; h.running = true; h.archive = true; h.baseGate = null; h.started = null; resetNodeCapabilityCache(); objects.clear();
  actor = (await db.insert(users).values({ email: 'operator@node.test', passwordHash: 'x', isInstanceOperator: true }).returning())[0]!.id;
  const serverId = (await db.insert(servers).values({ name: 'edge', host: '10.0.0.5', tokenEncrypted: encrypt('node-token'), status: 'online' }).returning())[0]!.id;
  d = (await db.insert(databases).values({ name: 'main', slug: 'main', engine: 'postgres', version: '18', serverId, containerName: null, volumeName: null, nodeContainerName: 'nd-db-main', nodeVolumeName: 'nd-db-main-data', status: 'running', pitrEnabled: true, pitrBaseBackupAt: new Date(), username: 'nine', dbName: 'app', passwordEncrypted: encrypt('db-password'), ownerUserId: actor }).returning())[0]!;
  destinationId = (await db.insert(backupDestinations).values({ name: 'remote', ...cfg, prefix: 'node', secretKeyEncrypted: encrypt(cfg.secretAccessKey) }).returning())[0]!.id;
  const files: string[] = [], entries: CheckpointManifest['files'] = [];
  const add = async (name: string, bytes: Buffer) => { const file = path.join(h.dir, String(files.length)); await writeFile(file, bytes); files.push(file); entries.push({ name, size: bytes.length, sha256: await hashCheckpointFile(file) }); return file; };
  await add(`base/${label}/base.tar.gz`, gzipSync(Buffer.from('base')));
  await add(`base/${label}/backup_manifest`, Buffer.from('{"System-Identifier":12345678901234567890,"Files":[]}'));
  await add(`wal/${seg(3)}.00000028.backup.gz`, gzipSync(Buffer.from('history')));
  for (let n = 3; n <= 6; n++) {
    const bytes = gzipSync(Buffer.alloc(16 * 1024 * 1024, n)), file = n <= 4 ? await add(`wal/${seg(n)}.gz`, bytes) : path.join(h.dir, `future-${n}`);
    if (n > 4) await writeFile(file, bytes);
    h.wal.set(seg(n), { file, size: bytes.length, sha256: await hashCheckpointFile(file), rawSha256: await walFileDigest(file) });
  }
  source(); const inv = h.inventory as ReturnType<typeof parseArchiveListing>; inv.baseBackups[0]!.sizeBytes = entries[0]!.size;
  const manifest = { format: 'NDPITR1', createdAt: '2026-11-17T09:03:00.000Z', source: { slug: 'main', version: '18', username: 'nine', dbName: 'app' }, base: { ...inv.baseBackups[0]!, startedAt: inv.baseBackups[0]!.startedAt.toISOString(), finishedAt: inv.baseBackups[0]!.finishedAt.toISOString() }, segments: inv.segments.map((s) => ({ name: s.name, archivedAt: s.archivedAt.toISOString(), sizeBytes: s.sizeBytes })), files: entries } as CheckpointManifest;
  const file = path.join(h.dir, 'anchor'); await packCheckpoint(manifest, files, file); h.checkpoint = await readFile(file);
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, opts: RequestInit) => {
    const key = decodeURIComponent(new URL(url).pathname.slice('/archive/'.length)), current = objects.get(key), headers = opts.headers as Record<string, string>;
    if (opts.method === 'PUT') {
      if (headers['if-none-match'] === '*' && current || headers['if-match'] && (!current || etag(current) !== headers['if-match'])) return new Response(null, { status: 412 });
      const data = Buffer.from(opts.body as Uint8Array); objects.set(key, data); return new Response('', { headers: { etag: etag(data) } });
    }
    if (opts.method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
    if (!current) return new Response(null, { status: 404 });
    return new Response(opts.method === 'HEAD' ? null : new Uint8Array(current), { headers: { etag: etag(current), 'content-length': String(current.length) } });
  }));
});
afterEach(async () => { vi.unstubAllGlobals(); closeMigratedDb(db); await rm(h.dir, { recursive: true, force: true }); });

describe('node remote PostgreSQL archives', () => {
  it.each(['nd-db-main-data', 'nd-db-main-data-wal', 'nd-db-custom', 'nd-db-custom-wal'])('refuses raw restore of an active node data/archive volume: %s', async (volume) => {
    const dataVolume = volume.endsWith('-wal') ? volume.slice(0, -4) : volume;
    await db.update(databases).set({ status: 'stopped', nodeVolumeName: dataVolume }).where(eq(databases.id, d.id));
    const file = path.join(h.dir, 'empty-volume.tar.gz'), bytes = gzipSync(Buffer.alloc(1024)); await writeFile(file, bytes);
    const backup = (await db.insert(backups).values({ volumeName: volume, scope: 'volumes', status: 'completed', serverId: d.serverId, path: file, sizeBytes: bytes.length }).returning())[0]!;
    const app = await buildTestApp({ db }); await app.register(volumeBackupRoutes, { prefix: '/volumes' });
    try {
      const response = await app.inject({ method: 'POST', url: `/volumes/${volume}/backups/${backup.id}/restore?serverId=${d.serverId}`, headers: asUser({ id: actor, isOperator: true }) });
      expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('pitr_volume_restore_refused');
      expect(h.streams).toEqual([]);
    } finally { await app.close(); }
  });
  it.each(['disabled on this node', 'active on a different node'])('allows raw volume restore when archiving is %s', async (control) => {
    const volume = 'nd-db-main-data-wal';
    if (control === 'disabled on this node') await db.update(databases).set({ pitrEnabled: false, status: 'stopped' }).where(eq(databases.id, d.id));
    else {
      const elsewhere = (await db.insert(servers).values({ name: 'elsewhere', host: '10.0.0.9', tokenEncrypted: encrypt('other-token'), status: 'online' }).returning())[0]!;
      await db.update(databases).set({ serverId: elsewhere.id, status: 'stopped' }).where(eq(databases.id, d.id));
    }
    const file = path.join(h.dir, 'empty-volume.tar.gz'), bytes = gzipSync(Buffer.alloc(1024)); await writeFile(file, bytes);
    const backup = (await db.insert(backups).values({ volumeName: volume, scope: 'volumes', status: 'completed', serverId: d.serverId, path: file, sizeBytes: bytes.length }).returning())[0]!;
    const app = await buildTestApp({ db }); await app.register(volumeBackupRoutes, { prefix: '/volumes' });
    try {
      const response = await app.inject({ method: 'POST', url: `/volumes/${volume}/backups/${backup.id}/restore?serverId=${d.serverId}`, headers: asUser({ id: actor, isOperator: true }) });
      expect(response.statusCode).toBe(200); expect(h.streams).toHaveLength(1); expect(h.streams[0]).toMatchObject({ kind: 'volume.import', volume });
    } finally { await app.close(); }
  });
  it('ships a base then only new WAL, resumes lost local progress and restores verified remote bytes', async () => {
    await configure(); const first = await sync(); source(5); await sync();
    expect(h.streams.map((s) => (s['selection'] as { kind: string }).kind)).toEqual(['checkpoint', 'wal']);
    await db.delete(settings).where(eq(settings.key, `pitr_stream_state:${d.id}`)); source(6); await sync();
    expect(h.streams.map((s) => (s['selection'] as { kind: string }).kind)).toEqual(['checkpoint', 'wal', 'wal']);
    const restored = await loadContinuousPitr({ cfg, key: first.key, passphrase, targetTime: null }, path.join(h.dir, 'restore'));
    expect(restored.manifest.segments.map((s) => s.name)).toEqual([seg(3), seg(4), seg(5), seg(6)]);
    expect((await remotePitrStatus(db, d.id)).stream!.protection!.lastSegment).toBe(seg(6));
    expect(JSON.stringify([...h.calls, ...h.streams])).not.toContain(passphrase);
    expect(JSON.stringify([...h.calls, ...h.streams])).not.toContain(cfg.secretAccessKey);
  });
  it('supports self-contained checkpoint mode for node databases without local Docker', async () => {
    await configure('checkpoint'); const result = await sync();
    expect(result.key).toMatch(/pitr-checkpoints\/main\/.+\.ndpc$/);
    expect((await remotePitrStatus(db, d.id)).state!.status).toBe('completed');
  });
  it.each(['truncated', 'offline'])('keeps the verified remote head after a node %s failure', async (fault) => {
    await configure(); const first = await sync(); const good = Buffer.from(objects.get(first.key)!); source(5); h.fault = fault;
    await expect(sync()).rejects.toThrow();
    expect(objects.get(first.key)).toEqual(good);
    expect((await remotePitrStatus(db, d.id)).stream).toMatchObject({ status: 'failed', protection: { lastSegment: seg(4) } });
  });
  it.each(['missing capability', 'owner disabled', 'unsealed'])('refuses %s before sending node operations or storing configuration', async (fault) => {
    h.fault = fault;
    if (fault !== 'unsealed') h.caps = h.caps.filter((c) => c !== 'db.pitr.archive'); else h.sealed = false;
    await expect(configure()).rejects.toMatchObject({ statusCode: fault === 'owner disabled' ? 403 : 422, code: fault === 'unsealed' ? 'node_transport_unsealed' : fault === 'owner disabled' ? 'node_feature_disabled' : 'node_agent_outdated' });
    expect(h.calls.every((c) => c.op === 'agent.ping')).toBe(true); expect((await remotePitrStatus(db, d.id)).settings).toBeNull();
  });
  it('rejects malformed node replies instead of treating them as empty healthy inventory', async () => {
    h.fault = 'malformed reply'; await expect(nodePitrInventory(db, d)).rejects.toMatchObject({ code: 'node_pitr_unconfirmed' });
  });
  it('holds the node lifecycle lease while copying an archive', async () => {
    await withPitrArchiveRead(d, async () => {
      await expect(withNodeDatabaseLifecycle(d.id, async () => undefined)).rejects.toMatchObject({ code: 'node_database_busy' });
      expect(pitrBusy.archiveRead(d.id)).toBe(true);
    });
    await expect(withNodeDatabaseLifecycle(d.id, async () => 'released')).resolves.toBe('released');
  });
  it('enables the node archive through the mounted API and keeps status readable while its first base runs', async () => {
    await db.update(databases).set({ pitrEnabled: false }).where(eq(databases.id, d.id)); h.archive = false;
    let release!: () => void; h.baseGate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { h.started = resolve; });
    const app = await buildTestApp({ db }); await app.register(pitrRoutes, { prefix: '/databases' });
    try {
      const response = await app.inject({ method: 'PUT', url: `/databases/${d.id}/pitr`, headers: asUser({ id: actor, isOperator: true }), payload: { enabled: true } });
      expect(response.statusCode).toBe(200); await started;
      expect(response.json()).toMatchObject({ enabled: true, available: true, recoveryUnavailableReason: expect.stringContaining('offline') });
      const spec = h.calls.find((c) => c.op === 'docker.runSpec')!.params;
      expect(spec['volumes']).toContainEqual({ name: 'nd-db-main-data-wal', mount: '/nd-wal-archive' });
      expect(spec['cmd']).toContain('archive_mode=on');
      const status = await app.inject({ method: 'GET', url: `/databases/${d.id}/pitr`, headers: asUser({ id: actor, isOperator: true }) }); expect(status.statusCode).toBe(200);
      const replay = await app.inject({ method: 'POST', url: `/databases/${d.id}/pitr/recover`, headers: asUser({ id: actor, isOperator: true }), payload: { name: 'new-copy' } }); expect(replay.statusCode).toBe(422); expect(replay.body).toContain('offline');
      release(); await vi.waitFor(() => expect(pitrBusy.baseBackup(d.id)).toBe(false));
      const disabled = await app.inject({ method: 'PUT', url: `/databases/${d.id}/pitr`, headers: asUser({ id: actor, isOperator: true }), payload: { enabled: false } });
      expect(disabled.statusCode).toBe(200); expect(disabled.json().enabled).toBe(false); expect(h.archive).toBe(false);
      const stoppedSpec = h.calls.filter((c) => c.op === 'docker.runSpec').at(-1)!.params;
      expect(stoppedSpec['cmd']).toBeUndefined(); expect(stoppedSpec['volumes']).toEqual([{ name: 'nd-db-main-data', mount: '/var/lib/postgresql' }]);
    } finally { release(); await vi.waitFor(() => expect(pitrBusy.baseBackup(d.id)).toBe(false)); await app.close(); }
  });
});
