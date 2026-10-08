/**
 * 0.14 public database access routes (DESIGN §1.2) and the database module's
 * additive fields (M7), against a real migrated SQLite and a fake Docker CLI.
 *
 *   GET    /:id/public-access   db admin
 *   PUT    /:id/public-access   operator — applies synchronously
 *   DELETE /:id/public-access   operator
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  type DB,
  databasePublicAccess,
  databases,
  projects,
  users,
  workspaceMembers,
  workspaces,
} from '@ninedeploy/db';

const h = vi.hoisted(() => ({
  tmp: '',
  running: new Map<string, { fp: string; port: number }>(),
  runs: 0,
  busyPorts: new Set<number>(),
  dockerDown: false,
}));

vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  const { mkdtempSync: mk } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  h.tmp = mk(join(tmpdir(), 'nd-dbpub-routes-'));
  return {
    ...actual,
    config: { ...actual.config, publicUrl: 'https://panel.example.test', paths: { ...actual.config.paths, dataDir: h.tmp } },
  };
});

vi.mock('../../src/lib/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/exec.js')>();
  const docker = (args: string[], sink?: (l: string) => void): string => {
    if (h.dockerDown) throw new Error('Cannot connect to the Docker daemon');
    const [cmd, ...rest] = args;
    if (cmd === 'rm') {
      h.running.delete(rest[rest.length - 1]!);
      return '';
    }
    if (cmd === 'run') {
      h.runs++;
      const at = (flag: string) => args[args.indexOf(flag) + 1]!;
      const port = Number(at('-p').split(':')[0]);
      if (h.busyPorts.has(port)) {
        sink?.(`Bind for 0.0.0.0:${port} failed: port is already allocated`);
        throw new Error('`docker run` exited with code 125');
      }
      const fp = args.find((a) => a.startsWith('ninedeploy.dbpub.config-sha='))!.split('=')[1]!;
      h.running.set(at('--name'), { fp, port });
      return 'id';
    }
    if (cmd === 'inspect') {
      const c = h.running.get(rest[0]!);
      if (!c) throw new Error('No such object');
      return `true|${c.fp}`;
    }
    throw new Error(`unexpected docker ${args.join(' ')}`);
  };
  return {
    ...actual,
    capture: vi.fn(async (_tool: string, args: string[]) => docker(args)),
    run: vi.fn(async (_tool: string, args: string[], _o: unknown, sink: (l: string) => void) => {
      docker(args, sink);
    }),
    sleep: vi.fn(async () => undefined),
  };
});
vi.mock('../../src/lib/dockerPull.js', () => ({ ensureDockerImage: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/hostPath.js', () => ({ hostPathFor: vi.fn(async (p: string) => p) }));

const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/audit.js', () => auditMock);

const { databasePublicAccessRoutes } = await import('../../src/modules/databasePublicAccess.js');
const { databasesRoutes } = await import('../../src/modules/databases.js');
const { encrypt } = await import('../../src/lib/crypto.js');
const { asUser, buildTestApp } = await import('../helpers.js');

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));
const ADMIN = 2;
const MEMBER = 3;
const OUTSIDER = 4;

let db: DB;
let close: () => void;
let pgId: number;
let chId: number;
let myId: number;

beforeEach(async () => {
  auditMock.audit.mockClear();
  h.running.clear();
  h.runs = 0;
  h.busyPorts.clear();
  h.dockerDown = false;
  rmSync(path.join(h.tmp, 'dbproxy'), { recursive: true, force: true });
  const created = createDb({ url: ':memory:' });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values([1, ADMIN, MEMBER, OUTSIDER].map((id) => ({ id, email: `u${id}@example.com`, passwordHash: 'x' })));
  const [ws] = await db.insert(workspaces).values({ name: 'W', slug: 'w', ownerId: 1 }).returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: ws!.id, userId: ADMIN, role: 'admin' },
    { workspaceId: ws!.id, userId: MEMBER, role: 'member' },
  ]);
  const [project] = await db.insert(projects).values({ name: 'P', slug: 'p', workspaceId: ws!.id }).returning();
  const pw = encrypt('s3cret');
  const rows = await db
    .insert(databases)
    .values([
      { name: 'pg', slug: 'pg', engine: 'postgres', status: 'running', passwordEncrypted: pw, projectId: project!.id, containerName: 'nd-db-pg', internalHost: 'nd-db-pg', internalPort: 5432 },
      { name: 'ch', slug: 'ch', engine: 'clickhouse', status: 'running', passwordEncrypted: pw, projectId: project!.id },
      { name: 'my', slug: 'my', engine: 'mysql', status: 'running', passwordEncrypted: pw, projectId: project!.id },
    ])
    .returning();
  [pgId, chId, myId] = rows.map((r) => r.id) as [number, number, number];
});

afterEach(() => close());
afterAll(() => {
  try {
    rmSync(h.tmp, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

async function app() {
  const a = await buildTestApp({ db });
  await a.register(databasePublicAccessRoutes);
  return a;
}

const operator = asUser({ id: 1, isOperator: true });
const member = (id: number) => asUser({ id, isOperator: false, role: 'member' });
const body = { enabled: true, port: 15432, ipAllowlist: ['203.0.113.0/24'], tlsMode: 'none' };

describe('GET /:id/public-access', () => {
  it('reports an unconfigured database to a db admin (the upgrade default)', async () => {
    const res = await (await app()).inject({ method: 'GET', url: `/${pgId}/public-access`, headers: member(ADMIN) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ supported: true, configured: false, enabled: false, status: 'off', port: null, publicHost: 'panel.example.test' });
  });

  it('needs admin on the database; hides it from outsiders', async () => {
    const a = await app();
    expect((await a.inject({ method: 'GET', url: `/${pgId}/public-access`, headers: member(MEMBER) })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: `/${pgId}/public-access`, headers: member(OUTSIDER) })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: `/${pgId}/public-access` })).statusCode).toBe(401);
  });

  it('marks HTTP engines unsupported', async () => {
    const res = await (await app()).inject({ method: 'GET', url: `/${chId}/public-access`, headers: operator });
    expect(res.json().supported).toBe(false);
  });
});

describe('PUT /:id/public-access', () => {
  it('is operator-only, even for the database’s admin', async () => {
    const res = await (await app()).inject({ method: 'PUT', url: `/${pgId}/public-access`, headers: member(ADMIN), payload: body });
    expect(res.statusCode).toBe(403);
    expect(h.runs).toBe(0);
    expect(auditMock.audit).not.toHaveBeenCalled();
  });

  it('enables synchronously, answers the GET shape and audits without the allow-list contents', async () => {
    const a = await app();
    const res = await a.inject({ method: 'PUT', url: `/${pgId}/public-access`, headers: operator, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: true, enabled: true, status: 'running', port: 15432, ipAllowlist: ['203.0.113.0/24'] });
    expect(h.running.get('nd-dbpub-pg')?.port).toBe(15432);
    expect(auditMock.audit).toHaveBeenCalledWith(expect.anything(), 1, 'database.public_access.enable', 'pg', expect.objectContaining({ databaseId: pgId, port: 15432, entries: 1, tlsMode: 'none' }));
    expect(JSON.stringify(auditMock.audit.mock.calls.map((c) => (c as unknown[]).slice(1)))).not.toContain('203.0.113');

    const second = await a.inject({ method: 'PUT', url: `/${pgId}/public-access`, headers: operator, payload: { ...body, ipAllowlist: ['198.51.100.7', '198.51.100.7/32'] } });
    expect(second.statusCode).toBe(200);
    expect(second.json().ipAllowlist).toEqual(['198.51.100.7/32']);
    expect(auditMock.audit).toHaveBeenLastCalledWith(expect.anything(), 1, 'database.public_access.update', 'pg', expect.objectContaining({ entries: 1, mode: 'hot' }));
    expect(h.runs).toBe(1);
  });

  it.each([
    [{ ...body, ipAllowlist: [] }, /ipAllowlist/],
    [{ ...body, ipAllowlist: ['0.0.0.0/0'] }, /\/0 is refused/],
    [{ ...body, ipAllowlist: ['10.0.0.1; rm -rf /'] }, /not an IP/],
    [{ ...body, port: 443 }, /port/],
    [{ ...body, port: 80 }, /port/],
    [{ ...body, enabled: false }, /enabled/],
    [{ ...body, tlsHostname: 'not a host' }, /tlsHostname/],
    [{}, /enabled|port/],
  ])('refuses %j with 400 and changes nothing', async (payload, why) => {
    const res = await (await app()).inject({ method: 'PUT', url: `/${pgId}/public-access`, headers: operator, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(why);
    expect(h.runs).toBe(0);
    expect(await db.select().from(databasePublicAccess)).toHaveLength(0);
    expect(auditMock.audit).not.toHaveBeenCalled();
  });

  it('refuses unsupported engines and mysql TLS termination with 422', async () => {
    const a = await app();
    expect((await a.inject({ method: 'PUT', url: `/${chId}/public-access`, headers: operator, payload: body })).statusCode).toBe(422);
    const my = await a.inject({ method: 'PUT', url: `/${myId}/public-access`, headers: operator, payload: { ...body, tlsMode: 'terminate' } });
    expect(my.statusCode).toBe(422);
    expect(auditMock.audit).not.toHaveBeenCalled();
  });

  it('a port held by another process is a 409 carrying Docker’s message, audited as apply_failed', async () => {
    h.busyPorts.add(15432);
    const res = await (await app()).inject({ method: 'PUT', url: `/${pgId}/public-access`, headers: operator, payload: body });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/port is already allocated/);
    expect(auditMock.audit).toHaveBeenCalledWith(expect.anything(), 1, 'database.public_access.apply_failed', 'pg', expect.objectContaining({ port: 15432, entries: 1 }));
    expect(await db.select().from(databasePublicAccess)).toHaveLength(0);
  });

  it('another database’s port is a 409 before anything runs', async () => {
    await db.insert(databasePublicAccess).values({ databaseId: myId, publicPort: 15432, ipAllowlist: ['10.0.0.0/8'] });
    const res = await (await app()).inject({ method: 'PUT', url: `/${pgId}/public-access`, headers: operator, payload: body });
    expect(res.statusCode).toBe(409);
    expect(h.runs).toBe(0);
    expect(auditMock.audit).not.toHaveBeenCalled();
  });

  it('a Docker failure becomes a 400 with its message', async () => {
    h.dockerDown = true;
    const res = await (await app()).inject({ method: 'PUT', url: `/${pgId}/public-access`, headers: operator, payload: body });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'public_access_failed', message: expect.stringMatching(/Cannot connect/) });
    expect(auditMock.audit).toHaveBeenCalledWith(expect.anything(), 1, 'database.public_access.apply_failed', 'pg', expect.anything());
  });
});

describe('DELETE /:id/public-access', () => {
  it('is operator-only', async () => {
    const res = await (await app()).inject({ method: 'DELETE', url: `/${pgId}/public-access`, headers: member(ADMIN) });
    expect(res.statusCode).toBe(403);
  });

  it('is a no-op without configuration, and disables (keeping the configuration) with one', async () => {
    const a = await app();
    const none = await a.inject({ method: 'DELETE', url: `/${pgId}/public-access`, headers: operator });
    expect(none.json()).toEqual({ ok: true });
    expect(auditMock.audit).not.toHaveBeenCalled();
    await a.inject({ method: 'PUT', url: `/${pgId}/public-access`, headers: operator, payload: body });
    const res = await a.inject({ method: 'DELETE', url: `/${pgId}/public-access`, headers: operator });
    expect(res.json()).toEqual({ ok: true });
    expect(h.running.has('nd-dbpub-pg')).toBe(false);
    expect(auditMock.audit).toHaveBeenLastCalledWith(expect.anything(), 1, 'database.public_access.disable', 'pg', { databaseId: pgId, port: 15432, wasEnabled: true });
    const get = await a.inject({ method: 'GET', url: `/${pgId}/public-access`, headers: operator });
    expect(get.json()).toMatchObject({ configured: true, enabled: false, status: 'off', port: 15432 });
  });
});

describe('databases module additions (M7)', () => {
  async function dbApp() {
    const a = await buildTestApp({ db });
    await a.register(databasePublicAccessRoutes);
    await a.register(databasesRoutes, { prefix: '/databases' });
    return a;
  }

  it('serialize carries publicAccess: null when unconfigured, {enabled, port} once configured', async () => {
    const a = await dbApp();
    const before = await a.inject({ method: 'GET', url: `/databases/${pgId}`, headers: operator });
    expect(before.json().publicAccess).toBeNull();
    await a.inject({ method: 'PUT', url: `/${pgId}/public-access`, headers: operator, payload: body });
    expect((await a.inject({ method: 'GET', url: `/databases/${pgId}`, headers: operator })).json().publicAccess).toEqual({ enabled: true, port: 15432 });
    const list = (await a.inject({ method: 'GET', url: '/databases', headers: operator })).json() as Array<{ id: number; publicAccess: unknown }>;
    expect(list.find((d) => d.id === pgId)?.publicAccess).toEqual({ enabled: true, port: 15432 });
    expect(list.find((d) => d.id === chId)?.publicAccess).toBeNull();
  });

  it('credentials gain publicConnectionString (null while off; sslmode=require for postgres terminate)', async () => {
    const a = await dbApp();
    const off = await a.inject({ method: 'GET', url: `/databases/${pgId}/credentials`, headers: operator });
    expect(off.statusCode).toBe(200);
    expect(off.json().publicConnectionString).toBeNull();
    expect(off.json().connectionString).toContain('@nd-db-pg:5432/app');

    await a.inject({ method: 'PUT', url: `/${pgId}/public-access`, headers: operator, payload: body });
    const plain = await a.inject({ method: 'GET', url: `/databases/${pgId}/credentials`, headers: operator });
    expect(plain.json().publicConnectionString).toBe('postgres://nine:s3cret@panel.example.test:15432/app');

    await a.inject({ method: 'PUT', url: `/${pgId}/public-access`, headers: operator, payload: { ...body, tlsMode: 'terminate', tlsHostname: 'db.example.com' } });
    const tls = await a.inject({ method: 'GET', url: `/databases/${pgId}/credentials`, headers: operator });
    expect(tls.json().publicConnectionString).toBe('postgres://nine:s3cret@db.example.com:15432/app?sslmode=require');

    await a.inject({ method: 'DELETE', url: `/${pgId}/public-access`, headers: operator });
    expect((await a.inject({ method: 'GET', url: `/databases/${pgId}/credentials`, headers: operator })).json().publicConnectionString).toBeNull();
  });

  it.each([
    ['redis', 'none', /^redis:\/\/:s3cret@panel\.example\.test:16379$/],
    ['redis', 'terminate', /^rediss:\/\/:s3cret@panel\.example\.test:16379$/],
    ['valkey', 'terminate', /^valkeys:\/\//],
    ['mongo', 'terminate', /^mongodb:\/\/nine:s3cret@panel\.example\.test:16379\/\?tls=true$/],
    ['mysql', 'none', /^mysql:\/\/root:s3cret@panel\.example\.test:16379\/app$/],
  ])('%s with tlsMode %s', async (engine, tlsMode, expected) => {
    const [row] = await db
      .insert(databases)
      .values({ name: `e-${engine}-${tlsMode}`, slug: `e-${engine}-${tlsMode}`, engine: engine as 'redis', status: 'running', passwordEncrypted: encrypt('s3cret') })
      .returning();
    await db.insert(databasePublicAccess).values({ databaseId: row!.id, enabled: true, publicPort: 16379, tlsMode: tlsMode as 'none', ipAllowlist: ['10.0.0.0/8'] });
    const res = await (await dbApp()).inject({ method: 'GET', url: `/databases/${row!.id}/credentials`, headers: operator });
    expect(res.json().publicConnectionString).toMatch(expected);
  });
});
