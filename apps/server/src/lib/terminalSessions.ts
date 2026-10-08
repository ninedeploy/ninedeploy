import { randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { type DB, type TerminalSession as TerminalSessionRow, terminalSessions, users } from '@ninedeploy/db';
import {
  TERMINAL_CLOSE,
  TERMINAL_SETTINGS_DEFAULTS,
  type TerminalSession,
  type TerminalSettingsView,
  type TerminalTargetKind,
} from '@ninedeploy/schemas';
import { TRAEFIK_IMAGE } from '../engine/dockerNames.js';
import type { AuthUser } from '../plugins/auth.js';
import { audit } from './audit.js';
import { resolveUser } from './auth.js';
import { sha256 } from './crypto.js';
import {
  type DockerTransport,
  isEngineTransport,
  openCliPipeTty,
  openExecTty,
  openHostShellTty,
  SHELL_CMD,
  type TtyProcess,
} from './dockerTty.js';
import { verifyJwt } from './jwt.js';
import { findLiveSession } from './sessions.js';
import { getSetting, getSettingJson } from './settings.js';
import { encodeServerMessage, parseClientFrame } from './terminalProtocol.js';

/**
 * Terminal session engine (0.15, DESIGN §1.2, §1.6). Owner: task T2a.
 *
 * - Settings (`terminal_*` keys; absent = the defaults, so an upgraded panel
 *   behaves like a fresh one: host shells off).
 * - Tickets: 32 random bytes, stored as sha256 only, valid 30s, single use.
 * - The principal that created a session, held in process memory only, and
 *   its 60s revalidation.
 * - The live-session registry (caps, termination) and the bridge between the
 *   browser socket and a `TtyProcess`, which records duration, bytes, the end
 *   reason and the exit code, and audits the end in a `finally`.
 * - Boot recovery, the reaper's ticket expiry, and retention.
 *
 * Metadata only (owner decision O2): no byte of terminal input or output is
 * ever stored.
 */

// ── settings ────────────────────────────────────────────────────────────────

/** Default for the `terminal_retention_days` setting. */
export const TERMINAL_RETENTION_DAYS_DEFAULT = TERMINAL_SETTINGS_DEFAULTS.retentionDays;

export const TERMINAL_SETTING_KEYS = {
  hostTerminalEnabled: 'terminal_host_enabled',
  idleTimeoutMinutes: 'terminal_idle_timeout_minutes',
  maxSessionMinutes: 'terminal_max_session_minutes',
  maxConcurrent: 'terminal_max_concurrent',
  retentionDays: 'terminal_retention_days',
} as const;

/** Bounds of the numeric settings (mirrors the `terminalSettings` contract). */
const NUMERIC_BOUNDS = {
  idleTimeoutMinutes: [1, 240],
  maxSessionMinutes: [5, 1440],
  maxConcurrent: [1, 50],
  retentionDays: [30, 3650],
} as const;

/** Live sessions one user may hold at a time, whatever `maxConcurrent` says. */
export const TERMINAL_PER_USER_MAX = 3;
/** Ticket lifetime. */
export const TERMINAL_TICKET_TTL_MS = 30_000;
/** How often a live session re-checks its principal. */
export const TERMINAL_REVALIDATE_MS = 60_000;
/** Backpressure: pause the shell while the socket holds more than this. */
export const TERMINAL_BACKPRESSURE_HIGH = 4 * 1024 * 1024;

export type TerminalSettingsValues = Omit<TerminalSettingsView, 'hostTerminalForbiddenByEnv'>;

/** `NINEDEPLOY_HOST_TERMINAL=off` forbids host shells whatever the setting says (owner decision O1). */
export function hostTerminalForbiddenByEnv(): boolean {
  return /^(off|false|0|no|disabled)$/i.test((process.env['NINEDEPLOY_HOST_TERMINAL'] ?? '').trim());
}

/** The helper image for host shells: `NINEDEPLOY_HOST_SHELL_IMAGE`, else the Traefik image (already present). */
export function hostShellImage(): string {
  const configured = (process.env['NINEDEPLOY_HOST_SHELL_IMAGE'] ?? '').trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}$/.test(configured) ? configured : TRAEFIK_IMAGE;
}

