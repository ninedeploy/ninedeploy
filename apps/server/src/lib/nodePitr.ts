/** Panel adapter for node archives. The agent supplies verified source bytes; remote keys and S3 secrets stay here. */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { Database, DB } from '@ninedeploy/db';
import { agentReplyCall } from './nodeAgentReply.js';
import { assertNodeCapability } from './agentCapabilities.js';
import { openAgentStream } from './agentStream.js';
import { NODE_PITR_CAPABILITY, NODE_PITR_REPLY, nodePitrTarget } from './nodePitrContract.js';
import { withNodeDatabaseLifecycle } from './nodeDatabaseLifecycle.js';
import { databaseRuntime } from './databaseRuntime.js';
import { withDatabaseOperationLock } from '../engine/database.js';
import { checkpointManifest, checkpointSystemIdentifier, unpackCheckpoint, walFileDigest, type createPitrCheckpoint } from '../engine/pitrCheckpoint.js';
import { unpackPitrWal } from '../engine/pitrWalTransfer.js';
import { parseSegment, type PitrInventory } from '../engine/postgresPitr.js';
import type { PitrDeps } from './pitr.js';

const iso = z.string().datetime();
const segment = z.string().regex(/^[0-9A-F]{24}$/);
const inventory = z.object({
  segments: z.array(z.object({ name: segment, timeline: z.number().int().positive(), ordinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sizeBytes: z.number().int().nonnegative(), archivedAt: iso }).strict()).max(200_000),
  baseBackups: z.array(checkpointManifest.shape.base).max(10_000),
  pendingBaseDirs: z.array(z.object({ label: z.string().regex(/^nd-[0-9TZ]{16,24}$/), modifiedAt: iso }).strict()),
  partialFiles: z.array(z.object({ name: z.string().max(128), modifiedAt: iso }).strict()),
  archiveBytes: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict().transform((v): PitrInventory => ({ ...v,
  segments: v.segments.map((s) => { const parsed = parseSegment(s.name); if (!parsed || parsed.timeline !== s.timeline || parsed.ordinal !== s.ordinal) throw new Error('Invalid node archive segment identity'); return { ...s, archivedAt: new Date(s.archivedAt) }; }),
  baseBackups: v.baseBackups.map((b) => ({ ...b, startedAt: new Date(b.startedAt), finishedAt: new Date(b.finishedAt) })),
  pendingBaseDirs: v.pendingBaseDirs.map((b) => ({ ...b, modifiedAt: new Date(b.modifiedAt) })),
  partialFiles: v.partialFiles.map((b) => ({ ...b, modifiedAt: new Date(b.modifiedAt) })),
}));
const archiver = z.object({ archivedCount: z.number().nonnegative(), failedCount: z.number().nonnegative(), lastArchivedAt: iso.nullable(), lastFailedAt: iso.nullable() }).strict().nullable().transform((s) => s && ({ ...s, lastArchivedAt: s.lastArchivedAt ? new Date(s.lastArchivedAt) : null, lastFailedAt: s.lastFailedAt ? new Date(s.lastFailedAt) : null }));

export async function assertNodePitrCapable(db: DB, d: Database) {
  if (d.serverId == null) return;
  await assertNodeCapability(db, d.serverId, { cap: ['db.manage', 'stream', NODE_PITR_CAPABILITY], feature: 'archive PostgreSQL WAL on a node', sealedRequired: true });
}
async function call<T>(db: DB, d: Database, action: string, shape: z.ZodType<T>, extra: Record<string, unknown> = {}) {
  await assertNodePitrCapable(db, d);
  return agentReplyCall(db, d.serverId!, 'db.pitr', { database: nodePitrTarget(d), action, ...extra }, { prefix: NODE_PITR_REPLY, shape,
    timeoutMs: action === 'baseBackup' ? 6 * 60 * 60_000 + 240_000 : action === 'prune' ? 13 * 60_000 : 11 * 60_000,
    unconfirmed: { code: 'node_pitr_unconfirmed', message: 'The node did not confirm the PostgreSQL archive operation' } });
}
export const nodePitrInventory = async (db: DB, d: Database) => (await call(db, d, 'inventory', z.object({ inventory }))).inventory;

async function receive(db: DB, d: Database, selection: Record<string, unknown>, file: string) {
  await assertNodePitrCapable(db, d);
  const stream = await openAgentStream(db, d.serverId!, 'db.pitr.export', { database: nodePitrTarget(d), selection });
  stream.done.catch(() => undefined);
  if (stream.direction !== 'agent-to-panel') { stream.abort('wrong archive direction'); throw new Error('Wrong node archive stream direction'); }
  try { await Promise.all([pipeline(stream.readable, createWriteStream(file, { mode: 0o600, flags: 'wx' })), stream.done]); }
  catch (err) { stream.abort('archive copy failed'); throw err; }
}
export async function nodePitrCheckpoint(db: DB, d: Database, dir: string, _log: (line: string) => void, snapshot?: { throughSegment: string }): ReturnType<typeof createPitrCheckpoint> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'checkpoint');
  await receive(db, d, { kind: 'checkpoint', ...snapshot }, file);
  const unpacked = await unpackCheckpoint(file, path.join(dir, 'node-anchor-files'));
  const expected = { slug: d.slug, version: d.version ?? '18', username: d.username ?? 'nine', dbName: d.dbName ?? 'app' };
  if (JSON.stringify(unpacked.manifest.source) !== JSON.stringify(expected)) throw new Error('The node checkpoint belongs to a different database');
  if (snapshot && unpacked.manifest.segments.at(-1)!.name !== snapshot.throughSegment) throw new Error('The node checkpoint boundary changed');
  const rawWalHashes: Record<string, string> = {};
  for (const [i, s] of unpacked.manifest.segments.entries()) rawWalHashes[s.name] = await walFileDigest(unpacked.files[i + 3]!);
  return { file, manifest: unpacked.manifest, systemIdentifier: await checkpointSystemIdentifier(unpacked.files[1]!), rawWalHashes };
}
export async function nodePitrWal(db: DB, d: Database, names: string[], dir: string, _log: (line: string) => void, identityBase: string) {
  const file = path.join(dir, 'node-wal-transfer');
  await receive(db, d, { kind: 'wal', names, identityBase }, file);
  return unpackPitrWal(file, path.join(dir, 'node-wal-files'), names);
}

