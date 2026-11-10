import { z } from 'zod';

// ── Service volume import (A1 step 3) ──────────────────────────────────────
// Request and response shapes for `/v1/services/:id/volume-imports`: a
// gzipped tar of a volume's contents, uploaded in ordered chunks like a
// database dump, then restored into the service's data volume
// (`nd-svc-<slug>-data`) through the same staged swap a volume backup
// restore uses. Docker services on the panel host only.

/** 8 MiB, the same as a dump import. Advertised on every import. */
export const VOLUME_IMPORT_CHUNK_SIZE = 8 * 1024 * 1024;

/** Mirrors `volumeImportStatus` in `@ninedeploy/db`. */
export const volumeImportStatus = z.enum(['uploading', 'pending', 'running', 'completed', 'failed', 'cancelled', 'expired']);
export type VolumeImportStatus = z.infer<typeof volumeImportStatus>;

/** POST /v1/services/:id/volume-imports. The sha256 is required: the server checks it before the volume is touched. */
export const volumeImportCreate = z.object({
  sizeBytes: z.number().int().positive(),
  sha256: z
    .string()
    .trim()
    .regex(/^[A-Fa-f0-9]{64}$/, 'sha256 must be 64 hex characters')
    .transform((v) => v.toLowerCase()),
  /** Display only; the staging path is always chosen by the server. */
  filename: z.string().trim().min(1).max(255).optional(),
});
export type VolumeImportCreate = z.input<typeof volumeImportCreate>;

/** One volume import as the API returns it. */
export const volumeImport = z.object({
  id: z.number().int(),
  serviceId: z.number().int(),
  volumeName: z.string(),
  status: volumeImportStatus,
  sizeBytes: z.number().int(),
  receivedBytes: z.number().int(),
  chunkSize: z.number().int(),
  sha256: z.string(),
  filename: z.string().nullable(),
  /** The snapshot of the volume taken before it was replaced (null: the volume did not exist yet). */
  safetyBackupId: z.number().int().nullable(),
  error: z.string().nullable(),
  createdByUserId: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type VolumeImport = z.infer<typeof volumeImport>;
