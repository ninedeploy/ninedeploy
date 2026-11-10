import { stat, open, mkdir } from 'node:fs/promises';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { deployments, serviceTargets, volumeImports, type Service } from '@ninedeploy/db';
import { VOLUME_IMPORT_CHUNK_SIZE, volumeImportCreate } from '@ninedeploy/schemas';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { MAX_REPLICAS, replicaNames } from '../engine/dockerNames.js';
import { audit } from '../lib/audit.js';
import { assertFreeSpace, assertImportSize, createStagingFile, removeStaging, sniffFile } from '../lib/databaseImport.js';
import { badRequest, conflict, forbidden, HttpError, notFound, parseId, unprocessable } from '../lib/errors.js';
import { loadServiceForUser } from '../lib/resourceAccess.js';
import { primaryServiceVolumeName } from '../lib/retainedSlugVolume.js';
import { runVolumeImportJob, serializeVolumeImport, volumeImportAuditMeta, volumeImportStagingDir } from '../lib/volumeImport.js';
import { runningForRestore } from './volumeBackups.js';

/** Options for tests; `api.ts` registers the module with none. */
export interface VolumeImportRouteOptions {
  chunkSize?: number;
  stagingDir?: string;
  maxBytes?: number;
  /** The job (tests replace it); default runVolumeImportJob. */
  runJob?: typeof runVolumeImportJob;
  /** Whether a container is running (tests replace it); default the volume restore's fail-closed probe. */
  isRunning?: (container: string) => Promise<boolean>;
}

const INDEX_RE = /^(?:0|[1-9]\d{0,8})$/;

/**
 * Why a service's data volume cannot take an import, or null. The archive
 * lands in `nd-svc-<slug>-data` on the panel host, which is the volume only a
 * docker service with a volume mount, running here and nowhere else, mounts.
 */
export function volumeImportRefusal(svc: Pick<Service, 'type' | 'orchestrator' | 'volumeMount' | 'serverId'>, fanout: boolean): string | null {
  if (svc.type !== 'docker') return 'Volume import is for docker services; a compose stack keeps its volumes per stack';
  if (svc.orchestrator === 'swarm') return 'Volume import is not available for Swarm services: their named volumes live on each node';
  if (!svc.volumeMount) return 'This service has no data volume: set its volume mount (the container path) first';
  if (svc.serverId != null) return 'Volume import restores into the panel host; this service runs on a node';
  if (fanout) return 'This service runs on several hosts; a volume import would fill only one of them';
  return null;
}

/**
 * Service volume import (A1 step 3) under `/v1/services/:id/volume-imports`:
 * a gzipped tar, uploaded in ordered `application/octet-stream` chunks with
 * its sha256 declared, then restored into the service's data volume.
 *
 * Authorization: operator (the floor of a volume restore, which this is), and
 * the service must be visible to the caller. Chunks and `start` belong to the
 * import's creator. The service must not be running or deploying when the
 * restore starts; a volume that exists is snapshotted first.
 */