export function nodePitrDeps(db: DB, d: Database): PitrDeps {
  const mutate = <T>(fn: () => Promise<T>) => withNodeDatabaseLifecycle(d.id, () => withDatabaseOperationLock(d.id, () => undefined, fn));
  return {
    start: (row, log) => databaseRuntime(db, row).start(log), stop: (row, log) => databaseRuntime(db, row).stop(log), probe: (row) => databaseRuntime(db, row).probeCredentials(45, 2000),
    preflight: async () => (await call(db, d, 'preflight', z.object({ refusal: z.string().nullable() }))).refusal,
    archiveExists: async () => (await call(db, d, 'archiveExists', z.object({ exists: z.boolean() }))).exists,
    removeArchive: async () => { await call(db, d, 'removeArchive', z.object({ removed: z.literal(true) })); },
    baseBackup: () => mutate(async () => (await call(db, d, 'baseBackup', z.object({ label: z.string().regex(/^nd-[0-9TZ]{16,24}$/) }))).label),
    prune: (_d, days) => mutate(() => call(db, d, 'prune', z.object({ removedBases: z.array(z.string()) }), { retentionDays: days })),
    inventory: () => nodePitrInventory(db, d), archiver: async () => (await call(db, d, 'archiver', z.object({ archiver }))).archiver,
    volumeExists: async () => { throw new Error('Node volume adoption is unavailable'); }, removeVolume: async () => { throw new Error('Node volume removal is unavailable'); },
    recover: async () => { throw new Error('Use offline remote archive recovery'); },
  };
}
