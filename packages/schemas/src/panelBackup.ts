import { z } from 'zod';

// ── Panel self-backup (0.12) ───────────────────────────────────────────────
/** The recovery passphrase seals every panel backup; it is the ONE secret an
 *  operator must keep off this server to restore on a new one. */
export const PANEL_BACKUP_PASSPHRASE_MIN = 12;
export const PANEL_BACKUP_RETAIN_MIN = 1;
export const PANEL_BACKUP_RETAIN_MAX = 365;
export const PANEL_BACKUP_DEFAULT_CRON = '0 3 * * *';
export const PANEL_BACKUP_DEFAULT_RETAIN = 7;

/**
 * PUT /v1/system/panel-backup — every field optional; omitted keeps the stored
 * value. `passphrase` is write-only (omitted = keep the stored one). The cron
 * expression is validated with croner (5-part) at the route, the same rule
 * scheduled jobs use; the schema package has no cron dependency.
 */
export const panelBackupSettingsPatch = z
  .object({
    enabled: z.boolean().optional(),
    cron: z.string().trim().min(1).max(120).optional(),
    /** A `backup_destinations` id; null clears it (and requires enabled=false). */
    destinationId: z.number().int().positive().nullable().optional(),
    retain: z.number().int().min(PANEL_BACKUP_RETAIN_MIN).max(PANEL_BACKUP_RETAIN_MAX).optional(),
    passphrase: z
      .string()
      .min(PANEL_BACKUP_PASSPHRASE_MIN, `The recovery passphrase needs at least ${PANEL_BACKUP_PASSPHRASE_MIN} characters`)
      .max(1024)
      .optional(),
  })
  .strict();
export type PanelBackupSettingsPatch = z.infer<typeof panelBackupSettingsPatch>;

/**
 * POST /v1/system/panel-backup/restore — destructive: replaces this panel's
 * database, master key, .env and Traefik config. `confirm` must repeat the
 * object's file name (the part of `key` after the last `/`).
 */
export const panelBackupRestore = z
  .object({
    /** Destination to read from; omitted = the configured one. On a fresh
     *  install, add the old bucket as a destination and name it here. */
    destinationId: z.number().int().positive().optional(),
    key: z.string().min(1).max(1024),
    passphrase: z.string().min(1).max(1024),
    confirm: z.string().max(1024),
  })
  .strict();
export type PanelBackupRestore = z.infer<typeof panelBackupRestore>;

/** Outcome of the latest run, as `GET /v1/system/panel-backup` reports it. */
export interface PanelBackupRunState {
  status: 'running' | 'completed' | 'failed';
  trigger: 'schedule' | 'manual';
  startedAt: string;
  finishedAt: string | null;
  key: string | null;
  sizeBytes: number | null;
  error: string | null;
  /** Retention problems that did not fail the run (the new backup is safe). */
  warning: string | null;
}

/** `GET /v1/system/panel-backup`. */
export interface PanelBackupStatus {
  settings: {
    enabled: boolean;
    cron: string;
    destinationId: number | null;
    retain: number;
    hasPassphrase: boolean;
  };
  /** True while a run (or a restore) is executing in this process. */
  running: boolean;
  lastRun: PanelBackupRunState | null;
  lastSuccessAt: string | null;
  /** Next scheduled run (ISO) when enabled and the cron is valid. */
  nextRunAt: string | null;
  /** The master key comes from NINEDEPLOY_MASTER_KEY(S), not the master.key
   *  file — backups then do NOT contain it and it must be kept separately. */
  masterKeyFromEnv: boolean;
}

/** One panel backup object in the destination bucket. */
export interface PanelBackupObject {
  key: string;
  name: string;
  sizeBytes: number;
  lastModified: string;
}
