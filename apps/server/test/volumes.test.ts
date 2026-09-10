import { beforeEach, describe, expect, it, vi } from 'vitest';
import { volumeRoutes } from '../src/modules/volumes.js';
import { asUser, buildTestApp, createFakeDb, dbRow, svcRow } from './helpers.js';

const execMocks = vi.hoisted(() => ({ capture: vi.fn() }));
const dbEngineMocks = vi.hoisted(() => ({
  removeVolume: vi.fn(async (_n: string, log: (l: string) => void) => { log('deleting'); }),
  volumeLabels: vi.fn(async (_n: string) => ({}) as Record<string, string>),
}));

vi.mock('../src/lib/exec.js', () => execMocks);
const volFilesMocks = vi.hoisted(() => ({
  listVolumeDir: vi.fn(),
  readVolumeFile: vi.fn(),
  writeVolumeFile: vi.fn(),
  makeVolumeDir: vi.fn(),
  deleteVolumePath: vi.fn(),
}));
vi.mock('../src/engine/volumeFiles.js', () => ({
  ...volFilesMocks,
  isManagedVolume: (n: string) => /^nd-(svc|db)-[a-z0-9-]+$/.test(n),
  safeRelPath: (input: string) => {
    if (input.includes('\n') || input.includes('\0')) return null;
    const parts: string[] = [];
    for (const seg of input.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (!parts.length) return null; parts.pop(); continue; }
      parts.push(seg);
    }
    return parts.join('/');
  },
}));
vi.mock('../src/engine/database.js', () => dbEngineMocks);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('volume routes', () => {
  describe('file manager', () => {
    it('lists a directory inside a volume', async () => {
      volFilesMocks.listVolumeDir.mockResolvedValue([
        { name: 'data', type: 'dir', sizeBytes: 4096, modifiedAt: null },
        { name: 'app.env', type: 'file', sizeBytes: 42, modifiedAt: null },
      ]);
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(volumeRoutes);
      const res = await app.inject({ method: 'GET', url: '/nd-svc-web-data/files?path=configs', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        path: 'configs',
        entries: [
          { name: 'data', type: 'dir', sizeBytes: 4096, modifiedAt: null },
          { name: 'app.env', type: 'file', sizeBytes: 42, modifiedAt: null },
        ],
      });
      expect(volFilesMocks.listVolumeDir).toHaveBeenCalledWith('nd-svc-web-data', 'configs');
    });

    it('defaults to the volume root when no path is given', async () => {
      volFilesMocks.listVolumeDir.mockResolvedValue([]);
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(volumeRoutes);
      const res = await app.inject({ method: 'GET', url: '/nd-svc-web-data/files', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ path: '', entries: [] });
      expect(volFilesMocks.listVolumeDir).toHaveBeenCalledWith('nd-svc-web-data', '');
    });

    it('refuses non-managed volume names and escaping paths', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(volumeRoutes);
      const bad1 = await app.inject({ method: 'GET', url: '/etc/files', headers: asUser() });
      expect(bad1.statusCode).toBe(400);
      const bad2 = await app.inject({ method: 'GET', url: '/nd-svc-web-data/files?path=../../etc', headers: asUser() });
      expect(bad2.statusCode).toBe(400);
      expect(volFilesMocks.listVolumeDir).not.toHaveBeenCalled();
    });

    it('reads a file as base64', async () => {
      volFilesMocks.readVolumeFile.mockResolvedValue({ content: 'aGk=', encoding: 'base64' });
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(volumeRoutes);
      const res = await app.inject({ method: 'GET', url: '/nd-svc-web-data/files/content?path=app.env', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ content: 'aGk=', encoding: 'base64' });
    });

    it('writes a file (base64 body) and creates directories', async () => {
      volFilesMocks.writeVolumeFile.mockImplementation(async (_v: string, _p: string, _c: string, sink: (l: string) => void) => { sink('written'); });
      volFilesMocks.makeVolumeDir.mockResolvedValue(undefined);
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(volumeRoutes);
      const put = await app.inject({
        method: 'PUT',
        url: '/nd-svc-web-data/files',
        headers: asUser(),
        payload: { path: 'configs/app.env', contentBase64: 'aGk=' },
      });
      expect(put.statusCode).toBe(200);
      expect(volFilesMocks.writeVolumeFile).toHaveBeenCalledWith('nd-svc-web-data', 'configs/app.env', 'aGk=', expect.any(Function));
      const mk = await app.inject({
        method: 'POST',
        url: '/nd-svc-web-data/files/dir',
        headers: asUser(),
        payload: { path: 'configs/deep' },
      });
      expect(mk.statusCode).toBe(200);
      expect(volFilesMocks.makeVolumeDir).toHaveBeenCalledWith('nd-svc-web-data', 'configs/deep');
    });

    it('deletes a path inside a volume', async () => {
      volFilesMocks.deleteVolumePath.mockImplementation(async (_v: string, _p: string, sink: (l: string) => void) => { sink('removing'); });
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(volumeRoutes);
      const res = await app.inject({ method: 'DELETE', url: '/nd-svc-web-data/files?path=old', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(volFilesMocks.deleteVolumePath).toHaveBeenCalledWith('nd-svc-web-data', 'old', expect.any(Function));
    });

    it('refuses a missing or root path instead of wiping the volume', async () => {
      // Regression r087: guardPath('') IS the volume root, and the engine's rm
      // target became '/v' — a whole-volume wipe. The missing param and every
      // root-equivalent form must be rejected before any delete runs.
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(volumeRoutes);
      const noPath = await app.inject({ method: 'DELETE', url: '/nd-svc-web-data/files', headers: asUser() });
      expect(noPath.statusCode).toBe(400);
      const slash = await app.inject({ method: 'DELETE', url: '/nd-svc-web-data/files?path=/', headers: asUser() });
      expect(slash.statusCode).toBe(400);
      const dot = await app.inject({ method: 'DELETE', url: '/nd-svc-web-data/files?path=.', headers: asUser() });
      expect(dot.statusCode).toBe(400);
      expect(volFilesMocks.deleteVolumePath).not.toHaveBeenCalled();
      await app.close();
    });

    it('refuses root-equivalent paths for content reads and writes (r088)', async () => {
      // Regression r088 — same root cause as the r087 delete wipe: `''` IS the
      // volume root, so the engine built `test -f '/v'` (exits 1 → capture
      // rejects → 500) and `mkdir -p ''` (fails → run rejects → 500).
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(volumeRoutes);

      const readNoPath = await app.inject({ method: 'GET', url: '/nd-svc-web-data/files/content', headers: asUser() });
      expect(readNoPath.statusCode).toBe(400);
      const readRoot = await app.inject({ method: 'GET', url: '/nd-svc-web-data/files/content?path=/', headers: asUser() });
      expect(readRoot.statusCode).toBe(400);

      const writeRoot = await app.inject({
        method: 'PUT',
        url: '/nd-svc-web-data/files',
        headers: asUser(),
        payload: { path: '/', contentBase64: 'aGk=' },
      });
      expect(writeRoot.statusCode).toBe(400);
      const writeDot = await app.inject({
        method: 'PUT',
        url: '/nd-svc-web-data/files',
        headers: asUser(),
        payload: { path: '.', contentBase64: 'aGk=' },
      });
      expect(writeDot.statusCode).toBe(400);

      expect(volFilesMocks.readVolumeFile).not.toHaveBeenCalled();
      expect(volFilesMocks.writeVolumeFile).not.toHaveBeenCalled();
      await app.close();
    });
  });

  it('lists managed volumes with owners and sizes', async () => {
    execMocks.capture.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'volume') return Promise.resolve('nd-svc-web\nnd-db-pg\nnd-svc-orphan\nnd-db-lonely\n');
      if (args[0] === 'ps') return Promise.resolve(''); // nothing running
      return Promise.resolve('2048 /v\n');
    });
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          services: [svcRow({ id: 1, slug: 'web', name: 'Web' })],
          databases: [dbRow({ id: 2, slug: 'pg', name: 'PG' })],
        },
      }),
    });
    await app.register(volumeRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { name: 'nd-svc-web', sizeBytes: 2048, owner: { id: 1, kind: 'service', name: 'Web' }, inUse: false },
      { name: 'nd-db-pg', sizeBytes: 2048, owner: { id: 2, kind: 'database', name: 'PG', engine: 'postgres' }, inUse: false },
      { name: 'nd-svc-orphan', sizeBytes: 2048, owner: null, inUse: false },
      { name: 'nd-db-lonely', sizeBytes: 2048, owner: null, inUse: false },
    ]);
  });

  it('surfaces the deleted origin of an ownerless labeled volume', async () => {
    execMocks.capture.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'volume') return Promise.resolve('nd-db-lonely\n');
      if (args[0] === 'ps') return Promise.resolve('');
      return Promise.resolve('2048 /v\n');
    });
    dbEngineMocks.volumeLabels.mockImplementation(async (name: string) =>
      name === 'nd-db-lonely'
        ? { 'ninedeploy.managed': 'database', 'ninedeploy.database.name': 'Directus DB', 'ninedeploy.database.engine': 'postgres' }
        : {},
    );
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(volumeRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        name: 'nd-db-lonely',
        sizeBytes: 2048,
        owner: null,
        inUse: false,
        retainedFrom: { name: 'Directus DB', engine: 'postgres' },
      },
    ]);
  });

  it('handles unparseable sizes as zero', async () => {
    execMocks.capture.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'volume') return Promise.resolve('nd-svc-web\n');
      return Promise.resolve('garbage output');
    });
    const app = await buildTestApp({
      db: createFakeDb({ select: { services: [svcRow({ slug: 'web' })] } }),
    });
    await app.register(volumeRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].sizeBytes).toBe(0);
  });

  it('returns an empty list when docker volume ls fails', async () => {
    execMocks.capture.mockRejectedValueOnce(new Error('docker down'));
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(volumeRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('treats a failing size probe as zero', async () => {
    execMocks.capture.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'volume') return Promise.resolve('nd-svc-web\n');
      return Promise.reject(new Error('docker run failed'));
    });
    const app = await buildTestApp({
      db: createFakeDb({ select: { services: [svcRow({ slug: 'web' })] } }),
    });
    await app.register(volumeRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].sizeBytes).toBe(0);
  });

  it('deletes a managed volume', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(volumeRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/nd-svc-web-data', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(dbEngineMocks.removeVolume).toHaveBeenCalledWith('nd-svc-web-data', expect.any(Function));
  });

  it('refuses to delete an unmanaged volume with 400', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(volumeRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/other-volume', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('not a managed volume');
    expect(dbEngineMocks.removeVolume).not.toHaveBeenCalled();
  });

  it('refuses (409) to delete a volume whose owner container is running', async () => {
    execMocks.capture.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'ps') return Promise.resolve('abc123\n'); // container running
      return Promise.resolve('');
    });
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          services: [svcRow({ id: 1, slug: 'web', name: 'Web', runtimeId: 'web-1' })],
          databases: [],
        },
      }),
    });
    await app.register(volumeRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/nd-svc-web-data', headers: asUser() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('in use by service "Web"');
    expect(dbEngineMocks.removeVolume).not.toHaveBeenCalled();
  });

  it('refuses (409) to delete a running database volume', async () => {
    execMocks.capture.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'ps') return Promise.resolve('abc123\n');
      return Promise.resolve('');
    });
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          services: [],
          databases: [dbRow({ id: 2, slug: 'pg', name: 'PG', engine: 'postgres', containerName: 'nd-db-pg' })],
        },
      }),
    });
    await app.register(volumeRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/nd-db-pg-data', headers: asUser() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('in use by database "PG"');
  });

  it('deletes an owned volume once its owner is stopped (container not running)', async () => {
    execMocks.capture.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'ps') return Promise.resolve(''); // stopped
      return Promise.resolve('');
    });
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          services: [svcRow({ id: 1, slug: 'web', name: 'Web', runtimeId: 'web-1' })],
          databases: [],
        },
      }),
    });
    await app.register(volumeRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/nd-svc-web-data', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(dbEngineMocks.removeVolume).toHaveBeenCalledWith('nd-svc-web-data', expect.any(Function));
  });

  it('treats a failing docker ps as not-running (never blocks deletes on docker hiccups)', async () => {
    execMocks.capture.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'ps') return Promise.reject(new Error('docker hiccup'));
      return Promise.resolve('');
    });
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          services: [svcRow({ id: 1, slug: 'web', name: 'Web', runtimeId: 'web-1' })],
          databases: [],
        },
      }),
    });
    await app.register(volumeRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/nd-svc-web-data', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(dbEngineMocks.removeVolume).toHaveBeenCalled();
  });

  it('treats an unmanaged volume name as ownerless in the listing path', async () => {
    // volumeOwner returns null for names outside nd-svc-/nd-db- prefixes;
    // exercised via the GET listing of a mixed set.
    execMocks.capture.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'volume') return Promise.resolve('nd-svc-web\n');
      if (args[0] === 'ps') return Promise.resolve('running-id\n'); // in-use path
      return Promise.resolve('4096 /v\n');
    });
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          services: [svcRow({ id: 1, slug: 'web', name: 'Web', runtimeId: 'web-1' })],
          databases: [],
        },
      }),
    });
    await app.register(volumeRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ name: 'nd-svc-web', inUse: true });
  });

  it('deletes an owned volume when the owner has no runtime container at all', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          services: [svcRow({ id: 1, slug: 'web', name: 'Web', runtimeId: null })],
          databases: [],
        },
      }),
    });
    await app.register(volumeRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/nd-svc-web-data', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(dbEngineMocks.removeVolume).toHaveBeenCalled();
  });

  describe('prune', () => {
    it('prunes all retained / unowned volumes and skips active owned ones', async () => {
      execMocks.capture.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'volume' && args[1] === 'ls') {
          return Promise.resolve('nd-db-old-data\nnd-svc-active-data\nignored-volume\n');
        }
        return Promise.resolve('2048 /v\n');
      });
      const app = await buildTestApp({
        db: createFakeDb({
          select: {
            services: [svcRow({ id: 1, slug: 'active', name: 'Active', runtimeId: 'active-1' })],
            databases: [],
          },
        }),
      });
      await app.register(volumeRoutes);
      const res = await app.inject({ method: 'POST', url: '/prune', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, deleted: 1, freedBytes: 2048 });
      expect(dbEngineMocks.removeVolume).toHaveBeenCalledWith('nd-db-old-data', expect.any(Function));
    });

    it('handles volume ls command failure gracefully', async () => {
      execMocks.capture.mockRejectedValueOnce(new Error('docker dead'));
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(volumeRoutes);
      const res = await app.inject({ method: 'POST', url: '/prune', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, deleted: 0, freedBytes: 0 });
    });
  });
});
