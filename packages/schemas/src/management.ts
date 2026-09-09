import { z } from 'zod';

/**
 * Zod schemas for management/admin endpoints that previously used ad-hoc
 * `as { ... }` casts. Centralising them gives consistent 400 validation errors.
 *
 * The legacy `rolePatch` (admin/member) was removed when the global
 * `users.role` column was dropped. Workspace role changes are now served by
 * `workspaceMemberRoleUpdate` in workspaces.ts.
 */

// ── Update check (admin) ───────────────────────────────────────────────────
export const updateCheckResult = z.object({
  current: z.string(),
  /** null when the feed was unreachable or checks are disabled. */
  latest: z.string().nullable(),
  /** null = unknown; otherwise true when latest > current. */
  updateAvailable: z.boolean().nullable(),
  notesUrl: z.string().nullable(),
  checkedAt: z.string().datetime(),
  /** Present only when updateAvailable is null: why no verdict exists. */
  reason: z.enum(['disabled', 'unreachable']).optional(),
  /** Short feed-side detail (status line / abort reason). */
  detail: z.string().max(200).optional(),
});
export type UpdateCheckResult = z.infer<typeof updateCheckResult>;

// ── Panel self-update (admin) ──────────────────────────────────────────────
/** Body of POST /v1/system/update-start: an exact release tag, e.g. "v0.3.4". */
export const selfUpdateStart = z.object({
  version: z.string().regex(/^v\d+\.\d+\.\d+$/, 'version must be a release tag like v0.3.4'),
});
export type SelfUpdateStart = z.infer<typeof selfUpdateStart>;

/**
 * Live state of a panel-initiated upgrade. The updater deliberately runs
 * outside the panel service's cgroup, so `running` and the terminal phases
 * survive the panel restart that every upgrade performs mid-way; phase is
 * resolved by reading marker files, not by process liveness.
 */
export const selfUpdateStatus = z.object({
  /** False when this install cannot update itself (container mode, dev checkout, no install.sh). */
  supported: z.boolean(),
  phase: z.enum(['idle', 'running', 'success', 'failed', 'unsupported']),
  currentVersion: z.string(),
  targetVersion: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** Short excerpt of the update log when phase === 'failed'. */
  errorTail: z.string().nullable(),
  /** Present when unsupported: why self-update is unavailable here. */
  reason: z.string().optional(),
});
export type SelfUpdateStatus = z.infer<typeof selfUpdateStatus>;

export const webhookCreate = z.object({
  branch: z.string().max(255).optional(),
  /** Newline/comma-separated globs — deploy only when a changed file matches. */
  watchPaths: z.string().max(1024).refine((raw) => {
    const patterns = raw.split(/[\n,]/).map((pattern) => pattern.trim()).filter(Boolean);
    return patterns.length <= 32 && patterns.every((pattern) => pattern.length <= 256 && (pattern.match(/\*\*/g) ?? []).length <= 4 && (pattern.match(/[?*]/g) ?? []).length <= 16);
  }, 'watchPaths contains an unsafe glob pattern').optional(),
});
export type WebhookCreate = z.infer<typeof webhookCreate>;

export const sourcePatch = z.object({
  name: z.string().min(1).max(100).optional(),
  token: z.string().max(4096).optional(),
  deployKey: z.string().max(16384).optional(),
  registryUsername: z.string().max(255).optional(),
  defaultBranch: z.string().max(255).optional(),
});
export type SourcePatch = z.infer<typeof sourcePatch>;

export const notificationType = z.enum(['telegram', 'webhook', 'discord', 'slack', 'ntfy', 'email', 'fcm']);

export const notificationChannelCreate = z.object({
  name: z.string().min(1).max(100),
  type: notificationType,
  target: z.string().min(1).max(2048),
  eventFilter: z.string().max(1000).optional(),
  // Per-provider configuration blob. Discord reads username / avatarUrl /
  // title / color for the embed; webhook (G-06) reads
  // `secret` / `headerName` / `algorithm` / `template`; other
  // channel types ignore it. Capped at 4KB so a misbehaving
  // client can't bloat the row.
  configJson: z.string().max(4096).optional(),
});
export type NotificationChannelCreate = z.infer<typeof notificationChannelCreate>;

/**
 * Webhook channel config (G-06). The dispatch path reads
 * this from the `configJson` blob; the schema here is
 * exported for the SDK and CLI to validate user input
 * BEFORE the string is round-tripped to the database.
 */