async function numberSetting(db: DB, key: string, fallback: number, [min, max]: readonly [number, number]): Promise<number> {
  const raw = await getSettingJson<unknown>(db, key, null).catch(() => null);
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max ? raw : fallback;
}

export async function readTerminalSettings(db: DB): Promise<TerminalSettingsValues> {
  const d = TERMINAL_SETTINGS_DEFAULTS;
  const k = TERMINAL_SETTING_KEYS;
  return {
    hostTerminalEnabled: await getSetting(db, k.hostTerminalEnabled, d.hostTerminalEnabled).catch(() => false),
    idleTimeoutMinutes: await numberSetting(db, k.idleTimeoutMinutes, d.idleTimeoutMinutes, NUMERIC_BOUNDS.idleTimeoutMinutes),
    maxSessionMinutes: await numberSetting(db, k.maxSessionMinutes, d.maxSessionMinutes, NUMERIC_BOUNDS.maxSessionMinutes),
    maxConcurrent: await numberSetting(db, k.maxConcurrent, d.maxConcurrent, NUMERIC_BOUNDS.maxConcurrent),
    retentionDays: await numberSetting(db, k.retentionDays, d.retentionDays, NUMERIC_BOUNDS.retentionDays),
  };
}

export async function terminalSettingsView(db: DB): Promise<TerminalSettingsView> {
  return { ...(await readTerminalSettings(db)), hostTerminalForbiddenByEnv: hostTerminalForbiddenByEnv() };
}

/** Host shells are possible: the setting is on AND the environment does not forbid them. */
export async function hostTerminalAllowed(db: DB): Promise<boolean> {
  if (hostTerminalForbiddenByEnv()) return false;
  return (await readTerminalSettings(db)).hostTerminalEnabled;
}

// ── tickets ─────────────────────────────────────────────────────────────────

export const hashTicket = (ticket: string): string => sha256(ticket);

/** A fresh single-use ticket. Only `hash` is ever written to the database. */
export function issueTicket(now = Date.now()): { ticket: string; hash: string; expiresAt: Date } {
  const ticket = randomBytes(32).toString('base64url');
  return { ticket, hash: hashTicket(ticket), expiresAt: new Date(now + TERMINAL_TICKET_TTL_MS) };
}

/**
 * Consume a ticket: one atomic UPDATE flips the row from `pending` to
 * `active` and clears the hash, so a ticket can be used once even by two
 * racing sockets. Null when the ticket is wrong, used or expired.
 */
