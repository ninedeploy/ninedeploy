/**
 * 0.15 terminal session engine (`lib/terminalSessions.ts`, DESIGN §1.2):
 * settings, tickets, the principal's revalidation, the live registry, the
 * socket ↔ TTY bridge (limits, frames, backpressure, end audit on every path),
 * boot recovery, ticket expiry and retention — against a real migrated SQLite
 * where SQL matters, and a fake socket and TTY for the bridge.
 */
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTokens, auditLog, createDb, type DB, services, sessions, settings, terminalSessions, users } from '@ninedeploy/db';
import { TERMINAL_CLOSE, TERMINAL_FRAME_MAX_BYTES, TERMINAL_SETTINGS_DEFAULTS } from '@ninedeploy/schemas';

const ttyMocks = vi.hoisted(() => ({
  openExecTty: vi.fn(),
  openHostShellTty: vi.fn(),
  openCliPipeTty: vi.fn(),
}));
// audit() fans out to notifyEvent fire-and-forget; with a real in-memory
// SQLite that query could outlive the test and hit a closed client.
vi.mock('../../src/lib/notifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/notifier.js')>()),
  notifyEvent: async () => undefined,
}));
vi.mock('../../src/lib/dockerTty.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/dockerTty.js')>()),
  openExecTty: (...a: unknown[]) => ttyMocks.openExecTty(...a),
  openHostShellTty: (...a: unknown[]) => ttyMocks.openHostShellTty(...a),
  openCliPipeTty: (...a: unknown[]) => ttyMocks.openCliPipeTty(...a),
}));

const S = await import('../../src/lib/terminalSessions.js');
const { sha256 } = await import('../../src/lib/crypto.js');
const { signAccessToken } = await import('../../src/lib/jwt.js');
const { SHELL_CMD } = await import('../../src/lib/dockerTty.js');
const { TRAEFIK_IMAGE } = await import('../../src/engine/dockerNames.js');

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));

let db: DB;
let close: () => void;

beforeEach(async () => {
  const created = createDb({ url: ':memory:' });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values([
    { id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true },
    { id: 2, email: 'member@example.com', passwordHash: 'x' },
  ]);
  S.resetTerminalRegistry();
  delete process.env['NINEDEPLOY_HOST_TERMINAL'];
  delete process.env['NINEDEPLOY_HOST_SHELL_IMAGE'];
});

// Let fire-and-forget audit writes land before the in-memory database closes.
const settle = () => new Promise((r) => setTimeout(r, 30));

afterEach(async () => {
  vi.useRealTimers();
  await settle();
  close();
});

const audits = async (action?: string) => {
  const rows = await db.select().from(auditLog);
  return action ? rows.filter((r) => r.action === action) : rows;
};

const sessionRow = async (over: Partial<typeof terminalSessions.$inferInsert> = {}) => {
  const [row] = await db
    .insert(terminalSessions)
    .values({ userId: 1, targetKind: 'container', targetLabel: 'nd-app-web', containerName: 'nd-app-web', ...over })
    .returning();
  return row!;
};

// ── settings ────────────────────────────────────────────────────────────────

describe('settings', () => {
  it('defaults apply when no key is stored (upgraded and fresh panels alike): host shells off', async () => {
    expect(await S.readTerminalSettings(db)).toEqual({ ...TERMINAL_SETTINGS_DEFAULTS });
    expect(await S.terminalSettingsView(db)).toEqual({ ...TERMINAL_SETTINGS_DEFAULTS, hostTerminalForbiddenByEnv: false });
    expect(await S.hostTerminalAllowed(db)).toBe(false);
    expect(S.TERMINAL_RETENTION_DAYS_DEFAULT).toBe(180);
  });

  it('reads stored values and ignores out-of-range ones', async () => {
    await db.insert(settings).values([
      { key: 'terminal_host_enabled', value: true },
      { key: 'terminal_idle_timeout_minutes', value: 30 as unknown as boolean },
      { key: 'terminal_max_session_minutes', value: 99999 as unknown as boolean },
      { key: 'terminal_max_concurrent', value: 'many' as unknown as boolean },
      { key: 'terminal_retention_days', value: 400 as unknown as boolean },
    ]);
    expect(await S.readTerminalSettings(db)).toEqual({
      hostTerminalEnabled: true,
      idleTimeoutMinutes: 30,
      maxSessionMinutes: 240,
      maxConcurrent: 10,
      retentionDays: 400,
    });
    expect(await S.hostTerminalAllowed(db)).toBe(true);
  });

  it('NINEDEPLOY_HOST_TERMINAL=off wins over the setting', async () => {
    await db.insert(settings).values({ key: 'terminal_host_enabled', value: true });
    for (const off of ['off', 'OFF', 'false', '0', 'no', 'disabled']) {
      process.env['NINEDEPLOY_HOST_TERMINAL'] = off;
      expect(S.hostTerminalForbiddenByEnv(), off).toBe(true);
      expect(await S.hostTerminalAllowed(db)).toBe(false);
    }
    process.env['NINEDEPLOY_HOST_TERMINAL'] = 'on';
    expect(S.hostTerminalForbiddenByEnv()).toBe(false);
    expect((await S.terminalSettingsView(db)).hostTerminalForbiddenByEnv).toBe(false);
  });

  it('the host-shell image defaults to the Traefik image and honours a valid override', () => {
    expect(S.hostShellImage()).toBe(TRAEFIK_IMAGE);
    process.env['NINEDEPLOY_HOST_SHELL_IMAGE'] = 'alpine:3.22';
    expect(S.hostShellImage()).toBe('alpine:3.22');
    process.env['NINEDEPLOY_HOST_SHELL_IMAGE'] = 'bad image; rm -rf';
    expect(S.hostShellImage()).toBe(TRAEFIK_IMAGE);
  });
});

