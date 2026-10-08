import { z } from 'zod';
import { id } from './common.js';

// ── Terminals (0.15) ────────────────────────────────────────────────────────
// Request and response shapes for `/v1/terminals`: interactive shells into a
// service replica, a managed database, any managed container, or (off by
// default, owner decision O1) the host of a server. A session is created over
// HTTP and attached over a WebSocket with a single-use ticket. Metadata only:
// no transcript is ever recorded (O2). These are SHAPE checks; the server
// resolves and authorises every target. Design: DESIGN.md §1.

export const TERMINAL_COLS_MIN = 10;
export const TERMINAL_COLS_MAX = 500;
export const TERMINAL_ROWS_MIN = 5;
export const TERMINAL_ROWS_MAX = 200;
/** Per-frame cap of the attach socket (protocol v1); a larger frame closes 1009. */
export const TERMINAL_FRAME_MAX_BYTES = 64 * 1024;
export const TERMINAL_HISTORY_LIMIT_MAX = 200;

/** Mirrors `terminalTargetKind` in `@ninedeploy/db`. */
export const terminalTargetKind = z.enum(['service', 'database', 'container', 'host']);
export type TerminalTargetKind = z.infer<typeof terminalTargetKind>;

/** Mirrors `terminalSessionStatus` in `@ninedeploy/db`. */
export const terminalSessionStatus = z.enum(['pending', 'active', 'ended', 'failed', 'expired']);
export type TerminalSessionStatus = z.infer<typeof terminalSessionStatus>;

/** A managed container name (`isManagedContainer` is checked server side). */
export const terminalContainerName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/, 'must be a container name');

export const terminalTarget = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('service'),
      serviceId: id,
      /** 1-based replica index; omitted = the primary container. */
      replica: z.number().int().min(1).max(50).optional(),
      /** A node the service runs on (primary or fan-out target); omitted = its primary. */
      serverId: id.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('database'),
      databaseId: id,
      /** `client` runs the engine CLI with the stored credentials. */
      mode: z.enum(['shell', 'client']).default('shell'),
    })
    .strict(),
  z.object({ kind: z.literal('container'), name: terminalContainerName }).strict(),
  z
    .object({
      kind: z.literal('host'),
      /** null = the panel host. */
      serverId: id.nullable(),
    })
    .strict(),
]);
export type TerminalTarget = z.infer<typeof terminalTarget>;
export type TerminalTargetInput = z.input<typeof terminalTarget>;

export const terminalCols = z.number().int().min(TERMINAL_COLS_MIN).max(TERMINAL_COLS_MAX);
export const terminalRows = z.number().int().min(TERMINAL_ROWS_MIN).max(TERMINAL_ROWS_MAX);

/** POST /v1/terminals (operator). `password` is the step-up for host shells. */
export const createTerminalSession = z
  .object({
    target: terminalTarget,
    cols: terminalCols.default(120),
    rows: terminalRows.default(32),
    password: z.string().min(1).max(1024).optional(),
  })
  .strict();
export type CreateTerminalSession = z.infer<typeof createTerminalSession>;
export type CreateTerminalSessionInput = z.input<typeof createTerminalSession>;

/** One session row as the API returns it (history, detail, create). */
export const terminalSession = z.object({
  id,
  status: terminalSessionStatus,
  targetKind: terminalTargetKind,
  targetLabel: z.string(),
  /** null = the panel host. */
  serverId: id.nullable(),
  userId: id.nullable(),
  userEmail: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  bytesIn: z.number().int().nonnegative(),
  bytesOut: z.number().int().nonnegative(),
  endReason: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  clientIp: z.string().nullable(),
});
export type TerminalSession = z.infer<typeof terminalSession>;

/** 201 answer of POST /v1/terminals. The ticket is single use and valid for 30s. */
export const terminalSessionCreated = z.object({
  session: terminalSession,
  ticket: z.string().min(1),
  ticketExpiresAt: z.string(),
  /** `/v1/terminals/:id/attach`. */
  attachPath: z.string().regex(/^\/v1\/terminals\/\d+\/attach$/),
});
export type TerminalSessionCreated = z.infer<typeof terminalSessionCreated>;

