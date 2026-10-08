/**
 * 0.15 terminal attach socket `GET /v1/terminals/:id/attach` (protocol v1,
 * DESIGN §1.4) end to end over a real WebSocket, with a real migrated SQLite
 * and a fake TTY in place of Docker: ticket single use and expiry, the Origin
 * check, caps, revalidation at attach, the start/end audits (host shells also
 * `security.host_terminal`), terminate (4410), and failure paths.
 */
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// ws client (transitive dep of @fastify/websocket): it can set the Origin header.
import { WebSocket as WsClient } from '../../../node_modules/.pnpm/ws@8.21.3/node_modules/ws';
import { auditLog, createDb, type DB, services, sessions, settings, terminalSessions, users } from '@ninedeploy/db';
import { TERMINAL_CLOSE, TERMINAL_FRAME_MAX_BYTES } from '@ninedeploy/schemas';

const fakes = vi.hoisted(() => {
  const make = () => {
    const dataCbs: Array<(c: Buffer) => void> = [];
    const endCbs: Array<(c: number | null) => void> = [];
    const t = {
      mode: 'exec' as const,
      written: [] as string[],
      write: (b: Buffer) => {
        t.written.push(b.toString());
        for (const cb of dataCbs) cb(b); // echo
      },
      resize: (() => undefined) as (c: number, r: number) => void,
      resizes: [] as Array<[number, number]>,
      pause: () => undefined,
      resume: () => undefined,
      killed: 0,
      kill: async () => {
        t.killed++;
      },
      onData: (cb: (c: Buffer) => void) => void dataCbs.push(cb),
      onEnd: (cb: (c: number | null) => void) => void endCbs.push(cb),
      exit: (code: number | null) => {
        for (const cb of endCbs.splice(0)) cb(code);
      },
    };
    t.resize = (c, r) => void t.resizes.push([c, r]);
    return t;
  };
  return { make, ttys: [] as Array<ReturnType<typeof make>>, openExec: null as null | ((...a: unknown[]) => Promise<unknown>) };
});
// audit() fans out to notifyEvent fire-and-forget; with a real in-memory
// SQLite that query could outlive the test and hit a closed client.
vi.mock('../src/lib/notifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/notifier.js')>()),
  notifyEvent: async () => undefined,
}));
vi.mock('../src/lib/dockerTty.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/dockerTty.js')>()),
  dockerTransport: () => ({ kind: 'socket', socketPath: '/var/run/docker.sock' }),
  inspectContainer: async () => ({ id: 'c', running: true, hostname: null, labels: {} }),
  probeHostShellImage: async () => ({ ok: true }),
  openExecTty: async (...a: unknown[]) => {
    if (fakes.openExec) return fakes.openExec(...a);
    const t = fakes.make();
    fakes.ttys.push(t);
    return t;
  },
  openHostShellTty: async () => {
    const t = fakes.make();
    fakes.ttys.push(t);
    return t;
  },
}));

const { terminalRoutes } = await import('../src/modules/terminals.js');
const S = await import('../src/lib/terminalSessions.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { signAccessToken } = await import('../src/lib/jwt.js');
const { panelAllowedOrigins } = await import('../src/lib/allowedOrigins.js');
const { asUser, buildTestApp, listen, waitFor } = await import('./helpers.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const PASSWORD = 'correct horse battery';
const ORIGIN = panelAllowedOrigins()[0]!;

let db: DB;
let close: () => void;
let serviceId: number;
let bearer: string;
let port: number;
const clients: WsClient[] = [];

beforeEach(async () => {
  const created = createDb({ url: ':memory:' });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: await hashPassword(PASSWORD), isInstanceOperator: true });
  await db.insert(sessions).values({ userId: 1, jti: 'jti-op', expiresAt: new Date(Date.now() + 3_600_000) });
  bearer = await signAccessToken(1, 0, 'jti-op');
  const [svc] = await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', runtimeId: 'nd-app-web' }).returning();
  serviceId = svc!.id;
  fakes.ttys.length = 0;
  fakes.openExec = null;
  S.resetTerminalRegistry();
  const app = await buildTestApp({ websocket: true, db });
  await app.register(terminalRoutes, { prefix: '/v1/terminals' });
  port = await listen(app);
});

// Let fire-and-forget audit writes land before the in-memory database closes.
const settle = () => new Promise((r) => setTimeout(r, 30));

afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  await vi.waitFor(() => expect(S.liveTerminalCount()).toBe(0));
  await settle();
  close();
});

const headers = () => ({ ...asUser({ id: 1, isOperator: true }), authorization: `Bearer ${bearer}` });

