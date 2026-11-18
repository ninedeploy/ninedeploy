/** Continuous closed-WAL shipping, atomic index publication and generation-aware retention. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from '@ninedeploy/db';
import { config } from '../config.js';
import { copyPitrWal, createPitrCheckpoint, hashCheckpointFile, unpackCheckpoint, walFileDigest } from '../engine/pitrCheckpoint.js';
import { parseSegment, planRecovery, PitrRefusal, readPitrInventory, segmentName, type PitrSegment } from '../engine/postgresPitr.js';
import { checkpointInventory } from '../engine/pitrCheckpoint.js';
import { withPitrArchiveRead } from './pitr.js';
import { pitrStreamStorage, type PitrStreamStorage } from './pitrStreamIO.js';
import type { PitrStreamState } from './pitrRemoteState.js';
import {
  generationLastRawHash, generationLastSegment, generationManifest, generationThrough, retainStreamGenerations,
  safeStreamRoot, streamRootFromKey, validateStreamCatalog, STREAM_DELETE_BATCH, STREAM_DELETE_GRACE_MS,
  type StreamCatalog, type StreamGeneration,
} from './pitrStreamCatalog.js';
import type { S3Config } from './s3.js';
import { stagePitrOrphans } from './pitrOrphans.js';

const WAL_BATCH = 128;
export const continuousPitrDeps = { inventory: readPitrInventory, anchor: createPitrCheckpoint, wal: copyPitrWal, storage: pitrStreamStorage };
export interface ContinuousPitrInput {
  cfg: S3Config; prefix: string; archiveId: string; passphrase: string; retentionDays: number;
  previous: PitrStreamState | null;
  save: (state: PitrStreamState) => Promise<void>;
  onAdmitted?: () => void;
  now?: () => Date;
  collectOrphans?: boolean;
}

/** Only already committed tombstones may be consumed. New retirement is first published, then delayed. */
async function collectGarbage(c: StreamCatalog, store: PitrStreamStorage, now: Date) {
  const due = c.garbage.filter((g) => Date.parse(g.notBefore) <= now.getTime()).slice(0, STREAM_DELETE_BATCH);
  if (due.some((g) => g.kind === 'data')) {
    await verifyRetained(c, store);
  }
  const deleted = new Set<string>();
  let failure: unknown;
  for (const item of due) {
    try { await store.remove(item.key); deleted.add(item.key); }
    catch (err) { failure = err; break; }
  }
  return { remaining: c.garbage.filter((g) => !deleted.has(g.key)), failure };
}

async function verifyRetained(c: StreamCatalog, store: PitrStreamStorage) {
  const refs = c.generations.flatMap((g) => [g.anchor, ...g.wal.map((s) => s.object)]);
  for (let i = 0; i < refs.length; i += 16) await Promise.all(refs.slice(i, i + 16).map((ref) => store.verifyReference(ref)));
}

