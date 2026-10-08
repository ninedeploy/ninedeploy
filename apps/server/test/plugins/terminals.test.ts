/**
 * 0.15 terminals plugin (DESIGN §1.2, mount point M8): boot recovery (rows and
 * helper containers), the 60s reaper (ticket expiry, pending contexts, helpers
 * whose session is not live or past their expiry label). Docker is mocked.
 */
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, createDb, type DB, terminalSessions, users } from '@ninedeploy/db';

const docker = vi.hoisted(() => ({
  transport: { kind: 'socket', socketPath: '/x' } as { kind: string; socketPath?: string; reason?: string },
  helpers: [] as Array<{ id: string; labels: Record<string, string> }>,
  list: vi.fn(),
  remove: vi.fn(),
}));
// audit() fans out to notifyEvent fire-and-forget; with a real in-memory
// SQLite that query could outlive the test and hit a closed client.
vi.mock('../../src/lib/notifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/notifier.js')>()),
  notifyEvent: async () => undefined,
}));
vi.mock('../../src/lib/dockerTty.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/dockerTty.js')>()),
  dockerTransport: () => docker.transport,
  listContainersWithLabel: (...a: unknown[]) => docker.list(...a),
  forceRemoveContainer: (...a: unknown[]) => docker.remove(...a),
}));

const { default: terminalsPlugin, reapTerminalHelpers, TERMINAL_REAPER_MS } = await import('../../src/plugins/terminals.js');
const S = await import('../../src/lib/terminalSessions.js');

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));
let db: DB;
let close: () => void;

beforeEach(async () => {
  const created = createDb({ url: ':memory:' });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true });
  docker.transport = { kind: 'socket', socketPath: '/x' };
  docker.helpers = [];
  docker.list.mockReset();
  docker.list.mockImplementation(async () => docker.helpers);
  docker.remove.mockReset();
  docker.remove.mockResolvedValue(undefined);
  S.resetTerminalRegistry();
});

// Let fire-and-forget audit writes land before the in-memory database closes.
const settle = () => new Promise((r) => setTimeout(r, 30));

afterEach(async () => {
  vi.useRealTimers();
  await settle();
  close();
});

const helper = (id: string, session: string, expires?: number) => ({
  id,
  labels: { 'ninedeploy.terminal.session': session, ...(expires !== undefined ? { 'ninedeploy.terminal.expires': String(expires) } : {}) },
});

describe('reapTerminalHelpers', () => {
  it('removes helpers whose session is not live, is past its expiry label, or carries no session id', async () => {
    const live = S.reserveLive({ id: 7, userId: 1, targetKind: 'host', legacy: false });
    const now = 1_900_000_000_000;
    docker.helpers = [
      helper('keep', '7', now / 1000 + 100),
      helper('orphan', '8'),
      helper('expired', '7', now / 1000 - 1),
      helper('garbage', 'x'),
    ];
    expect(await reapTerminalHelpers({ now })).toBe(3);
    expect(docker.remove.mock.calls.map((c) => c[1])).toEqual(['orphan', 'expired', 'garbage']);
    expect(docker.list).toHaveBeenCalledWith(docker.transport, 'ninedeploy.terminal.session');
    docker.remove.mockClear();
    expect(await reapTerminalHelpers({ all: true, now })).toBe(4);
    live.release();
  });

  it('does nothing without the Engine API (no helpers exist there) and survives a failed removal', async () => {
    docker.transport = { kind: 'cli', reason: 'ssh' };
    expect(await reapTerminalHelpers()).toBe(0);
    expect(docker.list).not.toHaveBeenCalled();
    docker.transport = { kind: 'socket', socketPath: '/x' };
    docker.helpers = [helper('a', '1')];
    docker.remove.mockRejectedValue(new Error('gone'));
    expect(await reapTerminalHelpers()).toBe(1);
  });
});

