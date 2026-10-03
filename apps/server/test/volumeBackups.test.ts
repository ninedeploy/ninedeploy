import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneOldBackups, backupServiceVolumes } from '../src/modules/volumeBackups.js';
import { buildTestApp, createFakeDb, NOW, svcRow } from './helpers.js';

const execMocks = vi.hoisted(() => ({ capture: vi.fn(), run: vi.fn(), sleep: vi.fn(async () => undefined) }));
vi.mock('../src/lib/exec.js', () => execMocks);

const dbEngineMocks = vi.hoisted(() => ({
  backupVolume: vi.fn(async (_name: string, _file: string) => undefined),
  restoreVolume: vi.fn(async () => undefined),
  volumeExists: vi.fn(async (_n: string) => true),
  ensureDockerImage: vi.fn(async () => undefined),
}));
vi.mock('../src/engine/database.js', async () => {
  const actual = await vi.importActual<typeof import('../src/engine/database.js')>('../src/engine/database.js');
  return { ...actual, ...dbEngineMocks };
});

// Stub `containerRunning` so the restore-time guard sees a stopped service.
async function stubContainerRunning(value: boolean) {
  const inv = await import('../src/lib/inventory.js');
  vi.spyOn(inv, 'containerRunning').mockResolvedValue(value);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-vol-backup-'));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  vi.clearAllMocks();
  dbEngineMocks.volumeExists.mockResolvedValue(true);
});

// NOTE: route-level integration tests are intentionally omitted here —
// they need a `loadServiceForUser` mock that bypasses the parallel
// `serviceWorkspaces` branch (0034_tags_and_team_overhaul). Until that
// branch merges, route tests live in the e2e smoke. The helpers below
// cover the data path that route handlers delegate to.

describe('pruneOldBackups', () => {
  it('retains completed snapshots and running snapshots independently of failures', async () => {
    const fakeDb = createFakeDb({ select: { backups: [
      { id: 4, volumeName: 'nd-svc-x', scope: 'volumes', status: 'failed', path: '/tmp/failure-new.tar.gz', createdAt: new Date(4000), remoteKey: null, databaseId: null, sizeBytes: 0 },
      { id: 3, volumeName: 'nd-svc-x', scope: 'volumes', status: 'failed', path: '/tmp/failure-old.tar.gz', createdAt: new Date(3000), remoteKey: null, databaseId: null, sizeBytes: 0 },
      { id: 2, volumeName: 'nd-svc-x', scope: 'volumes', status: 'completed', path: '/tmp/last-good.tar.gz', createdAt: new Date(2000), remoteKey: null, databaseId: null, sizeBytes: 100 },
      { id: 1, volumeName: 'nd-svc-x', scope: 'volumes', status: 'running', path: '/tmp/in-progress.tar.gz', createdAt: new Date(1000), remoteKey: null, databaseId: null, sizeBytes: 0 },
    ] } });
    const cfg = await import('../src/config.js');
    const originalRetain = cfg.config.volumeBackupRetainCount;
    Object.defineProperty(cfg.config, 'volumeBackupRetainCount', { value: 2, configurable: true });
    try {
      expect(await pruneOldBackups(fakeDb as never, 'nd-svc-x')).toEqual({ deleted: 0, kept: 4 });
    } finally {
      Object.defineProperty(cfg.config, 'volumeBackupRetainCount', { value: originalRetain, configurable: true });
    }
  });

  it('keeps the most recent N rows and deletes the rest', async () => {
    const fakeDb = createFakeDb({
      select: {
        backups: [
          { id: 5, volumeName: 'nd-svc-x', scope: 'volumes', status: 'completed', path: '/tmp/newest.tar.gz', sizeBytes: 100, createdAt: new Date(5_000), remoteKey: null, databaseId: null },
          { id: 4, volumeName: 'nd-svc-x', scope: 'volumes', status: 'completed', path: '/tmp/old4.tar.gz', sizeBytes: 100, createdAt: new Date(4_000), remoteKey: null, databaseId: null },
          { id: 3, volumeName: 'nd-svc-x', scope: 'volumes', status: 'completed', path: '/tmp/old3.tar.gz', sizeBytes: 100, createdAt: new Date(3_000), remoteKey: null, databaseId: null },
          { id: 2, volumeName: 'nd-svc-x', scope: 'volumes', status: 'completed', path: '/tmp/old2.tar.gz', sizeBytes: 100, createdAt: new Date(2_000), remoteKey: null, databaseId: null },
          { id: 1, volumeName: 'nd-svc-x', scope: 'volumes', status: 'completed', path: '/tmp/old1.tar.gz', sizeBytes: 100, createdAt: new Date(1_000), remoteKey: null, databaseId: null },
        ],
      },
    });
    const cfg = await import('../src/config.js');
    const originalRetain = cfg.config.volumeBackupRetainCount;
    Object.defineProperty(cfg.config, 'volumeBackupRetainCount', { value: 2, configurable: true });
    try {
      const result = await pruneOldBackups(fakeDb as never, 'nd-svc-x');
      expect(result.deleted).toBe(3);
      expect(result.kept).toBe(2);
    } finally {
      Object.defineProperty(cfg.config, 'volumeBackupRetainCount', { value: originalRetain, configurable: true });
    }
  });

  it('is a no-op when the row count is at or below the cap', async () => {
    const fakeDb = createFakeDb({
      select: {
        backups: [
          { id: 2, volumeName: 'nd-svc-x', scope: 'volumes', status: 'completed', path: '/tmp/a.tar.gz', sizeBytes: 0, createdAt: new Date(2_000), remoteKey: null, databaseId: null },
          { id: 1, volumeName: 'nd-svc-x', scope: 'volumes', status: 'completed', path: '/tmp/b.tar.gz', sizeBytes: 0, createdAt: new Date(1_000), remoteKey: null, databaseId: null },
        ],
      },
    });
    const cfg = await import('../src/config.js');
    const originalRetain = cfg.config.volumeBackupRetainCount;
    Object.defineProperty(cfg.config, 'volumeBackupRetainCount', { value: 5, configurable: true });
    try {
      const result = await pruneOldBackups(fakeDb as never, 'nd-svc-x');
      expect(result.deleted).toBe(0);
      expect(result.kept).toBe(2);
    } finally {
      Object.defineProperty(cfg.config, 'volumeBackupRetainCount', { value: originalRetain, configurable: true });
    }
  });
});