export async function runContinuousPitr(d: Database, input: ContinuousPitrInput, log: (line: string) => void, deps = continuousPitrDeps) {
  const now = input.now ?? (() => new Date());
  const root = safeStreamRoot(input.prefix, input.archiveId);
  const attemptedAt = now().toISOString();
  let protection = input.previous?.archiveId === input.archiveId ? input.previous.protection : null;
  let pending = input.previous?.gcPending ?? 0;
  let orphanSweep = input.collectOrphans && input.previous?.archiveId === input.archiveId ? input.previous.orphanSweep : undefined;
  const save = (status: PitrStreamState['status'], error: string | null = null, missingSegment: string | null = null) => input.save({ archiveId: input.archiveId, status, attemptedAt, error, missingSegment, protection, gcPending: pending, ...(orphanSweep ? { orphanSweep } : {}) });
  const scratch = path.join(config.paths.dataDir, 'pitr-streams');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(path.join(scratch, 'sync-'));
  try {
    await save('running'); input.onAdmitted?.();
    const store = deps.storage(input.cfg, root, input.archiveId, input.passphrase, dir);
    const loaded = await store.load();
    if (!loaded && protection) throw new PitrRefusal('The previously verified remote index is missing; deletion and publication are held. Restore it or explicitly start a new archive.');
    if (loaded && protection && loaded.catalog.sequence < protection.sequence) throw new PitrRefusal('The remote archive index moved backwards; publication and deletion are held.');
    await store.assertConditionalWrites();
    // Validate discovery access before copying/uploading more objects on a misconfigured destination.
    const page = input.collectOrphans && loaded ? await store.listPage(orphanSweep?.cursor ?? undefined).catch(() => {
      throw new PitrRefusal('Abandoned upload discovery failed; archive index publication and deletion were held. Check ListBucket permission and listing support, or turn off collection.');
    }) : null;
    const c: StreamCatalog | null = loaded ? structuredClone(loaded.catalog) : null;
    const active = c?.generations.at(-1);
    if (c) {
      for (const g of c.generations) await store.verifyReference(g.anchor);
      if (active?.wal.length) await store.verifyReference(active.wal.at(-1)!.object);
    }
    // All source copies happen under the same pin as local retention and manual base-backup admission.
    const snapshot = await withPitrArchiveRead(d, async () => {
      const inv = await deps.inventory(d);
      const latestBase = inv.baseBackups.at(-1);
      if (!latestBase) throw new PitrRefusal('No completed base backup is available for continuous remote archiving.');
      if (!active) {
        const built = await deps.anchor(d, dir, log);
        if (!built.systemIdentifier) throw new PitrRefusal('Continuous archiving requires a PostgreSQL backup manifest containing System-Identifier.');
        return { built, copied: null, tail: [] as PitrSegment[], rotate: true };
      }
      const last = parseSegment(generationLastSegment(active))!;
      const segments = new Map(inv.segments.filter((s) => s.timeline === last.timeline).map((s) => [s.ordinal, s]));
      const latest = Math.max(last.ordinal, ...segments.keys());
      if (!segments.has(last.ordinal)) throw new PitrRefusal(`Segment ${generationLastSegment(active)} is missing from the local archive; continuous shipping cannot confirm its boundary.`);
      const end = Math.min(latest, last.ordinal + WAL_BATCH);
      const tail: PitrSegment[] = [];
      for (let n = last.ordinal + 1; n <= end; n++) {
        const s = segments.get(n);
        if (!s) throw new PitrRefusal(`Segment ${segmentName(last.timeline, n)} is missing from the local archive.`);
        tail.push(s);
      }
      const rotate = latestBase.label !== active.manifest.base.label && end === latest;
      const built = rotate ? await deps.anchor(d, dir, log, { throughSegment: segmentName(last.timeline, end) }) : null;
      const copied = await deps.wal(d, [generationLastSegment(active), ...tail.map((s) => s.name)], dir, log, latestBase.label);
      if (!copied.systemIdentifier || copied.systemIdentifier !== c!.systemIdentifier || built && built.systemIdentifier !== c!.systemIdentifier) throw new PitrRefusal('The PostgreSQL cluster identity changed; start a separate remote archive.');
      if (copied.files.get(generationLastSegment(active))!.rawSha256 !== generationLastRawHash(active)) throw new PitrRefusal('The local WAL boundary differs from the verified remote history; publication is held.');
      return { built, copied, tail, rotate };
    });
    let catalog = c;
    if (!catalog) {
      const built = snapshot.built!;
      catalog = { format: 'NDPITR-CATALOG1', archiveId: input.archiveId, revision: randomUUID(), sequence: 1, createdAt: now().toISOString(), retentionDays: input.retentionDays,
        systemIdentifier: built.systemIdentifier!, source: built.manifest.source, generations: [], garbage: [] };
    }
    if (active && snapshot.copied) {
      for (const s of snapshot.tail) {
        const file = snapshot.copied.files.get(s.name)!;
        const object = await store.upload(file.file, `${root}g/${active.id}/wal/${s.name}-${randomUUID()}.ndwal`);
        active.wal.push({ name: s.name, archivedAt: s.archivedAt.toISOString(), size: file.size, plainSha256: file.sha256, rawSha256: file.rawSha256, object });
      }
    }
    if (snapshot.built) {
      const built = snapshot.built, id = randomUUID();
      const anchor = await store.upload(built.file, `${root}g/${id}/anchor-${randomUUID()}.ndpc`);
      if (active) active.sealed = true;
      catalog.generations.push({ id, anchor, manifest: built.manifest, anchorLastRawSha256: built.rawWalHashes[built.manifest.segments.at(-1)!.name]!, wal: [], sealed: false });
    }
    // First validate the whole graph; a failed handoff cannot remove an older generation.
    catalog.revision = randomUUID();
    catalog.sequence = (loaded?.catalog.sequence ?? 0) + 1;
    catalog.createdAt = now().toISOString();
    validateStreamCatalog(catalog, root, input.archiveId);
    // A page can still contain objects consumed by this pass's GC; never rediscover those intents.
    const previouslyRetired = new Set(catalog.garbage.map(g => g.key));
    const gc = await collectGarbage(catalog, store, now());
    catalog.garbage = gc.remaining;
    const nextSweep = page ? { cursor: page.cursor, scannedAt: now().toISOString(), found: stagePitrOrphans(catalog, root, loaded!.catalogRef.key, { ...page, objects: page.objects.filter(o => !previouslyRetired.has(o.key)) }, now()) } : orphanSweep;
    const count = catalog.generations.length;
    retainStreamGenerations(catalog, input.retentionDays, now());
    if (catalog.generations.length !== count) await verifyRetained(catalog, store);
    if (loaded) catalog.garbage.push({ key: loaded.catalogRef.key, kind: 'catalog', notBefore: new Date(now().getTime() + STREAM_DELETE_GRACE_MS).toISOString() });
    const published = await store.publish(catalog, loaded?.etag ?? null);
    orphanSweep = nextSweep;
    const newest = catalog.generations.at(-1)!;
    protection = { sequence: catalog.sequence, headKey: `${root}head.ndpi`, catalogKey: published.catalogRef.key, verifiedAt: now().toISOString(), baseLabel: newest.manifest.base.label,
      headSha256: published.headSha256, headBytes: published.headBytes,
      lastSegment: generationLastSegment(newest), from: catalog.generations[0]!.manifest.base.finishedAt, through: generationThrough(newest),
      ranges: catalog.generations.map((g) => ({ from: g.manifest.base.finishedAt, through: generationThrough(g) })) };
    pending = catalog.garbage.length;
    if (gc.failure) throw new PitrRefusal('Remote data was published, but deletion of expired objects failed; cleanup will retry.');
    await save('completed');
    return protection;
  } catch (err) {
    const message = err instanceof PitrRefusal ? err.message : 'Continuous WAL shipping or verification failed. Check the archive index, destination and panel log.';
    await save('failed', message, /Segment ([0-9A-F]{24}) is missing/.exec(message)?.[1] ?? null).catch(() => undefined);
    throw err;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Read-only disaster recovery. Every required byte is authenticated before creating a data volume. */
export async function loadContinuousPitr(input: { cfg: S3Config; key: string; passphrase: string; targetTime: Date | null }, directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { root, archiveId } = streamRootFromKey(input.key);
  const store = pitrStreamStorage(input.cfg, root, archiveId, input.passphrase, directory);
  const loaded = input.key.endsWith('/head.ndpi') ? await store.load() : null;
  if (input.key.endsWith('/head.ndpi') && !loaded) throw new PitrRefusal('The remote archive index is missing.');
  const catalog = loaded?.catalog ?? await store.readCatalog(input.key);
  const candidates = input.targetTime ? catalog.generations.filter((g) => Date.parse(g.manifest.base.finishedAt) < input.targetTime!.getTime()) : [catalog.generations.at(-1)!];
  let generation: StreamGeneration | undefined;
  let requiredThrough = Number.MAX_SAFE_INTEGER;
  let refusal = 'No remote base backup covers the requested target.';
  for (const g of [...candidates].reverse()) {
    const plan = planRecovery(checkpointInventory(generationManifest(g)), input.targetTime);
    if ('refusal' in plan) refusal = plan.refusal;
    else { generation = g; requiredThrough = plan.segments.at(-1)!.ordinal; break; }
  }
  if (!generation) throw new PitrRefusal(refusal);
  const encrypted = path.join(directory, 'anchor-sealed'), plain = path.join(directory, 'anchor-plain');
  await store.getObject(generation.anchor, encrypted); await store.open(encrypted, plain);
  const unpacked = await unpackCheckpoint(plain, path.join(directory, 'anchor-files'));
  if (JSON.stringify(unpacked.manifest) !== JSON.stringify(generation.manifest)) throw new Error('Remote anchor metadata differs from its authenticated catalog');
  const selected = { ...generation, wal: generation.wal.filter((s) => parseSegment(s.name)!.ordinal <= requiredThrough) };
  for (const [i, wal] of selected.wal.entries()) {
    const sealed = path.join(directory, `delta-${i}-sealed`), file = path.join(directory, `delta-${i}`);
    await store.getObject(wal.object, sealed); await store.open(sealed, file);
    if (await hashCheckpointFile(file) !== wal.plainSha256 || await walFileDigest(file) !== wal.rawSha256) throw new Error('Remote WAL integrity failed');
    unpacked.files.push(file);
  }
  return { manifest: generationManifest(selected), files: unpacked.files };
}
