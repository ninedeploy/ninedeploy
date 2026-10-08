/**
 * 0.15 `/v1/terminals` HTTP routes (DESIGN §1.6) against a real migrated
 * SQLite: target resolution and authorisation, the four host-shell gates
 * (owner decision O1), tickets, history, terminate and settings. Docker is
 * mocked (`lib/dockerTty.ts`); the attach socket is `terminalsWs.test.ts`.
 */
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditLog,
  createDb,
  type DB,
  databases,
  servers,
  serviceTargets,
  services,
  settings,
  terminalSessions,
  users,
} from '@ninedeploy/db';
import { terminalSessionCreated, terminalSessionList, terminalSettingsView } from '@ninedeploy/schemas';

const tty = vi.hoisted(() => ({
  transport: { kind: 'socket', socketPath: '/var/run/docker.sock' } as { kind: string; socketPath?: string; reason?: string },
  inspect: vi.fn(),
  probe: vi.fn(),
}));
// audit() fans out to notifyEvent fire-and-forget; with a real in-memory
// SQLite that query could outlive the test and hit a closed client.
vi.mock('../src/lib/notifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/notifier.js')>()),
  notifyEvent: async () => undefined,
}));
vi.mock('../src/lib/dockerTty.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/dockerTty.js')>()),
  dockerTransport: () => tty.transport,
  inspectContainer: (...a: unknown[]) => tty.inspect(...a),
  probeHostShellImage: (...a: unknown[]) => tty.probe(...a),
}));
const execMock = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/exec.js')>()),
  capture: (...a: unknown[]) => execMock.capture(...a),
}));