// ── tickets ─────────────────────────────────────────────────────────────────

describe('tickets', () => {
  it('are 32 random bytes, stored as sha256 only, valid 30s', () => {
    const t = S.issueTicket(1_000);
    expect(Buffer.from(t.ticket, 'base64url')).toHaveLength(32);
    expect(t.hash).toBe(sha256(t.ticket));
    expect(t.hash).not.toContain(t.ticket);
    expect(t.expiresAt.getTime()).toBe(1_000 + 30_000);
    expect(S.issueTicket().ticket).not.toBe(t.ticket);
  });

  it('are single use: one atomic consume flips the row to active and clears the hash', async () => {
    const t = S.issueTicket();
    const row = await sessionRow({ ticketHash: t.hash, ticketExpiresAt: t.expiresAt });
    expect(row.ticketHash).not.toBe(t.ticket); // the row never holds the plaintext
    const [a, b] = await Promise.all([S.consumeTicket(db, row.id, t.ticket), S.consumeTicket(db, row.id, t.ticket)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const consumed = (a ?? b)!;
    expect(consumed).toMatchObject({ status: 'active', ticketHash: null });
    expect(consumed.startedAt).toBeInstanceOf(Date);
    expect(await S.consumeTicket(db, row.id, t.ticket)).toBeNull();
  });

  it('refuse a wrong ticket, another session id and an expired ticket', async () => {
    const t = S.issueTicket();
    const row = await sessionRow({ ticketHash: t.hash, ticketExpiresAt: t.expiresAt });
    expect(await S.consumeTicket(db, row.id, S.issueTicket().ticket)).toBeNull();
    expect(await S.consumeTicket(db, row.id + 1, t.ticket)).toBeNull();
    expect(await S.consumeTicket(db, row.id, t.ticket, new Date(t.expiresAt.getTime() + 1))).toBeNull();
    expect(await S.consumeTicket(db, row.id, t.ticket)).not.toBeNull();
  });
});

// ── the principal ───────────────────────────────────────────────────────────

describe('principal revalidation', () => {
  const liveSession = async (jti: string, userId = 1) =>
    db.insert(sessions).values({ userId, jti, expiresAt: new Date(Date.now() + 3_600_000) });

  it('a browser session is re-checked by its session row and token version, not the access token expiry', async () => {
    await liveSession('jti-1');
    const bearer = await signAccessToken(1, 0, 'jti-1');
    const p = await S.principalFor({ id: 1, viaApiToken: false }, `Bearer ${bearer}`);
    expect(p).toEqual({ authKind: 'session', userId: 1, jti: 'jti-1', ver: 0, bearer: null });
    expect(await S.revalidatePrincipal(db, p, { host: false })).toBeNull();
    // Host shells also need the host switch.
    expect(await S.revalidatePrincipal(db, p, { host: true })).toBe('host shells were disabled');
    await db.insert(settings).values({ key: 'terminal_host_enabled', value: true });
    expect(await S.revalidatePrincipal(db, p, { host: true })).toBeNull();

    // Logout-everywhere bumps the token version.
    await db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, 1));
    expect(await S.revalidatePrincipal(db, p, { host: false })).toBe('session revoked');
    await db.update(users).set({ tokenVersion: 0 }).where(eq(users.id, 1));
    // The operator flag pulled.
    await db.update(users).set({ isInstanceOperator: false }).where(eq(users.id, 1));
    expect(await S.revalidatePrincipal(db, p, { host: false })).toBe('operator access revoked');
    await db.update(users).set({ isInstanceOperator: true }).where(eq(users.id, 1));
    // That one session revoked.
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.jti, 'jti-1'));
    expect(await S.revalidatePrincipal(db, p, { host: false })).toBe('session revoked');
    // Deactivated, or gone.
    await db.update(sessions).set({ revokedAt: null }).where(eq(sessions.jti, 'jti-1'));
    await db.update(users).set({ deactivatedAt: new Date() }).where(eq(users.id, 1));
    expect(await S.revalidatePrincipal(db, p, { host: false })).toBe('session revoked');
  });

  it("another user's session row does not keep the session alive", async () => {
    await liveSession('jti-2', 2);
    const p = { authKind: 'session' as const, userId: 1, jti: 'jti-2', ver: null, bearer: null };
    expect(await S.revalidatePrincipal(db, p, { host: false })).toBe('session revoked');
  });

  it('an API token is re-resolved, needs the operator scope when scoped, and never holds a host shell', async () => {
    await db.insert(apiTokens).values([
      { userId: 1, name: 'ci', hash: sha256('nd_full'), scopes: [] },
      { userId: 1, name: 'ro', hash: sha256('nd_read'), scopes: ['read'] },
    ]);
    const p = await S.principalFor({ id: 1, viaApiToken: true }, 'Bearer nd_full');
    expect(p).toEqual({ authKind: 'api_token', userId: 1, bearer: 'nd_full' });
    expect(await S.revalidatePrincipal(db, p, { host: false })).toBeNull();
    expect(await S.revalidatePrincipal(db, p, { host: true })).toBe('host shells need an interactive session');
    const ro = await S.principalFor({ id: 1, viaApiToken: true }, 'Bearer nd_read');
    expect(await S.revalidatePrincipal(db, ro, { host: false })).toBe('operator access revoked');
    await db.delete(apiTokens);
    expect(await S.revalidatePrincipal(db, p, { host: false })).toBe('session revoked');
  });

  it('a credential with no session id falls back to the bearer; none at all is revoked', async () => {
    expect(S.bearerFromHeader(undefined)).toBeNull();
    expect(S.bearerFromHeader('Basic x')).toBeNull();
    expect(S.bearerFromHeader('Bearer ')).toBeNull();
    const legacy = await signAccessToken(1, 0); // no jti
    const p = await S.principalFor({ id: 1, viaApiToken: false }, `Bearer ${legacy}`);
    expect(p).toEqual({ authKind: 'session', userId: 1, jti: null, ver: null, bearer: legacy });
    expect(await S.revalidatePrincipal(db, p, { host: true })).toBe('host shells were disabled');
    const bad = await S.principalFor({ id: 1, viaApiToken: false }, 'Bearer a.b.c');
    expect(bad).toMatchObject({ jti: null, bearer: 'a.b.c' });
    expect(await S.revalidatePrincipal(db, bad, { host: false })).toBe('session revoked');
    const none = await S.principalFor({ id: 1, viaApiToken: false }, undefined);
    expect(await S.revalidatePrincipal(db, none, { host: false })).toBe('session revoked');
  });
});