async function createSession(target: unknown = { kind: 'service', serviceId }, extra: Record<string, unknown> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/terminals`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ target, ...extra }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { session: { id: number }; ticket: string; attachPath: string };
}

interface Conn {
  ws: WsClient;
  texts: Array<Record<string, unknown>>;
  binary: string[];
  closed: Promise<{ code: number; reason: string }>;
  opened: Promise<void>;
}

function connect(path: string, protocols: string[], origin: string | null = ORIGIN): Conn {
  const ws = new WsClient(`ws://127.0.0.1:${port}${path}`, protocols, origin ? { origin } : {});
  clients.push(ws);
  const texts: Array<Record<string, unknown>> = [];
  const binary: string[] = [];
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) binary.push(data.toString());
    else texts.push(JSON.parse(data.toString()));
  });
  ws.on('error', () => undefined);
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() })),
  );
  const opened = new Promise<void>((resolve) => ws.on('open', () => resolve()));
  return { ws, texts, binary, closed, opened };
}

const attach = (s: { attachPath: string; ticket: string }, origin: string | null = ORIGIN) =>
  connect(s.attachPath, ['ninedeploy.terminal.v1', `ninedeploy.ticket.${s.ticket}`], origin);

const row = async (id: number) => (await db.select().from(terminalSessions).where(eq(terminalSessions.id, id)))[0]!;
const actions = async () => (await db.select().from(auditLog)).map((r) => r.action);

describe('attach: the happy path', () => {
  it('ready → binary stdin/output → resize → shell exit (1000) with the session recorded and audited', async () => {
    const s = await createSession();
    const c = attach(s);
    await c.opened;
    expect(c.ws.protocol).toBe('ninedeploy.terminal.v1'); // the ticket is never echoed (D6)
    await waitFor(() => c.texts.length > 0);
    expect(c.texts[0]).toEqual({ t: 'ready', sessionId: s.session.id, target: { kind: 'service', label: 'web', serverId: null } });
    const t = fakes.ttys[0]!;
    c.ws.send(Buffer.from('echo nd-42\r'), { binary: true });
    await waitFor(() => c.binary.join('').includes('echo nd-42'));
    expect(t.written).toEqual(['echo nd-42\r']);
    c.ws.send(JSON.stringify({ t: 'resize', cols: 140, rows: 50 }));
    await waitFor(() => t.resizes.length === 1);
    expect(t.resizes).toEqual([[140, 50]]);
    expect((await row(s.session.id)).status).toBe('active');

    await new Promise((r) => setTimeout(r, 15));
    t.exit(0);
    expect(await c.closed).toEqual({ code: 1000, reason: 'shell exited' });
    expect(c.texts.at(-1)).toEqual({ t: 'exit', code: 0, reason: 'shell_exited' });
    await vi.waitFor(async () => expect((await row(s.session.id)).status).toBe('ended'));
    const r = await row(s.session.id);
    expect(r).toMatchObject({ endReason: 'shell_exited', exitCode: 0, bytesIn: 11, bytesOut: 11, ticketHash: null });
    expect(r.durationMs).toBeGreaterThan(0);
    expect(r.startedAt).toBeInstanceOf(Date);
    await vi.waitFor(async () => expect(await actions()).toEqual(expect.arrayContaining(['terminal.session.create', 'terminal.session.start', 'terminal.session.end'])));
    expect(await actions()).not.toContain('security.host_terminal');
    expect(S.liveTerminalCount()).toBe(0);
  });

  it('a missing Origin (CLI) is accepted', async () => {
    const s = await createSession();
    const c = attach(s, null);
    await waitFor(() => c.texts.length > 0);
    expect(c.texts[0]!.t).toBe('ready');
    c.ws.close();
    await vi.waitFor(async () => expect((await row(s.session.id)).endReason).toBe('client_closed'));
    expect(fakes.ttys[0]!.killed).toBe(1);
  });

  it('a host shell start also reaches the security fan-out', async () => {
    await db.insert(settings).values({ key: 'terminal_host_enabled', value: true });
    const s = await createSession({ kind: 'host', serverId: null }, { password: PASSWORD });
    const c = attach(s);
    await waitFor(() => c.texts.length > 0);
    await vi.waitFor(async () => expect(await actions()).toContain('security.host_terminal'));
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, 'security.host_terminal'));
    expect(audit!.meta).toMatchObject({ sessionId: s.session.id, serverId: null });
    c.ws.close();
  });
});