const { terminalRoutes } = await import('../src/modules/terminals.js');
const S = await import('../src/lib/terminalSessions.js');
const { encrypt, hashPassword, sha256 } = await import('../src/lib/crypto.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const PASSWORD = 'correct horse battery';

let db: DB;
let close: () => void;
let ids: { svc: number; replicated: number; compose: number; pm2: number; nodeSvc: number; fanout: number; idle: number; pg: number; mongo: number; stoppedDb: number; server: number };

beforeEach(async () => {
  const created = createDb({ url: ':memory:' });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values([
    { id: 1, email: 'op@example.com', passwordHash: await hashPassword(PASSWORD), isInstanceOperator: true },
    { id: 2, email: 'member@example.com', passwordHash: 'x' },
  ]);
  const [server] = await db.insert(servers).values({ name: 'node-1', host: '10.0.0.9', tokenEncrypted: 'v1:x' }).returning();
  const svc = async (v: Partial<typeof services.$inferInsert>) => (await db.insert(services).values({ name: 'x', slug: `s${Math.random()}`, ...v }).returning())[0]!.id;
  const svcId = await svc({ name: 'web', type: 'docker', runtimeId: 'nd-app-web' });
  const replicated = await svc({ name: 'api', type: 'docker', runtimeId: 'nd-app-api', runtimeReplicas: 2 });
  const compose = await svc({ name: 'stack', type: 'compose', runtimeId: 'nd-stack' });
  const pm2 = await svc({ name: 'proc', type: 'pm2', runtimeId: 'proc' });
  const nodeSvc = await svc({ name: 'remote', type: 'docker', runtimeId: 'nd-app-remote', serverId: server!.id });
  const fanout = await svc({ name: 'fan', type: 'docker', runtimeId: 'nd-app-fan' });
  await db.insert(serviceTargets).values({ serviceId: fanout, serverId: server!.id, runtimeId: 'fan-t1-3', status: 'running' });
  const idle = await svc({ name: 'idle', type: 'docker', runtimeId: null });
  const dbRow = async (v: Partial<typeof databases.$inferInsert>) =>
    (await db.insert(databases).values({ name: 'db', slug: `d${Math.random()}`, engine: 'postgres', passwordEncrypted: encrypt('pw-secret'), ...v }).returning())[0]!.id;
  ids = {
    svc: svcId,
    replicated,
    compose,
    pm2,
    nodeSvc,
    fanout,
    idle,
    pg: await dbRow({ name: 'pg', engine: 'postgres', status: 'running', containerName: 'nd-db-pg' }),
    mongo: await dbRow({ name: 'mg', engine: 'mongo', status: 'running', containerName: 'nd-db-mg' }),
    stoppedDb: await dbRow({ name: 'off', engine: 'postgres', status: 'stopped', containerName: 'nd-db-off' }),
    server: server!.id,
  };
  tty.transport = { kind: 'socket', socketPath: '/var/run/docker.sock' };
  tty.inspect.mockReset();
  tty.inspect.mockImplementation(async (_t: unknown, name: string) =>
    name === 'missing' ? null : { id: `id-${name}`, running: name !== 'stopped', hostname: 'h', labels: {} },
  );
  tty.probe.mockReset();
  tty.probe.mockResolvedValue({ ok: true });
  execMock.capture.mockReset();
  S.resetTerminalRegistry();
  delete process.env['NINEDEPLOY_HOST_TERMINAL'];
});

// Let fire-and-forget audit writes land before the in-memory database closes.
const settle = () => new Promise((r) => setTimeout(r, 30));

afterEach(async () => {
  await settle();
  close();
});

async function app() {
  const a = await buildTestApp({ db });
  await a.register(terminalRoutes, { prefix: '/v1/terminals' });
  return a;
}

const op = asUser({ id: 1, isOperator: true });
const member = asUser({ id: 2, isOperator: false, role: 'member' });

const create = async (target: unknown, extra: Record<string, unknown> = {}, headers: Record<string, string> = op) =>
  (await app()).inject({ method: 'POST', url: '/v1/terminals', headers, payload: { target, ...extra } });

const actions = async () => (await db.select().from(auditLog)).map((r) => r.action);

const enableHost = () => db.insert(settings).values({ key: 'terminal_host_enabled', value: true });

describe('POST /v1/terminals: service targets', () => {
  it('opens a session on the primary container and returns a single-use ticket (stored hashed)', async () => {
    const res = await create({ kind: 'service', serviceId: ids.svc }, { cols: 100, rows: 30 }, { ...op, 'user-agent': 'vitest-ua' });
    expect(res.statusCode).toBe(201);
    const body = terminalSessionCreated.parse(res.json());
    expect(body.session).toMatchObject({ status: 'pending', targetKind: 'service', targetLabel: 'web', userId: 1, userEmail: 'op@example.com', serverId: null });
    expect(body.attachPath).toBe(`/v1/terminals/${body.session.id}/attach`);
    expect(new Date(body.ticketExpiresAt).getTime() - Date.now()).toBeLessThanOrEqual(30_000);
    const [row] = await db.select().from(terminalSessions);
    expect(row).toMatchObject({ containerName: 'nd-app-web', serviceId: ids.svc, cols: 100, rows: 30, authKind: 'session', userAgent: 'vitest-ua' });
    expect(row!.ticketHash).toBe(sha256(body.ticket));
    expect(JSON.stringify(row)).not.toContain(body.ticket);
    expect(S.takePending(row!.id)).toMatchObject({ cols: 100, rows: 30, target: { containerName: 'nd-app-web', cmd: null } });
    await vi.waitFor(async () => expect(await actions()).toContain('terminal.session.create'));
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, 'terminal.session.create'));
    expect(audit!.meta).toMatchObject({ sessionId: row!.id, targetKind: 'service', targetLabel: 'web', serverId: null });
    expect(tty.inspect).toHaveBeenCalledWith(tty.transport, 'nd-app-web');
  });

  it('defaults to 120x32 and addresses replicas by name', async () => {
    const res = await create({ kind: 'service', serviceId: ids.replicated, replica: 2 });
    expect(res.statusCode).toBe(201);
    expect(res.json().session.targetLabel).toBe('api (replica 2)');
    const [row] = await db.select().from(terminalSessions);
    expect(row).toMatchObject({ containerName: 'nd-app-api-r2', cols: 120, rows: 32 });
    expect((await create({ kind: 'service', serviceId: ids.replicated, replica: 3 })).json().error.code).toBe('replica_out_of_range');
    expect((await create({ kind: 'service', serviceId: ids.replicated, replica: 1 })).statusCode).toBe(201);
  });

  it('refuses compose, pm2, stopped and unknown services with an actionable code', async () => {
    const compose = await create({ kind: 'service', serviceId: ids.compose });
    expect(compose.statusCode).toBe(422);
    expect(compose.json().error).toMatchObject({ code: 'use_container_target' });
    expect(compose.json().error.message).toContain(`/v1/services/${ids.compose}/containers`);
    expect((await create({ kind: 'service', serviceId: ids.pm2 })).json().error.code).toBe('not_a_container');
    const idle = await create({ kind: 'service', serviceId: ids.idle });
    expect([idle.statusCode, idle.json().error.code]).toEqual([409, 'not_running']);
    tty.inspect.mockResolvedValueOnce({ id: 'x', running: false, hostname: null, labels: {} });
    expect((await create({ kind: 'service', serviceId: ids.svc })).json().error.code).toBe('not_running');
    tty.inspect.mockResolvedValueOnce(null);
    expect((await create({ kind: 'service', serviceId: ids.svc })).statusCode).toBe(409);
    expect((await create({ kind: 'service', serviceId: 99999 })).statusCode).toBe(404);
    expect(await db.select().from(terminalSessions)).toHaveLength(0);
  });

  it('node placements are refused until node terminals land (T2b), fan-out targets included', async () => {
    const node = await create({ kind: 'service', serviceId: ids.nodeSvc });
    expect([node.statusCode, node.json().error.code]).toEqual([422, 'node_terminal_unsupported']);
    const fan = await create({ kind: 'service', serviceId: ids.fanout, serverId: ids.server });
    expect(fan.json().error.code).toBe('node_terminal_unsupported');
    expect((await create({ kind: 'service', serviceId: ids.fanout, serverId: ids.server, replica: 2 })).json().error.code).toBe('replica_out_of_range');
    expect((await create({ kind: 'service', serviceId: ids.svc, serverId: ids.server })).json().error.code).toBe('not_a_target');
    await db.update(serviceTargets).set({ runtimeId: null });
    expect((await create({ kind: 'service', serviceId: ids.fanout, serverId: ids.server })).json().error.code).toBe('not_running');
    expect(tty.inspect).not.toHaveBeenCalled();
  });
});