export const webhookChannelConfig = z
  .object({
    /** HMAC secret. Required for the signature header to be emitted. */
    secret: z.string().min(1).max(256).optional(),
    /** Signature header name. Defaults to `X-NineDeploy-Signature`. */
    headerName: z.string().min(1).max(64).regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'invalid HTTP header name').optional(),
    /** Hash algorithm. Defaults to `sha256`. */
    algorithm: z.enum(['sha256', 'sha1']).optional(),
    /**
     * Body template. Either a JSON object (sent verbatim, with
     * `${event}` / `${entity}` / `${message}` / `${ts}`
     * placeholders expanded) or a string template that's
     * JSON-encoded before send. The default — when this is
     * absent — is the four-field envelope
     * `{ event, entity, ts, message }`.
     */
    template: z
      .union([
        z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
        z.string().max(2048),
      ])
      .optional(),
  })
  .strict();
export type WebhookChannelConfig = z.infer<typeof webhookChannelConfig>;

export const notificationChannelPatch = z.object({
  name: z.string().min(1).max(100).optional(),
  target: z.string().min(1).max(2048).optional(),
  eventFilter: z.string().max(1000).optional(),
  active: z.boolean().optional(),
  // Empty string clears the channel's provider-specific config.
  configJson: z.string().max(4096).optional(),
});
export type NotificationChannelPatch = z.infer<typeof notificationChannelPatch>;

export const alertMetricEnum = z.enum(['cpu', 'memory', 'cert-expiry']);
export const alertOperatorEnum = z.enum(['>', '<']);

export const alertRuleCreate = z
  .object({
    name: z.string().min(1).max(100),
    serviceId: z.number().int().positive().nullable().optional(),
    metric: alertMetricEnum,
    operator: alertOperatorEnum.default('>'),
    threshold: z.number().int(),
    durationWindows: z.number().int().min(1).max(120).default(1),
    enabled: z.boolean().default(true),
  })
  // Certificate expiry is tracked per HOST (the collector samples the ACME
  // store), so a service-scoped rule could never evaluate.
  .refine((r) => r.metric !== 'cert-expiry' || !r.serviceId, {
    message: 'cert-expiry rules are host-wide (omit serviceId)',
    path: ['serviceId'],
  });
export type AlertRuleCreate = z.infer<typeof alertRuleCreate>;

export const alertRulePatch = z
  .object({
    name: z.string().min(1).max(100).optional(),
    serviceId: z.number().int().positive().nullable().optional(),
    metric: alertMetricEnum.optional(),
    operator: alertOperatorEnum.optional(),
    threshold: z.number().int().optional(),
    durationWindows: z.number().int().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((r) => r.metric !== 'cert-expiry' || !r.serviceId, {
    message: 'cert-expiry rules are host-wide (omit serviceId)',
    path: ['serviceId'],
  });
export type AlertRulePatch = z.infer<typeof alertRulePatch>;

// ── Backup destinations (admin) ────────────────────────────────────────────
/**
 * Blank region/prefix fall back to the documented defaults (pre-schema
 * behaviour); the endpoint must be an http(s) URL.
 */
export const backupDestinationCreate = z.object({
  name: z.string().trim().min(1).max(100),
  endpoint: z.string().trim().regex(/^https?:\/\//, 'endpoint must be an http(s) URL'),
  region: z.string().trim().optional().transform((v) => v || 'us-east-1'),
  bucket: z.string().trim().min(1).max(255),
  prefix: z.string().trim().optional().transform((v) => v || 'ninedeploy'),
  accessKeyId: z.string().trim().min(1).max(255),
  secretAccessKey: z.string().min(1).max(4096),
});
export type BackupDestinationCreate = z.infer<typeof backupDestinationCreate>;

/**
 * All fields optional; blank strings are accepted here and skipped by the
 * route (patching e.g. `name: " "` is a no-op, not an error).
 */
export const backupDestinationPatch = z.object({
  name: z.string().max(100).optional(),
  endpoint: z.string().max(2048).optional(),
  region: z.string().max(100).optional(),
  bucket: z.string().max(255).optional(),
  prefix: z.string().max(255).optional(),
  accessKeyId: z.string().max(255).optional(),
  secretAccessKey: z.string().max(4096).optional(),
  active: z.boolean().optional(),
});
export type BackupDestinationPatch = z.infer<typeof backupDestinationPatch>;

// ── Remote servers (admin) ─────────────────────────────────────────────────
/**
 * `host` is a bare hostname (or IP) or host:port. A non-numeric port falls
 * back to the default 4600 (pre-schema behaviour); an out-of-range one is
 * rejected.
 */
export const serverCreate = z.object({
  name: z.string().trim().min(1).max(100),
  host: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9.-]*(:\d+)?$/, 'host must be a hostname or host:port'),
  port: z
    .unknown()
    .optional()
    .transform((v) => Number(v ?? 4600) || 4600)
    .pipe(z.number().int().min(1).max(65535)),
});
export type ServerCreate = z.infer<typeof serverCreate>;

export const serverAnnounce = z.object({
  name: z.string().trim().min(1).max(100),
  host: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9.-]*(:\d+)?$/, 'host must be a hostname or host:port')
    .optional(),
  port: z
    .unknown()
    .optional()
    .transform((v) => Number(v ?? 4600) || 4600)
    .pipe(z.number().int().min(1).max(65535)),
  token: z.string().trim().min(16).max(256),
});
export type ServerAnnounce = z.infer<typeof serverAnnounce>;