export async function consumeTicket(db: DB, sessionId: number, ticket: string, now = new Date()): Promise<TerminalSessionRow | null> {
  const rows = await db
    .update(terminalSessions)
    .set({ status: 'active', ticketHash: null, startedAt: now })
    .where(
      and(
        eq(terminalSessions.id, sessionId),
        eq(terminalSessions.ticketHash, hashTicket(ticket)),
        eq(terminalSessions.status, 'pending'),
        gt(terminalSessions.ticketExpiresAt, now),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

// ── the principal (in memory only) ──────────────────────────────────────────

/**
 * Who opened a session, for the 60s revalidation. Browser sessions are
 * re-checked by their session row (`jti`) and token version, not by
 * re-verifying the access token: that token expires in minutes, and a
 * terminal must not die with it while the sign-in it belongs to is still
 * live. API tokens are re-resolved (they carry no expiry of minutes). The
 * bearer is kept only where it is needed, and only here — never in a table.
 */
export type TerminalPrincipal =
  | { authKind: 'session'; userId: number; jti: string | null; ver: number | null; bearer: string | null }
  | { authKind: 'api_token'; userId: number; bearer: string };

export const bearerFromHeader = (header: string | undefined): string | null =>
  header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() || null : null;

export async function principalFor(user: Pick<AuthUser, 'id' | 'viaApiToken'>, authorization: string | undefined): Promise<TerminalPrincipal> {
  const bearer = bearerFromHeader(authorization);
  if (user.viaApiToken && bearer) return { authKind: 'api_token', userId: user.id, bearer };
  if (bearer && bearer.split('.').length === 3) {
    try {
      const payload = await verifyJwt(bearer);
      if (payload.jti) {
        return { authKind: 'session', userId: user.id, jti: payload.jti, ver: typeof payload.ver === 'number' ? payload.ver : null, bearer: null };
      }
    } catch {
      /* fall through: re-resolved by bearer */
    }
  }
  return { authKind: 'session', userId: user.id, jti: null, ver: null, bearer };
}

/** Null while the principal may keep the session; otherwise why not. */
export async function revalidatePrincipal(db: DB, p: TerminalPrincipal, opts: { host: boolean }): Promise<string | null> {
  if (p.authKind === 'api_token' || p.jti === null) {
    if (opts.host && p.authKind === 'api_token') return 'host shells need an interactive session';
    const fresh = p.bearer ? await resolveUser(db, p.bearer).catch(() => null) : null;
    if (!fresh) return 'session revoked';
    if (!fresh.isOperator || (Array.isArray(fresh.tokenScopes) && !fresh.tokenScopes.includes('operator'))) {
      return 'operator access revoked';
    }
    if (opts.host && fresh.viaApiToken) return 'host shells need an interactive session';
  } else {
    const user = await db.query.users.findFirst({ where: eq(users.id, p.userId) }).catch(() => undefined);
    if (!user || user.deactivatedAt) return 'session revoked';
    if (p.ver !== null && user.tokenVersion !== p.ver) return 'session revoked';
    const live = await findLiveSession(db, p.jti).catch(() => null);
    if (!live || live.userId !== p.userId) return 'session revoked';
    if (user.isInstanceOperator !== true) return 'operator access revoked';
  }
  if (opts.host && !(await hostTerminalAllowed(db))) return 'host shells were disabled';
  return null;
}

// ── resolved targets and pending sessions (in memory) ───────────────────────

/** What a session runs, resolved and authorised at create time. `env` may hold credentials: never logged or stored. */
export interface ResolvedTerminalTarget {
  kind: TerminalTargetKind;
  label: string;
  /** null = the panel host. */
  serverId: number | null;
  serviceId: number | null;
  databaseId: number | null;
  /** null for host shells. */
  containerName: string | null;
  /** null = the interactive shell (`SHELL_CMD`). */
  cmd: readonly string[] | null;
  env: string[];
}

export interface PendingTerminal {
  target: ResolvedTerminalTarget;
  principal: TerminalPrincipal;
  cols: number;
  rows: number;
  expiresAt: number;
}

const pending = new Map<number, PendingTerminal>();

export function rememberPending(sessionId: number, entry: PendingTerminal): void {
  pending.set(sessionId, entry);
}

/** Take (and forget) a pending session's context. */
export function takePending(sessionId: number): PendingTerminal | null {
  const entry = pending.get(sessionId) ?? null;
  pending.delete(sessionId);
  return entry;
}

export function forgetPending(sessionId: number): void {
  pending.delete(sessionId);
}

/** Drop contexts whose ticket expired (the reaper). */
export function sweepPending(now = Date.now()): number {
  let n = 0;
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) {
      pending.delete(id);
      n++;
    }
  }
  return n;
}

// ── the live registry ───────────────────────────────────────────────────────

export interface LiveTerminal {
  id: number;
  userId: number | null;
  targetKind: TerminalTargetKind;
  /** The deprecated `/services/:id/exec` socket. */
  legacy: boolean;
  /** End the session because an operator terminated it. */
  terminate(byUserId: number | null): void;
  /** End the session because its principal or its setting no longer allows it. */
  revoke(reason: string): void;
}

const live = new Map<number, LiveTerminal>();
let legacySeq = 0;

export const liveTerminalCount = (): number => live.size;
export const liveTerminalCountForUser = (userId: number): number => [...live.values()].filter((s) => s.userId === userId).length;
export const isTerminalLive = (id: number): boolean => live.has(id);
export const liveTerminalIds = (): number[] => [...live.keys()];

/** Register a live session. A legacy socket without a row gets a private negative key. */
export function registerLive(entry: LiveTerminal): number {
  const key = entry.id > 0 ? entry.id : --legacySeq;
  live.set(key, entry);
  return key;
}

export function unregisterLive(key: number): void {
  live.delete(key);
}

export interface LiveReservation {
  key: number;
  /** Hand the slot to the running bridge; a terminate/revoke that came in meanwhile is applied now. */
  attach(handle: Pick<LiveTerminal, 'terminate' | 'revoke'>): void;
  /** Give the slot back (the session never started). */
  release(): void;
}

/**
 * Take a registry slot BEFORE any await, so the caps cannot be overrun by
 * sockets attaching at the same moment, and so an operator can terminate a
 * session that is still starting.
 */
export function reserveLive(meta: Pick<LiveTerminal, 'id' | 'userId' | 'targetKind' | 'legacy'>): LiveReservation {
  let handle: Pick<LiveTerminal, 'terminate' | 'revoke'> | null = null;
  let early: ((h: Pick<LiveTerminal, 'terminate' | 'revoke'>) => void) | null = null;
  const key = registerLive({
    ...meta,
    terminate: (by) => {
      if (handle) handle.terminate(by);
      else early ??= (h) => h.terminate(by);
    },
    revoke: (why) => {
      if (handle) handle.revoke(why);
      else early ??= (h) => h.revoke(why);
    },
  });
  return {
    key,
    attach: (h) => {
      handle = h;
      if (early) early(h);
    },
    release: () => unregisterLive(key),
  };
}

/** Terminate a live session; false when it is not live in this process. */
export function terminateLive(id: number, byUserId: number | null): boolean {
  const entry = live.get(id);
  if (!entry) return false;
  entry.terminate(byUserId);
  return true;
}

/** End every live host session (the host setting was turned off). */
export function revokeLiveHostSessions(reason: string): number {
  let n = 0;
  for (const entry of [...live.values()]) {
    if (entry.targetKind === 'host') {
      entry.revoke(reason);
      n++;
    }
  }
  return n;
}

/** Test hook. */
export function resetTerminalRegistry(): void {
  live.clear();
  pending.clear();
  legacySeq = 0;
}

// ── API shape ───────────────────────────────────────────────────────────────

export function toTerminalSession(row: TerminalSessionRow, userEmail: string | null): TerminalSession {
  return {
    id: row.id,
    status: row.status,
    targetKind: row.targetKind,
    targetLabel: row.targetLabel,
    serverId: row.serverId ?? null,
    userId: row.userId ?? null,
    userEmail,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    durationMs: row.durationMs ?? null,
    bytesIn: row.bytesIn,
    bytesOut: row.bytesOut,
    endReason: row.endReason ?? null,
    exitCode: row.exitCode ?? null,
    clientIp: row.clientIp ?? null,
  };
}

// ── recording a session's end ───────────────────────────────────────────────

export interface RecorderInfo {
  /** The row; null when it could not be written (the legacy socket still runs and audits). */
  id: number | null;
  userId: number | null;
  targetKind: TerminalTargetKind;
  targetLabel: string;
  serverId: number | null;
  startedAt: Date;
  ctx: { ip?: string; userAgent?: string };
}

export interface EndOptions {
  exitCode?: number | null;
  failed?: boolean;
  error?: string;
  terminatedByUserId?: number | null;
}

/**
 * Counts bytes and writes the end of a session once: the row (ended or
 * failed, duration, bytes, reason, exit code) and the `terminal.session.end`
 * audit, the audit in a `finally` so a failed row update still leaves it.
 */
export class TerminalSessionRecorder {
  bytesIn = 0;
  bytesOut = 0;
  private ending: Promise<void> | null = null;

  constructor(
    private readonly db: DB,
    readonly info: RecorderInfo,
  ) {}

  get ended(): boolean {
    return this.ending !== null;
  }

  end(reason: string, opts: EndOptions = {}): Promise<void> {
    this.ending ??= (async () => {
      const endedAt = new Date();
      const durationMs = Math.max(0, endedAt.getTime() - this.info.startedAt.getTime());
      try {
        if (this.info.id !== null) {
          await this.db
            .update(terminalSessions)
            .set({
              status: opts.failed ? 'failed' : 'ended',
              ticketHash: null,
              endedAt,
              durationMs,
              bytesIn: this.bytesIn,
              bytesOut: this.bytesOut,
              endReason: reason,
              exitCode: opts.exitCode ?? null,
              error: opts.error?.slice(0, 500) ?? null,
              terminatedByUserId: opts.terminatedByUserId ?? null,
            })
            .where(eq(terminalSessions.id, this.info.id));
        }
      } catch {
        /* the audit below still records the end */
      } finally {
        await audit(
          this.db,
          this.info.userId,
          'terminal.session.end',
          this.info.targetLabel,
          {
            sessionId: this.info.id,
            targetKind: this.info.targetKind,
            serverId: this.info.serverId,
            reason,
            durationMs,
            bytesIn: this.bytesIn,
            bytesOut: this.bytesOut,
            exitCode: opts.exitCode ?? null,
            ...(opts.terminatedByUserId != null ? { terminatedByUserId: opts.terminatedByUserId } : {}),
          },
          this.info.ctx,
        );
      }
    })();
    return this.ending;
  }
}

/**
 * The deprecated `GET /v1/services/:id/exec` socket (kept for 0.14 clients,
 * removed no earlier than 0.17) records its sessions too (D2): an `active`
 * row from the start, the `terminal.session.start` audit, and a recorder for
 * the end. A failed insert never blocks the shell: the audits still run.
 */
export async function startLegacyExecRecord(
  db: DB,
  opts: {
    userId: number;
    serviceId: number;
    container: string;
    label: string;
    authKind: 'session' | 'api_token';
    ctx: { ip?: string; userAgent?: string };
  },
): Promise<TerminalSessionRecorder> {
  const startedAt = new Date();
  let id: number | null = null;
  try {
    const [row] = await db
      .insert(terminalSessions)
      .values({
        userId: opts.userId,
        targetKind: 'service',
        serviceId: opts.serviceId,
        containerName: opts.container,
        targetLabel: opts.label,
        status: 'active',
        authKind: opts.authKind,
        clientIp: opts.ctx.ip ?? null,
        userAgent: opts.ctx.userAgent?.slice(0, 300) ?? null,
        startedAt,
      })
      .returning();
    id = typeof row?.id === 'number' ? row.id : null;
  } catch {
    /* the shell still opens; the audits below carry the trail */
  }
  void audit(
    db,
    opts.userId,
    'terminal.session.start',
    opts.label,
    { sessionId: id, targetKind: 'service', serverId: null, legacy: true },
    opts.ctx,
  );
  return new TerminalSessionRecorder(db, {
    id,
    userId: opts.userId,
    targetKind: 'service',
    targetLabel: opts.label,
    serverId: null,
    startedAt,
    ctx: opts.ctx,
  });
}

// ── opening the process ─────────────────────────────────────────────────────

/** Start what a resolved local target runs. Host shells need the Engine API (refused earlier otherwise). */
export async function openTargetTty(
  transport: DockerTransport,
  target: ResolvedTerminalTarget,
  opts: { sessionId: number; cols: number; rows: number; maxMs: number },
): Promise<TtyProcess> {
  if (target.kind === 'host') {
    if (!isEngineTransport(transport)) throw new Error(`host shells need the Docker Engine API (${transport.reason})`);
    return openHostShellTty(transport, {
      image: hostShellImage(),
      sessionId: opts.sessionId,
      expiresAt: Math.ceil((Date.now() + opts.maxMs) / 1000) + 60,
      cols: opts.cols,
      rows: opts.rows,
    });
  }
  const container = target.containerName;
  if (!container) throw new Error('the target has no container');
  if (!isEngineTransport(transport)) {
    return openCliPipeTty(container, target.cmd ?? ['sh', '-i'], target.env);
  }
  return openExecTty(transport, { container, cmd: target.cmd ?? SHELL_CMD, env: target.env, cols: opts.cols, rows: opts.rows });
}

// ── the bridge ──────────────────────────────────────────────────────────────

/** The parts of a `ws` socket the bridge uses (a structural type keeps it testable). */
export interface TerminalSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', cb: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close' | 'error', cb: () => void): unknown;
}

