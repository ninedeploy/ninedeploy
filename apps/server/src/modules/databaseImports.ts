import { stat } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { and, desc, eq } from 'drizzle-orm';
import { backupDestinations, databaseImports, type Database } from '@ninedeploy/db';
import { DATABASE_IMPORT_CHUNK_SIZE, databaseImportCreate } from '@ninedeploy/schemas';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { probeMysqlSandboxFlag } from '../engine/database.js';
import { audit } from '../lib/audit.js';
import { decrypt } from '../lib/crypto.js';
import {
  ENVELOPE_REFUSAL,
  assertFreeSpace,
  assertImportEngine,
  assertImportSize,
  assertMaySkipSafetyBackup,
  createStagingFile,
  downloadS3Import,
  formatFor,
  importAuditMeta,
  importStagingDir,
  keyWithinPrefix,
  removeStaging,
  resolveImportOptions,
  runImportJob,
  serializeImport,
  sniffFile,
} from '../lib/databaseImport.js';
import { badRequest, conflict, forbidden, HttpError, notFound, parseId, unprocessable } from '../lib/errors.js';
import { assertDatabaseRole, loadDatabaseForUser } from '../lib/resourceAccess.js';
import { s3Request, type S3Config } from '../lib/s3.js';

/** Options for tests; `api.ts` registers the module with none. */
export interface DatabaseImportRouteOptions {
  /** Chunk size advertised on new imports (default 8 MiB). */
  chunkSize?: number;
  /** Staging directory (default `<backupsDir>/imports`). */
  stagingDir?: string;
  /** Size ceiling (default `NINEDEPLOY_IMPORT_MAX_BYTES`). */
  maxBytes?: number;
}

const INDEX_RE = /^(?:0|[1-9]\d{0,8})$/;

/**
 * Database dump import (0.14): chunked, resumable uploads and S3 sources under
 * `/v1/databases/:id/imports`. Design: DESIGN.md §3.3.
 *
 * Authorization: every route needs `admin` on the database (the same floor as
 * taking or restoring a backup); an S3 source is operator-only; chunks and
 * `start` belong to the import's creator.
 *
 * Chunks are raw `application/octet-stream` bodies. This plugin's scope swaps
 * the root parser (a latin1 string, for system import) for a Buffer one;
 * Fastify encapsulation keeps that swap out of every sibling scope. The
 * chunk route carries its own `bodyLimit` (chunk + 1 KiB) — the app-wide
 * 1 MiB stays everywhere else — and authentication runs at `onRequest`,
 * before a body byte is read.
 */
