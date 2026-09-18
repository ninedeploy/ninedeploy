import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { asUser, buildTestApp, createFakeDb, NOW, svcRow } from './helpers.js';

/**
 * Route-level tests for `/v1/volumes/:name/backups`. These used to be omitted
 * because `loadServiceForUser` reached for the `service_workspaces` table from
 * an unmerged branch; that branch has since landed, so the routes are covered
 * here directly.
 */
const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-vol-backup-routes-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const configMock = vi.hoisted(() => ({
  wildcardDomain: '',
  isProd: false,
  publicUrl: 'http://localhost:3000',
  paths: { dataDir: '/tmp', backupsDir: '', masterKeyFile: '/tmp/master.key' },
  jwt: { secret: 'x', accessTtl: '15m', refreshTtl: '7d' },
}));
vi.mock('../src/config.js', () => ({ config: configMock }));
configMock.paths.backupsDir = tmp;

const auditMocks = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMocks);

const remoteMocks = vi.hoisted(() => ({
  uploadBackup: vi.fn(async () => undefined),
  fetchRemoteBackup: vi.fn(async () => undefined),
  deleteRemoteBackup: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/backupRemote.js', () => remoteMocks);

const engineMocks = vi.hoisted(() => ({
  backupVolume: vi.fn(async (_name: string, _file: string) => undefined),
  restoreVolume: vi.fn(async () => undefined),
  volumeExists: vi.fn(async () => true),
}));
vi.mock('../src/engine/database.js', async () => {
  const actual = await vi.importActual<typeof import('../src/engine/database.js')>('../src/engine/database.js');
  return { ...actual, ...engineMocks };
});

const inventoryMocks = vi.hoisted(() => ({
  listManagedVolumeNames: vi.fn(async () => ['nd-svc-web-data']),
  containerRunning: vi.fn(async () => false),
  resolveVolumeOwnerWithSharing: vi.fn(() => ({
    owner: { kind: 'service' as const, refId: 1, name: 'web' },
    sharedWith: 0,
  })),
}));
vi.mock('../src/lib/inventory.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/inventory.js')>('../src/lib/inventory.js');
  return { ...actual, ...inventoryMocks };
});

vi.mock('../src/lib/serviceAccess.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/serviceAccess.js')>('../src/lib/serviceAccess.js');
  return { ...actual, loadServiceForUser: vi.fn(async () => svcRow({ id: 1 })) };
});

const { volumeBackupRoutes } = await import('../src/modules/volumeBackups.js');

const VOLUME = 'nd-svc-web-data';

const backupRow = (over: Record<string, unknown> = {}) => ({
  id: 10,
  databaseId: 1,
  volumeName: VOLUME,
  scope: 'volumes',
  status: 'completed',
  sizeBytes: 2048,
  path: path.join(tmp, 'existing.tar.gz'),
  remoteKey: null,
  createdAt: NOW,
  ...over,
});

async function appWith(fixtures: Record<string, unknown>) {
  const app = await buildTestApp({ db: createFakeDb(fixtures as never) });
  await app.register(volumeBackupRoutes, { prefix: '/volumes' });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  inventoryMocks.listManagedVolumeNames.mockResolvedValue([VOLUME]);
  inventoryMocks.containerRunning.mockResolvedValue(false);
  inventoryMocks.resolveVolumeOwnerWithSharing.mockReturnValue({
    owner: { kind: 'service', refId: 1, name: 'web' },
    sharedWith: 0,
  });
  engineMocks.volumeExists.mockResolvedValue(true);
});