describe('POST /v1/terminals: database and container targets', () => {
  it('opens a database shell, or its client with the credentials in the exec env', async () => {
    const shell = await create({ kind: 'database', databaseId: ids.pg });
    expect(shell.statusCode).toBe(201);
    expect(shell.json().session.targetLabel).toBe('pg');
    const client = await create({ kind: 'database', databaseId: ids.pg, mode: 'client' });
    expect(client.statusCode).toBe(201);
    expect(client.json().session.targetLabel).toBe('pg (client)');
    const pending = S.takePending(client.json().session.id)!;
    expect(pending.target).toMatchObject({ kind: 'database', containerName: 'nd-db-pg', cmd: ['psql', '-U', 'nine', '-d', 'app'], env: ['PGPASSWORD=pw-secret'] });
    // The credential is in memory only: never in the row or the audit.
    expect(JSON.stringify(await db.select().from(terminalSessions))).not.toContain('pw-secret');
    await vi.waitFor(async () => expect((await actions()).filter((a) => a === 'terminal.session.create')).toHaveLength(2));
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain('pw-secret');
  });

  it('maps every engine to its client, or refuses one without an interactive client', async () => {
    const cases: Array<[string, unknown]> = [
      ['mysql', { cmd: ['mysql', '-uroot'], env: ['MYSQL_PWD=pw-secret'] }],
      ['mariadb', { cmd: ['mariadb', '-uroot'], env: ['MYSQL_PWD=pw-secret'] }],
      ['redis', { cmd: ['redis-cli'], env: ['REDISCLI_AUTH=pw-secret'] }],
      ['valkey', { cmd: ['valkey-cli'], env: ['REDISCLI_AUTH=pw-secret', 'VALKEYCLI_AUTH=pw-secret'] }],
    ];
    for (const [engine, expected] of cases) {
      const [row] = await db
        .insert(databases)
        .values({ name: engine, slug: engine, engine: engine as 'mysql', status: 'running', containerName: `nd-db-${engine}`, passwordEncrypted: encrypt('pw-secret') })
        .returning();
      const res = await create({ kind: 'database', databaseId: row!.id, mode: 'client' });
      expect(res.statusCode, engine).toBe(201);
      expect(S.takePending(res.json().session.id)!.target).toMatchObject(expected as object);
    }
    const mongo = await create({ kind: 'database', databaseId: ids.mongo, mode: 'client' });
    expect([mongo.statusCode, mongo.json().error.code]).toEqual([422, 'client_mode_unsupported']);
    expect((await create({ kind: 'database', databaseId: ids.mongo })).statusCode).toBe(201);
    expect((await create({ kind: 'database', databaseId: ids.stoppedDb })).json().error.code).toBe('not_running');
    expect((await create({ kind: 'database', databaseId: 99999 })).statusCode).toBe(404);
  });

  it('opens any running local container by name, refusing remote, missing and the panel itself', async () => {
    expect((await create({ kind: 'container', name: 'nd-app-web' })).statusCode).toBe(201);
    expect((await create({ kind: 'container', name: 'missing' })).json().error.code).toBe('not_running');
    expect((await create({ kind: 'container', name: 'stopped' })).json().error.code).toBe('not_running');
    const remote = await create({ kind: 'container', name: 'nd-app-remote-r2' });
    expect([remote.statusCode, remote.json().error.code]).toEqual([422, 'remote_container']);
    expect((await create({ kind: 'container', name: 'fan-t1-3' })).json().error.code).toBe('remote_container');
    const { hostname } = await import('node:os');
    tty.inspect.mockResolvedValueOnce({ id: 'self', running: true, hostname: null, labels: {} });
    const own = hostname();
    if (/^[0-9a-f]{12,64}$/.test(own)) {
      tty.inspect.mockReset();
      tty.inspect.mockResolvedValue({ id: `${own}deadbeef`, running: true, hostname: own, labels: {} });
      expect((await create({ kind: 'container', name: 'ninedeploy' })).json().error.code).toBe('panel_container_refused');
    } else {
      expect((await create({ kind: 'container', name: 'nd-other' })).statusCode).toBe(201);
    }
    expect((await create({ kind: 'container', name: '../etc' })).statusCode).toBe(400);
  });

  it('with a CLI-only DOCKER_HOST the container is inspected through the CLI (pipe mode later)', async () => {
    tty.transport = { kind: 'cli', reason: 'DOCKER_HOST uses ssh://' };
    execMock.capture.mockResolvedValueOnce('abc|abc|true\n');
    expect((await create({ kind: 'container', name: 'nd-app-web' })).statusCode).toBe(201);
    expect(execMock.capture).toHaveBeenCalledWith('docker', [
      'inspect',
      '--type',
      'container',
      '--format',
      '{{.Id}}|{{.Config.Hostname}}|{{.State.Running}}',
      '--',
      'nd-app-web',
    ]);
    execMock.capture.mockResolvedValueOnce('abc||false');
    expect((await create({ kind: 'container', name: 'nd-app-web' })).json().error.code).toBe('not_running');
    execMock.capture.mockRejectedValueOnce(new Error('No such object'));
    expect((await create({ kind: 'container', name: 'nd-app-web' })).json().error.code).toBe('not_running');
    expect(tty.inspect).not.toHaveBeenCalled();
  });

  it('is operator only, and validates the body', async () => {
    expect((await create({ kind: 'service', serviceId: ids.svc }, {}, member)).statusCode).toBe(403);
    expect((await (await app()).inject({ method: 'POST', url: '/v1/terminals', payload: {} })).statusCode).toBe(401);
    expect((await create({ kind: 'service', serviceId: ids.svc }, { cols: 9 })).statusCode).toBe(400);
    expect((await create({ kind: 'nope' })).statusCode).toBe(400);
  });
});

