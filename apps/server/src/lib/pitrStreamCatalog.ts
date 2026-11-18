/** Authenticated remote graph: immutable generations, a conditional HEAD and restartable deletion intent. */
import { z } from 'zod';
import { checkpointManifest, validateCheckpoint, type CheckpointManifest } from '../engine/pitrCheckpoint.js';
import { parseSegment, PitrRefusal } from '../engine/postgresPitr.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const iso = z.string().datetime();
export const streamObject = z.object({ key: z.string().min(1).max(1024), sha256: hash, bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), etag: z.string().min(1).max(256) }).strict();
export const streamWal = z.object({
  name: z.string().regex(/^[0-9A-F]{24}$/), archivedAt: iso, size: z.number().int().positive(),
  plainSha256: hash, rawSha256: hash, object: streamObject,
}).strict();
export const streamGeneration = z.object({
  id: z.string().uuid(), anchor: streamObject, manifest: checkpointManifest,
  anchorLastRawSha256: hash, wal: z.array(streamWal).max(20_000), sealed: z.boolean(),
}).strict();
export const streamCatalog = z.object({
  format: z.literal('NDPITR-CATALOG1'), archiveId: z.string().uuid(), revision: z.string().uuid(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), createdAt: iso, retentionDays: z.number().int().min(1).max(35),
  systemIdentifier: z.string().regex(/^[0-9]{1,20}$/), source: checkpointManifest.shape.source,
  generations: z.array(streamGeneration).min(1).max(512),
  garbage: z.array(z.object({ key: z.string().max(1024), kind: z.enum(['data', 'catalog']), notBefore: iso }).strict()).max(200_000),
}).strict();
export const streamHead = z.object({
  format: z.literal('NDPITR-HEAD1'), archiveId: z.string().uuid(), sequence: z.number().int().positive(), catalog: streamObject,
}).strict();
export type StreamCatalog = z.infer<typeof streamCatalog>;
export type StreamGeneration = z.infer<typeof streamGeneration>;
export type StreamWal = z.infer<typeof streamWal>;
export type StreamObject = z.infer<typeof streamObject>;
export const STREAM_METADATA_MAX_BYTES = 32 * 1024 * 1024;
export const STREAM_DELETE_GRACE_MS = 60 * 60_000;
export const STREAM_DELETE_BATCH = 200;
const unsafePath = (value: string) => [...value].some((c) => c === '\\' || c.charCodeAt(0) < 32) || value.split('/').some((p) => p === '.' || p === '..');

export function safeStreamRoot(prefix: string, archiveId: string): string {
  z.string().uuid().parse(archiveId);
  const base = prefix.replace(/^\/+|\/+$/g, '');
  if (unsafePath(base)) throw new Error('Unsafe remote archive prefix');
  return `${base ? `${base}/` : ''}pitr-streams/${archiveId}/`;
}

export function streamRootFromKey(key: string): { root: string; archiveId: string } {
  const m = /^(.*pitr-streams\/([a-f0-9-]{36})\/)(?:head\.ndpi|catalog\/[a-f0-9-]{36}\.ndcat)$/.exec(key);
  if (!m) throw new Error('Invalid remote stream index key');
  const id = z.string().uuid().parse(m[2]);
  if (unsafePath(m[1]!)) throw new Error('Unsafe remote stream index key');
  return { root: m[1]!, archiveId: id };
}

export function generationManifest(g: StreamGeneration): CheckpointManifest {
  return validateCheckpoint({ ...g.manifest,
    segments: [...g.manifest.segments, ...g.wal.map((s) => ({ name: s.name, archivedAt: s.archivedAt, sizeBytes: s.size }))],
    files: [...g.manifest.files, ...g.wal.map((s) => ({ name: `wal/${s.name}.gz`, size: s.size, sha256: s.plainSha256 }))],
  });
}
export const generationThrough = (g: StreamGeneration) => g.wal.at(-1)?.archivedAt ?? g.manifest.segments.at(-1)!.archivedAt;
export const generationLastSegment = (g: StreamGeneration) => g.wal.at(-1)?.name ?? g.manifest.segments.at(-1)!.name;
export const generationLastRawHash = (g: StreamGeneration) => g.wal.at(-1)?.rawSha256 ?? g.anchorLastRawSha256;
export const generationObjects = (g: StreamGeneration) => [g.anchor, ...g.wal.map((s) => s.object)];