const OPEN = 1;

export interface RunSessionOptions {
  socket: TerminalSocket;
  tty: TtyProcess;
  recorder: TerminalSessionRecorder;
  /** `v1`: protocol v1. `legacy`: the raw-frame `/services/:id/exec` socket. */
  protocol: 'v1' | 'legacy';
  /** null = no limit (the legacy socket keeps its 0.14 behaviour). */
  idleMs: number | null;
  maxMs: number | null;
  revalidate: () => Promise<string | null>;
  revalidateMs?: number;
  /** The registry key the caller registered (removed on end). */
  liveKey: number;
}

export interface SessionEnd {
  reason: string;
  exitCode: number | null;
}

/**
 * Bridge a socket and a TTY until either side ends, a limit fires, the
 * principal is revoked or an operator terminates the session. Resolves once
 * the end has been recorded.
 */
export function runTerminalSession(opts: RunSessionOptions): { done: Promise<SessionEnd>; live: Pick<LiveTerminal, 'terminate' | 'revoke'> } {
  const { socket, tty, recorder, protocol } = opts;
  const v1 = protocol === 'v1';
  let resolveDone!: (end: SessionEnd) => void;
  const done = new Promise<SessionEnd>((r) => {
    resolveDone = r;
  });
  let finished = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let maxTimer: NodeJS.Timeout | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  let revalidateTimer: NodeJS.Timeout | undefined;
  let paused = false;

  const sendText = (msg: Parameters<typeof encodeServerMessage>[0]) => {
    if (!v1 || socket.readyState !== OPEN) return;
    try {
      socket.send(encodeServerMessage(msg));
    } catch {
      /* closed */
    }
  };

  const finish = async (
    reason: string,
    closeCode: number | null,
    closeReason: string,
    extra: EndOptions & { legacyMessage?: string } = {},
  ): Promise<void> => {
    if (finished) return;
    finished = true;
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    clearInterval(drainTimer);
    clearInterval(revalidateTimer);
    unregisterLive(opts.liveKey);
    const exitCode = extra.exitCode ?? null;
    try {
      if (socket.readyState === OPEN) {
        if (v1) sendText({ t: 'exit', code: exitCode, reason });
        else if (extra.legacyMessage) {
          try {
            socket.send(extra.legacyMessage);
          } catch {
            /* closed */
          }
        }
        if (closeCode === null) socket.close();
        else socket.close(closeCode, closeReason);
      }
    } catch {
      /* already closed */
    }
    try {
      await tty.kill();
    } catch {
      /* the process is gone or unreachable: the end is still recorded */
    } finally {
      await recorder.end(reason, extra);
      resolveDone({ reason, exitCode });
    }
  };

  const armIdle = () => {
    if (opts.idleMs === null) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void finish('idle', TERMINAL_CLOSE.idle, 'idle timeout');
    }, opts.idleMs);
    idleTimer.unref?.();
  };

  if (opts.maxMs !== null) {
    maxTimer = setTimeout(() => {
      void finish('max_duration', TERMINAL_CLOSE.maxDuration, 'maximum session length reached');
    }, opts.maxMs);
    maxTimer.unref?.();
  }
  armIdle();

  socket.on('message', (data, isBinary) => {
    if (finished) return;
    if (!v1) {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : String(data));
      recorder.bytesIn += bytes.length;
      tty.write(bytes);
      return;
    }
    const frame = parseClientFrame(data, isBinary);
    switch (frame.kind) {
      case 'stdin':
        recorder.bytesIn += frame.data.length;
        tty.write(frame.data);
        armIdle();
        return;
      case 'resize':
        tty.resize(frame.cols, frame.rows);
        return;
      case 'ping':
        return;
      case 'too_large':
        void finish('frame_too_large', TERMINAL_CLOSE.frameTooLarge, 'frame too large');
        return;
      case 'invalid':
        sendText({ t: 'notice', message: `Ignored a control message: ${frame.reason}.` });
        return;
    }
  });

  tty.onData((chunk) => {
    if (finished || socket.readyState !== OPEN) return;
    recorder.bytesOut += chunk.length;
    try {
      socket.send(chunk);
    } catch {
      return;
    }
    if (!paused && socket.bufferedAmount > TERMINAL_BACKPRESSURE_HIGH) {
      paused = true;
      tty.pause();
      drainTimer = setInterval(() => {
        if (socket.readyState !== OPEN || socket.bufferedAmount <= TERMINAL_BACKPRESSURE_HIGH / 4) {
          clearInterval(drainTimer);
          paused = false;
          tty.resume();
        }
      }, 50);
      drainTimer.unref?.();
    }
  });

  tty.onEnd((exitCode) => {
    void finish('shell_exited', v1 ? TERMINAL_CLOSE.shellExited : null, 'shell exited', { exitCode });
  });

  socket.on('close', () => {
    void finish('client_closed', null, '');
  });
  socket.on('error', () => {
    void finish('client_error', null, '');
  });

  const live: Pick<LiveTerminal, 'terminate' | 'revoke'> = {
    terminate: (byUserId) => {
      void finish('terminated', v1 ? TERMINAL_CLOSE.terminated : 1008, 'session terminated', {
        terminatedByUserId: byUserId,
        legacyMessage: '\r\n\x1b[31m✕ Session terminated by an operator — disconnecting.\x1b[0m\r\n',
      });
    },
    revoke: (why) => {
      void finish('revoked', v1 ? TERMINAL_CLOSE.forbidden : 1008, 'session revoked', {
        legacyMessage: '\r\n\x1b[31m✕ Session revoked — disconnecting.\x1b[0m\r\n',
        error: why,
      });
    },
  };
  // A TTY that had already ended finished the session synchronously above.
  if (!finished) {
    revalidateTimer = setInterval(() => {
      if (finished) return;
      void opts.revalidate().then(
        (why) => {
          if (why) live.revoke(why);
        },
        () => undefined,
      );
    }, opts.revalidateMs ?? TERMINAL_REVALIDATE_MS);
    revalidateTimer.unref?.();
  }
  return { done, live };
}

