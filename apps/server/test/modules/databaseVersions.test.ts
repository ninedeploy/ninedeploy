import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, databases, databaseUpgrades, type DB, runMigrations, users } from '@ninedeploy/db';
import { buildTestApp } from '../helpers.js';

/**
 * N12: the routes that show and name the release of a database without a
 * version (modules/databaseVersions.ts), and the first Start on a name, the
 * trial in the Start route (modules/databases.ts): over a real migrated
 * SQLite, with Docker's answers injected where the version pin and the trial
 * take them, and the engine swapped for a runtime that records.
 */
const audit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../src/lib/audit.js', () => ({ audit }));

const runtime = vi.hoisted(() => ({
  calls: [] as string[],
  fake: (name: string) => ({
    where: 'panel' as const,
    start: vi.fn(async () => { runtime.calls.push(`start ${name}`); }),
    stop: vi.fn(async () => { runtime.calls.push(`stop ${name}`); }),
    restart: vi.fn(async () => { runtime.calls.push(`restart ${name}`); }),
    logs: vi.fn(async () => []),
    size: vi.fn(async () => 0),
    backup: vi.fn(async () => undefined),
    restore: vi.fn(async () => undefined),
    import: vi.fn(async () => undefined),
    probeCredentials: vi.fn(async () => true),
    probeMysqlSandboxFlag: vi.fn(async () => null),
    adoptRetainedVolume: vi.fn(async () => ({ action: 'none' }) as never),
    attachToServiceBridges: vi.fn(async () => undefined),
  }),
}));
vi.mock('../../src/lib/databaseRuntime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/databaseRuntime.js')>()),
  databaseRuntime: vi.fn((_db: unknown, d: { containerName: string | null }) => runtime.fake(d.containerName ?? '?')),
}));

const { versionPinDeps } = await import('../../src/lib/databaseVersionPin.js');
const version = await import('../../src/lib/databaseVersion.js');
const { databaseVersionRoutes } = await import('../../src/modules/databaseVersions.js');
const { databasesRoutes } = await import('../../src/modules/databases.js');

let db: DB;
const real = { ...versionPinDeps };
const realTrial = { ...version.namedVersionDeps };

/** Docker's answers: no container, a volume created by `image`. */
function docker(over: Partial<typeof versionPinDeps> = {}) {
  Object.assign(versionPinDeps, {
    containerImage: async () => ({ exists: false }),
    volumeImage: async () => ({ exists: true, image: 'mysql:8.0' }),
    ...over,
  } satisfies Partial<typeof versionPinDeps>);
}