/** GET /v1/terminals query (history). Query strings arrive as text. */
export const terminalSessionListQuery = z
  .object({
    status: terminalSessionStatus.optional(),
    userId: z.coerce.number().int().positive().optional(),
    targetKind: terminalTargetKind.optional(),
    limit: z.coerce.number().int().min(1).max(TERMINAL_HISTORY_LIMIT_MAX).default(50),
    /** Page backwards from this session id. */
    before: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type TerminalSessionListQuery = z.infer<typeof terminalSessionListQuery>;

/**
 * PUT /v1/terminals/settings (operator). Partial: only the named keys change.
 * Turning `hostTerminalEnabled` on needs step-up (`password`, or a sign-in
 * less than 10 minutes old) and an interactive session.
 */
export const terminalSettings = z
  .object({
    hostTerminalEnabled: z.boolean(),
    idleTimeoutMinutes: z.number().int().min(1).max(240),
    maxSessionMinutes: z.number().int().min(5).max(1440),
    maxConcurrent: z.number().int().min(1).max(50),
    retentionDays: z.number().int().min(30).max(3650),
    password: z.string().max(1024).optional(),
  })
  .partial()
  .strict();
export type TerminalSettingsInput = z.infer<typeof terminalSettings>;

/** GET /v1/terminals/settings: the stored values (defaults when unset). */
export const terminalSettingsView = z.object({
  hostTerminalEnabled: z.boolean(),
  /** `NINEDEPLOY_HOST_TERMINAL=off` forbids host shells whatever the setting says. */
  hostTerminalForbiddenByEnv: z.boolean(),
  idleTimeoutMinutes: z.number().int(),
  maxSessionMinutes: z.number().int(),
  maxConcurrent: z.number().int(),
  retentionDays: z.number().int(),
});
export type TerminalSettingsView = z.infer<typeof terminalSettingsView>;

/** Defaults applied when a settings key is absent (fresh and upgraded installs alike). */
export const TERMINAL_SETTINGS_DEFAULTS = {
  hostTerminalEnabled: false,
  idleTimeoutMinutes: 15,
  maxSessionMinutes: 240,
  maxConcurrent: 10,
  retentionDays: 180,
} as const;

// ── attach protocol v1 (`ninedeploy.terminal.v1`) ──────────────────────────
// Binary frames carry stdin / output. Text frames carry these JSON messages.

/** Client → server text frames. */
export const terminalClientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('resize'), cols: terminalCols, rows: terminalRows }).strict(),
  z.object({ t: z.literal('ping') }).strict(),
]);
export type TerminalClientMessage = z.infer<typeof terminalClientMessage>;

/** Server → client text frames. */
export const terminalServerMessage = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('ready'),
    sessionId: id,
    target: z.object({ kind: terminalTargetKind, label: z.string(), serverId: id.nullable() }),
  }),
  z.object({ t: z.literal('notice'), message: z.string() }),
  z.object({ t: z.literal('exit'), code: z.number().int().nullable(), reason: z.string() }),
]);
export type TerminalServerMessage = z.infer<typeof terminalServerMessage>;

/** WebSocket close codes of the attach socket. */
export const TERMINAL_CLOSE = {
  shellExited: 1000,
  frameTooLarge: 1009,
  badTicket: 4401,
  forbidden: 4403,
  idle: 4408,
  maxDuration: 4409,
  terminated: 4410,
  tooManySessions: 4429,
  targetUnreachable: 4502,
} as const;

/** Subprotocols of the attach socket: the protocol name, then the ticket. */
export const TERMINAL_PROTOCOL = 'ninedeploy.terminal.v1';
export const TERMINAL_TICKET_PROTOCOL_PREFIX = 'ninedeploy.ticket.';