export function validateStreamCatalog(value: unknown, root: string, archiveId: string): StreamCatalog {
  const c = streamCatalog.parse(value);
  if (c.archiveId !== archiveId || root !== streamRootFromKey(`${root}head.ndpi`).root) throw new Error('Remote catalog namespace does not match');
  const owned = (key: string, id?: string) => {
    const suffix = key.startsWith(root) ? key.slice(root.length) : '';
    const data = /^g\/([a-f0-9-]{36})\/(?:anchor-[a-f0-9-]{36}\.ndpc|wal\/[0-9A-F]{24}-[a-f0-9-]{36}\.ndwal)$/.exec(suffix);
    return id ? data?.[1] === id : !!data || /^catalog\/[a-f0-9-]{36}\.ndcat$/.test(suffix);
  };
  const ids = new Set<string>(), live = new Set<string>();
  for (const [i, g] of c.generations.entries()) {
    if (ids.has(g.id) || g.sealed !== (i < c.generations.length - 1)) throw new Error('Invalid remote generation order');
    ids.add(g.id); generationManifest(g);
    if (JSON.stringify(g.manifest.source) !== JSON.stringify(c.source)) throw new Error('Remote generation source changed');
    if (i > 0) {
      const previous = c.generations[i - 1]!;
      if (Date.parse(previous.manifest.base.finishedAt) > Date.parse(g.manifest.base.finishedAt) || Date.parse(generationThrough(previous)) < Date.parse(g.manifest.base.finishedAt)) throw new PitrRefusal('Remote base backups do not have overlapping recovery windows.');
      if (parseSegment(g.manifest.base.startSegment)!.timeline !== parseSegment(previous.manifest.base.startSegment)!.timeline) throw new Error('Remote archive timeline changed');
    }
    for (const ref of generationObjects(g)) {
      if (!owned(ref.key, g.id) || live.has(ref.key)) throw new Error('Remote object is outside its generation or is shared');
      live.add(ref.key);
    }
  }
  const dead = new Set<string>();
  for (const item of c.garbage) {
    if (!owned(item.key) || live.has(item.key) || dead.has(item.key) || item.key === `${root}catalog/${c.revision}.ndcat`) throw new Error('Unsafe remote deletion intent');
    if ((item.kind === 'catalog') !== item.key.startsWith(`${root}catalog/`)) throw new Error('Remote deletion kind does not match');
    dead.add(item.key);
  }
  return c;
}

/** Preserve the base at/before the boundary and every newer generation, including the newest when all are old. */
export function retainStreamGenerations(c: StreamCatalog, days: number, now: Date): void {
  const boundary = now.getTime() - days * 24 * 60 * 60_000;
  let anchor = 0;
  // PostgreSQL history timestamps have second precision: do not drop the predecessor at a subsecond boundary.
  for (let i = 0; i < c.generations.length; i++) if (Date.parse(c.generations[i]!.manifest.base.finishedAt) + 1000 <= boundary) anchor = i;
  const retiring = c.generations.splice(0, anchor);
  const known = new Set(c.garbage.map((g) => g.key));
  for (const g of retiring) for (const object of generationObjects(g)) {
    if (!known.has(object.key)) c.garbage.push({ key: object.key, kind: 'data', notBefore: new Date(now.getTime() + STREAM_DELETE_GRACE_MS).toISOString() });
  }
  c.retentionDays = days;
}
