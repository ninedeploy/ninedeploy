/** Portable, self-contained PITR checkpoints. The outer format has no tar paths or links. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { z } from 'zod';
import type { Database } from '@ninedeploy/db';
import { run } from '../lib/exec.js';
import { ENGINES, volumeExists } from './database.js';
import { PITR_ARCHIVE_MOUNT, PITR_HELPER_FLAGS, pitrArchiveVolume } from './pitrArchive.js';
import { parseSegment, planRecovery, readPitrInventory, PitrRefusal, type PitrInventory } from './postgresPitr.js';

const iso = z.string().datetime();
const segment = z.string().regex(/^[0-9A-F]{24}$/).refine((s) => parseSegment(s) !== null);
const baseSchema = z.object({
  label: z.string().regex(/^nd-[0-9TZ]{16,24}$/), startSegment: segment,
  historyFile: z.string().regex(/^[0-9A-F]{24}\.[0-9A-F]{8}\.backup$/),
  timeline: z.number().int().positive(), startedAt: iso, finishedAt: iso, sizeBytes: z.number().int().nonnegative(),
}).strict();
export const checkpointManifest = z.object({
  format: z.literal('NDPITR1'), createdAt: iso,
  source: z.object({ slug: z.string().min(1).max(100), version: z.string().regex(/^\d+(?:\.\d+)*(?:-(?:alpine[0-9.]*|bookworm|bullseye|trixie))?$/), username: z.string().min(1).max(100), dbName: z.string().min(1).max(100) }).strict(),
  base: baseSchema,
  segments: z.array(z.object({ name: segment, archivedAt: iso, sizeBytes: z.number().int().nonnegative() }).strict()).min(1).max(20_000),
  files: z.array(z.object({ name: z.string().max(150), size: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(4).max(20_003),
}).strict();
export type CheckpointManifest = z.infer<typeof checkpointManifest>;
const MAX_HEADER = 8 * 1024 * 1024;

/** This slice carries base.tar.gz only; pg_basebackup emits separate archives for extra tablespaces. */
async function assertCheckpointLayout(file: string): Promise<void> {
  if ((await stat(file)).size > 32 * 1024 * 1024) throw new PitrRefusal('The PostgreSQL backup manifest exceeds this checkpoint slice\'s 32 MiB limit.');
  const pg = JSON.parse(await readFile(file, 'utf8')) as { Files?: Array<{ Path?: unknown; 'Encoded-Path'?: unknown }> };
  if (!Array.isArray(pg.Files)) throw new PitrRefusal('The base backup has no readable PostgreSQL file manifest.');
  for (const entry of pg.Files) {
    const encoded = entry['Encoded-Path'];
    const name = typeof entry.Path === 'string' ? entry.Path : typeof encoded === 'string' && /^(?:[a-fA-F0-9]{2})+$/.test(encoded) ? Buffer.from(encoded, 'hex').toString('utf8') : null;
    if (name === null) throw new PitrRefusal('The PostgreSQL backup manifest contains an invalid file path.');
    if (name.startsWith('pg_tblspc/')) throw new PitrRefusal('Remote checkpoints do not yet support additional PostgreSQL tablespaces; their separate archives are not included in this slice.');
  }
}

export function checkpointInventory(m: CheckpointManifest): PitrInventory {
  return {
    baseBackups: [{ ...m.base, startedAt: new Date(m.base.startedAt), finishedAt: new Date(m.base.finishedAt) }],
    segments: m.segments.map((s) => ({ ...s, ...parseSegment(s.name)!, archivedAt: new Date(s.archivedAt) })),
    pendingBaseDirs: [], partialFiles: [], archiveBytes: m.files.reduce((n, f) => n + f.size, 0),
  };
}

