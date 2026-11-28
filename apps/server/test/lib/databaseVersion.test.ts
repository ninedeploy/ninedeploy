/**
 * N12: the release of a database that has no version, or whose version was
 * named by hand (lib/databaseVersion.ts) against a real migrated SQLite, with
 * Docker's answers injected: the image of a container, the image that created
 * a volume, and the state of the container a named release is tried on.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, databases, servers, type Database, type DB } from '@ninedeploy/db';

const audits = vi.hoisted(() => [] as Array<{ action: string; detail: string; meta: Record<string, unknown> }>);
vi.mock('../../src/lib/audit.js', () => ({
  audit: vi.fn(async (_db: unknown, _actor: unknown, action: string, detail: string, meta: Record<string, unknown> = {}) => { audits.push({ action, detail, meta }); }),
}));
// What `docker inspect` answers is injected; everything else of the shell stays.
vi.mock('../../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/exec.js')>()),
  capture: vi.fn(),
}));

import type { HttpError } from '../../src/lib/errors.js';
import { capture } from '../../src/lib/exec.js';
import {
  KNOWN_RELEASES, NAMED_VERSION_SETTLE_MS, isAmbiguousVersion, legacyVersionStatus, namedVersionDeps, setLegacyVersion, settleNamedVersion, versionChoices, type LegacyVersionStatus,
} from '../../src/lib/databaseVersion.js';
import type { NamedVersionDeps } from '../../src/lib/databaseVersion.js';
import type { VersionPinDeps } from '../../src/lib/databaseVersionPin.js';

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));
let db: DB;
let close: () => void;
let dir: string;

/** Docker's answers: no container, a volume created by `image`. */
function docker(over: Partial<VersionPinDeps> = {}): VersionPinDeps {
  return {
    containerImage: async () => ({ exists: false }),
    volumeImage: async () => ({ exists: true, image: 'mysql:8.0' }),
    ...over,
  };
}

let seq = 0;
/** A stopped MySQL row without a version on the panel host; the first is `shop`, the next `shop2`, … (the slug is unique). */
async function insertDb(over: Partial<typeof databases.$inferInsert> = {}): Promise<Database> {
  const slug = ++seq === 1 ? 'shop' : `shop${seq}`;
  const [row] = await db.insert(databases).values({
    name: 'shop', slug, engine: 'mysql', status: 'stopped', version: null, containerName: `nd-db-${slug}`, volumeName: `nd-db-${slug}-data`,
    username: 'root', passwordEncrypted: 'x', dbName: 'app', ...over,
  }).returning();
  return row!;
}
const reload = async (id: number) => (await db.query.databases.findFirst({ where: eq(databases.id, id) }))!;
const settled = async (p: Promise<unknown>) => p.then(() => null, (e: HttpError) => [e.statusCode, e.code, e.message] as const);
const can = (s: LegacyVersionStatus) => ({ canSet: s.canSet, why: s.why });

