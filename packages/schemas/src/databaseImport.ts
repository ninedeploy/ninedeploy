import { z } from 'zod';
import { id } from './common.js';

// ── Database dump import (0.14) ────────────────────────────────────────────
// Request and response shapes for `/v1/databases/:id/imports` and
// `/v1/backup-destinations/:id/objects`. Uploads are chunked and resumable
// (Traefik's 60s read timeout would cut a single multi-GB request). The
// server detects the format by magic bytes, refuses engines and options that
// do not apply, and enforces size, disk and role rules. Design: DESIGN.md §3.

/** 8 MiB. Advertised by the server on every import; chunks arrive in order. */
export const DATABASE_IMPORT_CHUNK_SIZE = 8 * 1024 * 1024;

/** Mirrors `databaseImportSource` in `@ninedeploy/db`. */
export const databaseImportSource = z.enum(['upload', 's3']);
export type DatabaseImportSource = z.infer<typeof databaseImportSource>;

/** Mirrors `databaseImportStatus` in `@ninedeploy/db`. */
export const databaseImportStatus = z.enum([
  'uploading',
  'pending',
  'running',
  'completed',
  'completed_with_warnings',
  'failed',
  'cancelled',
  'expired',
]);
export type DatabaseImportStatus = z.infer<typeof databaseImportStatus>;

/** Mirrors `databaseImportFormat` in `@ninedeploy/db`. */
export const databaseImportFormat = z.enum(['pg_custom', 'pg_plain', 'mysql_sql', 'mongo_archive', 'rdb']);
export type DatabaseImportFormat = z.infer<typeof databaseImportFormat>;

/**
 * Import options. Strict: an unknown key is refused, not dropped. The server
 * further refuses keys that do not apply to the database's engine, and
 * applies `singleTransaction: true` when it is omitted (postgres).
 */
export const databaseImportOptions = z
  .object({
    /** postgres custom format: `--clean --if-exists`. */
    clean: z.boolean().optional(),
    /** postgres: wrap the restore in one transaction (server default true). */
    singleTransaction: z.boolean().optional(),
    /** mongo: `--drop`. */
    drop: z.boolean().optional(),
    /** redis/valkey/keydb/dragonfly: required, the RDB replaces the whole dataset. */
    confirmReplace: z.boolean().optional(),
    /** Operator, or a database initialised in the last 10 minutes, only. */
    skipSafetyBackup: z.boolean().optional(),
  })
  .strict();
export type DatabaseImportOptions = z.infer<typeof databaseImportOptions>;

/**
 * The engines an import accepts, and the option keys each one applies. The
 * server refuses (422) any other engine, and any key not listed for the
 * database's engine. clickhouse, meilisearch and rabbitmq have no import.
 */
export const DATABASE_IMPORT_ENGINE_OPTIONS = {
  postgres: ['clean', 'singleTransaction', 'skipSafetyBackup'],
  mysql: ['skipSafetyBackup'],
  mariadb: ['skipSafetyBackup'],
  mongo: ['drop', 'skipSafetyBackup'],
  redis: ['confirmReplace', 'skipSafetyBackup'],
  valkey: ['confirmReplace', 'skipSafetyBackup'],
  keydb: ['confirmReplace', 'skipSafetyBackup'],
  dragonfly: ['confirmReplace', 'skipSafetyBackup'],
} as const satisfies Record<string, ReadonlyArray<keyof DatabaseImportOptions>>;
export type DatabaseImportEngine = keyof typeof DATABASE_IMPORT_ENGINE_OPTIONS;

const sha256Hex = z
  .string()
  .trim()
  .regex(/^[A-Fa-f0-9]{64}$/, 'sha256 must be 64 hex characters')
  .transform((v) => v.toLowerCase());

/** Display only; the staging path is always chosen by the server. */
const importFilename = z.string().trim().min(1).max(255);

const uploadSource = z.object({
  source: z.literal('upload'),
  sizeBytes: z.number().int().positive(),
  sha256: sha256Hex.optional(),
  filename: importFilename.optional(),
  options: databaseImportOptions.default({}),
});

/** S3 imports are operator only (checked in the handler). */
const s3Source = z.object({
  source: z.literal('s3'),
  destinationId: id,
  key: z.string().min(1).max(1024),
  options: databaseImportOptions.default({}),
});

/** POST /v1/databases/:id/imports. */
export const databaseImportCreate = z.discriminatedUnion('source', [uploadSource, s3Source]);
export type DatabaseImportCreate = z.input<typeof databaseImportCreate>;

/** One import row as the API returns it. */
export const databaseImport = z.object({
  id: z.number().int(),
  databaseId: z.number().int(),
  source: databaseImportSource,
  status: databaseImportStatus,
  format: databaseImportFormat.nullable(),
  sizeBytes: z.number().int(),
  receivedBytes: z.number().int(),
  chunkSize: z.number().int(),
  sha256: z.string().nullable(),
  filename: z.string().nullable(),
  destinationId: z.number().int().nullable(),
  objectKey: z.string().nullable(),
  options: databaseImportOptions,
  safetyBackupId: z.number().int().nullable(),
  error: z.string().nullable(),
  createdByUserId: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type DatabaseImport = z.infer<typeof databaseImport>;

/** GET /v1/backup-destinations/:id/objects?prefix= (operator). */
export const backupDestinationObjectsQuery = z.object({
  prefix: z.string().max(1024).optional(),
});
export type BackupDestinationObjectsQuery = z.infer<typeof backupDestinationObjectsQuery>;

export const backupDestinationObject = z.object({
  key: z.string(),
  sizeBytes: z.number().int(),
  lastModified: z.string().nullable(),
});
export type BackupDestinationObject = z.infer<typeof backupDestinationObject>;
