import { z } from 'zod';

// ── Public database access (0.14) ──────────────────────────────────────────
// Request and response shapes for `/v1/databases/:id/public-access`. A
// per-database Traefik TCP sidecar (`nd-dbpub-<slug>`) publishes one host
// port, gated by a required IP allow-list. These are SHAPE checks only: the
// server validates every allow-list entry with `node:net` (and refuses `/0`),
// checks the port against reserved and in-use host ports, and refuses engines
// and TLS modes the sidecar cannot serve. Design: DESIGN.md §1.

export const PUBLIC_ACCESS_PORT_MIN = 1024;
export const PUBLIC_ACCESS_PORT_MAX = 65535;
export const PUBLIC_ACCESS_ALLOWLIST_MAX = 100;

/** Engines a TCP sidecar can expose. Every other engine is refused with 422. */
export const publicAccessEngines = ['postgres', 'mysql', 'mariadb', 'redis', 'valkey', 'mongo'] as const;

/** Mirrors `databasePublicTlsMode` in `@ninedeploy/db`. */
export const publicAccessTlsMode = z.enum(['none', 'terminate']);
export type PublicAccessTlsMode = z.infer<typeof publicAccessTlsMode>;

export const publicAccessPort = z.number().int().min(PUBLIC_ACCESS_PORT_MIN).max(PUBLIC_ACCESS_PORT_MAX);

/** One allow-list entry as typed (an address or CIDR); the server parses it. */
export const publicAccessAllowlistEntry = z.string().trim().min(1).max(64);

/** 1–100 entries. An empty allow-list is never "allow everyone". */
export const publicAccessAllowlist = z.array(publicAccessAllowlistEntry).min(1).max(PUBLIC_ACCESS_ALLOWLIST_MAX);

/** The hostname clients connect to (and, in terminate mode, the TLS name). */
export const publicAccessHostname = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/,
    'must be a valid hostname',
  );

/**
 * PUT /v1/databases/:id/public-access (operator). Applies synchronously and
 * answers with the GET shape. Disabling is DELETE, so `enabled` is pinned to
 * `true` here.
 */
export const publicAccessPut = z.object({
  enabled: z.literal(true),
  port: publicAccessPort,
  ipAllowlist: publicAccessAllowlist,
  tlsMode: publicAccessTlsMode.default('none'),
  tlsHostname: publicAccessHostname.optional(),
});
export type PublicAccessPut = z.input<typeof publicAccessPut>;

/** GET (db admin) and PUT response. `configured: false` = no row. */
export const publicAccessStatus = z.object({
  /** false for engines a TCP sidecar cannot expose. */
  supported: z.boolean(),
  configured: z.boolean(),
  enabled: z.boolean(),
  port: z.number().int().nullable(),
  tlsMode: publicAccessTlsMode,
  tlsHostname: z.string().nullable(),
  ipAllowlist: z.array(z.string()),
  status: z.enum(['off', 'running', 'error']),
  lastError: z.string().nullable(),
  appliedAt: z.string().nullable(),
  /** `tlsHostname`, else the panel domain, else the host of the public URL. */
  publicHost: z.string().nullable(),
});
export type PublicAccessStatus = z.infer<typeof publicAccessStatus>;

/** The `publicAccess` field added to the database serializer; null when unconfigured. */
export const databasePublicAccessSummary = z
  .object({
    enabled: z.boolean(),
    port: z.number().int(),
  })
  .nullable();
export type DatabasePublicAccessSummary = z.infer<typeof databasePublicAccessSummary>;