beforeEach(async () => {
  audits.length = 0;
  seq = 0;
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-db-version-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
});
afterEach(() => {
  vi.restoreAllMocks();
  close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

describe('the list a row without a version may be given', () => {
  it('is the engine\u2019s known releases, then the tag of the image that created the volume and the default when they are not among them', () => {
    expect(versionChoices('mysql', '8.0')).toEqual(['8.0', '8.4', '9.7']);
    // A volume created by a release the list does not know (an image tag that was dropped) still offers it.
    expect(versionChoices('mysql', '8.3')).toEqual(['8.0', '8.4', '9.7', '8.3']);
    expect(versionChoices('postgres', null)).toEqual(['14', '15', '16', '17', '18']);
    expect(Object.keys(KNOWN_RELEASES).sort()).toEqual(['mariadb', 'mongo', 'mysql', 'postgres']);
  });

  it('for an engine without a known list, the image that created the volume and the default', () => {
    expect(versionChoices('redis', '7.2')).toEqual(['7.2', '8.8']);
    expect(versionChoices('redis', '8.8')).toEqual(['8.8']);
    // KeyDB's default depends on the host: only what created the volume.
    expect(versionChoices('keydb', '6.6')).toEqual(['6.6']);
    expect(versionChoices('keydb', null)).toEqual([]);
  });

  it('a volume created by another image than the default is what makes a Start an in-place upgrade', () => {
    expect(isAmbiguousVersion('mysql:8.0', '9.7', 'mysql')).toBe(true);
    expect(isAmbiguousVersion('mysql:9.7', '9.7', 'mysql')).toBe(false);
    // No volume, or one that says nothing: nothing is known, so nothing is claimed.
    expect(isAmbiguousVersion(null, '9.7', 'mysql')).toBe(false);
    expect(isAmbiguousVersion('some/unrecorded:tag', '9.7', 'mysql')).toBe(true);
  });
});

describe('what is known about the release such a row runs', () => {
  it('a stopped row whose volume another image created: ambiguous, and the release may be named', async () => {
    const s = await legacyVersionStatus(await insertDb(), docker());
    expect(s).toMatchObject({
      version: null, canSet: true, why: null, creationImage: 'mysql:8.0', defaultImage: 'mysql:9.7', defaultTag: '9.7', containerImage: null, ambiguous: true, choices: ['8.0', '8.4', '9.7'],
    });
  });

  it('a volume the default image created is the case the version pin takes: not ambiguous, still nameable', async () => {
    const s = await legacyVersionStatus(await insertDb(), docker({ volumeImage: async () => ({ exists: true, image: 'mysql:9.7' }) }));
    expect(s).toMatchObject({ canSet: true, ambiguous: false, creationImage: 'mysql:9.7' });
    // No volume at all: a Start would begin with empty data.
    expect(await legacyVersionStatus(await insertDb(), docker({ volumeImage: async () => ({ exists: false }) }))).toMatchObject({ canSet: true, ambiguous: false, creationImage: null });
    // A volume that says nothing about its image: the row is nameable from the known releases.
    expect(await legacyVersionStatus(await insertDb(), docker({ volumeImage: async () => ({ exists: true, image: '' }) }))).toMatchObject({ canSet: true, ambiguous: false, creationImage: null, choices: ['8.0', '8.4', '9.7'] });
  });

  it('a row with a version, a node row, a row whose container exists, or one still being created: nothing to name, and it says why', async () => {
    expect(can(await legacyVersionStatus(await insertDb({ version: '8.0' }), docker()))).toEqual({ canSet: false, why: 'This database already has a version.' });
    const [node] = await db.insert(servers).values({ name: 'edge', host: '198.51.100.3', tokenEncrypted: 'x' }).returning();
    expect(can(await legacyVersionStatus(await insertDb({ serverId: node!.id, containerName: null, volumeName: null }), docker()))).toEqual({ canSet: false, why: 'A database on a node takes the default release; the panel pins it at its next start.' });
    expect(can(await legacyVersionStatus(await insertDb({ containerName: null }), docker()))).toEqual({ canSet: false, why: 'This database has no container on the panel host.' });
    // The container says what it runs: the pin reads it at the panel's next boot, so it is not touched.
    const running = await legacyVersionStatus(await insertDb(), docker({ containerImage: async () => ({ exists: true, image: 'mysql:8.4' }) }));
    expect(can(running)).toEqual({ canSet: false, why: 'Its container exists: the panel pins the release it runs at its next boot.' });
    expect(running.containerImage).toBe('mysql:8.4');
    expect(can(await legacyVersionStatus(await insertDb({ status: 'creating' }), docker()))).toEqual({ canSet: false, why: 'The database is still being created.' });
    // A row marked running whose container is gone (it died) is stopped in fact: nameable, since its next Start is the one in question.
    expect((await legacyVersionStatus(await insertDb({ status: 'running' }), docker())).canSet).toBe(true);
  });

  it('when Docker cannot answer, nothing is claimed and nothing may be named', async () => {
    const container = await insertDb();
    expect(can(await legacyVersionStatus(container, docker({ containerImage: async () => { throw new Error('Cannot connect to the Docker daemon'); } })))).toEqual({ canSet: false, why: `Docker did not answer for ${container.containerName}.` });
    const volume = await insertDb();
    expect(can(await legacyVersionStatus(volume, docker({ volumeImage: async () => { throw new Error('Cannot connect to the Docker daemon'); } })))).toEqual({ canSet: false, why: `Docker did not answer for volume ${volume.volumeName}.` });
  });

  it('an engine whose default depends on the host, and a volume that says nothing: no list, so no name', async () => {
    const [row] = await db.insert(databases).values({ name: 'cache', slug: 'cache', engine: 'keydb', status: 'stopped', containerName: 'nd-db-cache', volumeName: 'nd-db-cache-data', passwordEncrypted: 'x' }).returning();
    expect(can(await legacyVersionStatus(row!, docker({ volumeImage: async () => ({ exists: true, image: '' }) })))).toEqual({
      canSet: false,
      why: 'The keydb default depends on the host, and nothing says which release created the volume.',
    });
  });
});

describe('naming the release before the first start', () => {
  it('writes the version to a row that has none, from its list, audits it, and leaves the name provisional', async () => {
    const d = await insertDb();
    const after = await setLegacyVersion(db, d, '8.0', 7, docker());
    const row = await reload(d.id);
    expect(row).toMatchObject({ version: '8.0', status: 'stopped' });
    expect(row.versionNamedAt).toBeInstanceOf(Date);
    // Provisional until the server has run on it: the first start may refuse it, and then it can be changed.
    expect(after).toMatchObject({ version: '8.0', namedAt: row.versionNamedAt!.toISOString(), canSet: true, why: null, ambiguous: false });
    expect(audits).toEqual([{ action: 'database.version_set', detail: 'shop', meta: { databaseId: d.id, version: '8.0' } }]);
  });

  it('a provisional name may be changed, whatever container was made from it; one the server ran on may not', async () => {
    const ago = new Date('2026-11-27T03:00:00Z');
    const named = await insertDb({ version: '8.0', versionNamedAt: ago, status: 'error' });
    // The container of the start that failed is still there: it was made from the name, and says nothing new.
    const s = await legacyVersionStatus(named, docker({ containerImage: async () => ({ exists: true, image: 'mysql:8.0' }) }));
    expect(s).toMatchObject({ version: '8.0', namedAt: ago.toISOString(), canSet: true, why: null, containerImage: null, creationImage: 'mysql:8.0', choices: ['8.0', '8.4', '9.7'] });
    const again = await setLegacyVersion(db, named, '8.4', 7, docker());
    expect(await reload(named.id)).toMatchObject({ version: '8.4', status: 'error' });
    expect((await reload(named.id)).versionNamedAt!.getTime()).toBeGreaterThan(ago.getTime());
    expect(again.version).toBe('8.4');
    expect(audits).toEqual([{ action: 'database.version_set', detail: 'shop', meta: { databaseId: named.id, version: '8.4', replaced: '8.0' } }]);
    expect(await settled(setLegacyVersion(db, await insertDb({ version: '8.4', status: 'error' }), '8.0', 7, docker()))).toEqual([409, 'database_version_set', 'This database already has a version.']);
    // Docker not answering for the volume does not stop a change: the known releases are still a list.
    expect((await legacyVersionStatus(named, docker({ volumeImage: async () => { throw new Error('daemon down'); } }))).choices).toEqual(['8.0', '8.4', '9.7']);
  });

  it('while the start on a named release runs, the name is not touched', async () => {
    const ago = new Date('2026-11-27T03:00:00Z');
    const trialled = await insertDb({ version: '8.0', versionNamedAt: ago, status: 'running' });
    expect(await settled(setLegacyVersion(db, trialled, '8.4', 7, docker()))).toEqual([409, 'database_version_set', 'The database is starting on the named release; wait until it is up, or has failed.']);
    expect(await settled(setLegacyVersion(db, await insertDb({ version: '8.0', versionNamedAt: ago, status: 'creating' }), '8.4', 7, docker()))).toEqual([409, 'database_version_set', 'The database is still being created.']);
    expect((await reload(trialled.id)).version).toBe('8.0');
    expect(audits).toEqual([]);
  });

  it('keeps a name the server ran on meanwhile', async () => {
    const ago = new Date('2026-11-27T03:00:00Z');
    const named = await insertDb({ version: '8.0', versionNamedAt: ago });
    const racing = docker({
      volumeImage: async () => {
        await db.update(databases).set({ versionNamedAt: null }).where(eq(databases.id, named.id));
        return { exists: true, image: 'mysql:8.0' };
      },
    });
    await expect(setLegacyVersion(db, named, '8.4', 7, racing)).rejects.toMatchObject({ statusCode: 409, code: 'database_version_set', message: 'The database ran on its named release meanwhile; it is its version now.' });
    expect((await reload(named.id)).version).toBe('8.0');
    expect(audits).toEqual([]);
  });

  it('refuses a release outside the list, a row that has a version, and one whose container exists', async () => {
    const d = await insertDb();
    expect(await settled(setLegacyVersion(db, d, '8.3', 7, docker()))).toEqual([422, 'database_version_choice', '"8.3" is not a release this database may be given. Choose one of: 8.0, 8.4, 9.7.']);
    expect(await settled(setLegacyVersion(db, d, 'latest', 7, docker()))).toEqual([422, 'database_version_choice', expect.stringContaining('Choose one of')]);
    expect((await reload(d.id)).version).toBeNull();
    expect(await settled(setLegacyVersion(db, await insertDb({ version: '8.4' }), '8.0', 7, docker()))).toEqual([409, 'database_version_set', 'This database already has a version.']);
    const [gone] = await db.insert(databases).values({ name: 'gone', slug: 'gone', engine: 'mysql', status: 'stopped', containerName: 'nd-db-gone', volumeName: 'nd-db-gone-data', passwordEncrypted: 'x' }).returning();
    await db.delete(databases).where(eq(databases.id, gone!.id));
    expect(await settled(setLegacyVersion(db, gone!, '8.0', 7, docker()))).toEqual([409, 'conflict', 'The database is gone.']);
  });

  it('keeps a version the row was given meanwhile', async () => {
    const d = await insertDb();
    // Docker's answer takes a moment; in that moment the row is given a version by someone else.
    const racing = docker({
      volumeImage: async () => {
        await db.update(databases).set({ version: '8.4' }).where(eq(databases.id, d.id));
        return { exists: true, image: 'mysql:8.0' };
      },
    });
    await expect(setLegacyVersion(db, d, '8.0', 7, racing)).rejects.toMatchObject({ statusCode: 409, code: 'database_version_set', message: 'The database was given a version meanwhile; reload the page.' });
    expect((await reload(d.id)).version).toBe('8.4');
    expect(audits).toEqual([]);
  });
});

describe('the trial of a named release', () => {
  /** A clock the trial runs on without waiting: each sleep moves it forward. */
  function clock(): Pick<NamedVersionDeps, 'sleep'> {
    let now = Date.parse('2026-11-28T03:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    return { sleep: async (ms) => { now += Math.max(0, ms); } };
  }
  const named = (over: Partial<typeof databases.$inferInsert> = {}) => insertDb({ version: '8.0', versionNamedAt: new Date('2026-11-27T02:00:00Z'), ...over });

  it('a container that stays up without a restart makes the name the row\u2019s version', async () => {
    const d = await named();
    let samples = 0;
    const stops: string[] = [];
    const logs: string[] = [];
    await settleNamedVersion(db, d, async () => { stops.push('stop'); }, (line) => logs.push(line), {
      containerState: async (name) => { samples++; expect(name).toBe(d.containerName); return { state: 'running', restarts: 0 }; },
      ...clock(),
    });
    expect(await reload(d.id)).toMatchObject({ version: '8.0', versionNamedAt: null, status: 'stopped' });
    expect(stops).toEqual([]);
    // Watched for the whole window, once a second.
    expect(samples).toBe(NAMED_VERSION_SETTLE_MS / 1000 + 1);
    expect(logs.at(-1)).toContain("mysql:8.0 stayed up: the named release is the database's version");
  });

  it('one the server does not stay up in is removed and the start is refused with the reason; the row is left as it was', async () => {
    for (const broken of [{ state: 'restarting', restarts: 0 }, { state: 'running', restarts: 1 }, { state: 'exited', restarts: 1 }, null]) {
      const d = await named();
      let samples = 0;
      const stops: string[] = [];
      const logs: string[] = [];
      const result = await settled(settleNamedVersion(db, d, async (line) => { stops.push(line); }, (line) => logs.push(line), {
        containerState: async () => (++samples < 3 ? { state: 'running', restarts: 0 } : broken),
        ...clock(),
      }));
      expect(result, JSON.stringify(broken)).toEqual([
        409,
        'database_version_named',
        'The server did not stay up on mysql:8.0: this data does not run on that release. Name another release for the database, then start it again.',
      ]);
      // The name stays open, so it can be changed. Nothing else is written: a row put in error would go through the
      // retained-volume gate at its next Start, which is for brand-new rows.
      expect(await reload(d.id)).toMatchObject({ status: 'stopped', version: '8.0', versionNamedAt: d.versionNamedAt });
      expect(stops).toHaveLength(1);
      expect(samples).toBe(3);
    }
  });

  it('confirms only the name that ran', async () => {
    const d = await named();
    await settleNamedVersion(db, d, async () => undefined, () => undefined, {
      containerState: async () => {
        // Another name is written while the trial runs: it is not the one that ran.
        await db.update(databases).set({ version: '8.4' }).where(eq(databases.id, d.id));
        return { state: 'running', restarts: 0 };
      },
      ...clock(),
    });
    expect(await reload(d.id)).toMatchObject({ version: '8.4', versionNamedAt: d.versionNamedAt });
  });

  it("asks Docker for the container's state the way the trial reads it, and has nothing when Docker does not answer", async () => {
    const inspect = vi.mocked(capture);
    inspect.mockReset();
    inspect.mockResolvedValueOnce('running 0\n');
    expect(await namedVersionDeps.containerState('nd-db-shop')).toEqual({ state: 'running', restarts: 0 });
    inspect.mockResolvedValueOnce('  restarting 3 \n');
    expect(await namedVersionDeps.containerState('nd-db-shop')).toEqual({ state: 'restarting', restarts: 3 });
    inspect.mockRejectedValueOnce(new Error('Cannot connect to the Docker daemon'));
    expect(await namedVersionDeps.containerState('nd-db-shop')).toBeNull();
    expect(inspect).toHaveBeenCalledWith('docker', ['inspect', 'nd-db-shop', '--format', '{{.State.Status}} {{.RestartCount}}'], { timeoutMs: 30_000 });
    await namedVersionDeps.sleep(1);
  });
});
