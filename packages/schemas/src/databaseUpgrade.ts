import { z } from 'zod';

// ── Database major upgrade (O2) ────────────────────────────────────────────
// Request and response shapes for `/v1/databases/:id/upgrades`. A PostgreSQL
// database on the panel host moves to a newer major by dump and restore into a
// new volume; the previous volume stays until the upgrade is finalized, so it
// can be rolled back. Server side: apps/server/src/lib/databaseUpgrade.ts.

/** Mirrors `databaseUpgradeStatus` in `@ninedeploy/db`. */
export const databaseUpgradeStatus = z.enum(['running', 'completed', 'failed', 'rolled_back', 'finalized']);
export type DatabaseUpgradeStatus = z.infer<typeof databaseUpgradeStatus>;

export const databaseUpgradePhase = z.enum(['pull', 'stop', 'dump', 'restore', 'verify', 'switch', 'start']);
export type DatabaseUpgradePhase = z.infer<typeof databaseUpgradePhase>;

/** POST /v1/databases/:id/upgrades */
export const databaseUpgradeStart = z.object({ toMajor: z.number().int().min(1).max(99) }).strict();
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
  }),
  mismatches: z.array(z.string()),
});
export type DatabaseUpgradeVerification = z.infer<typeof databaseUpgradeVerification>;

export const databaseUpgrade = z.object({
  id: z.number().int(),
  databaseId: z.number().int(),
  engine: z.string(),
  fromMajor: z.number().int(),
  toMajor: z.number().int(),
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
  /** The major the running cluster reports; null when it could not be read. */
  currentMajor: z.number().int().nullable(),
  targets: z.array(z.number().int()),
  /** Why no upgrade can start now (null = one can). */
  refusal: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type DatabaseUpgradeOptions = z.infer<typeof databaseUpgradeOptions>;
