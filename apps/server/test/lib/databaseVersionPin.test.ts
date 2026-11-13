import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, databases, databaseUpgrades, type DB, runMigrations, servers, users } from '@ninedeploy/db';

vi.mock('../../src/lib/exec.js', async (orig) => ({ ...(await orig<typeof import('../../src/lib/exec.js')>()), capture: vi.fn() }));
const { capture } = await import('../../src/lib/exec.js');
const { defaultVersionTag, DRAGONFLY_DEFAULT_VERSION, ENGINES, versionForImage } = await import('../../src/engine/database.js');
const { pinUnversionedDatabases, versionPinDeps } = await import('../../src/lib/databaseVersionPin.js');
type ContainerImage = import('../../src/lib/databaseVersionPin.js').ContainerImage;
type VersionPinDeps = import('../../src/lib/databaseVersionPin.js').VersionPinDeps;

/**
 * A row without a version follows the engine default, which moves with
 * releases; a moved default would upgrade the old data in place on the next
 * recreate. New rows get the tag at create; older rows get the tag their
 * container runs at boot. Real migrated SQLite, Docker faked.
 */

let db: DB;
let nextId = 1;

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 7, email: 'owner@example.com', passwordHash: 'x' });
  nextId = 1;
});

async function row(engine: string, fields: Record<string, unknown> = {}) {
  const id = nextId++;
  const slug = `db${id}`;
  await db.insert(databases).values({
    id, ownerUserId: 7, name: slug, slug, engine, status: 'running', version: null,
    containerName: `nd-db-${slug}`, volumeName: `nd-db-${slug}-data`, passwordEncrypted: 'x', ...fields,
  } as never);
  return id;
}

const versionOf = async (id: number) => (await db.query.databases.findFirst({ where: eq(databases.id, id) }))!.version;

function docker(images: Record<string, ContainerImage | Error>): VersionPinDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    containerImage: vi.fn(async (name: string) => {
      asked.push(name);
      const v = images[name];
      if (v instanceof Error) throw v;
      return v ?? { exists: false };
    }),
  };
}

describe('versionForImage / defaultVersionTag', () => {
  it('finds the tag whose image is exactly the given one', () => {
    expect(versionForImage('mysql', 'mysql:8.4')).toBe('8.4');
    expect(versionForImage('postgres', 'postgres:16')).toBe('16');
    expect(versionForImage('postgres', 'pgvector/pgvector:pg18')).toBe('vector');
    expect(versionForImage('dragonfly', `ghcr.io/dragonflydb/dragonfly:${DRAGONFLY_DEFAULT_VERSION}`)).toBe(DRAGONFLY_DEFAULT_VERSION);
    expect(versionForImage('rabbitmq', 'rabbitmq:4-management')).toBe('4-management');
    expect(versionForImage('meilisearch', 'getmeili/meilisearch:v1.53')).toBe('v1.53');
  });

  it('refuses an image of another repository or without a tag', () => {
    expect(versionForImage('mysql', 'mariadb:11.8')).toBeNull();
    expect(versionForImage('mysql', 'mysql')).toBeNull();
    expect(versionForImage('mysql', 'registry.local:5000/mysql')).toBeNull();
    expect(versionForImage('postgres', 'sha256:0123abcd')).toBeNull();
    expect(versionForImage('nope', 'nope:1')).toBeNull();
  });

  it('gives every engine its default tag but KeyDB, whose default depends on the CPU', () => {
    for (const [engine, cfg] of Object.entries(ENGINES)) {
      const tag = defaultVersionTag(engine);
      if (engine === 'keydb') {
        expect(tag).toBeNull();
        continue;
      }
      expect(tag, engine).toBeTruthy();
      expect(cfg.image(tag!), engine).toBe(cfg.image(undefined));
    }
  });
});

describe('versionPinDeps.containerImage (docker inspect)', () => {
  it('reads the image the container runs (not the volume label, which names the image that initialized the data)', async () => {
    vi.mocked(capture).mockResolvedValueOnce('mysql:8.4\n');
    expect(await versionPinDeps.containerImage('nd-db-a')).toEqual({ exists: true, image: 'mysql:8.4' });
    expect(vi.mocked(capture).mock.calls[0]![1]).toEqual(['inspect', '--type', 'container', '--format', '{{.Config.Image}}', 'nd-db-a']);
  });

  it('says a container is missing only when Docker names exactly that container', async () => {
    vi.mocked(capture).mockRejectedValueOnce(new Error('`docker inspect` exited 1: Error: No such container: nd-db-a'));
    expect(await versionPinDeps.containerImage('nd-db-a')).toEqual({ exists: false });
    vi.mocked(capture).mockRejectedValueOnce(new Error('`docker inspect` exited 1: Cannot connect to the Docker daemon at unix:///var/run/docker.sock'));
    await expect(versionPinDeps.containerImage('nd-db-a')).rejects.toThrow('Cannot connect');
    vi.mocked(capture).mockRejectedValueOnce(new Error('`docker inspect` timed out: Error: No such container: nd-db-a'));
    await expect(versionPinDeps.containerImage('nd-db-a')).rejects.toThrow('timed out');
  });
});