describe('terminalsPlugin', () => {
  const boot = async () => {
    const app = Fastify({ logger: false });
    app.decorate('db', db);
    await app.register(terminalsPlugin);
    await app.ready();
    return app;
  };

  it('boot recovery: live and pending rows end with panel_restart, and every helper is removed', async () => {
    await db.insert(terminalSessions).values([
      { userId: 1, targetKind: 'host', targetLabel: 'panel host', status: 'active', startedAt: new Date(Date.now() - 1000) },
      { userId: 1, targetKind: 'container', targetLabel: 'c', status: 'pending', ticketHash: 'h', ticketExpiresAt: new Date(Date.now() + 1000) },
      { userId: 1, targetKind: 'container', targetLabel: 'c', status: 'ended' },
    ]);
    docker.helpers = [helper('left-over', '1')];
    const app = await boot();
    const rows = await db.select().from(terminalSessions);
    expect(rows.map((r) => [r.status, r.endReason])).toEqual([
      ['ended', 'panel_restart'],
      ['ended', 'panel_restart'],
      ['ended', null],
    ]);
    expect(docker.remove).toHaveBeenCalledWith(docker.transport, 'left-over');
    expect((await db.select().from(auditLog)).map((r) => r.action)).toContain('terminal.session.end');
    await app.close();
  });

  it('a Docker outage at boot does not fail the boot', async () => {
    docker.list.mockRejectedValue(new Error('connect ENOENT /var/run/docker.sock'));
    const app = await boot();
    expect(app.hasPlugin('ninedeploy-terminals')).toBe(true);
    await app.close();
  });

  it('a database failure at boot does not fail the boot either', async () => {
    const app = Fastify({ logger: false });
    app.decorate('db', { update: () => { throw new Error('db down'); } } as unknown as DB);
    await app.register(terminalsPlugin);
    await expect(app.ready()).resolves.toBeDefined();
    await app.close();
  });

  it('an isolated registration without a database does nothing', async () => {
    const app = Fastify({ logger: false });
    await app.register(terminalsPlugin);
    await app.ready();
    expect(docker.list).not.toHaveBeenCalled();
    await app.close();
  });

  it('the reaper expires tickets, drops pending contexts and sweeps helpers every minute, until close', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const app = await boot();
    docker.list.mockClear();
    const [pending] = await db
      .insert(terminalSessions)
      .values({ userId: 1, targetKind: 'container', targetLabel: 'c', status: 'pending', ticketHash: 'h2', ticketExpiresAt: new Date(Date.now() - 1000) })
      .returning();
    S.rememberPending(pending!.id, {
      target: { kind: 'container', label: 'c', serverId: null, serviceId: null, databaseId: null, containerName: 'c', cmd: null, env: [] },
      principal: { authKind: 'session', userId: 1, jti: null, ver: null, bearer: null },
      cols: 80,
      rows: 24,
      expiresAt: Date.now() - 1000,
    });
    docker.helpers = [helper('stale', String(pending!.id))];
    vi.advanceTimersByTime(TERMINAL_REAPER_MS);
    vi.useRealTimers();
    await vi.waitFor(async () => expect((await db.select().from(terminalSessions))[0]).toMatchObject({ status: 'expired', endReason: 'ticket_expired' }));
    await vi.waitFor(() => expect(docker.remove).toHaveBeenCalledWith(docker.transport, 'stale'));
    expect(S.takePending(pending!.id)).toBeNull();
    await app.close();
    expect(TERMINAL_REAPER_MS).toBe(60_000);
  });

  it('a failing reaper step is logged, not thrown, and ticks do not overlap', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const app = await boot();
    let release!: () => void;
    docker.list.mockReset();
    docker.list.mockImplementation(() => new Promise((resolve) => { release = () => resolve([]); }));
    vi.advanceTimersByTime(TERMINAL_REAPER_MS);
    vi.advanceTimersByTime(TERMINAL_REAPER_MS); // still running: skipped
    vi.useRealTimers();
    await vi.waitFor(() => expect(docker.list).toHaveBeenCalledTimes(1));
    release();
    docker.list.mockRejectedValue(new Error('down'));
    await app.close();
  });
});