export const sshAuthType = z.enum(['key', 'password']);
export type SshAuthType = z.infer<typeof sshAuthType>;

/**
 * SSH destination operands.
 *
 * These are joined as `${sshUser}@${host}` and handed to the `ssh` binary as a
 * single argv element. OpenSSH parses any element that STARTS WITH `-` as an
 * option, so an unconstrained `sshUser` of `-oProxyCommand=…` turns the
 * destination into an option whose value runs through /bin/sh on the panel
 * host. Constraining the charset (no leading dash, no whitespace, no `@`)
 * keeps the element a destination.
 */
const sshUser = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/, 'invalid SSH username')
  .default('root');

/** A hostname, IPv4 or bare IPv6 address — same reasoning as `sshUser`. */
const sshHost = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.:_-]*$/, 'invalid SSH host');

export const serverSshTest = z.object({
  host: sshHost,
  sshPort: z
    .unknown()
    .optional()
    .transform((v) => Number(v ?? 22) || 22)
    .pipe(z.number().int().min(1).max(65535)),
  sshUser,
  authType: sshAuthType.default('key'),
  sshKey: z.string().optional(),
  sshPassword: z.string().optional(),
});
export type ServerSshTest = z.infer<typeof serverSshTest>;

export const serverSshBootstrap = z.object({
  name: z.string().trim().min(1).max(100),
  host: sshHost,
  sshPort: z
    .unknown()
    .optional()
    .transform((v) => Number(v ?? 22) || 22)
    .pipe(z.number().int().min(1).max(65535)),
  sshUser,
  authType: sshAuthType.default('key'),
  sshKey: z.string().optional(),
  sshPassword: z.string().optional(),
  installDocker: z.boolean().default(true),
  agentPort: z
    .unknown()
    .optional()
    .transform((v) => Number(v ?? 4600) || 4600)
    .pipe(z.number().int().min(1).max(65535)),
});
export type ServerSshBootstrap = z.infer<typeof serverSshBootstrap>;

export interface ServerSshTestResult {
  ok: boolean;
  message: string;
  os?: string;
  dockerInstalled?: boolean;
  dockerVersion?: string;
  latencyMs?: number;
}

export interface ServerBootstrapStep {
  step: 'connecting' | 'os_detect' | 'docker_check' | 'docker_install' | 'agent_deploy' | 'verify' | 'done' | 'error';
  status: 'pending' | 'running' | 'success' | 'failed';
  message: string;
  timestamp: string;
}

export interface ServerBootstrapResult {
  ok: boolean;
  serverId?: number;
  serverName?: string;
  steps: ServerBootstrapStep[];
  logs: string[];
  error?: string;
}

// ── Scheduled jobs ─────────────────────────────────────────────────────────
/**
 * The cron expression itself is validated with croner at the route (the
 * schema package has no cron dependency); a non-string `command` is ignored
 * (empty string) as before.
 */
export const jobCreate = z.object({
  name: z.string().trim().min(1).max(100),
  cron: z.string().trim().min(1).max(120),
  kind: z.enum(['deploy', 'exec', 'backup']).default('deploy'),
  command: z.unknown().optional().transform((v) => (typeof v === 'string' ? v.trim() : '')),
  enabled: z.unknown().optional().transform((v) => v !== false),
});
export type JobCreate = z.infer<typeof jobCreate>;

/** Blank strings are accepted and treated as "no change"/cleared by the route. */
export const jobPatch = z.object({
  name: z.string().optional(),
  cron: z.string().optional(),
  kind: z.enum(['deploy', 'exec', 'backup']).optional(),
  command: z.string().optional(),
  enabled: z.boolean().optional(),
});
export type JobPatch = z.infer<typeof jobPatch>;

// ── Metrics query ──────────────────────────────────────────────────────────
/**
 * Query params arrive as strings: any `kind` other than "memory" reads as
 * "cpu", and an unusable `minutes` falls back to 60 (clamped to 1..1440).
 */
export const metricQuery = z.object({
  kind: z.string().optional().transform((k) => (k === 'memory' ? 'memory' : 'cpu')),
  minutes: z
    .unknown()
    .optional()
    .transform((v) => Math.min(Math.max(Number(v ?? 60) || 60, 1), 1440)),
});
export type MetricQuery = z.infer<typeof metricQuery>;

