import { z } from 'zod';

// ── Database major upgrade (O2) ────────────────────────────────────────────
// Request and response shapes for `/v1/databases/:id/upgrades`. A database on
// the panel host moves to a newer release in a new volume: PostgreSQL by dump
// and restore, MySQL and MariaDB by copying the stopped data directory and
// upgrading the copy in place. The previous volume stays until the upgrade is
// finalized, so it can be rolled back. Server side:
// apps/server/src/lib/databaseUpgrade.ts.

/** Mirrors `databaseUpgradeStatus` in `@ninedeploy/db`. */
export const databaseUpgradeStatus = z.enum(['running', 'completed', 'failed', 'rolled_back', 'finalized']);
export type DatabaseUpgradeStatus = z.infer<typeof databaseUpgradeStatus>;

export const databaseUpgradePhase = z.enum(['pull', 'stop', 'dump', 'copy', 'upgrade', 'restore', 'verify', 'switch', 'start']);
export type DatabaseUpgradePhase = z.infer<typeof databaseUpgradePhase>;

/**
 * POST /v1/databases/:id/upgrades. `toVersion` names the target series
 * (`18`, `8.4`, `11.8`); `toMajor` is the PostgreSQL major, kept for clients
 * from before MySQL and MariaDB. Exactly one of the two.
 */
export const databaseUpgradeStart = z
  .object({
    toMajor: z.number().int().min(1).max(99).optional(),
    toVersion: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, 'toVersion is a release series such as 18, 8.4 or 11.8').optional(),
  })
  .strict()
  .refine((b) => (b.toMajor === undefined) !== (b.toVersion === undefined), { message: 'Give exactly one of toMajor and toVersion' });
export type DatabaseUpgradeStart = z.infer<typeof databaseUpgradeStart>;

/** What the restored copy was compared on (row counts are exact, per user table). */
export const databaseUpgradeVerification = z.object({
  tables: z.number().int(),
  rows: z.number(),
  sequences: z.number().int(),
  objects: z.object({
    indexes: z.number().int(),
    constraints: z.number().int(),
    views: z.number().int(),
    triggers: z.number().int(),
    functions: z.number().int(),
    extensions: z.string(),
    /** MySQL/MariaDB: scheduled events and user databases. */
    events: z.number().int().optional(),
    schemas: z.number().int().optional(),
  }),
  /** MySQL/MariaDB: accounts checked (each must still exist after). */
  users: z.number().int().optional(),
  mismatches: z.array(z.string()),
});
export type DatabaseUpgradeVerification = z.infer<typeof databaseUpgradeVerification>;

export const databaseUpgrade = z.object({
  id: z.number().int(),
  databaseId: z.number().int(),
  engine: z.string(),
  fromMajor: z.number().int(),
  toMajor: z.number().int(),
  /** The release series: the PostgreSQL major as text, or `8.0` → `8.4` for MySQL/MariaDB (where the major alone is ambiguous). */
  fromSeries: z.string(),
  toSeries: z.string(),
  previousVersion: z.string().nullable(),
  targetVersion: z.string(),
  previousVolume: z.string(),
  targetVolume: z.string(),
  status: databaseUpgradeStatus,
  phase: databaseUpgradePhase.nullable(),
  safetyBackupId: z.number().int().nullable(),
  verification: databaseUpgradeVerification.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  rolledBackAt: z.string().nullable(),
  finalizedAt: z.string().nullable(),
});
export type DatabaseUpgrade = z.infer<typeof databaseUpgrade>;

/** GET /v1/databases/:id/upgrades/options: what this database can move to now. */
export const databaseUpgradeOptions = z.object({
  databaseId: z.number().int(),
  engine: z.string(),
  /** The major the running cluster reports (MySQL/MariaDB: the leading number of its series); null when it could not be read. */
  currentMajor: z.number().int().nullable(),
  /** PostgreSQL majors it can move to (empty for MySQL/MariaDB: read `versions`). */
  targets: z.array(z.number().int()),
  /** The series the running server reports: `16`, `8.0`, `11.4`. */
  currentSeries: z.string().nullable(),
  /** Every series it can move to, oldest first: pass one as `toVersion`. */
  versions: z.array(z.string()),
  /** Why no upgrade can start now (null = one can). */
  refusal: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type DatabaseUpgradeOptions = z.infer<typeof databaseUpgradeOptions>;