// ── pending contexts and the live registry ──────────────────────────────────

describe('pending contexts and the registry', () => {
  const target = {
    kind: 'container' as const,
    label: 'c',
    serverId: null,
    serviceId: null,
    databaseId: null,
    containerName: 'c',
    cmd: null,
    env: [],
  };
  const principal = { authKind: 'session' as const, userId: 1, jti: null, ver: null, bearer: null };

  it('a pending context is taken once and swept after its expiry', () => {
    S.rememberPending(1, { target, principal, cols: 80, rows: 24, expiresAt: 100 });
    S.rememberPending(2, { target, principal, cols: 80, rows: 24, expiresAt: 10_000 });
    S.rememberPending(3, { target, principal, cols: 80, rows: 24, expiresAt: 10_000 });
    expect(S.sweepPending(500)).toBe(1);
    expect(S.takePending(1)).toBeNull();
    expect(S.takePending(2)).toMatchObject({ cols: 80 });
    expect(S.takePending(2)).toBeNull();
    S.forgetPending(3);
    expect(S.takePending(3)).toBeNull();
  });

  it('counts live sessions per user, terminates, revokes host sessions and applies an early terminate on attach', () => {
    const calls: string[] = [];
    const a = S.reserveLive({ id: 10, userId: 1, targetKind: 'host', legacy: false });
    const b = S.reserveLive({ id: 11, userId: 1, targetKind: 'service', legacy: false });
    const legacy = S.reserveLive({ id: 0, userId: 2, targetKind: 'service', legacy: true });
    expect(legacy.key).toBeLessThan(0);
    expect(S.liveTerminalCount()).toBe(3);
    expect(S.liveTerminalCountForUser(1)).toBe(2);
    expect(S.isTerminalLive(10)).toBe(true);
    expect(S.liveTerminalIds()).toEqual(expect.arrayContaining([10, 11]));

    // Terminated while still starting: applied once the bridge attaches.
    expect(S.terminateLive(11, 5)).toBe(true);
    b.attach({ terminate: (by) => calls.push(`terminate:${by}`), revoke: (why) => calls.push(`revoke:${why}`) });
    a.attach({ terminate: (by) => calls.push(`a-terminate:${by}`), revoke: (why) => calls.push(`a-revoke:${why}`) });
    expect(S.revokeLiveHostSessions('off')).toBe(1);
    expect(S.terminateLive(10, 1)).toBe(true);
    expect(calls).toEqual(['terminate:5', 'a-revoke:off', 'a-terminate:1']);
    expect(S.terminateLive(99, 1)).toBe(false);

    const c = S.reserveLive({ id: 12, userId: 1, targetKind: 'host', legacy: false });
    S.revokeLiveHostSessions('again');
    const late: string[] = [];
    c.attach({ terminate: () => late.push('t'), revoke: (why) => late.push(why) });
    expect(late).toEqual(['again']);
    for (const r of [a, b, c, legacy]) r.release();
    expect(S.liveTerminalCount()).toBe(0);
  });
});