/** Only these exact regular files may be published or imported. */
export function validateCheckpoint(value: unknown): CheckpointManifest {
  const m = checkpointManifest.parse(value);
  const names = [`base/${m.base.label}/base.tar.gz`, `base/${m.base.label}/backup_manifest`, `wal/${m.base.historyFile}.gz`, ...m.segments.map((s) => `wal/${s.name}.gz`)];
  if (new Set(names).size !== names.length || m.files.length !== names.length || m.files.some((f, i) => f.name !== names[i])) throw new Error('Checkpoint file list is invalid');
  const plan = planRecovery(checkpointInventory(m), null);
  if ('refusal' in plan) throw new PitrRefusal(plan.refusal);
  const start = parseSegment(m.base.startSegment)!;
  if (!m.base.historyFile.startsWith(`${m.base.startSegment}.`) || m.segments.some((s, i) => parseSegment(s.name)!.ordinal !== start.ordinal + i)) throw new Error('Checkpoint segment order is invalid');
  if (Date.parse(m.base.startedAt) > Date.parse(m.base.finishedAt) || Date.parse(m.base.finishedAt) > Date.parse(m.segments.at(-1)!.archivedAt)) throw new Error('Checkpoint time bounds are invalid');
  if (plan.segments.length !== m.segments.length || plan.base.timeline !== parseSegment(m.base.startSegment)!.timeline || m.segments.some((s) => parseSegment(s.name)!.timeline !== m.base.timeline)) throw new Error('Checkpoint WAL chain is invalid');
  if (m.files[0]!.size !== m.base.sizeBytes || m.segments.some((s, i) => s.sizeBytes !== m.files[i + 3]!.size)) throw new Error('Checkpoint sizes disagree');
  return m;
}

export async function hashCheckpointFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Validate the actual WAL bytes, not gzip headers that can change across retries. */
export async function walFileDigest(file: string): Promise<string> {
  let bytes = 0;
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), createGunzip(), new Writable({ write(chunk: Buffer, _encoding, done) {
    bytes += chunk.length; hash.update(chunk);
    done(bytes > 16 * 1024 * 1024 ? new Error('WAL segment exceeds 16 MiB') : null);
  } }));
  if (bytes !== 16 * 1024 * 1024) throw new PitrRefusal('The archived WAL segment is damaged or has an unsupported size.');
  return hash.digest('hex');
}

/** An exact uint64 identity: JSON.parse would round PostgreSQL's numeric system identifier. */
export async function checkpointSystemIdentifier(manifestFile: string): Promise<string | undefined> {
  const text = await readFile(manifestFile, 'utf8');
  return /"System-Identifier"\s*:\s*(?:"([0-9]+)"|([0-9]+))/.exec(text)?.slice(1).find(Boolean);
}

/** Source files are a private scratch copy; stream them without buffering a base backup. */
export async function packCheckpoint(manifest: CheckpointManifest, files: string[], output: string): Promise<void> {
  validateCheckpoint(manifest);
  const header = Buffer.from(JSON.stringify(manifest));
  if (header.length > MAX_HEADER) throw new Error('Checkpoint manifest is too large');
  const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
  await writeFile(output, Buffer.concat([Buffer.from('NDPITR1\n'), size, header]), { mode: 0o600, flag: 'wx' });
  for (let i = 0; i < manifest.files.length; i++) {
    const file = files[i]!;
    if (!(await lstat(file)).isFile() || (await stat(file)).size !== manifest.files[i]!.size || await hashCheckpointFile(file) !== manifest.files[i]!.sha256) throw new Error('Checkpoint source changed or is not a regular file');
    await pipeline(createReadStream(file), createWriteStream(output, { flags: 'a' }));
  }
}

/** Authenticate/decrypt before calling this. Validate every byte before any Docker volume is created. */
export async function unpackCheckpoint(input: string, directory: string): Promise<{ manifest: CheckpointManifest; files: string[] }> {
  const handle = await open(input, 'r');
  let m: CheckpointManifest;
  let offset: number;
  try {
    const prefix = Buffer.alloc(12);
    if ((await handle.read(prefix, 0, 12, 0)).bytesRead !== 12 || prefix.subarray(0, 8).toString() !== 'NDPITR1\n') throw new Error('Not a PITR checkpoint');
    const length = prefix.readUInt32BE(8);
    if (length === 0 || length > MAX_HEADER) throw new Error('Invalid checkpoint manifest length');
    const header = Buffer.alloc(length);
    if ((await handle.read(header, 0, length, 12)).bytesRead !== length) throw new Error('Truncated checkpoint manifest');
    m = validateCheckpoint(JSON.parse(header.toString('utf8')));
    offset = 12 + length;
    const total = m.files.reduce((n, f) => n + f.size, offset);
    if (!Number.isSafeInteger(total) || total !== (await handle.stat()).size) throw new Error('Checkpoint is truncated or has trailing data');
  } finally { await handle.close(); }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files: string[] = [];
  for (const [i, f] of m.files.entries()) {
    const file = path.join(directory, String(i));
    await pipeline(createReadStream(input, { start: offset, end: offset + f.size - 1 }), createWriteStream(file, { mode: 0o600, flags: 'wx' }));
    if (await hashCheckpointFile(file) !== f.sha256) throw new Error(`Checkpoint integrity failed: ${f.name}`);
    files.push(file); offset += f.size;
  }
  await assertCheckpointLayout(files[1]!);
  return { manifest: m, files };
}