/** The trial's view of the container, on a clock that does not wait. */
function trial(state: version.ContainerState | null) {
  let now = Date.parse('2026-11-28T03:00:00Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  Object.assign(version.namedVersionDeps, { containerState: async () => state, sleep: async (ms: number) => { now += Math.max(0, ms); } } satisfies version.NamedVersionDeps);
}

beforeEach(async () => {
  audit.mockClear();
  runtime.calls.length = 0;
  Object.assign(versionPinDeps, real);
  Object.assign(version.namedVersionDeps, realTrial);
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'x', isOperator: true } as never);
  await db.insert(databases).values({
    id: 10, ownerUserId: 1, name: 'orders', slug: 'orders', engine: 'mysql', status: 'stopped', version: null,
    containerName: 'nd-db-orders', volumeName: 'nd-db-orders-data', passwordEncrypted: 'x',
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function app() {
  const a = await buildTestApp({ db });
  await a.register(databaseVersionRoutes, { prefix: '/v1/databases' });
  await a.register(databasesRoutes, { prefix: '/v1/databases' });
  await a.ready();
  return a;
}
const as = { 'x-test-user': '1', 'x-test-operator': 'true' };
const get = (a: Awaited<ReturnType<typeof app>>, headers = as) => a.inject({ method: 'GET', url: '/v1/databases/10/version', headers });
const put = (a: Awaited<ReturnType<typeof app>>, payload: unknown, headers = as) => a.inject({ method: 'PUT', url: '/v1/databases/10/version', headers, payload });
const start = (a: Awaited<ReturnType<typeof app>>) => a.inject({ method: 'POST', url: '/v1/databases/10/start', headers: as });
const row = async () => (await db.query.databases.findFirst({ where: eq(databases.id, 10) }))!;
const named = async (version: string) => {
  await db.update(databases).set({ version, versionNamedAt: new Date('2026-11-27T02:00:00Z') }).where(eq(databases.id, 10));
};

describe('database version routes', () => {
  it('GET shows what is known about the release such a row runs; PUT names it, audits it, and the name stays open until the server has run on it', async () => {
    docker();
    const a = await app();
    expect((await get(a)).json()).toEqual({
      databaseId: 10, version: null, namedAt: null, canSet: true, why: null, creationImage: 'mysql:8.0', defaultImage: 'mysql:9.7', defaultTag: '9.7',
      containerImage: null, ambiguous: true, choices: ['8.0', '8.4', '9.7'],
    });

    const set = await put(a, { version: '8.0' });
    expect(set.statusCode).toBe(200);
    const first = await row();
    expect(first).toMatchObject({ version: '8.0', status: 'stopped' });
    expect(first.versionNamedAt).toBeInstanceOf(Date);
    expect(set.json()).toMatchObject({ databaseId: 10, version: '8.0', namedAt: first.versionNamedAt!.toISOString(), canSet: true, why: null });
    await vi.waitFor(() => expect(audit).toHaveBeenCalledWith(db, 1, 'database.version_set', 'orders', { databaseId: 10, version: '8.0' }));

    // Named by hand, not run on yet: it may be changed, and the change is audited with what it replaced.
    const changed = await put(a, { version: '8.4' });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ version: '8.4', canSet: true });
    expect((await row()).version).toBe('8.4');
    await vi.waitFor(() => expect(audit).toHaveBeenLastCalledWith(db, 1, 'database.version_set', 'orders', { databaseId: 10, version: '8.4', replaced: '8.0' }));
    expect((await get(a)).json()).toMatchObject({ version: '8.4', canSet: true });
  });

  it('refuses a body that is not a release tag, a release outside the list, and an upgrade running', async () => {
    docker();
    await db.insert(databaseUpgrades).values({
      databaseId: 10, engine: 'mysql', fromMajor: 8, toMajor: 9, targetVersion: '9.7', fromImage: 'mysql:8.0', toImage: 'mysql:9.7',
      previousVolume: 'nd-db-orders-data', targetVolume: 'nd-db-orders-data-u1', status: 'running', phase: 'dump',
    });
    const a = await app();
    const during = await put(a, { version: '8.0' });
    expect(during.statusCode).toBe(409);
    expect(during.json().error.message).toContain('major upgrade');
    await db.delete(databaseUpgrades).where(eq(databaseUpgrades.databaseId, 10));

    for (const payload of [{ version: 'latest' }, { version: '' }]) {
      const res = await put(a, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      expect(res.json().error.message, JSON.stringify(payload)).toBe('A release tag, such as 18, 8.4 or 11.8');
    }
    // The shape refuses what is missing, not a tag, or more than a tag, before the list is consulted.
    for (const payload of [{}, { version: 8 }, { version: '8.0', engine: 'mysql' }]) {
      expect((await put(a, payload)).statusCode, JSON.stringify(payload)).toBe(422);
    }
    expect((await a.inject({ method: 'PUT', url: '/v1/databases/10/version', headers: as })).statusCode).toBe(422);
    const outside = await put(a, { version: '8.3' });
    expect(outside.statusCode).toBe(422);
    expect(outside.json().error.code).toBe('database_version_choice');
    expect(outside.json().error.message).toBe('"8.3" is not a release this database may be given. Choose one of: 8.0, 8.4, 9.7.');
    expect((await row()).version).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it('a row whose container exists is shown, not named: the pin reads the container at the next boot', async () => {
    docker({ containerImage: async () => ({ exists: true, image: 'mysql:8.4' }) });
    const a = await app();
    expect((await get(a)).json()).toMatchObject({ canSet: false, containerImage: 'mysql:8.4', why: 'Its container exists: the panel pins the release it runs at its next boot.' });
    const res = await put(a, { version: '8.0' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toEqual({ code: 'database_version_set', message: 'Its container exists: the panel pins the release it runs at its next boot.' });
    expect((await row()).version).toBeNull();
  });

  it('the database of another id, and a caller without a user', async () => {
    docker();
    const a = await app();
    expect((await a.inject({ method: 'GET', url: '/v1/databases/999/version', headers: as })).statusCode).toBe(404);
    expect((await a.inject({ method: 'PUT', url: '/v1/databases/999/version', headers: as, payload: { version: '8.0' } })).statusCode).toBe(404);
    expect((await get(a, {})).statusCode).toBe(401);
    expect((await put(a, { version: '8.0' }, {})).statusCode).toBe(401);
  });
});

describe('the first Start on a named release', () => {
  it('is a trial: a server that does not stay up is undone and the start refused, with the name still open and the row as it was', async () => {
    await named('8.0');
    trial({ state: 'restarting', restarts: 0 });
    const a = await app();
    const res = await start(a);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('database_version_named');
    expect(res.json().error.message).toContain('The server did not stay up on mysql:8.0');
    expect(runtime.calls).toEqual(['start nd-db-orders', 'stop nd-db-orders']);
    expect(await row()).toMatchObject({ status: 'stopped', version: '8.0' });
    expect((await row()).versionNamedAt).toBeInstanceOf(Date);
    expect((await get(a)).json()).toMatchObject({ canSet: true, why: null });
    expect((await put(a, { version: '8.4' })).statusCode).toBe(200);
    expect((await row()).version).toBe('8.4');
  });

  it('one that stays up makes the name the database\u2019s version; a row not named by hand starts as before', async () => {
    await named('8.0');
    trial({ state: 'running', restarts: 0 });
    const a = await app();
    expect((await start(a)).json()).toEqual({ ok: true });
    expect(await row()).toMatchObject({ status: 'running', version: '8.0' });
    expect((await row()).versionNamedAt).toBeNull();
    expect(runtime.calls).toEqual(['start nd-db-orders']);
    // Run on: the row's version now, like any other.
    const res = await put(a, { version: '8.4' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('This database already has a version.');

    // Without a name by hand nothing is watched, and the row stays without a version.
    await db.update(databases).set({ version: null, status: 'stopped' }).where(eq(databases.id, 10));
    expect((await start(a)).json()).toEqual({ ok: true });
    expect(runtime.calls).toEqual(['start nd-db-orders', 'start nd-db-orders']);
    expect(await row()).toMatchObject({ status: 'running', version: null });
  });
});