/** Serialized alert rule as returned by GET/PATCH /v1/alerts. */
export interface AlertRule {
  id: number;
  serviceId: number | null;
  name: string;
  metric: 'cpu' | 'memory' | 'cert-expiry';
  operator: '>' | '<';
  threshold: number;
  durationWindows: number;
  enabled: boolean;
  status: 'ok' | 'breaching' | 'firing';
  lastValue: number | null;
  /** When the collector last evaluated the rule (null = never evaluated). */
  lastEvaluatedAt: string | null;
  firedAt: string | null;
  createdAt: string;
}

/** Input for creating an alert rule — defaults optional (zod applies them server-side). */
export type CreateAlertRuleInput = z.input<typeof alertRuleCreate>;

/** One audit-log entry (activity feed). `meta` carries request context (ip/ua). */
export interface ActivityEntry {
  id: number;
  userId: number | null;
  userName?: string | null;
  userEmail?: string | null;
  action: string;
  entity: string | null;
  meta: Record<string, unknown> | null;
  ts: string;
}

// ── Traefik proxy schemas & types ──────────────────────────────────────────
export interface TraefikStatus {
  running: boolean;
  version: string | null;
  versionLatest: string | null;
  outdated: boolean;
  uptime: string | null;
  ports: { http: number; https: number };
  configDir: string;
}

export interface TraefikCertificate {
  domain: string;
  expiresAt: string | null;
  daysUntilExpiry: number | null;
  issuer: string | null;
}

/**
 * Richer certificate inventory (G-15). The basic
 * `TraefikCertificate` shape is what the existing
 * `/v1/traefik/certificates` returns; the inventory
 * adds `sans` (parsed from the leaf cert's subject
 * alt names when available), `notBefore`, `status`
 * (valid / expiring-soon / expired), `autoRenew`
 * (true when the host is owned by a Let's Encrypt
 * solver), and `source` (`acme.json` | `static`).
 *
 * `daysToExpiry` is the same as `daysUntilExpiry`
 * for backwards compat; new code should prefer
 * `daysToExpiry` to match the column name in the
 * alerting engine.
 */
export interface CertificateInventoryEntry {
  host: string;
  issuer: string | null;
  subject: string | null;
  sans: string[];
  notBefore: string | null;
  notAfter: string | null;
  daysToExpiry: number | null;
  status: 'valid' | 'expiring-soon' | 'expired' | 'unknown';
  autoRenew: boolean;
  source: 'acme.json' | 'static' | 'unknown';
}

export interface CertificateInventorySummary {
  total: number;
  valid: number;
  expiringSoon: number;
  expired: number;
  /** Threshold used for `expiring-soon`; defaults to 30. */
  expiringThresholdDays: number;
  /** When the inventory was last rebuilt. */
  fetchedAt: string;
}

export interface CertificateInventoryReport {
  certificates: CertificateInventoryEntry[];
  summary: CertificateInventorySummary;
}

export interface TraefikRouter {
  name: string;
  rule: string;
  service: string;
  entryPoints: string[];
  tls: boolean;
  middleware: string[];
}

export interface TraefikService {
  name: string;
  url: string;
  loadBalancer: string;
}

export interface TraefikMiddleware {
  name: string;
  type: string;
  config: Record<string, unknown>;
}

export interface TraefikInfo {
  status: TraefikStatus;
  certificates: TraefikCertificate[];
  routers: TraefikRouter[];
  services: TraefikService[];
  middlewares: TraefikMiddleware[];
}

// ── Database detail & credentials types ─────────────────────────────────────
export interface DatabaseDetail {
  id: number;
  projectId: number | null;
  name: string;
  slug: string;
  engine: string;
  version: string | null;
  status: string;
  host: string | null;
  port: number | null;
  username: string | null;
  database: string | null;
  connectionString: string | null;
  containerName?: string | null;
  containerId?: string | null;
  volumeName?: string | null;
  cpuShares?: number | null;
  memLimitMb?: number | null;
  webGuiEnabled?: boolean | null;
  webGuiPort?: number | null;
  extensions?: string[];
  attachedServices: Array<{ id: number; name: string; slug: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseCredentials {
  engine: string;
  username: string | null;
  password: string;
  database: string | null;
  internalHost: string | null;
  internalPort: number | null;
  connectionString: string;
}

export const demoSeedResult = z.object({
  ok: z.boolean(),
  projectId: z.number(),
  projectName: z.string(),
  services: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      type: z.string(),
      status: z.string(),
      port: z.number().nullable(),
    }),
  ),
  database: z
    .object({
      id: z.number(),
      name: z.string(),
      engine: z.string(),
    })
    .nullable(),
});
export type DemoSeedResult = z.infer<typeof demoSeedResult>;