describe('attach: tickets, origin and handshake', () => {
  it('a ticket works once: the second socket closes 4401', async () => {
    const s = await createSession();
    const first = attach(s);
    await waitFor(() => first.texts.length > 0);
    const again = attach(s);
    expect((await again.closed).code).toBe(TERMINAL_CLOSE.badTicket);
    first.ws.close();
  });

  it('an expired ticket, a wrong ticket, a missing protocol or a bad id close 4401', async () => {
    const s = await createSession();
    await db.update(terminalSessions).set({ ticketExpiresAt: new Date(Date.now() - 1000) }).where(eq(terminalSessions.id, s.session.id));
    expect((await attach(s).closed).code).toBe(TERMINAL_CLOSE.badTicket);

    const s2 = await createSession();
    expect((await attach({ ...s2, ticket: 'A'.repeat(43) }).closed).code).toBe(4401);
    expect((await connect(s2.attachPath, [`ninedeploy.ticket.${s2.ticket}`]).closed).code).toBe(4401);
    expect((await connect(s2.attachPath, ['ninedeploy.terminal.v1']).closed).code).toBe(4401);
    expect((await connect('/v1/terminals/0/attach', ['ninedeploy.terminal.v1', `ninedeploy.ticket.${s2.ticket}`]).closed).code).toBe(4401);
    // None of the refusals consumed the real ticket.
    const ok = attach(s2);
    await waitFor(() => ok.texts.length > 0);
    ok.ws.close();
  });

  it('a foreign Origin closes 4403 before the ticket is touched', async () => {
    const s = await createSession();
    expect(await attach(s, 'https://evil.example').closed).toEqual({ code: TERMINAL_CLOSE.forbidden, reason: 'origin not allowed' });
    expect((await row(s.session.id)).status).toBe('pending');
  });

  it('a session whose context is gone (e.g. revoked) closes 4401 and is recorded as failed', async () => {
    const s = await createSession();
    S.takePending(s.session.id);
    expect((await attach(s).closed).code).toBe(4401);
    await vi.waitFor(async () => expect(await row(s.session.id)).toMatchObject({ status: 'failed', endReason: 'context_lost' }));
  });
});

describe('attach: limits, revalidation and failures', () => {
  it('the instance cap closes 4429', async () => {
    await db.insert(settings).values({ key: 'terminal_max_concurrent', value: 1 as unknown as boolean });
    const busy = S.reserveLive({ id: 999, userId: 5, targetKind: 'container', legacy: false });
    const s = await createSession();
    const c = attach(s);
    expect((await c.closed).code).toBe(TERMINAL_CLOSE.tooManySessions);
    await vi.waitFor(async () => expect(await row(s.session.id)).toMatchObject({ status: 'failed', endReason: 'too_many_sessions' }));
    busy.release();
  });

  it('the per-user cap (3) closes 4429', async () => {
    const held = [1, 2, 3].map((n) => S.reserveLive({ id: 800 + n, userId: 1, targetKind: 'container', legacy: false }));
    const s = await createSession();
    expect((await attach(s).closed).code).toBe(4429);
    for (const h of held) h.release();
  });

  it('a principal revoked between create and attach closes 4403', async () => {
    const s = await createSession();
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.jti, 'jti-op'));
    const c = attach(s);
    expect((await c.closed).code).toBe(TERMINAL_CLOSE.forbidden);
    await vi.waitFor(async () => expect(await row(s.session.id)).toMatchObject({ status: 'failed', endReason: 'revoked', error: 'session revoked' }));
    expect(S.liveTerminalCount()).toBe(0);
  });

  it('a target Docker cannot open closes 4502 with a notice', async () => {
    fakes.openExec = async () => {
      throw new Error('Container nd-app-web is not running');
    };
    const s = await createSession();
    const c = attach(s);
    expect((await c.closed).code).toBe(TERMINAL_CLOSE.targetUnreachable);
    expect(c.texts[0]).toMatchObject({ t: 'notice', message: expect.stringContaining('is not running') });
    await vi.waitFor(async () => expect(await row(s.session.id)).toMatchObject({ status: 'failed', endReason: 'target_unreachable' }));
    expect(S.liveTerminalCount()).toBe(0);
  });

  it('a client that leaves while Docker starts the shell leaves nothing running', async () => {
    let release!: () => void;
    const tty = fakes.make();
    fakes.openExec = () => new Promise((resolve) => { release = () => resolve(tty); });
    const s = await createSession();
    const c = attach(s);
    await c.opened;
    await waitFor(() => typeof release === 'function');
    c.ws.close();
    await c.closed;
    release();
    await vi.waitFor(async () => expect(await row(s.session.id)).toMatchObject({ status: 'ended', endReason: 'client_closed' }));
    expect(tty.killed).toBe(1);
    expect(S.liveTerminalCount()).toBe(0);
  });

  it('DELETE /v1/terminals/:id closes a live socket with 4410 and records who', async () => {
    const s = await createSession();
    const c = attach(s);
    await waitFor(() => c.texts.length > 0);
    const res = await fetch(`http://127.0.0.1:${port}/v1/terminals/${s.session.id}`, { method: 'DELETE', headers: headers() });
    expect(await res.json()).toEqual({ ok: true, wasLive: true });
    expect(await c.closed).toEqual({ code: TERMINAL_CLOSE.terminated, reason: 'session terminated' });
    expect(c.texts.at(-1)).toEqual({ t: 'exit', code: null, reason: 'terminated' });
    await vi.waitFor(async () => expect(await row(s.session.id)).toMatchObject({ status: 'ended', endReason: 'terminated', terminatedByUserId: 1 }));
  });

  it('a frame over 64 KiB closes 1009', async () => {
    const s = await createSession();
    const c = attach(s);
    await waitFor(() => c.texts.length > 0);
    c.ws.send(Buffer.alloc(TERMINAL_FRAME_MAX_BYTES + 1), { binary: true });
    expect((await c.closed).code).toBe(1009);
    await vi.waitFor(async () => expect((await row(s.session.id)).endReason).toBe('frame_too_large'));
  });
});