// ── the API shape and the recorder ──────────────────────────────────────────

describe('toTerminalSession and the recorder', () => {
  it('maps a row to the API shape', async () => {
    const row = await sessionRow({ clientIp: '10.0.0.1' });
    expect(S.toTerminalSession(row, 'op@example.com')).toMatchObject({
      id: row.id,
      status: 'pending',
      targetKind: 'container',
      targetLabel: 'nd-app-web',
      serverId: null,
      userId: 1,
      userEmail: 'op@example.com',
      startedAt: null,
      endedAt: null,
      durationMs: null,
      bytesIn: 0,
      bytesOut: 0,
      endReason: null,
      exitCode: null,
      clientIp: '10.0.0.1',
    });
    const full = { ...row, startedAt: new Date(0), endedAt: new Date(1000), userId: null, serverId: 3 };
    expect(S.toTerminalSession(full, null)).toMatchObject({ startedAt: new Date(0).toISOString(), userId: null, serverId: 3 });
  });

  it('writes the end once: row and audit, with duration, bytes, reason and exit code', async () => {
    const row = await sessionRow({ status: 'active', startedAt: new Date(Date.now() - 5000) });
    const rec = new S.TerminalSessionRecorder(db, {
      id: row.id,
      userId: 1,
      targetKind: 'container',
      targetLabel: 'nd-app-web',
      serverId: null,
      startedAt: row.startedAt!,
      ctx: { ip: '10.0.0.2', userAgent: 'xterm' },
    });
    rec.bytesIn = 3;
    rec.bytesOut = 40;
    expect(rec.ended).toBe(false);
    await Promise.all([rec.end('shell_exited', { exitCode: 0 }), rec.end('client_closed')]);
    expect(rec.ended).toBe(true);
    const [after] = await db.select().from(terminalSessions).where(eq(terminalSessions.id, row.id));
    expect(after).toMatchObject({ status: 'ended', endReason: 'shell_exited', exitCode: 0, bytesIn: 3, bytesOut: 40 });
    expect(after!.durationMs).toBeGreaterThanOrEqual(4000);
    const ends = await audits('terminal.session.end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.meta).toMatchObject({ sessionId: row.id, reason: 'shell_exited', exitCode: 0, bytesIn: 3, bytesOut: 40, ip: '10.0.0.2' });
  });

  it('records a failure and the operator who terminated, and still audits when the row update fails', async () => {
    const row = await sessionRow({ status: 'active', startedAt: new Date() });
    const rec = new S.TerminalSessionRecorder(db, {
      id: row.id,
      userId: 1,
      targetKind: 'container',
      targetLabel: 'x',
      serverId: null,
      startedAt: new Date(),
      ctx: {},
    });
    await rec.end('terminated', { terminatedByUserId: 2, failed: true, error: 'e'.repeat(900) });
    const [after] = await db.select().from(terminalSessions).where(eq(terminalSessions.id, row.id));
    expect(after).toMatchObject({ status: 'failed', terminatedByUserId: 2 });
    expect(after!.error).toHaveLength(500);
    expect((await audits('terminal.session.end'))[0]!.meta).toMatchObject({ terminatedByUserId: 2 });

    const broken = { update: () => { throw new Error('db down'); }, insert: db.insert.bind(db), query: db.query } as unknown as DB;
    const rec2 = new S.TerminalSessionRecorder(broken, { ...rec.info, id: 999 });
    await rec2.end('client_closed');
    expect(await audits('terminal.session.end')).toHaveLength(2);
    // No row at all (a legacy socket whose insert failed): still audited.
    await new S.TerminalSessionRecorder(db, { ...rec.info, id: null }).end('client_closed');
    expect(await audits('terminal.session.end')).toHaveLength(3);
  });

  it('startLegacyExecRecord inserts an active row and audits the start (and survives a failed insert)', async () => {
    const [svc] = await db.insert(services).values({ name: 'web', slug: 'web' }).returning();
    const rec = await S.startLegacyExecRecord(db, {
      userId: 1,
      serviceId: svc!.id,
      container: 'web-1',
      label: 'web',
      authKind: 'session',
      ctx: { ip: '10.0.0.3', userAgent: 'ua' },
    });
    expect(rec.info.id).not.toBeNull();
    const [row] = await db.select().from(terminalSessions).where(eq(terminalSessions.id, rec.info.id!));
    expect(row).toMatchObject({
      status: 'active',
      targetKind: 'service',
      serviceId: svc!.id,
      containerName: 'web-1',
      clientIp: '10.0.0.3',
      userAgent: 'ua',
      authKind: 'session',
    });
    expect(row!.startedAt).toBeInstanceOf(Date);
    await vi.waitFor(async () => expect(await audits('terminal.session.start')).toHaveLength(1));
    expect((await audits('terminal.session.start'))[0]!.meta).toMatchObject({ sessionId: rec.info.id, targetKind: 'service', legacy: true, ip: '10.0.0.3' });

    const broken = { insert: () => { throw new Error('db down'); } } as unknown as DB;
    const rec2 = await S.startLegacyExecRecord(broken, {
      userId: 1,
      serviceId: 1,
      container: 'web-1',
      label: 'web',
      authKind: 'api_token',
      ctx: {},
    });
    expect(rec2.info.id).toBeNull();
  });
});

// ── openTargetTty ───────────────────────────────────────────────────────────

describe('openTargetTty', () => {
  const base = { serverId: null, serviceId: null, databaseId: null, env: [] as string[] };
  const engine = { kind: 'socket' as const, socketPath: '/x' };
  const cli = { kind: 'cli' as const, reason: 'ssh' };

  it('opens an Engine-API exec with the interactive shell, or the given client command', async () => {
    ttyMocks.openExecTty.mockResolvedValue('exec-tty');
    await S.openTargetTty(engine, { ...base, kind: 'container', label: 'c', containerName: 'c', cmd: null }, { sessionId: 1, cols: 100, rows: 30, maxMs: 1 });
    expect(ttyMocks.openExecTty).toHaveBeenLastCalledWith(engine, { container: 'c', cmd: SHELL_CMD, env: [], cols: 100, rows: 30 });
    await S.openTargetTty(
      engine,
      { ...base, kind: 'database', label: 'pg', containerName: 'nd-db-pg', cmd: ['psql'], env: ['PGPASSWORD=x'] },
      { sessionId: 1, cols: 80, rows: 24, maxMs: 1 },
    );
    expect(ttyMocks.openExecTty).toHaveBeenLastCalledWith(engine, { container: 'nd-db-pg', cmd: ['psql'], env: ['PGPASSWORD=x'], cols: 80, rows: 24 });
  });

  it('falls back to pipe mode through the CLI, and refuses a target without a container', async () => {
    ttyMocks.openCliPipeTty.mockReturnValue('cli-tty');
    expect(await S.openTargetTty(cli, { ...base, kind: 'service', label: 's', containerName: 's', cmd: null }, { sessionId: 1, cols: 80, rows: 24, maxMs: 1 })).toBe('cli-tty');
    expect(ttyMocks.openCliPipeTty).toHaveBeenLastCalledWith('s', ['sh', '-i'], []);
    await expect(
      S.openTargetTty(engine, { ...base, kind: 'container', label: 'c', containerName: null, cmd: null }, { sessionId: 1, cols: 80, rows: 24, maxMs: 1 }),
    ).rejects.toThrow('the target has no container');
  });

  it('starts the host helper with the image and an expiry label past the max duration; never over the CLI', async () => {
    ttyMocks.openHostShellTty.mockResolvedValue('host-tty');
    const before = Math.floor(Date.now() / 1000);
    await S.openTargetTty(engine, { ...base, kind: 'host', label: 'panel host', containerName: null, cmd: null }, { sessionId: 7, cols: 80, rows: 24, maxMs: 3_600_000 });
    const opts = ttyMocks.openHostShellTty.mock.calls.at(-1)![1] as { image: string; sessionId: number; expiresAt: number };
    expect(opts).toMatchObject({ image: TRAEFIK_IMAGE, sessionId: 7, cols: 80, rows: 24 });
    expect(opts.expiresAt).toBeGreaterThanOrEqual(before + 3600);
    await expect(
      S.openTargetTty(cli, { ...base, kind: 'host', label: 'panel host', containerName: null, cmd: null }, { sessionId: 7, cols: 80, rows: 24, maxMs: 1 }),
    ).rejects.toThrow(/Docker Engine API/);
  });
});

// ── the bridge ──────────────────────────────────────────────────────────────

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<string | Buffer> = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string | Buffer) {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closed = { code, reason };
    this.emit('close');
  }
  texts() {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s));
  }
}