export const volumeImportRoutes: FastifyPluginAsync<VolumeImportRouteOptions> = async (app, opts) => {
  const chunkSize = opts.chunkSize ?? VOLUME_IMPORT_CHUNK_SIZE;
  const stagingDir = () => opts.stagingDir ?? volumeImportStagingDir();
  const maxBytes = () => opts.maxBytes ?? config.importMaxBytes;
  const runJob = opts.runJob ?? runVolumeImportJob;
  const isRunning = opts.isRunning ?? runningForRestore;

  const chunkWrites = new Map<number, Promise<void>>();
  const inChunkOrder = async <T>(id: number, work: () => Promise<T>): Promise<T> => {
    const previous = chunkWrites.get(id) ?? Promise.resolve();
    let release!: () => void;
    const completed = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => completed);
    chunkWrites.set(id, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (chunkWrites.get(id) === tail) chunkWrites.delete(id);
    }
  };

  if (app.hasContentTypeParser('application/octet-stream')) app.removeContentTypeParser('application/octet-stream');
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    await (app as FastifyInstance & { authenticate: (r: FastifyRequest, p: FastifyReply) => Promise<void> }).authenticate(req, reply);
  });

  const target = async (req: FastifyRequest): Promise<Service> => {
    if (!req.user!.isOperator) throw forbidden('Admin access required');
    return loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
  };
  const loadImport = async (req: FastifyRequest, svc: Service) => {
    const importId = parseId((req.params as { importId: string }).importId);
    const row = await app.db.query.volumeImports.findFirst({ where: and(eq(volumeImports.id, importId), eq(volumeImports.serviceId, svc.id)) });
    if (!row) throw notFound('Import not found');
    return row;
  };
  const assertCreator = (req: FastifyRequest, row: { createdByUserId: number | null }) => {
    if (row.createdByUserId !== req.user!.id) throw forbidden('Only the user who created this import may upload to or start it');
  };
  const assertImportable = async (svc: Service) => {
    const fanout = await app.db.query.serviceTargets.findFirst({ where: eq(serviceTargets.serviceId, svc.id) });
    const refusal = volumeImportRefusal(svc, Boolean(fanout));
    if (refusal) throw unprocessable(refusal, 'volume_import_unsupported');
  };

  app.get('/:id/volume-imports', async (req) => {
    const svc = await target(req);
    const rows = await app.db.query.volumeImports.findMany({ where: eq(volumeImports.serviceId, svc.id), orderBy: desc(volumeImports.id), limit: 50 });
    return rows.map(serializeVolumeImport);
  });

  app.get('/:id/volume-imports/:importId', async (req) => serializeVolumeImport(await loadImport(req, await target(req))));

  app.post('/:id/volume-imports', async (req, reply) => {
    const svc = await target(req);
    await assertImportable(svc);
    const input = volumeImportCreate.parse(req.body ?? {});
    assertImportSize(input.sizeBytes, maxBytes());
    const dir = stagingDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await assertFreeSpace(dir, input.sizeBytes);
    const [row] = await app.db
      .insert(volumeImports)
      .values({
        serviceId: svc.id,
        volumeName: primaryServiceVolumeName(svc.slug),
        status: 'uploading',
        sizeBytes: input.sizeBytes,
        chunkSize,
        sha256: input.sha256,
        filename: input.filename ?? null,
        createdByUserId: req.user!.id,
      })
      .returning();
    let stagingPath: string;
    try {
      stagingPath = await createStagingFile(dir, row!.id);
    } catch (err) {
      await app.db.update(volumeImports).set({ status: 'failed', error: 'could not create the staging file', completedAt: new Date() }).where(eq(volumeImports.id, row!.id));
      throw err;
    }
    const [saved] = await app.db.update(volumeImports).set({ stagingPath }).where(eq(volumeImports.id, row!.id)).returning();
    void audit(app.db, req.user!.id, 'volume.import.create', svc.name, volumeImportAuditMeta(saved!));
    return reply.code(201).send(serializeVolumeImport(saved!));
  });

  app.put('/:id/volume-imports/:importId/chunks/:index', { bodyLimit: chunkSize + 1024 }, async (req) => {
    const svc = await target(req);
    const observed = await loadImport(req, svc);
    assertCreator(req, observed);
    return inChunkOrder(observed.id, async () => {
      const row = await loadImport(req, svc);
      const rawIndex = (req.params as { index: string }).index;
      if (!INDEX_RE.test(rawIndex)) throw badRequest('Invalid chunk index', 'invalid_index');
      const index = Number(rawIndex);
      const body = req.body;
      if (!Buffer.isBuffer(body)) throw new HttpError(415, 'unsupported_media_type', 'Send each chunk as application/octet-stream');
      if (row.status !== 'uploading' || !row.stagingPath) {
        if (row.status === 'pending' && isLastChunkRetry(row, index, body.length)) return serializeVolumeImport(row);
        throw conflict(`The import is ${row.status}; chunks are accepted only while it is uploading`);
      }
      const expected = row.receivedBytes / row.chunkSize;
      if (index === expected - 1 && Number.isInteger(expected) && isLastChunkRetry(row, index, body.length)) return serializeVolumeImport(row);
      if (index !== expected) throw conflict(`Chunks arrive in order: expected chunk ${expected}, got ${index}`);
      const want = Math.min(row.chunkSize, row.sizeBytes - row.receivedBytes);
      if (body.length !== want) throw badRequest(`Chunk ${index} must be ${want} bytes, got ${body.length}`, 'chunk_size');
      const fh = await open(row.stagingPath, 'r+').catch(() => {
        throw conflict('The staging file is gone; cancel this import and start again');
      });
      try {
        let offset = 0;
        while (offset < body.length) {
          const { bytesWritten } = await fh.write(body, offset, body.length - offset, index * row.chunkSize + offset);
          if (bytesWritten === 0) throw new Error('The staging file write made no progress');
          offset += bytesWritten;
        }
      } finally {
        await fh.close();
      }
      const receivedBytes = row.receivedBytes + body.length;
      const done = receivedBytes === row.sizeBytes;
      const [updated] = await app.db
        .update(volumeImports)
        .set({ receivedBytes, status: done ? 'pending' : 'uploading' })
        .where(and(eq(volumeImports.id, row.id), eq(volumeImports.status, 'uploading'), eq(volumeImports.receivedBytes, row.receivedBytes)))
        .returning();
      if (!updated) return serializeVolumeImport((await app.db.query.volumeImports.findFirst({ where: eq(volumeImports.id, row.id) }))!);
      if (done) void audit(app.db, req.user!.id, 'volume.import.upload', svc.name, volumeImportAuditMeta(updated));
      return serializeVolumeImport(updated);
    });
  });

  app.post('/:id/volume-imports/:importId/start', async (req, reply) => {
    const svc = await target(req);
    const row = await loadImport(req, svc);
    assertCreator(req, row);
    if (row.status !== 'pending' || !row.stagingPath) throw conflict(`The import is ${row.status}; only a fully uploaded import can be started`);
    await assertImportable(svc);
    if (row.volumeName !== primaryServiceVolumeName(svc.slug)) throw conflict('The service was renamed since this import was created; cancel it and start again');
    // Files must not change under a running process: the same rule as a volume restore.
    if (svc.status === 'running' || svc.status === 'deploying') throw new HttpError(409, 'volume_import_stop_first', 'Stop the service first, so its data does not change while the archive is restored');
    const busy = await app.db.query.deployments.findFirst({
      where: and(eq(deployments.serviceId, svc.id), inArray(deployments.status, ['queued', 'building', 'deploying'])),
    });
    if (busy) throw new HttpError(409, 'volume_import_deploying', 'Wait for the running deployment to finish');
    if (svc.runtimeId) {
      for (const container of replicaNames(svc.runtimeId, MAX_REPLICAS)) {
        if (await isRunning(container)) throw new HttpError(409, 'volume_import_stop_first', `Service "${svc.name}" is running — stop it before importing into its volume`);
      }
    }

    const refuse = async (message: string): Promise<never> => {
      const [refused] = await app.db
        .update(volumeImports)
        .set({ status: 'failed', error: message, completedAt: new Date(), stagingPath: null })
        .where(and(eq(volumeImports.id, row.id), eq(volumeImports.status, 'pending')))
        .returning({ id: volumeImports.id });
      if (!refused) throw conflict('The import was started or cancelled by another request');
      await removeStaging(row.stagingPath);
      void audit(app.db, req.user!.id, 'volume.import.fail', svc.name, { ...volumeImportAuditMeta(row), error: message });
      throw unprocessable(message, 'import_refused');
    };
    const size = (await stat(row.stagingPath).catch(() => null))?.size;
    if (size !== row.sizeBytes) await refuse(`The staged file is ${size ?? 0} bytes, not the declared ${row.sizeBytes}`);
    const sniff = await sniffFile(row.stagingPath);
    if (!sniff.gzip || sniff.kind !== 'tar') await refuse('The file is not a gzipped tar archive (tar -czf … -C <volume> .)');

    const [started] = await app.db
      .update(volumeImports)
      .set({ status: 'running', startedAt: new Date(), error: null })
      .where(and(eq(volumeImports.id, row.id), eq(volumeImports.status, 'pending')))
      .returning();
    if (!started) throw conflict('The import was started or cancelled by another request');
    void audit(app.db, req.user!.id, 'volume.import.start', svc.name, volumeImportAuditMeta(started));
    void runJob(app.db, started.id, { actorId: req.user!.id, log: (line) => app.log.info({ component: 'volume-import', importId: started.id }, line) });
    return reply.code(202).send(serializeVolumeImport(started));
  });

  app.delete('/:id/volume-imports/:importId', async (req) => {
    const svc = await target(req);
    const row = await loadImport(req, svc);
    if (row.status !== 'uploading' && row.status !== 'pending') throw conflict(`The import is ${row.status}; only an uploading or pending import can be cancelled`);
    const [cancelled] = await app.db
      .update(volumeImports)
      .set({ status: 'cancelled', completedAt: new Date(), stagingPath: null })
      .where(and(eq(volumeImports.id, row.id), eq(volumeImports.status, row.status)))
      .returning();
    if (!cancelled) throw conflict('The import changed state; reload and try again');
    await removeStaging(row.stagingPath);
    void audit(app.db, req.user!.id, 'volume.import.cancel', svc.name, volumeImportAuditMeta(row));
    return serializeVolumeImport(cancelled);
  });
};

/** The chunk that brought `receivedBytes` to where it is, resent with the same length. */
function isLastChunkRetry(row: { receivedBytes: number; chunkSize: number }, index: number, length: number): boolean {
  if (row.receivedBytes === 0 || row.chunkSize <= 0) return false;
  const last = Math.ceil(row.receivedBytes / row.chunkSize) - 1;
  return index === last && length === row.receivedBytes - last * row.chunkSize;
}