describe('volume backup routes', () => {
  it('requires authentication', async () => {
    const app = await appWith({});
    expect((await app.inject({ method: 'GET', url: `/volumes/${VOLUME}/backups` })).statusCode).toBe(401);
  });

  it('lists a volume backups newest-first', async () => {
    const app = await appWith({ select: { backups: [backupRow(), backupRow({ id: 11, remoteKey: 'r/1' })] } });
    const res = await app.inject({ method: 'GET', url: `/volumes/${VOLUME}/backups`, headers: asUser() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ id: 10, hasRemoteCopy: false, sizeBytes: 2048 }),
      expect.objectContaining({ id: 11, hasRemoteCopy: true }),
    ]);
  });

  it('rejects a name that is not a managed volume', async () => {
    const app = await appWith({});
    const res = await app.inject({ method: 'GET', url: '/volumes/etc-passwd/backups', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('not a managed volume');
  });

  it('404s a managed volume that is not on this host', async () => {
    inventoryMocks.listManagedVolumeNames.mockResolvedValue([]);
    const app = await appWith({});
    const res = await app.inject({ method: 'GET', url: `/volumes/${VOLUME}/backups`, headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a member whose volume has no owning service', async () => {
    inventoryMocks.resolveVolumeOwnerWithSharing.mockReturnValue(null as never);
    const app = await appWith({});
    const res = await app.inject({
      method: 'GET',
      url: `/volumes/${VOLUME}/backups`,
      headers: asUser({ id: 7, isOperator: false }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Volume has no owning service');
  });

  it('creates a backup, records its size and pushes it off-site', async () => {
    engineMocks.backupVolume.mockImplementation(async (...args: unknown[]) => {
      writeFileSync(String(args[1]), 'tarball');
    });
    const app = await appWith({
      insert: { backups: [backupRow({ id: 20, status: 'running' })] },
      findFirst: { backups: backupRow({ id: 20 }) },
      select: { backups: [] },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/volumes/${VOLUME}/backups`,
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: { label: 'pre upgrade/../etc' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expect.objectContaining({ id: 20, status: 'completed' }));
    // The label is sanitised into the filename.
    const file = String(engineMocks.backupVolume.mock.calls[0]![1]);
    expect(path.basename(file)).toMatch(/^nd-svc-web-data-.*-pre_upgrade_.._etc\.tar\.gz$/);
    expect(remoteMocks.uploadBackup).toHaveBeenCalled();
    expect(auditMocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      1,
      'volume.backup.create',
      expect.stringContaining(VOLUME),
    );
  });

  it('names the file without a label when none is given', async () => {
    const app = await appWith({
      insert: { backups: [backupRow({ id: 21 })] },
      findFirst: { backups: backupRow({ id: 21 }) },
      select: { backups: [] },
    });
    await app.inject({
      method: 'POST',
      url: `/volumes/${VOLUME}/backups`,
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: {},
    });
    const file = String(engineMocks.backupVolume.mock.calls[0]![1]);
    expect(path.basename(file)).toMatch(/^nd-svc-web-data-[\dTZ.:-]+\.tar\.gz$/);
  });

  it('keeps the completed snapshot when retention fails', async () => {
    const updates: Array<Record<string, unknown>> = [];
    let written = '';
    engineMocks.backupVolume.mockImplementationOnce(async (_name: string, file: string) => {
      written = file;
      writeFileSync(file, 'snapshot');
    });
    const app = await appWith({
      insert: { backups: [backupRow({ id: 25, status: 'running' })] },
      findFirst: { backups: backupRow({ id: 25 }) },
      update: { backups: (v: Record<string, unknown>) => { updates.push(v); return [backupRow()]; } },
      selectError: { backups: new Error('retention query failed') },
    });
    const res = await app.inject({ method: 'POST', url: `/volumes/${VOLUME}/backups`, headers: asUser(), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('completed');
    expect(updates).toEqual([expect.objectContaining({ status: 'completed' })]);
    expect(existsSync(written)).toBe(true);
  });

  it('404s when the volume disappears between the check and the snapshot', async () => {
    engineMocks.volumeExists.mockResolvedValue(false);
    const app = await appWith({});
    const res = await app.inject({
      method: 'POST',
      url: `/volumes/${VOLUME}/backups`,
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('marks the row failed and reports the reason when the snapshot fails', async () => {
    engineMocks.backupVolume.mockRejectedValue(new Error('disk full'));
    const updates: Array<Record<string, unknown>> = [];
    const app = await appWith({
      insert: { backups: [backupRow({ id: 22, status: 'running' })] },
      update: { backups: (v: Record<string, unknown>) => { updates.push(v); return [backupRow()]; } },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/volumes/${VOLUME}/backups`,
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Backup failed: disk full');
    expect(updates.at(-1)).toEqual({ status: 'failed' });
  });

  it('stringifies a non-Error snapshot failure', async () => {
    engineMocks.backupVolume.mockRejectedValue('kaboom');
    const app = await appWith({ insert: { backups: [backupRow({ id: 23 })] } });
    const res = await app.inject({
      method: 'POST',
      url: `/volumes/${VOLUME}/backups`,
      headers: { ...asUser(), 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.json().error.message).toBe('Backup failed: kaboom');
  });

  it('restores a local backup while the service is stopped', async () => {
    const file = path.join(tmp, 'restore-me.tar.gz');
    writeFileSync(file, 'tarball');
    const app = await appWith({
      findFirst: { backups: backupRow({ path: file }), services: svcRow({ id: 1, runtimeId: 'c1' }) },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/volumes/${VOLUME}/backups/10/restore`,
      headers: asUser(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(engineMocks.restoreVolume).toHaveBeenCalledWith(VOLUME, file, expect.any(Function));
  });

  it('refuses to restore while the owning service is running', async () => {
    inventoryMocks.containerRunning.mockResolvedValue(true);
    const app = await appWith({
      findFirst: { backups: backupRow(), services: svcRow({ id: 1, name: 'web', runtimeId: 'c1' }) },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/volumes/${VOLUME}/backups/10/restore`,
      headers: asUser(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/stop the service before restoring/);
  });

  it('r164: refuses to restore a database volume while the database runs', async () => {
    inventoryMocks.listManagedVolumeNames.mockResolvedValue(['nd-db-pg-data']);
    inventoryMocks.resolveVolumeOwnerWithSharing.mockReturnValue({
      owner: { kind: 'database', refId: 4, name: 'pg', containerName: 'nd-db-pg' },
      sharedWith: 0,
    } as never);
    inventoryMocks.containerRunning.mockImplementation(async (name: string | null | undefined) => name === 'nd-db-pg');
    const app = await appWith({ findFirst: { backups: backupRow({ volumeName: 'nd-db-pg-data' }) } });
    const res = await app.inject({ method: 'POST', url: '/volumes/nd-db-pg-data/backups/10/restore', headers: asUser() });
    expect(res.statusCode).toBe(409);
    expect(engineMocks.restoreVolume).not.toHaveBeenCalled();
  });

  it('r164: refuses to restore while a service that SHARES the volume runs', async () => {
    inventoryMocks.containerRunning.mockImplementation(async (name: string | null | undefined) => name === 'c-worker');
    const app = await appWith({
      findFirst: {
        backups: backupRow(),
        // Checked in order: the owner (web, stopped), then the sharer (worker).
        services: (() => {
          let call = 0;
          return () => (call++ === 0 ? svcRow({ id: 1, name: 'web', runtimeId: 'c-web' }) : svcRow({ id: 2, name: 'worker', runtimeId: 'c-worker' }));
        })(),
      },
      select: {
        service_volume_attachments: [
          { id: 1, serviceId: 2, volumeName: VOLUME, containerPath: '/shared', readOnly: false, createdAt: NOW, updatedAt: NOW },
        ],
      },
    });
    const res = await app.inject({ method: 'POST', url: `/volumes/${VOLUME}/backups/10/restore`, headers: asUser() });
    expect(res.statusCode).toBe(409);
    expect(engineMocks.restoreVolume).not.toHaveBeenCalled();
  });

  it('404s a restore for an unknown backup', async () => {
    const app = await appWith({ findFirst: { backups: undefined } });
    const res = await app.inject({
      method: 'POST',
      url: `/volumes/${VOLUME}/backups/10/restore`,
      headers: asUser(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('fetches a remote-only backup, restores it and removes the temp copy', async () => {
    const missing = path.join(tmp, 'gone.tar.gz');
    remoteMocks.fetchRemoteBackup.mockImplementation(async (...args: unknown[]) => {
      writeFileSync(String(args[2]), 'tarball');
    });
    const app = await appWith({
      findFirst: { backups: backupRow({ path: missing, remoteKey: 'r/10' }), services: undefined },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/volumes/${VOLUME}/backups/10/restore`,
      headers: asUser(),
    });

    expect(res.statusCode).toBe(200);
    expect(remoteMocks.fetchRemoteBackup).toHaveBeenCalledWith(expect.anything(), 'r/10', `${missing}.remote`);
    expect(engineMocks.restoreVolume).toHaveBeenCalledWith(VOLUME, `${missing}.remote`, expect.any(Function));
  });

  it('404s a restore whose file is gone locally and remotely', async () => {
    const app = await appWith({
      findFirst: { backups: backupRow({ path: path.join(tmp, 'nope.tar.gz'), remoteKey: null }) },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/volumes/${VOLUME}/backups/10/restore`,
      headers: asUser(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('reports a failed restore', async () => {
    const file = path.join(tmp, 'broken.tar.gz');
    writeFileSync(file, 'tarball');
    engineMocks.restoreVolume.mockRejectedValue(new Error('bad archive'));
    const app = await appWith({ findFirst: { backups: backupRow({ path: file }) } });
    const res = await app.inject({
      method: 'POST',
      url: `/volumes/${VOLUME}/backups/10/restore`,
      headers: asUser(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Restore failed: bad archive');
  });

  it('stringifies a non-Error restore failure', async () => {
    const file = path.join(tmp, 'broken2.tar.gz');
    writeFileSync(file, 'tarball');
    engineMocks.restoreVolume.mockRejectedValue('kaboom');
    const app = await appWith({ findFirst: { backups: backupRow({ path: file }) } });
    const res = await app.inject({
      method: 'POST',
      url: `/volumes/${VOLUME}/backups/10/restore`,
      headers: asUser(),
    });
    expect(res.json().error.message).toBe('Restore failed: kaboom');
  });

  it('streams the tarball on download', async () => {
    const file = path.join(tmp, 'download.tar.gz');
    writeFileSync(file, 'tarball');
    const app = await appWith({ findFirst: { backups: backupRow({ path: file }) } });
    // Assert the route hands Fastify a stream rather than buffering an entire
    // potentially multi-GB archive before sending its first byte.
    let downloadPayload: unknown;
    app.addHook('onSend', async (_request, _reply, payload) => {
      downloadPayload = payload;
      return payload;
    });
    const res = await app.inject({
      method: 'GET',
      url: `/volumes/${VOLUME}/backups/10/download`,
      headers: asUser(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/gzip');
    expect(res.headers['content-disposition']).toContain('download.tar.gz');
    expect(res.body).toBe('tarball');
    expect(downloadPayload).toBeInstanceOf(Readable);
  });

  it('404s a download whose file is missing', async () => {
    const app = await appWith({ findFirst: { backups: backupRow({ path: path.join(tmp, 'absent.tar.gz') }) } });
    const res = await app.inject({
      method: 'GET',
      url: `/volumes/${VOLUME}/backups/10/download`,
      headers: asUser(),
    });
    expect(res.statusCode).toBe(404);
  });
});
