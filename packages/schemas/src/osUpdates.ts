import { z } from 'zod';

// ── OS security updates (G4.2) ─────────────────────────────────────────────
// What the panel reports about a host's packages: the panel host through
// `/v1/os-updates`, a node through `/v1/servers/:id/os-updates` (agent op
// `host.packages`). The panel never reboots a host.

export const osPackageManager = z.enum(['apt', 'dnf', 'unsupported']);
export type OsPackageManager = z.infer<typeof osPackageManager>;

export const osPendingUpdate = z.object({
  name: z.string(),
  version: z.string(),
  /** The installed version, when the package manager reports it. */
  from: z.string().nullable(),
  security: z.boolean(),
});
export type OsPendingUpdate = z.infer<typeof osPendingUpdate>;

/** At most this many pending updates are listed; `updatesTruncated` says when more exist. */
export const OS_UPDATES_MAX = 1000;

export const osUpdateStatus = z.object({
  os: z.object({ id: z.string(), version: z.string(), name: z.string() }),
  packageManager: osPackageManager,
  updates: z.array(osPendingUpdate).max(OS_UPDATES_MAX),
  updatesTruncated: z.boolean(),
  securityCount: z.number().int().min(0),
  autoUpdates: z.object({
    /** unattended-upgrades (apt) or dnf-automatic (dnf) is installed. */
    installed: z.boolean(),
    /** Security updates install on their own. */
    enabled: z.boolean(),
  }),
  /** A reboot finishes installed updates; null when the host cannot tell (no needs-restarting). */
  rebootRequired: z.boolean().nullable(),
  /** Packages that asked for the reboot (Debian/Ubuntu). */
  rebootPackages: z.array(z.string()).max(200),
  /** Non-fatal problems while reading, such as a failed package-list refresh. */
  warnings: z.array(z.string()).max(20),
  checkedAt: z.string(),
});
export type OsUpdateStatus = z.infer<typeof osUpdateStatus>;

/** POST …/os-updates/auto. */
export const osAutoUpdatesInput = z.object({ enabled: z.boolean() });
export type OsAutoUpdatesInput = z.infer<typeof osAutoUpdatesInput>;

/** GET …/os-updates: `refresh=1` refreshes the package lists before reading. */
export const osUpdateStatusQuery = z.object({ refresh: z.enum(['0', '1']).optional() }).strict();