describe('POST /v1/terminals: host shells (owner decision O1)', () => {
  const host = { kind: 'host', serverId: null };

  it('are off by default (an upgraded panel has no setting row)', async () => {
    const res = await create(host, { password: PASSWORD });
    expect([res.statusCode, res.json().error.code]).toEqual([403, 'host_terminal_disabled']);
    expect(tty.probe).not.toHaveBeenCalled();
  });

  it('NINEDEPLOY_HOST_TERMINAL=off forbids them even when enabled', async () => {
    await enableHost();
    process.env['NINEDEPLOY_HOST_TERMINAL'] = 'off';
    expect((await create(host, { password: PASSWORD })).json().error.code).toBe('host_terminal_disabled');
  });

  it('need an interactive session (no API token) and a password re-check', async () => {
    await enableHost();
    const token = await create(host, { password: PASSWORD }, { ...op, 'x-test-token-scopes': 'operator' });
    expect([token.statusCode, token.json().error.message]).toEqual([403, 'Host shells require an interactive session, not an API token']);
    const noPassword = await create(host);
    expect([noPassword.statusCode, noPassword.json().error.code]).toEqual([403, 'reauth_required']);
    const wrong = await create(host, { password: 'wrong' });
    expect([wrong.statusCode, wrong.json().error.code]).toEqual([403, 'invalid_password']);
    const ok = await create(host, { password: PASSWORD });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().session).toMatchObject({ targetKind: 'host', targetLabel: 'panel host', serverId: null });
    expect(tty.probe).toHaveBeenCalledWith(tty.transport, 'traefik:3');
    const [row] = await db.select().from(terminalSessions);
    expect(row).toMatchObject({ containerName: null, authKind: 'session' });
  });

  it('a node host is checked by the same gates first, then refused until T2b', async () => {
    await enableHost();
    expect((await create({ kind: 'host', serverId: ids.server })).json().error.code).toBe('reauth_required');
    expect((await create({ kind: 'host', serverId: ids.server }, { password: PASSWORD })).json().error.code).toBe('node_terminal_unsupported');
  });

  it('need the Engine API and an image with nsenter', async () => {
    await enableHost();
    tty.transport = { kind: 'cli', reason: 'DOCKER_HOST uses TLS' };
    const cli = await create(host, { password: PASSWORD });
    expect([cli.statusCode, cli.json().error.code]).toEqual([422, 'host_shell_unsupported_docker_host']);
    tty.transport = { kind: 'socket', socketPath: '/x' };
    tty.probe.mockResolvedValueOnce({ ok: false, reason: 'the image traefik:3 has no nsenter' });
    const probe = await create(host, { password: PASSWORD });
    expect([probe.statusCode, probe.json().error.code]).toEqual([422, 'host_shell_image_unsupported']);
    expect(probe.json().error.message).toContain('NINEDEPLOY_HOST_SHELL_IMAGE');
    tty.probe.mockRejectedValueOnce(new Error('connect ENOENT'));
    expect((await create(host, { password: PASSWORD })).json().error.message).toContain('connect ENOENT');
    tty.probe.mockRejectedValueOnce('weird');
    expect((await create(host, { password: PASSWORD })).json().error.code).toBe('host_shell_image_unsupported');
  });

  it('refuses a user row that disappeared', async () => {
    await enableHost();
    const res = await create(host, { password: PASSWORD }, asUser({ id: 77, isOperator: true }));
    expect(res.statusCode).toBe(401);
  });
});