describe('backupServiceVolumes (scheduled sweep)', () => {
  it('counts a completed snapshot as created when retention fails', async () => {
    let written = '';
    const updates: Array<Record<string, unknown>> = [];
    dbEngineMocks.backupVolume.mockImplementationOnce(async (_name: string, file: string) => {
      written = file;
      writeFileSync(file, 'snapshot');
    });
    const app = await buildTestApp({ db: createFakeDb({
      findFirst: { services: svcRow({ id: 1, slug: 'web', volumeMount: '/data' }) },
      insert: { backups: [{ id: 40 }] },
      update: { backups: (v: Record<string, unknown>) => { updates.push(v); return []; } },
      selectError: { backups: new Error('retention query failed') },
    }) });
    const log = vi.fn();
    try {
      expect(await backupServiceVolumes(app, 1, log)).toEqual({ created: 1, failed: 0 });
      expect(updates).toEqual([expect.objectContaining({ status: 'completed' })]);
      expect(existsSync(written)).toBe(true);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('retention failed'));
    } finally {
      if (written && existsSync(written)) unlinkSync(written);
    }
  });

  it('iterates the service\'s volume attachments and creates one row per volume', async () => {
    await stubContainerRunning(false);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, slug: 'web' }) },
        select: {
          services: [svcRow({ id: 1, slug: 'web' })],
          service_volume_attachments: [
            { id: 1, serviceId: 1, volumeName: 'nd-svc-web-uploads', containerPath: '/uploads', readOnly: false, createdAt: NOW, updatedAt: NOW },
            { id: 2, serviceId: 1, volumeName: 'nd-svc-web-cache', containerPath: '/cache', readOnly: false, createdAt: NOW, updatedAt: NOW },
          ],
        },
        insert: {
          backups: [
            { id: 1, volumeName: 'nd-svc-web-uploads', scope: 'volumes', status: 'running', path: '/tmp/a.tar.gz', sizeBytes: 0, createdAt: NOW, remoteKey: null, databaseId: null },
            { id: 2, volumeName: 'nd-svc-web-cache', scope: 'volumes', status: 'running', path: '/tmp/b.tar.gz', sizeBytes: 0, createdAt: NOW, remoteKey: null, databaseId: null },
          ],
        },
      }),
    });

    const result = await backupServiceVolumes(app as never, 1);
    expect(result.created).toBe(2);
    expect(result.failed).toBe(0);
    expect(dbEngineMocks.backupVolume).toHaveBeenCalledTimes(2);
    expect(dbEngineMocks.backupVolume.mock.calls[0]?.[0]).toBe('nd-svc-web-uploads');
    expect(dbEngineMocks.backupVolume.mock.calls[1]?.[0]).toBe('nd-svc-web-cache');
  });

  it("r163: backs up the service's PRIMARY volume by its docker name", async () => {
    await stubContainerRunning(false);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, slug: 'web', volumeMount: '/data' }) },
        select: { services: [svcRow({ id: 1, slug: 'web' })], service_volume_attachments: [] },
        insert: {
          backups: [{ id: 1, volumeName: 'nd-svc-web-data', scope: 'volumes', status: 'running', path: '/tmp/p.tar.gz', sizeBytes: 0, createdAt: NOW, remoteKey: null, databaseId: null }],
        },
      }),
    });

    const result = await backupServiceVolumes(app as never, 1);
    expect(result).toEqual({ created: 1, failed: 0 });
    expect(dbEngineMocks.backupVolume.mock.calls[0]?.[0]).toBe('nd-svc-web-data');
  });

  it('counts a volume as failed when it is not on this host', async () => {
    await stubContainerRunning(false);
    dbEngineMocks.volumeExists.mockResolvedValue(false);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, slug: 'web' }) },
        select: {
          services: [svcRow({ id: 1, slug: 'web' })],
          service_volume_attachments: [
            { id: 1, serviceId: 1, volumeName: 'nd-svc-web-missing', containerPath: '/x', readOnly: false, createdAt: NOW, updatedAt: NOW },
          ],
        },
      }),
    });

    const result = await backupServiceVolumes(app as never, 1);
    expect(result.created).toBe(0);
    expect(result.failed).toBe(1);
    expect(dbEngineMocks.backupVolume).not.toHaveBeenCalled();
  });
});