/** Read-only helper, never the live data volume. A database-controlled link is refused by docker cp + lstat. */
export async function createPitrCheckpoint(d: Database, dir: string, log: (line: string) => void, snapshot?: { throughSegment: string }): Promise<{ file: string; manifest: CheckpointManifest; systemIdentifier?: string; rawWalHashes: Record<string, string> }> {
  const inv = await readPitrInventory(d);
  if (snapshot) {
    const end = parseSegment(snapshot.throughSegment);
    if (!end || !inv.segments.some((s) => s.name === snapshot.throughSegment)) throw new PitrRefusal('The selected WAL snapshot is no longer present.');
    inv.segments = inv.segments.filter((s) => s.timeline === end.timeline && s.ordinal <= end.ordinal);
  }
  const plan = planRecovery(inv, null);
  if ('refusal' in plan) throw new PitrRefusal(plan.refusal);
  const helper = `nd-pitr-export-${randomUUID()}`;
  const image = ENGINES.postgres!.image(d.version ?? undefined);
  const base = plan.base;
  const names = [`base/${base.label}/base.tar.gz`, `base/${base.label}/backup_manifest`, `wal/${base.historyFile}.gz`, ...plan.segments.map((s) => `wal/${s.name}.gz`)];
  const files: string[] = [];
  const entries: CheckpointManifest['files'] = [];
  const rawWalHashes: Record<string, string> = {};
  let created = false;
  try {
    await run('docker', ['create', '--name', helper, '--label', 'ninedeploy.role=pitr-checkpoint', ...PITR_HELPER_FLAGS, '--user', 'postgres', '-v', `${pitrArchiveVolume(d.volumeName!)}:${PITR_ARCHIVE_MOUNT}:ro`, '--entrypoint', 'sh', image, '-c', 'exit 0'], {}, log);
    created = true;
    for (const [i, name] of names.entries()) {
      const file = path.join(dir, `source-${i}`);
      await run('docker', ['cp', `${helper}:${PITR_ARCHIVE_MOUNT}/${name}`, file], { timeoutMs: 30 * 60_000 }, log);
      const s = await lstat(file);
      if (!s.isFile() || s.nlink !== 1) throw new Error('Archive contains a non-regular file');
      if (name.endsWith('.gz')) {
        if (i >= 3) rawWalHashes[plan.segments[i - 3]!.name] = await walFileDigest(file);
        else {
        let bytes = 0;
        await pipeline(createReadStream(file), createGunzip(), new Writable({ write(chunk: Buffer, _encoding, done) {
          bytes += chunk.length;
          done(null);
        } }));
        if (bytes === 0) throw new Error('The archived gzip file is empty');
        }
      }
      files.push(file); entries.push({ name, size: s.size, sha256: await hashCheckpointFile(file) });
    }
    await assertCheckpointLayout(files[1]!);
    const manifest = validateCheckpoint({
      format: 'NDPITR1', createdAt: new Date().toISOString(),
      source: { slug: d.slug, version: d.version ?? '18', username: d.username ?? 'nine', dbName: d.dbName ?? 'app' },
      base: { ...base, startedAt: base.startedAt.toISOString(), finishedAt: base.finishedAt.toISOString() },
      segments: plan.segments.map((s) => ({ name: s.name, archivedAt: s.archivedAt.toISOString(), sizeBytes: s.sizeBytes })), files: entries,
    });
    const file = path.join(dir, 'checkpoint');
    await packCheckpoint(manifest, files, file);
    return { file, manifest, systemIdentifier: await checkpointSystemIdentifier(files[1]!), rawWalHashes };
  } finally { if (created) await run('docker', ['rm', '-f', helper], {}, log); }
}