describe('history, detail and terminate', () => {
  const seed = async () => {
    const mk = async (v: Partial<typeof terminalSessions.$inferInsert>) =>
      (await db.insert(terminalSessions).values({ userId: 1, targetKind: 'container', targetLabel: 'c', ...v }).returning())[0]!;
    return {
      ended: await mk({ status: 'ended', endReason: 'shell_exited', durationMs: 10 }),
      host: await mk({ status: 'ended', targetKind: 'host', userId: 2 }),
      pending: await mk({ status: 'pending', ticketHash: 'h', ticketExpiresAt: new Date(Date.now() + 30_000) }),
      active: await mk({ status: 'active', startedAt: new Date() }),
      orphan: await mk({ status: 'ended', userId: null }),
    };
  };

  it('lists newest first with emails, filters and pages backwards', async () => {
    const rows = await seed();
    const a = await app();
    const all = terminalSessionList.parse((await a.inject({ method: 'GET', url: '/v1/terminals', headers: op })).json());
    expect(all.items.map((i) => i.id)).toEqual([rows.orphan.id, rows.active.id, rows.pending.id, rows.host.id, rows.ended.id]);
    expect(all.items.find((i) => i.id === rows.host.id)!.userEmail).toBe('member@example.com');
    expect(all.items.find((i) => i.id === rows.orphan.id)!.userEmail).toBeNull();
    expect(all.nextBefore).toBeNull();
    const page = (await a.inject({ method: 'GET', url: '/v1/terminals?limit=2', headers: op })).json();
    expect(page.items).toHaveLength(2);
    expect(page.nextBefore).toBe(rows.active.id);
    const next = (await a.inject({ method: 'GET', url: `/v1/terminals?limit=2&before=${page.nextBefore}`, headers: op })).json();
    expect(next.items.map((i: { id: number }) => i.id)).toEqual([rows.pending.id, rows.host.id]);
    const filtered = (await a.inject({ method: 'GET', url: '/v1/terminals?status=ended&targetKind=host&userId=2', headers: op })).json();
    expect(filtered.items.map((i: { id: number }) => i.id)).toEqual([rows.host.id]);
    expect((await a.inject({ method: 'GET', url: '/v1/terminals?limit=500', headers: op })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/v1/terminals', headers: member })).statusCode).toBe(403);
    const none = (await a.inject({ method: 'GET', url: '/v1/terminals?status=failed', headers: op })).json();
    expect(none).toEqual({ items: [], nextBefore: null });
  });

  it('shows one session; 404 for an unknown one', async () => {
    const rows = await seed();
    const a = await app();
    const res = await a.inject({ method: 'GET', url: `/v1/terminals/${rows.ended.id}`, headers: op });
    expect(res.json()).toMatchObject({ id: rows.ended.id, endReason: 'shell_exited', durationMs: 10, userEmail: 'op@example.com' });
    expect((await a.inject({ method: 'GET', url: `/v1/terminals/${rows.orphan.id}`, headers: op })).json().userEmail).toBeNull();
    expect((await a.inject({ method: 'GET', url: '/v1/terminals/999999', headers: op })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/v1/terminals/abc', headers: op })).statusCode).toBe(400);
  });

  it('terminates a live session through the registry, revokes a pending ticket, and refuses an ended one', async () => {
    const rows = await seed();
    const a = await app();
    const terminated: Array<number | null> = [];
    const slot = S.reserveLive({ id: rows.active.id, userId: 1, targetKind: 'container', legacy: false });
    slot.attach({ terminate: (by) => terminated.push(by), revoke: () => undefined });
    const live = await a.inject({ method: 'DELETE', url: `/v1/terminals/${rows.active.id}`, headers: op });
    expect(live.json()).toEqual({ ok: true, wasLive: true });
    expect(terminated).toEqual([1]);
    slot.release();

    S.rememberPending(rows.pending.id, {
      target: { kind: 'container', label: 'c', serverId: null, serviceId: null, databaseId: null, containerName: 'c', cmd: null, env: [] },
      principal: { authKind: 'session', userId: 1, jti: null, ver: null, bearer: null },
      cols: 80,
      rows: 24,
      expiresAt: Date.now() + 30_000,
    });
    const pend = await a.inject({ method: 'DELETE', url: `/v1/terminals/${rows.pending.id}`, headers: op });
    expect(pend.json()).toEqual({ ok: true, wasLive: false });
    const [after] = await db.select().from(terminalSessions).where(eq(terminalSessions.id, rows.pending.id));
    expect(after).toMatchObject({ status: 'expired', ticketHash: null, endReason: 'terminated', terminatedByUserId: 1 });
    expect(S.takePending(rows.pending.id)).toBeNull();

    // An `active` row no process runs (a crash before boot recovery): closed here.
    const stale = await a.inject({ method: 'DELETE', url: `/v1/terminals/${rows.active.id}`, headers: op });
    expect(stale.json()).toEqual({ ok: true, wasLive: false });
    const [staleRow] = await db.select().from(terminalSessions).where(eq(terminalSessions.id, rows.active.id));
    expect(staleRow).toMatchObject({ status: 'ended', endReason: 'terminated' });

    const ended = await a.inject({ method: 'DELETE', url: `/v1/terminals/${rows.ended.id}`, headers: op });
    expect([ended.statusCode, ended.json().error.code]).toEqual([409, 'not_live']);
    expect((await a.inject({ method: 'DELETE', url: '/v1/terminals/999999', headers: op })).statusCode).toBe(404);
    expect((await a.inject({ method: 'DELETE', url: `/v1/terminals/${rows.active.id}`, headers: member })).statusCode).toBe(403);
    await vi.waitFor(async () => expect((await actions()).filter((x) => x === 'terminal.session.terminate')).toHaveLength(3));
  });
});

describe('settings', () => {
  const put = async (payload: unknown, headers: Record<string, string> = op) =>
    (await app()).inject({ method: 'PUT', url: '/v1/terminals/settings', headers, payload: payload as object });

  it('GET shows the defaults on a panel that never stored any', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/v1/terminals/settings', headers: op });
    expect(terminalSettingsView.parse(res.json())).toEqual({
      hostTerminalEnabled: false,
      hostTerminalForbiddenByEnv: false,
      idleTimeoutMinutes: 15,
      maxSessionMinutes: 240,
      maxConcurrent: 10,
      retentionDays: 180,
    });
    expect((await (await app()).inject({ method: 'GET', url: '/v1/terminals/settings', headers: member })).statusCode).toBe(403);
  });

  it('PUT changes the limits and audits the changed keys only', async () => {
    const res = await put({ idleTimeoutMinutes: 30, maxConcurrent: 10, retentionDays: 365, maxSessionMinutes: 60 });
    expect(res.json()).toMatchObject({ idleTimeoutMinutes: 30, maxConcurrent: 10, retentionDays: 365, maxSessionMinutes: 60 });
    await vi.waitFor(async () => expect(await actions()).toContain('terminal.settings.update'));
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, 'terminal.settings.update'));
    expect((audit!.meta as { changed: string[] }).changed).toEqual(['idleTimeoutMinutes', 'maxSessionMinutes', 'retentionDays']);
    expect((await put({ idleTimeoutMinutes: 0 })).statusCode).toBe(400);
    expect((await put({ unknown: 1 })).statusCode).toBe(400);
    expect((await put({ idleTimeoutMinutes: 20 }, member)).statusCode).toBe(403);
    expect((await (await app()).inject({ method: 'PUT', url: '/v1/terminals/settings', headers: op })).statusCode).toBe(200);
  });

  it('turning host shells on needs an interactive session and step-up; turning them off ends live host sessions', async () => {
    const token = await put({ hostTerminalEnabled: true, password: PASSWORD }, { ...op, 'x-test-token-scopes': 'operator' });
    expect(token.statusCode).toBe(403);
    expect((await put({ hostTerminalEnabled: true })).json().error.code).toBe('reauth_required');
    expect((await put({ hostTerminalEnabled: true, password: 'nope' })).json().error.code).toBe('invalid_password');
    expect((await put({ hostTerminalEnabled: true }, asUser({ id: 77, isOperator: true }))).statusCode).toBe(401);
    expect(await S.hostTerminalAllowed(db)).toBe(false);
    const on = await put({ hostTerminalEnabled: true, password: PASSWORD });
    expect(on.json().hostTerminalEnabled).toBe(true);
    // Already on: no step-up needed to save other keys.
    expect((await put({ hostTerminalEnabled: true, idleTimeoutMinutes: 5 })).statusCode).toBe(200);

    const revoked: string[] = [];
    const slot = S.reserveLive({ id: 900, userId: 1, targetKind: 'host', legacy: false });
    slot.attach({ terminate: () => undefined, revoke: (why) => revoked.push(why) });
    const off = await put({ hostTerminalEnabled: false });
    expect(off.json().hostTerminalEnabled).toBe(false);
    expect(revoked).toEqual(['host shells were disabled']);
    slot.release();
    await vi.waitFor(async () => {
      const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'terminal.settings.update'));
      expect(rows.map((r) => (r.meta as { hostTerminalEnabled?: boolean }).hostTerminalEnabled)).toEqual(expect.arrayContaining([true, false]));
    });
  });
});