// ── boot recovery, expiry, retention ────────────────────────────────────────

/**
 * Boot: no session survives a restart. Every `pending` or `active` row
 * becomes `ended` with `end_reason='panel_restart'`; each one that was live
 * gets its `terminal.session.end` audit (its `finally` never ran). Returns
 * the number of rows closed.
 */
export async function recoverTerminalSessions(db: DB, now = new Date()): Promise<number> {
  const rows = await db
    .update(terminalSessions)
    .set({ status: 'ended', endReason: 'panel_restart', endedAt: now, ticketHash: null })
    .where(inArray(terminalSessions.status, ['pending', 'active']))
    .returning();
  for (const row of rows) {
    if (!row.startedAt) continue;
    const durationMs = Math.max(0, now.getTime() - row.startedAt.getTime());
    await db.update(terminalSessions).set({ durationMs }).where(eq(terminalSessions.id, row.id)).catch(() => undefined);
    await audit(db, row.userId ?? null, 'terminal.session.end', row.targetLabel, {
      sessionId: row.id,
      targetKind: row.targetKind,
      serverId: row.serverId ?? null,
      reason: 'panel_restart',
      durationMs,
      bytesIn: row.bytesIn,
      bytesOut: row.bytesOut,
      exitCode: null,
    });
  }
  return rows.length;
}

