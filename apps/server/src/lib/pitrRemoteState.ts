import { z } from 'zod';

export const pitrRemoteConfig = z.object({
  enabled: z.boolean(), destinationId: z.number().int().positive(), intervalMinutes: z.number().int().min(15).max(1440),
  mode: z.enum(['checkpoint', 'continuous']).optional(),
  remoteRetentionDays: z.number().int().min(1).max(35).optional(),
  collectOrphans: z.boolean().optional(),
  archiveId: z.string().uuid().optional(),
}).strict();
const success = z.object({ key: z.string(), destinationId: z.number().int().positive(), verifiedAt: z.string().datetime(), from: z.string().datetime(), through: z.string().datetime(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().nonnegative() }).strict();
export const pitrRemoteState = z.object({
  status: z.enum(['running', 'completed', 'failed']), attemptedAt: z.string().datetime(), error: z.string().nullable(),
  missingSegment: z.string().regex(/^[0-9A-F]{24}$/).nullable(), lastSuccess: success.nullable(),
}).strict();
export type PitrRemoteConfig = z.infer<typeof pitrRemoteConfig>;
export type PitrRemoteState = z.infer<typeof pitrRemoteState>;

export const pitrStreamProtection = z.object({
  sequence: z.number().int().positive(), headKey: z.string(), catalogKey: z.string(),
  headSha256: z.string().regex(/^[a-f0-9]{64}$/), headBytes: z.number().int().positive(),
  verifiedAt: z.string().datetime(), baseLabel: z.string(), lastSegment: z.string().regex(/^[0-9A-F]{24}$/),
  from: z.string().datetime(), through: z.string().datetime(),
  ranges: z.array(z.object({ from: z.string().datetime(), through: z.string().datetime() }).strict()).max(512),
}).strict();
export const pitrStreamState = z.object({
  archiveId: z.string().uuid(), status: z.enum(['running', 'completed', 'failed']), attemptedAt: z.string().datetime(),
  error: z.string().nullable(), missingSegment: z.string().regex(/^[0-9A-F]{24}$/).nullable(),
  protection: pitrStreamProtection.nullable(), gcPending: z.number().int().nonnegative(),
  orphanSweep: z.object({ cursor: z.string().min(1).max(8192).nullable(), scannedAt: z.string().datetime(), found: z.number().int().min(0).max(200) }).strict().optional(),
}).strict();
export type PitrStreamState = z.infer<typeof pitrStreamState>;