const fakeTty = () => {
  const dataCbs: Array<(c: Buffer) => void> = [];
  const endCbs: Array<(c: number | null) => void> = [];
  return {
    mode: 'exec' as const,
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(async () => undefined),
    onData: (cb: (c: Buffer) => void) => void dataCbs.push(cb),
    onEnd: (cb: (c: number | null) => void) => void endCbs.push(cb),
    emit: (s: string | Buffer) => {
      for (const cb of dataCbs) cb(Buffer.isBuffer(s) ? s : Buffer.from(s));
    },
    exit: (code: number | null) => {
      for (const cb of endCbs) cb(code);
    },
  };
};

const fakeRecorder = () => {
  const ends: Array<{ reason: string; opts: unknown }> = [];
  const rec = {
    bytesIn: 0,
    bytesOut: 0,
    end: vi.fn(async (reason: string, opts: unknown = {}) => {
      ends.push({ reason, opts });
    }),
  };
  return { rec, ends };
};

const bridge = (over: Partial<Parameters<typeof S.runTerminalSession>[0]> = {}) => {
  const socket = new FakeSocket();
  const tty = fakeTty();
  const { rec, ends } = fakeRecorder();
  const slot = S.reserveLive({ id: 50, userId: 1, targetKind: 'container', legacy: over.protocol === 'legacy' });
  const run = S.runTerminalSession({
    socket,
    tty,
    recorder: rec as unknown as InstanceType<typeof S.TerminalSessionRecorder>,
    protocol: 'v1',
    idleMs: 60_000,
    maxMs: 600_000,
    revalidate: async () => null,
    liveKey: slot.key,
    ...over,
  });
  slot.attach(run.live);
  return { socket, tty, rec, ends, run };
};