/** The reaper: `pending` rows whose ticket expired become `expired`. */
export async function expireTerminalTickets(db: DB, now = new Date()): Promise<number> {
  const rows = await db
    .update(terminalSessions)
    .set({ status: 'expired', ticketHash: null, endReason: 'ticket_expired', endedAt: now })
    .where(and(eq(terminalSessions.status, 'pending'), lt(terminalSessions.ticketExpiresAt, now)))
    .returning({ id: terminalSessions.id });
  return rows.length;
}

/**
 * Retention for `terminal_sessions` (DESIGN §5), run hourly by housekeeping:
 * - `ended` / `failed` / `expired` rows that ended (or, without an end, were
 *   created) more than `terminal_retention_days` (default 180) ago;
 * - `pending` rows whose ticket expired more than one day ago (normally the
 *   reaper has already expired them).
 * Live (`active`) rows are never touched. Returns the number of rows deleted.
 */
export async function pruneTerminalSessions(db: DB, now: number = Date.now()): Promise<number> {
  const { retentionDays } = await readTerminalSettings(db);
  const cutoff = new Date(now - retentionDays * 86_400_000);
  const pendingCutoff = new Date(now - 86_400_000);
  const rows = await db
    .delete(terminalSessions)
    .where(
      or(
        and(
          inArray(terminalSessions.status, ['ended', 'failed', 'expired']),
          or(lt(terminalSessions.endedAt, cutoff), and(isNull(terminalSessions.endedAt), lt(terminalSessions.createdAt, cutoff))),
        ),
        and(eq(terminalSessions.status, 'pending'), lt(terminalSessions.ticketExpiresAt, pendingCutoff)),
      ),
    )
    .returning({ id: terminalSessions.id });
  return rows.length;
}
