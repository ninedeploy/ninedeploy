import { z } from 'zod';

// ── Per-database backup policy (0.12) ──────────────────────────────────────
/** Bounds for both retention counts. At least one dump is always kept, so a
 *  policy can never prune a database's last good backup. */
export const BACKUP_RETAIN_MIN = 1;
export const BACKUP_RETAIN_MAX = 365;
/** What a database WITHOUT a policy gets: the built-in schedule. */
export const DEFAULT_BACKUP_RETAIN_COUNT = 7;

const retain = z.number().int().min(BACKUP_RETAIN_MIN).max(BACKUP_RETAIN_MAX);

/**
 * PUT /v1/databases/:id/backup-policy — the whole policy (PUT replaces).
 * The cron expression is validated with croner (5-part) at the route, the
 * same rule scheduled jobs use; the schema package has no cron dependency.
 */
export const backupPolicyInput = z
  .object({
    enabled: z.boolean().default(true),
    cron: z.string().trim().min(1).max(120),
    retainCount: retain,
    /** Remote copies kept; null/omitted = the remote copies of the newest `retainCount` dumps. */
    retainRemoteCount: retain.nullable().optional().transform((v) => v ?? null),
    /** A `backup_destinations` id; null/omitted = the active destination. */
    destinationId: z.number().int().positive().nullable().optional().transform((v) => v ?? null),
    /** true = keep this database's scheduled dumps on the panel host only. */
    localOnly: z.boolean().optional().transform((v) => v ?? false),
  })
  .refine((p) => !(p.localOnly && p.destinationId != null), {
    message: 'localOnly and destinationId are mutually exclusive',
    path: ['destinationId'],
  })
  .refine((p) => !(p.localOnly && p.retainRemoteCount != null), {
    message: 'retainRemoteCount has no effect on a local-only policy',
    path: ['retainRemoteCount'],
  });
export type BackupPolicyInput = z.input<typeof backupPolicyInput>;

/** GET/PUT response. `configured: false` = no policy row: the built-in
 *  schedule (daily, 7 kept, active destination) applies and `cron` is null. */
export const backupPolicy = z.object({
  databaseId: z.number().int(),
  configured: z.boolean(),
  enabled: z.boolean(),
  cron: z.string().nullable(),
  retainCount: z.number().int(),
  retainRemoteCount: z.number().int().nullable(),
  destinationId: z.number().int().nullable(),
  localOnly: z.boolean(),
  /** Next scheduled run for a configured, enabled policy (ISO); null otherwise. */
  nextRunAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type BackupPolicy = z.infer<typeof backupPolicy>;