describe('runTerminalSession (protocol v1)', () => {
  it('binary in → stdin, output → binary out; resize and ping are control; the shell exit closes 1000 with the code', async () => {
    const { socket, tty, rec, ends, run } = bridge();
    socket.emit('message', Buffer.from('ls\r'), true);
    expect(tty.write).toHaveBeenCalledWith(Buffer.from('ls\r'));
    socket.emit('message', Buffer.from('{"t":"resize","cols":132,"rows":43}'), false);
    expect(tty.resize).toHaveBeenCalledWith(132, 43);
    socket.emit('message', Buffer.from('{"t":"ping"}'), false);
    tty.emit('file.txt\r\n');
    expect(socket.sent[0]).toEqual(Buffer.from('file.txt\r\n'));
    expect(rec.bytesIn).toBe(3);
    expect(rec.bytesOut).toBe(10);
    tty.exit(0);
    expect(await run.done).toEqual({ reason: 'shell_exited', exitCode: 0 });
    expect(socket.texts().at(-1)).toEqual({ t: 'exit', code: 0, reason: 'shell_exited' });
    expect(socket.closed).toEqual({ code: TERMINAL_CLOSE.shellExited, reason: 'shell exited' });
    expect(ends).toEqual([{ reason: 'shell_exited', opts: { exitCode: 0 } }]);
    expect(tty.kill).toHaveBeenCalled();
    expect(S.isTerminalLive(50)).toBe(false);
    // Late events after the end change nothing.
    socket.emit('message', Buffer.from('x'), true);
    tty.emit('late');
    expect(tty.write).toHaveBeenCalledTimes(1);
  });

  it('refuses bad resize values with a notice (never resizing), and closes 1009 on a frame over 64 KiB', async () => {
    const { socket, tty, ends, run } = bridge();
    socket.emit('message', Buffer.from('{"t":"resize","cols":5000,"rows":43}'), false);
    socket.emit('message', Buffer.from('rm -rf /'), false);
    expect(tty.resize).not.toHaveBeenCalled();
    expect(tty.write).not.toHaveBeenCalled();
    expect(socket.texts().filter((m) => m.t === 'notice')).toHaveLength(2);
    socket.emit('message', Buffer.alloc(TERMINAL_FRAME_MAX_BYTES + 1), true);
    await run.done;
    expect(socket.closed).toEqual({ code: 1009, reason: 'frame too large' });
    expect(ends[0]!.reason).toBe('frame_too_large');
  });

  it('closes 4408 after the idle timeout; input (not output or pings) resets it', async () => {
    vi.useFakeTimers();
    const { socket, tty, ends, run } = bridge({ idleMs: 1000, maxMs: null });
    await vi.advanceTimersByTimeAsync(900);
    socket.emit('message', Buffer.from('a'), true);
    await vi.advanceTimersByTimeAsync(900);
    tty.emit('output does not count');
    socket.emit('message', Buffer.from('{"t":"ping"}'), false);
    expect(socket.closed).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    await run.done;
    expect(socket.closed).toEqual({ code: TERMINAL_CLOSE.idle, reason: 'idle timeout' });
    expect(ends[0]!.reason).toBe('idle');
  });

  it('closes 4409 at the maximum session length whatever the activity', async () => {
    vi.useFakeTimers();
    const { socket, ends, run } = bridge({ idleMs: 1000, maxMs: 3000 });
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(700);
      socket.emit('message', Buffer.from('k'), true);
    }
    await run.done;
    expect(socket.closed).toEqual({ code: TERMINAL_CLOSE.maxDuration, reason: 'maximum session length reached' });
    expect(ends[0]!.reason).toBe('max_duration');
  });

  it('revalidation ends the session (4403) with the reason', async () => {
    vi.useFakeTimers();
    let verdict: string | null = null;
    const { socket, ends, run } = bridge({ idleMs: null, maxMs: null, revalidateMs: 1000, revalidate: async () => verdict });
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.closed).toBeNull();
    verdict = 'host shells were disabled';
    await vi.advanceTimersByTimeAsync(1000);
    await run.done;
    expect(socket.closed).toEqual({ code: TERMINAL_CLOSE.forbidden, reason: 'session revoked' });
    expect(ends[0]).toEqual({ reason: 'revoked', opts: expect.objectContaining({ error: 'host shells were disabled' }) });
  });

  it('a revalidation that throws keeps the session', async () => {
    vi.useFakeTimers();
    const { socket, run } = bridge({ idleMs: null, maxMs: null, revalidateMs: 1000, revalidate: async () => { throw new Error('db'); } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(socket.closed).toBeNull();
    socket.close();
    await run.done;
  });

  it('terminate closes 4410 and records who; client close and socket errors end it too', async () => {
    const a = bridge();
    expect(S.terminateLive(50, 9)).toBe(true);
    await a.run.done;
    expect(a.socket.closed).toEqual({ code: TERMINAL_CLOSE.terminated, reason: 'session terminated' });
    expect(a.ends[0]).toEqual({ reason: 'terminated', opts: expect.objectContaining({ terminatedByUserId: 9 }) });

    const b = bridge();
    b.socket.close();
    expect(await b.run.done).toEqual({ reason: 'client_closed', exitCode: null });

    const c = bridge();
    c.socket.emit('error');
    expect((await c.run.done).reason).toBe('client_error');
  });

  it('the end is recorded even when killing the process fails', async () => {
    const { tty, ends, run, socket } = bridge();
    tty.kill.mockRejectedValue(new Error('daemon gone'));
    socket.close();
    await expect(run.done).resolves.toBeDefined();
    expect(ends).toHaveLength(1);
  }, 10_000);

  it('pauses the shell while the socket buffers more than 4 MiB and resumes once drained', async () => {
    vi.useFakeTimers();
    const { socket, tty, run } = bridge({ idleMs: null, maxMs: null });
    socket.bufferedAmount = S.TERMINAL_BACKPRESSURE_HIGH + 1;
    tty.emit('big');
    expect(tty.pause).toHaveBeenCalledTimes(1);
    tty.emit('more');
    expect(tty.pause).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(tty.resume).not.toHaveBeenCalled();
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(60);
    expect(tty.resume).toHaveBeenCalledTimes(1);
    socket.close();
    await run.done;
  });

  it('a send that throws (socket gone) is ignored', async () => {
    const { socket, tty, run } = bridge();
    socket.send = () => {
      throw new Error('closed');
    };
    tty.emit('x');
    socket.readyState = 3;
    tty.emit('y');
    socket.readyState = 1;
    socket.close();
    await run.done;
  });

  it('a TTY that already ended finishes at once and arms no revalidation', async () => {
    const socket = new FakeSocket();
    const { rec, ends } = fakeRecorder();
    const revalidate = vi.fn(async () => null);
    const ended = { ...fakeTty(), onEnd: (cb: (c: number | null) => void) => cb(1) };
    const slot = S.reserveLive({ id: 51, userId: 1, targetKind: 'container', legacy: false });
    const run = S.runTerminalSession({
      socket,
      tty: ended,
      recorder: rec as never,
      protocol: 'v1',
      idleMs: null,
      maxMs: null,
      revalidate,
      revalidateMs: 1,
      liveKey: slot.key,
    });
    expect(await run.done).toEqual({ reason: 'shell_exited', exitCode: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(revalidate).not.toHaveBeenCalled();
    expect(ends).toHaveLength(1);
  });
});

describe('runTerminalSession (legacy raw frames)', () => {
  it('every frame is stdin, no control messages, and close codes stay 0.14-shaped', async () => {
    const { socket, tty, run, rec } = bridge({ protocol: 'legacy', idleMs: null, maxMs: null });
    socket.emit('message', Buffer.from('{"t":"ping"}'), false);
    socket.emit('message', 'text', false);
    expect(tty.write.mock.calls.map((c) => (c[0] as Buffer).toString())).toEqual(['{"t":"ping"}', 'text']);
    expect(rec.bytesIn).toBe(16);
    tty.exit(0);
    await run.done;
    expect(socket.closed).toEqual({ code: undefined, reason: undefined });
    expect(socket.texts()).toEqual([]); // no JSON `exit` frame on the legacy socket
  });

  it('terminate and revoke print a line and close 1008', async () => {
    const a = bridge({ protocol: 'legacy', idleMs: null, maxMs: null });
    a.run.live.terminate(3);
    await a.run.done;
    expect(a.socket.closed).toEqual({ code: 1008, reason: 'session terminated' });
    expect(String(a.socket.sent.at(-1))).toContain('terminated by an operator');

    const b = bridge({ protocol: 'legacy', idleMs: null, maxMs: null });
    b.socket.send = () => {
      throw new Error('gone');
    };
    b.run.live.revoke('session revoked');
    await b.run.done;
    expect(b.socket.closed).toEqual({ code: 1008, reason: 'session revoked' });
  });
});

// ── boot recovery, expiry, retention ────────────────────────────────────────

describe('boot recovery, ticket expiry and retention', () => {
  it('boot: pending and active rows end with panel_restart; live ones get their end audit', async () => {
    const active = await sessionRow({ status: 'active', startedAt: new Date(Date.now() - 60_000), bytesIn: 5 });
    const pending = await sessionRow({ status: 'pending', ticketHash: 'h', ticketExpiresAt: new Date(Date.now() + 1000) });
    const ended = await sessionRow({ status: 'ended', endReason: 'shell_exited' });
    expect(await S.recoverTerminalSessions(db)).toBe(2);
    const rows = await db.select().from(terminalSessions);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(active.id)).toMatchObject({ status: 'ended', endReason: 'panel_restart' });
    expect(byId.get(active.id)!.durationMs).toBeGreaterThanOrEqual(59_000);
    expect(byId.get(pending.id)).toMatchObject({ status: 'ended', endReason: 'panel_restart', ticketHash: null });
    expect(byId.get(ended.id)).toMatchObject({ endReason: 'shell_exited' });
    const ends = await audits('terminal.session.end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.meta).toMatchObject({ sessionId: active.id, reason: 'panel_restart', bytesIn: 5 });
    expect(await S.recoverTerminalSessions(db)).toBe(0);
  });

  it('the reaper expires pending rows past their ticket', async () => {
    const old = await sessionRow({ status: 'pending', ticketHash: 'a', ticketExpiresAt: new Date(Date.now() - 1000) });
    const fresh = await sessionRow({ status: 'pending', ticketHash: 'b', ticketExpiresAt: new Date(Date.now() + 30_000) });
    expect(await S.expireTerminalTickets(db)).toBe(1);
    const rows = new Map((await db.select().from(terminalSessions)).map((r) => [r.id, r]));
    expect(rows.get(old.id)).toMatchObject({ status: 'expired', ticketHash: null, endReason: 'ticket_expired' });
    expect(rows.get(fresh.id)).toMatchObject({ status: 'pending' });
  });

  it('retention deletes finished rows past terminal_retention_days and stale pending rows, never live ones', async () => {
    const now = Date.now();
    const day = 86_400_000;
    const oldEnded = await sessionRow({ status: 'ended', endedAt: new Date(now - 181 * day) });
    const recentEnded = await sessionRow({ status: 'ended', endedAt: new Date(now - 10 * day) });
    const oldFailedNoEnd = await sessionRow({ status: 'failed', createdAt: new Date(now - 200 * day) });
    const oldExpired = await sessionRow({ status: 'expired', endedAt: new Date(now - 181 * day) });
    const stalePending = await sessionRow({ status: 'pending', ticketExpiresAt: new Date(now - 2 * day) });
    const freshPending = await sessionRow({ status: 'pending', ticketExpiresAt: new Date(now - 1000) });
    const oldActive = await sessionRow({ status: 'active', createdAt: new Date(now - 400 * day), startedAt: new Date(now - 400 * day) });
    expect(await S.pruneTerminalSessions(db, now)).toBe(4);
    const left = (await db.select().from(terminalSessions)).map((r) => r.id).sort();
    expect(left).toEqual([recentEnded.id, freshPending.id, oldActive.id].sort());
    expect([oldEnded.id, oldFailedNoEnd.id, oldExpired.id, stalePending.id].some((id) => left.includes(id))).toBe(false);

    // The setting moves the cutoff.
    await db.insert(settings).values({ key: 'terminal_retention_days', value: 30 as unknown as boolean });
    // 25 days on, with 30 days kept: the session that ended 10 days ago is past
    // the cutoff, and so is the ticket that expired today; the live row stays.
    expect(await S.pruneTerminalSessions(db, now + 25 * day)).toBe(2);
    expect((await db.select().from(terminalSessions)).map((r) => r.id)).toEqual([oldActive.id]);
  });
});