describe('pinUnversionedDatabases', () => {
  it('pins a panel-host row to the tag its container runs, not to today’s default', async () => {
    const id = await row('mysql');
    const deps = docker({ [`nd-db-db${id}`]: { exists: true, image: 'mysql:8.4' } });
    expect(await pinUnversionedDatabases(db, deps)).toEqual({ pinned: 1, left: 0 });
    expect(await versionOf(id)).toBe('8.4');
    expect(defaultVersionTag('mysql')).not.toBe('8.4');
  });

  it('pins a row whose container is gone, and a node row, to the default their next start runs', async () => {
    const gone = await row('mariadb');
    await db.insert(servers).values({ id: 4, name: 'edge', host: 'edge.example.test', tokenEncrypted: 'x' });
    const node = await row('redis', { containerName: null, volumeName: null, serverId: 4, nodeContainerName: 'nd-db-n', nodeVolumeName: 'nd-db-n-data' });
    const deps = docker({});
    expect(await pinUnversionedDatabases(db, deps)).toEqual({ pinned: 2, left: 0 });
    expect(await versionOf(gone)).toBe(defaultVersionTag('mariadb'));
    expect(await versionOf(node)).toBe(defaultVersionTag('redis'));
    expect(deps.asked).toEqual([`nd-db-db${gone}`]);
  });

  it('leaves a row when Docker does not answer, when no tag reproduces the image, and a KeyDB row without a container', async () => {
    const down = await row('mysql');
    const odd = await row('postgres');
    const keydbGone = await row('keydb');
    const deps = docker({
      [`nd-db-db${down}`]: new Error('Cannot connect to the Docker daemon'),
      [`nd-db-db${odd}`]: { exists: true, image: 'sha256:0123abcd' },
    });
    expect(await pinUnversionedDatabases(db, deps)).toEqual({ pinned: 0, left: 3 });
    for (const id of [down, odd, keydbGone]) expect(await versionOf(id)).toBeNull();
  });

  it('pins a KeyDB row to the per-CPU tag its container runs on this host', async () => {
    const id = await row('keydb');
    const deps = docker({ [`nd-db-db${id}`]: { exists: true, image: 'eqalpha/keydb:x86_64_v6.3.4' } });
    expect(await pinUnversionedDatabases(db, deps)).toEqual({ pinned: 1, left: 0 });
    expect(await versionOf(id)).toBe('x86_64_v6.3.4');
  });

  it('leaves a row whose upgrade is running to upgrade recovery, and never touches a pinned row', async () => {
    const upgrading = await row('mysql');
    await db.insert(databaseUpgrades).values({
      databaseId: upgrading, engine: 'mysql', fromMajor: 8, toMajor: 8, status: 'running', previousVersion: '8.0', targetVersion: '8.4', fromImage: 'mysql:8.0', toImage: 'mysql:8.4',
      previousVolume: `nd-db-db${upgrading}-data`, targetVolume: `nd-db-db${upgrading}-data-u1`,
    } as never);
    const pinned = await row('mysql', { version: '8.0' });
    const deps = docker({ [`nd-db-db${upgrading}`]: { exists: true, image: 'mysql:8.4' }, [`nd-db-db${pinned}`]: { exists: true, image: 'mysql:9.7' } });
    expect(await pinUnversionedDatabases(db, deps)).toEqual({ pinned: 0, left: 1 });
    expect(await versionOf(upgrading)).toBeNull();
    expect(await versionOf(pinned)).toBe('8.0');
    expect(deps.asked).toEqual([]);
  });

  it('pins nothing twice: a second boot finds no row without a version', async () => {
    const id = await row('postgres');
    const deps = docker({ [`nd-db-db${id}`]: { exists: true, image: 'postgres:16' } });
    expect((await pinUnversionedDatabases(db, deps)).pinned).toBe(1);
    expect(await pinUnversionedDatabases(db, deps)).toEqual({ pinned: 0, left: 0 });
    expect(await versionOf(id)).toBe('16');
  });
});