export const databaseImportRoutes: FastifyPluginAsync<DatabaseImportRouteOptions> = async (app, opts) => {
  const chunkSize = opts.chunkSize ?? DATABASE_IMPORT_CHUNK_SIZE;
  const stagingDir = () => opts.stagingDir ?? importStagingDir();
  const maxBytes = () => opts.maxBytes ?? config.importMaxBytes;

  if (app.hasContentTypeParser('application/octet-stream')) app.removeContentTypeParser('application/octet-stream');
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  // Resolved per request: the hook stays a function even on an instance
  // decorated later (the wiring guard mounts this module on a bare Fastify).
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    await (app as FastifyInstance & { authenticate: (r: FastifyRequest, p: FastifyReply) => Promise<void> }).authenticate(req, reply);
  });

  const dbAdmin = async (req: FastifyRequest): Promise<Database> => {
    const d = await loadDatabaseForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertDatabaseRole(app.db, d, req.user!, 'admin');
    return d;
  };
  const loadImport = async (req: FastifyRequest, d: Database) => {
    const importId = parseId((req.params as { importId: string }).importId);
    const row = await app.db.query.databaseImports.findFirst({
      where: and(eq(databaseImports.id, importId), eq(databaseImports.databaseId, d.id)),
    });
    if (!row) throw notFound('Import not found');
    return row;
  };
  const assertCreator = (req: FastifyRequest, row: { createdByUserId: number | null }) => {
    if (row.createdByUserId !== req.user!.id) throw forbidden('Only the user who created this import may upload to or start it');
  };
  const logFor = (importId: number) => (line: string) => app.log.info({ component: 'database-import', importId }, line);

  app.get('/:id/imports', async (req) => {
    const d = await dbAdmin(req);
    const rows = await app.db.query.databaseImports.findMany({
      where: eq(databaseImports.databaseId, d.id),
      orderBy: desc(databaseImports.id),
      limit: 50,
    });
    return rows.map(serializeImport);
  });

  app.get('/:id/imports/:importId', async (req) => {
    const d = await dbAdmin(req);
    return serializeImport(await loadImport(req, d));
  });

  app.post('/:id/imports', async (req, reply) => {
    const d = await dbAdmin(req);
    const input = databaseImportCreate.parse(req.body ?? {});
    if (input.source === 's3' && !req.user!.isOperator) {
      throw forbidden('Importing from a backup destination is limited to instance operators');
    }
    assertImportEngine(d.engine);
    const options = resolveImportOptions(d.engine, input.options);
    assertMaySkipSafetyBackup(d, options, req.user!.isOperator);

    if (input.source === 'upload') {
      assertImportSize(input.sizeBytes, maxBytes());
      await assertFreeSpace(await ensureDir(stagingDir()), input.sizeBytes);
      const [row] = await app.db
        .insert(databaseImports)
        .values({
          databaseId: d.id,
          source: 'upload',
          status: 'uploading',
          sizeBytes: input.sizeBytes,
          chunkSize,
          sha256: input.sha256 ?? null,
          filename: input.filename ?? null,
          options,
          createdByUserId: req.user!.id,
        })
        .returning();
      const stagingPath = await stageOrFail(row!.id);
      const [saved] = await app.db.update(databaseImports).set({ stagingPath }).where(eq(databaseImports.id, row!.id)).returning();
      void audit(app.db, req.user!.id, 'database.import.create', d.name, importAuditMeta(saved!));
      return reply.code(201).send(serializeImport(saved!));
    }

    // S3: an operator names a destination and an object inside its prefix.
    const dest = await app.db.query.backupDestinations.findFirst({ where: eq(backupDestinations.id, input.destinationId) });
    if (!dest) throw notFound('Destination not found');
    if (!keyWithinPrefix(dest.prefix, input.key)) {
      throw unprocessable(`The key must sit under the destination prefix "${dest.prefix}/" and contain no "." or ".." segments`, 'import_key');
    }
    const cfg: S3Config = {
      endpoint: dest.endpoint,
      region: dest.region,
      bucket: dest.bucket,
      accessKeyId: dest.accessKeyId,
      secretAccessKey: decrypt(dest.secretKeyEncrypted),
    };
    let head: Response;
    try {
      head = await s3Request(cfg, 'HEAD', input.key);
    } catch (err) {
      req.log.warn({ err }, 'import: destination HEAD failed');
      throw new HttpError(502, 'destination_unreachable', 'The backup destination could not be reached');
    }
    if (head.status === 404) throw notFound('Object not found in the destination');
    if (!head.ok) throw new HttpError(502, 'destination_unreachable', `The backup destination answered ${head.status}`);
    const sizeBytes = Number(head.headers.get('content-length'));
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw unprocessable('The object is empty or its size is unknown', 'import_size');
    assertImportSize(sizeBytes, maxBytes());
    await assertFreeSpace(await ensureDir(stagingDir()), sizeBytes);
    const [row] = await app.db
      .insert(databaseImports)
      .values({
        databaseId: d.id,
        source: 's3',
        status: 'uploading',
        sizeBytes,
        chunkSize,
        destinationId: dest.id,
        objectKey: input.key,
        options,
        createdByUserId: req.user!.id,
      })
      .returning();
    const stagingPath = await stageOrFail(row!.id);
    const [saved] = await app.db.update(databaseImports).set({ stagingPath }).where(eq(databaseImports.id, row!.id)).returning();
    void audit(app.db, req.user!.id, 'database.import.create', d.name, importAuditMeta(saved!));
    void downloadS3Import(app.db, saved!, cfg, req.user!.id, logFor(saved!.id));
    return reply.code(202).send(serializeImport(saved!));
  });

  app.put(
    '/:id/imports/:importId/chunks/:index',
    { bodyLimit: chunkSize + 1024 },
    async (req) => {
      const d = await dbAdmin(req);
      const row = await loadImport(req, d);
      assertCreator(req, row);
      const rawIndex = (req.params as { index: string }).index;
      if (!INDEX_RE.test(rawIndex)) throw badRequest('Invalid chunk index', 'invalid_index');
      const index = Number(rawIndex);
      const body = req.body;
      if (!Buffer.isBuffer(body)) throw new HttpError(415, 'unsupported_media_type', 'Send each chunk as application/octet-stream');
      if (row.source !== 'upload' || row.status !== 'uploading' || !row.stagingPath) {
        // A retry of the chunk that completed the upload is still a success.
        if (row.status === 'pending' && isLastChunkRetry(row, index, body.length)) return serializeImport(row);
        throw conflict(`The import is ${row.status}; chunks are accepted only while it is uploading`);
      }
      const expected = row.receivedBytes / row.chunkSize;
      // Idempotent: the chunk before `expected` already landed; a retry is a no-op.
      if (index === expected - 1 && Number.isInteger(expected) && isLastChunkRetry(row, index, body.length)) return serializeImport(row);
      if (index !== expected) throw conflict(`Chunks arrive in order: expected chunk ${expected}, got ${index}`);
      const want = Math.min(row.chunkSize, row.sizeBytes - row.receivedBytes);
      if (body.length !== want) throw badRequest(`Chunk ${index} must be ${want} bytes, got ${body.length}`, 'chunk_size');

      const fh = await open(row.stagingPath, 'r+').catch(() => {
        throw conflict('The staging file is gone; cancel this import and start again');
      });
      try {
        await fh.write(body, 0, body.length, index * row.chunkSize);
      } finally {
        await fh.close();
      }
      const receivedBytes = row.receivedBytes + body.length;
      const done = receivedBytes === row.sizeBytes;
      const [updated] = await app.db
        .update(databaseImports)
        .set({ receivedBytes, status: done ? 'pending' : 'uploading' })
        .where(
          and(eq(databaseImports.id, row.id), eq(databaseImports.status, 'uploading'), eq(databaseImports.receivedBytes, row.receivedBytes)),
        )
        .returning();
      if (!updated) {
        // A concurrent retry of the same chunk won the race (or a cancel did).
        return serializeImport((await app.db.query.databaseImports.findFirst({ where: eq(databaseImports.id, row.id) }))!);
      }
      // One audit entry per upload, not per chunk.
      if (done) void audit(app.db, req.user!.id, 'database.import.upload', d.name, importAuditMeta(updated));
      return serializeImport(updated);
    },
  );

  app.post('/:id/imports/:importId/start', async (req, reply) => {
    const d = await dbAdmin(req);
    const row = await loadImport(req, d);
    assertCreator(req, row);
    if (row.status !== 'pending' || !row.stagingPath) {
      throw conflict(`The import is ${row.status}; only a fully uploaded import can be started`);
    }
    if (d.status !== 'running' || !d.containerName) throw conflict('The database is not running');
    const isOperator = req.user!.isOperator;
    const options = resolveImportOptions(d.engine, (row.options ?? {}) as never);
    assertMaySkipSafetyBackup(d, options, isOperator);

    // A refusal inherent to the file is final: the row fails and the file goes.
    const refuse = async (message: string): Promise<never> => {
      await app.db
        .update(databaseImports)
        .set({ status: 'failed', error: message, completedAt: new Date(), stagingPath: null })
        .where(and(eq(databaseImports.id, row.id), eq(databaseImports.status, 'pending')));
      await removeStaging(row.stagingPath);
      void audit(app.db, req.user!.id, 'database.import.fail', d.name, { ...importAuditMeta(row), error: message });
      throw unprocessable(message, 'import_refused');
    };

    const size = (await stat(row.stagingPath).catch(() => null))?.size;
    if (size !== row.sizeBytes) await refuse(`The staged file is ${size ?? 0} bytes, not the declared ${row.sizeBytes}`);
    const sniff = await sniffFile(row.stagingPath);
    let format: string | null = null;
    if (sniff.kind === 'envelope') {
      if (!isOperator) await refuse(ENVELOPE_REFUSAL);
      if (sniff.gzip) await refuse('A gzip-compressed NineDeploy backup is not supported: import the backup file itself');
    } else {
      try {
        format = formatFor(d.engine, sniff);
      } catch (err) {
        await refuse((err as Error).message);
      }
      if (options.clean && format === 'pg_plain') {
        await refuse('options.clean applies to custom-format dumps only; plain SQL carries its own DROP statements');
      }
    }
    let sandboxFlag: string | null = null;
    if (d.engine === 'mysql' || d.engine === 'mariadb') {
      sandboxFlag = await probeMysqlSandboxFlag(d);
      if (!sandboxFlag && !isOperator) {
        await refuse(`This ${d.engine} client has no sandbox flag (--sandbox / --system-command), so a dump could run shell commands in the database container; only an instance operator may import into it`);
      }
    }

    const [started] = await app.db
      .update(databaseImports)
      .set({ status: 'running', format: format as never, startedAt: new Date(), error: null })
      .where(and(eq(databaseImports.id, row.id), eq(databaseImports.status, 'pending')))
      .returning();
    if (!started) throw conflict('The import was started or cancelled by another request');
    void audit(app.db, req.user!.id, 'database.import.start', d.name, importAuditMeta(started));
    void runImportJob(app.db, started.id, { actorId: req.user!.id, isOperator, sandboxFlag, log: logFor(started.id) });
    return reply.code(202).send(serializeImport(started));
  });

  app.delete('/:id/imports/:importId', async (req) => {
    const d = await dbAdmin(req);
    const row = await loadImport(req, d);
    if (row.status !== 'uploading' && row.status !== 'pending') {
      throw conflict(`The import is ${row.status}; only an uploading or pending import can be cancelled`);
    }
    const [cancelled] = await app.db
      .update(databaseImports)
      .set({ status: 'cancelled', completedAt: new Date(), stagingPath: null })
      .where(and(eq(databaseImports.id, row.id), eq(databaseImports.status, row.status)))
      .returning();
    if (!cancelled) throw conflict('The import changed state; reload and try again');
    // An S3 download still writing is cleaned up by the download itself.
    await removeStaging(row.stagingPath);
    void audit(app.db, req.user!.id, 'database.import.cancel', d.name, importAuditMeta(row));
    return serializeImport(cancelled);
  });

  async function stageOrFail(id: number): Promise<string> {
    try {
      return await createStagingFile(stagingDir(), id);
    } catch (err) {
      await app.db
        .update(databaseImports)
        .set({ status: 'failed', error: 'could not create the staging file', completedAt: new Date() })
        .where(eq(databaseImports.id, id));
      throw err;
    }
  }
};

/** The chunk that brought `receivedBytes` to where it is, resent with the same length. */
function isLastChunkRetry(row: { receivedBytes: number; chunkSize: number; sizeBytes: number }, index: number, length: number): boolean {
  if (row.receivedBytes === 0 || row.chunkSize <= 0) return false;
  const last = Math.ceil(row.receivedBytes / row.chunkSize) - 1;
  const lastLength = row.receivedBytes - last * row.chunkSize;
  return index === last && length === lastLength;
}

async function ensureDir(dir: string): Promise<string> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}