/** Copy only selected closed segments. The caller pins local archive retention. */
export async function copyPitrWal(d: Database, names: string[], directory: string, log: (line: string) => void, identityBase: string) {
  if (names.length > 20_000 || names.some((name) => parseSegment(name) === null)) throw new Error('Invalid WAL copy request');
  if (!/^nd-[0-9TZ]{16,24}$/.test(identityBase)) throw new Error('Invalid base backup label');
  const helper = `nd-pitr-export-${randomUUID()}`;
  const copied = new Map<string, { file: string; sha256: string; rawSha256: string; size: number }>();
  let created = false;
  try {
    await run('docker', ['create', '--name', helper, '--label', 'ninedeploy.role=pitr-checkpoint', ...PITR_HELPER_FLAGS, '--user', 'postgres', '-v', `${pitrArchiveVolume(d.volumeName!)}:${PITR_ARCHIVE_MOUNT}:ro`, '--entrypoint', 'sh', ENGINES.postgres!.image(d.version ?? undefined), '-c', 'exit 0'], {}, log);
    created = true;
    const identity = path.join(directory, 'identity');
    await run('docker', ['cp', `${helper}:${PITR_ARCHIVE_MOUNT}/base/${identityBase}/backup_manifest`, identity], { timeoutMs: 120_000 }, log);
    const metadataStat = await lstat(identity);
    if (!metadataStat.isFile() || metadataStat.nlink !== 1) throw new Error('Archive identity is not a regular file');
    await assertCheckpointLayout(identity);
    for (const [i, name] of names.entries()) {
      const file = path.join(directory, `wal-${i}`);
      await run('docker', ['cp', `${helper}:${PITR_ARCHIVE_MOUNT}/wal/${name}.gz`, file], { timeoutMs: 120_000 }, log);
      const s = await lstat(file);
      if (!s.isFile() || s.nlink !== 1) throw new Error('WAL archive contains a non-regular file');
      copied.set(name, { file, sha256: await hashCheckpointFile(file), rawSha256: await walFileDigest(file), size: s.size });
    }
    return { files: copied, systemIdentifier: await checkpointSystemIdentifier(identity) };
  } finally { if (created) await run('docker', ['rm', '-f', helper], {}, log); }
}

/** Import to a fresh staging archive only. Existing volumes are never replaced. Caller owns cleanup. */
export async function importPitrCheckpoint(unpacked: { manifest: CheckpointManifest; files: string[] }, volume: string, log: (line: string) => void): Promise<void> {
  const m = validateCheckpoint(unpacked.manifest);
  if (!/^nd-pitr-remote-[0-9a-f-]{36}-wal$/.test(volume)) throw new Error('Invalid staging archive name');
  if (await volumeExists(volume)) throw new Error('Staging archive already exists');
  const helper = `nd-pitr-import-${randomUUID()}`;
  let created = false;
  try {
    await run('docker', ['volume', 'create', '--label', 'ninedeploy.managed=pitr-remote-staging', volume], {}, log);
    await run('docker', ['run', '-d', '--name', helper, '--label', 'ninedeploy.role=pitr-checkpoint', ...PITR_HELPER_FLAGS, '--user', '0', '-v', `${volume}:${PITR_ARCHIVE_MOUNT}`, '--entrypoint', 'sh', ENGINES.postgres!.image(m.source.version), '-c', 'sleep 21600'], {}, log);
    created = true;
    await run('docker', ['exec', helper, 'mkdir', '-p', `${PITR_ARCHIVE_MOUNT}/wal`, `${PITR_ARCHIVE_MOUNT}/base/${m.base.label}`], {}, log);
    for (const [i, f] of m.files.entries()) {
      await run('docker', ['cp', unpacked.files[i]!, `${helper}:${PITR_ARCHIVE_MOUNT}/${f.name}`], { timeoutMs: 30 * 60_000 }, log);
      const at = i < 3 ? m.base.finishedAt : m.segments[i - 3]!.archivedAt;
      await run('docker', ['exec', helper, 'touch', '-d', `@${Date.parse(at) / 1000}`, `${PITR_ARCHIVE_MOUNT}/${f.name}`], {}, log);
    }
    // Public files in an otherwise isolated new archive, readable by the image's postgres uid.
    await run('docker', ['exec', helper, 'chmod', '-R', 'a+rX', PITR_ARCHIVE_MOUNT], {}, log);
  } finally { if (created) await run('docker', ['rm', '-f', helper], {}, log); }
}
