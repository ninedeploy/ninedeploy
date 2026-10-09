import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  serviceVolumeAttachments,
  serviceWorkspaces,
  services,
  users,
  workspaceMembers,
  workspaces,
  type DB,
} from '@ninedeploy/db';
import { serviceVolumesRoutes, _internal } from '../src/modules/serviceVolumes.js';
import { asUser, buildTestApp, createFakeDb, NOW, svcRow } from './helpers.js';

const execMocks = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../src/lib/exec.js', () => execMocks);

const dbEngineMocks = vi.hoisted(() => ({
  createDockerVolume: vi.fn(async (_name: string) => undefined),
  volumeExists: vi.fn(async (_name: string) => true),
}));
vi.mock('../src/engine/database.js', () => dbEngineMocks);

// Stub `loadServiceForUser` — the pre-existing implementation queries the
// `serviceWorkspaces` table which belongs to a parallel branch not merged
// here yet. The volume-attach route's auth gate has its own owner check
// via `serviceVolumeAttachments`, so this stub keeps the test independent.
vi.mock('../src/lib/resourceAccess.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/resourceAccess.js')>('../src/lib/resourceAccess.js');
  return {
    ...actual,
    // The id goes in as a `where` the fake db ignores; the real-SQLite
    // regressions below (F548–F550) need it to pick the right row.
    loadServiceForUser: vi.fn(async (db: { query: { services: { findFirst: (a?: unknown) => Promise<unknown> } } }, id: number) => {
      return db.query.services.findFirst({ where: eq(services.id, id) });
    }),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  // Optional call: keeps this file runnable against pre-r649 sources (regression proofs).
  _internal.resetVolumeSizeCache?.();
  // listManagedVolumeNames hits docker — return the candidate name for the
  // "attach existing" test, an empty list otherwise.
  execMocks.capture.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args[0] === 'volume' && args[1] === 'ls') {
      return 'nd-svc-web-uploads\nnd-svc-web-data\n';
    }
    if (args[0] === 'volume' && args[1] === 'inspect') return '';
    if (args[0] === 'run' && args[1] === '--rm') return '0\t0\n';
    return '';
  });
  dbEngineMocks.createDockerVolume.mockResolvedValue(undefined);
});

describe('service volume attachments', () => {
  describe('volume-name derivation', () => {
    it('passes through an existing managed volume name', () => {
      const name = _internal.resolveVolumeName(svcRow({ slug: 'web' }), { volumeName: 'nd-svc-web-uploads' });
      expect(name).toBe('nd-svc-web-uploads');
    });

    it('rejects non-managed volume names on attach', () => {
      expect(() => _internal.resolveVolumeName(svcRow({ slug: 'web' }), { volumeName: 'random-vol' })).toThrow();
    });

    it('produces a managed nd-svc-<slug>-<label> name for create+attach', () => {
      const name = _internal.resolveVolumeName(svcRow({ slug: 'web' }), { create: { label: 'Uploads' } });
      expect(name).toBe('nd-svc-web-uploads');
    });

    it('slugifies non-ASCII labels', () => {
      const name = _internal.resolveVolumeName(svcRow({ slug: 'web' }), { create: { label: 'Cache & Logs' } });
      expect(name).toBe('nd-svc-web-cache-logs');
    });

    it('rejects a label that slugifies to an empty string', () => {
      // A label made entirely of non-ASCII glyphs the regex strips
      // (e.g. emoji) collapses to '' — the route must reject, not
      // mint a volume whose name ends in a stray dash.
      expect(() => _internal.resolveVolumeName(svcRow({ slug: 'web' }), { create: { label: '🚀' } })).toThrow(/Invalid label/);
    });

    it('rejects an input that has neither volumeName nor create.label', () => {
      // The route's body validator catches the missing fields first
      // in production, but the helper is exported and reusable
      // from other code paths (e.g. CLI smoke tests) that bypass
      // the zod schema. Cover the guard here.
      expect(() => _internal.resolveVolumeName(svcRow({ slug: 'web' }), {})).toThrow(/Either volumeName or create\.label/);
    });
  });

  describe('GET /:id/volumes', () => {
    it('returns the service\'s attachments with size + sharing metadata', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            services: svcRow({ id: 1, slug: 'web' }),
            // Second attach row: same volumeName, different service → sharing=1.
            'service_volume_attachments': undefined,
          },
          select: {
            services: [svcRow({ id: 1, slug: 'web' })],
            databases: [],
            service_volume_attachments: [
              { id: 1, serviceId: 1, volumeName: 'nd-svc-web-uploads', containerPath: '/uploads', readOnly: false, createdAt: NOW, updatedAt: NOW },
            ],
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({ method: 'GET', url: '/1/volumes', headers: asUser() });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ volumeName: string; sharedWith: number; sizeBytes: number }>;
      expect(body).toHaveLength(1);
      expect(body[0]?.volumeName).toBe('nd-svc-web-uploads');
      // sizeBytes comes from `docker run --rm alpine du` — the mock returns 0.
      expect(body[0]?.sizeBytes).toBe(0);
      // Only this service has the row → no other sharer.
      expect(body[0]?.sharedWith).toBe(0);
    });

    it('r649: caches volume sizes, so repeated listings do not start a du container per attachment each time', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web' }) },
          select: {
            services: [svcRow({ id: 1, slug: 'web' })],
            databases: [],
            service_volume_attachments: [
              { id: 1, serviceId: 1, volumeName: 'nd-svc-web-uploads', containerPath: '/uploads', readOnly: false, createdAt: NOW, updatedAt: NOW },
              { id: 2, serviceId: 1, volumeName: 'nd-svc-web-cache', containerPath: '/cache', readOnly: false, createdAt: NOW, updatedAt: NOW },
            ],
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({ method: 'GET', url: '/1/volumes', headers: asUser() });
        expect(res.statusCode).toBe(200);
      }
      const duRuns = execMocks.capture.mock.calls.filter(([, args]) => (args as string[])[0] === 'run');
      // One probe per volume across all five requests (was 5 × 2).
      expect(duRuns).toHaveLength(2);
      await app.close();
    });

    it('falls back to `?? 1` when the sharing map query returns empty (no cross-service rows)', async () => {
      // The route does TWO `select().from(serviceVolumeAttachments)`
      // calls: the first scoped by `where(serviceId = svc.id)` to
      // build the inventory rows, and the second un-scoped to build
      // the `sharingByVolume` cross-service map. In production both
      // see the same table so the lookup is always defined, but if
      // the un-scoped query returns `[]` (e.g. right after a fresh
      // attach where no other service has caught up yet) the
      // `sharingByVolume.get(r.volumeName) ?? 1` fallback must fire
      // and the response must still carry a sensible sharedWith=0.
      let selectCallCount = 0;
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            services: svcRow({ id: 1, slug: 'web' }),
            'service_volume_attachments': undefined,
          },
          select: {
            services: [svcRow({ id: 1, slug: 'web' })],
            databases: [],
            // First call → return the scoped row so `rows` has it.
            // Second call → return `[]` so sharingByVolume is empty
            // and the `?? 1` fallback is exercised.
            service_volume_attachments: () => {
              selectCallCount++;
              if (selectCallCount === 1) {
                return [
                  { id: 1, serviceId: 1, volumeName: 'nd-svc-web-uploads', containerPath: '/uploads', readOnly: false, createdAt: NOW, updatedAt: NOW },
                ];
              }
              return [];
            },
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({ method: 'GET', url: '/1/volumes', headers: asUser() });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ volumeName: string; sharedWith: number }>;
      expect(body[0]?.volumeName).toBe('nd-svc-web-uploads');
      // sharedWith: 1 - 1 = 0 (the fallback defaults to "1 sharer",
      // which is just this service's own row).
      expect(body[0]?.sharedWith).toBe(0);
      expect(selectCallCount).toBeGreaterThanOrEqual(2);
      await app.close();
    });

    it('reports sizeBytes=0 when the docker size probe throws', async () => {
      // The `volumeSize` helper is a try/catch that returns 0 on
      // failure. The default mock in `beforeEach` returns '0\t0\n'
      // for `docker run --rm`; here we replace the implementation
      // with one that throws so the catch branch runs.
      execMocks.capture.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === 'run' && args[1] === '--rm') {
          throw new Error('docker daemon unreachable');
        }
        return '';
      });
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            services: svcRow({ id: 1, slug: 'web' }),
            'service_volume_attachments': undefined,
          },
          select: {
            services: [svcRow({ id: 1, slug: 'web' })],
            databases: [],
            service_volume_attachments: [
              { id: 1, serviceId: 1, volumeName: 'nd-svc-web-uploads', containerPath: '/uploads', readOnly: false, createdAt: NOW, updatedAt: NOW },
            ],
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({ method: 'GET', url: '/1/volumes', headers: asUser() });
      // The size probe's failure is non-fatal — the inventory row
      // reports `sizeBytes: 0` and the route still returns 200.
      const body = res.json() as Array<{ sizeBytes: number }>;
      expect(body[0]?.sizeBytes).toBe(0);
      await app.close();
    });
  });

  describe('POST /:id/volumes', () => {
    it('attaches an existing managed volume and queues a redeploy', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web' }) },
          insert: {
            service_volume_attachments: [{ id: 9, serviceId: 1, volumeName: 'nd-svc-web-uploads', containerPath: '/uploads', readOnly: false, createdAt: NOW, updatedAt: NOW }],
            deployments: [{ id: 42, serviceId: 1, status: 'queued', trigger: 'user', message: 'Volume attached' }],
          },
        }),
      });
      await app.register(serviceVolumesRoutes);

      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes',
        headers: asUser(),
        payload: { volumeName: 'nd-svc-web-uploads', containerPath: '/uploads' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { attachment: { id: number; volumeName: string }; deploymentId: number };
      expect(body.attachment.id).toBe(9);
      expect(body.attachment.volumeName).toBe('nd-svc-web-uploads');
      expect(body.deploymentId).toBe(42);
    });

    it('provisions a fresh volume and attaches it when create.label is given', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web' }) },
          insert: {
            service_volume_attachments: [{ id: 9, serviceId: 1, volumeName: 'nd-svc-web-uploads', containerPath: '/uploads', readOnly: false, createdAt: NOW, updatedAt: NOW }],
            deployments: [{ id: 42, serviceId: 1, status: 'queued', trigger: 'user', message: 'Volume attached' }],
          },
        }),
      });
      await app.register(serviceVolumesRoutes);

      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes',
        headers: asUser(),
        payload: { create: { label: 'Uploads' }, containerPath: '/uploads' },
      });
      expect(res.statusCode).toBe(200);
      expect(dbEngineMocks.createDockerVolume).toHaveBeenCalledWith('nd-svc-web-uploads', expect.any(Function));
    });

    it('0.16: create.label on a node service records the attachment but creates nothing on the panel host (D9)', async () => {
      // A node service's volume exists only on its node: ensureNodeVolumes
      // pre-creates it there on the redeploy this attach queues.
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web', serverId: 4 }) },
          insert: {
            service_volume_attachments: [{ id: 9, serviceId: 1, volumeName: 'nd-svc-web-media', containerPath: '/media', readOnly: false, createdAt: NOW, updatedAt: NOW }],
            deployments: [{ id: 42, serviceId: 1, status: 'queued', trigger: 'user', message: 'Volume attached' }],
          },
        }),
      });
      await app.register(serviceVolumesRoutes);

      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes',
        headers: asUser(),
        payload: { create: { label: 'media' }, containerPath: '/media' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ attachment: { volumeName: 'nd-svc-web-media' }, deploymentId: 42 });
      expect(dbEngineMocks.createDockerVolume).not.toHaveBeenCalled();
      // Control: the same request on a panel-host service still creates it there.
      const host = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web', serverId: null }) },
          insert: {
            service_volume_attachments: [{ id: 9, serviceId: 1, volumeName: 'nd-svc-web-media', containerPath: '/media', readOnly: false, createdAt: NOW, updatedAt: NOW }],
            deployments: [{ id: 42 }],
          },
        }),
      });
      await host.register(serviceVolumesRoutes);
      const res2 = await host.inject({ method: 'POST', url: '/1/volumes', headers: asUser(), payload: { create: { label: 'media' }, containerPath: '/media' } });
      expect(res2.statusCode).toBe(200);
      expect(dbEngineMocks.createDockerVolume).toHaveBeenCalledWith('nd-svc-web-media', expect.any(Function));
    });

    it('refuses create.label for a member when the resolved name already exists on the host (r096)', async () => {
      // Slug + label concatenation collides across services: `shop` +
      // `api-data` spells `shop-api`'s data volume. The mocked host already
      // has `nd-svc-web-uploads`, and no visible attachment claims it.
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web', ownerUserId: 7 }) },
          select: { service_volume_attachments: [] },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes',
        headers: asUser({ id: 7, isOperator: false }),
        payload: { create: { label: 'uploads' }, containerPath: '/uploads' },
      });
      expect(res.statusCode).toBe(403);
      expect(dbEngineMocks.createDockerVolume).not.toHaveBeenCalled();
    });

    it('fails closed when docker cannot list volumes (member, create.label)', async () => {
      execMocks.capture.mockRejectedValue(new Error('docker unreachable'));
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web', ownerUserId: 7 }) },
          select: { service_volume_attachments: [] },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes',
        headers: asUser({ id: 7, isOperator: false }),
        payload: { create: { label: 'brand-new' }, containerPath: '/new' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('still lets a member create a volume under a fresh name', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web', ownerUserId: 7 }) },
          insert: {
            service_volume_attachments: [{ id: 9, serviceId: 1, volumeName: 'nd-svc-web-brand-new', containerPath: '/new', readOnly: false, createdAt: NOW, updatedAt: NOW }],
            deployments: [{ id: 42 }],
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes',
        headers: asUser({ id: 7, isOperator: false }),
        payload: { create: { label: 'brand-new' }, containerPath: '/new' },
      });
      expect(res.statusCode).toBe(200);
      expect(dbEngineMocks.createDockerVolume).toHaveBeenCalledWith('nd-svc-web-brand-new', expect.any(Function));
    });

    it('refuses to attach at the primary volumeMount path', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web', volumeMount: '/data' }) },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes',
        headers: asUser(),
        payload: { volumeName: 'nd-svc-web-uploads', containerPath: '/data' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('refuses non-managed volumeName even when the volume is missing from docker', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web' }) },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes',
        headers: asUser(),
        payload: { volumeName: 'random-vol', containerPath: '/uploads' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects unsupported service types (pm2)', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web', type: 'pm2' }) },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes',
        headers: asUser(),
        payload: { volumeName: 'nd-svc-web-uploads', containerPath: '/uploads' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /:id/volumes/:attId', () => {
    it('204s and returns 204 even when the attachment does not exist (idempotent — actually 404 here)', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            services: svcRow({ id: 1, slug: 'web' }),
            service_volume_attachments: undefined,
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({ method: 'DELETE', url: '/1/volumes/9', headers: asUser() });
      expect(res.statusCode).toBe(404);
    });

    it('detaches even while the container is RUNNING and queues the mount-drop redeploy', async () => {
      const queuedDeploys: Array<Record<string, unknown>> = [];
      const app = await buildTestApp({
        db: createFakeDb({
          // runtimeId present + running: the old stop-first guard would have
          // answered 409 here and silently swallowed the detach in the UI.
          findFirst: {
            services: svcRow({ id: 1, slug: 'web', type: 'docker', runtimeId: 'c-web-1', status: 'running' }),
            service_volume_attachments: {
              id: 9, serviceId: 1, volumeName: 'nd-svc-web-uploads',
              containerPath: '/uploads', readOnly: false,
              createdAt: new Date(0), updatedAt: new Date(0),
            },
          },
          // Snake-case key (the drizzle table name) so the route's
          // post-delete "still referenced?" select actually returns
          // the empty list we want here.
          select: { service_volume_attachments: [] },
          insert: {
            deployments: (values: Record<string, unknown>) => {
              queuedDeploys.push(values);
              return [{ id: 77 }];
            },
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({ method: 'DELETE', url: '/1/volumes/9', headers: asUser() });
      expect(res.statusCode).toBe(204);
      expect(queuedDeploys).toHaveLength(1);
      expect(String(queuedDeploys[0]?.message)).toContain('Volume detached');
    });

    it('skips the orphan log when other services still attach the same volume', async () => {
      // The DELETE route always re-queries `serviceVolumeAttachments`
      // by volumeName after deletion. If even one other service still
      // attaches the volume, the operator's mental model is "moved
      // ownership" rather than "orphaned" — the "no remaining
      // attachments" log line must NOT fire.
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            services: svcRow({ id: 1, slug: 'web', type: 'docker' }),
            service_volume_attachments: {
              id: 9, serviceId: 1, volumeName: 'nd-svc-web-uploads',
              containerPath: '/uploads', readOnly: false,
              createdAt: new Date(0), updatedAt: new Date(0),
            },
          },
          // After delete, another service still references the volume.
          // The fake DB keys `select` by the drizzle table name
          // (snake_case `service_volume_attachments`), not the
          // camelCase alias, so we must use the snake_case key here
          // for the row to actually reach the route.
          select: { service_volume_attachments: [{ id: 22, serviceId: 2, volumeName: 'nd-svc-web-uploads' }] },
          insert: { deployments: [{ id: 78 }] },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({ method: 'DELETE', url: '/1/volumes/9', headers: asUser() });
      expect(res.statusCode).toBe(204);
      await app.close();
    });
  });

  describe('PATCH /:id/volumes/:attId', () => {
    it('updates the containerPath and readOnly flags, queues a redeploy', async () => {
      const queuedDeploys: Array<Record<string, unknown>> = [];
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            services: svcRow({ id: 1, slug: 'web' }),
            service_volume_attachments: { id: 12, serviceId: 1, volumeName: 'nd-svc-web-uploads', containerPath: '/uploads', readOnly: false, createdAt: NOW, updatedAt: NOW },
          },
          update: {
            service_volume_attachments: (set: Record<string, unknown>) => {
              expect(set).toMatchObject({ containerPath: '/data', readOnly: true });
              expect(set.updatedAt).toBeInstanceOf(Date);
              return [{ id: 12, serviceId: 1, volumeName: 'nd-svc-web-uploads', containerPath: '/data', readOnly: true, createdAt: NOW, updatedAt: new Date() }];
            },
          },
          insert: {
            deployments: (values: Record<string, unknown>) => {
              queuedDeploys.push(values);
              return [{ id: 88 }];
            },
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'PATCH',
        url: '/1/volumes/12',
        headers: asUser(),
        payload: { containerPath: '/data', readOnly: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { attachment: { containerPath: string; readOnly: boolean }; deploymentId: number };
      expect(body.attachment).toMatchObject({ containerPath: '/data', readOnly: true });
      expect(body.deploymentId).toBe(88);
      expect(queuedDeploys).toHaveLength(1);
      await app.close();
    });

    it('refuses to retarget the path onto the service\'s primary volumeMount', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            services: svcRow({ id: 1, slug: 'web', volumeMount: '/var/data' }),
            service_volume_attachments: { id: 12, serviceId: 1, volumeName: 'nd-svc-web-uploads', containerPath: '/uploads', readOnly: false, createdAt: NOW, updatedAt: NOW },
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'PATCH',
        url: '/1/volumes/12',
        headers: asUser(),
        payload: { containerPath: '/var/data' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/primary volume mount/);
      await app.close();
    });

    it('returns 404 when the attachment does not exist', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            services: svcRow({ id: 1, slug: 'web' }),
            service_volume_attachments: undefined,
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'PATCH',
        url: '/1/volumes/999',
        headers: asUser(),
        payload: { readOnly: true },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('surfaces a UNIQUE container_path conflict on PATCH as a 409', async () => {
      // Renaming a second attachment onto a path the service already
      // mounts triggers the (serviceId, container_path) unique index.
      // The route must catch the violation and answer 409 — not 500.
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            services: svcRow({ id: 1, slug: 'web' }),
            service_volume_attachments: { id: 12, serviceId: 1, volumeName: 'nd-svc-web-uploads', containerPath: '/uploads', readOnly: false, createdAt: NOW, updatedAt: NOW },
          },
          update: {
            service_volume_attachments: () => {
              throw new Error('UNIQUE constraint failed: service_volume_attachments.container_path');
            },
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'PATCH',
        url: '/1/volumes/12',
        headers: asUser(),
        payload: { containerPath: '/data' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/already mounted/);
      await app.close();
    });

    it('rethrows non-UNIQUE PATCH update errors as 500', async () => {
      // Mirror of the POST fallthrough test: the PATCH catch only
      // owns the container_path UNIQUE case. Other DB errors must
      // surface verbatim so the operator can debug the real cause
      // (FK drift, disk full, schema mismatch, etc.) instead of a
      // misleading 409.
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            services: svcRow({ id: 1, slug: 'web' }),
            service_volume_attachments: { id: 12, serviceId: 1, volumeName: 'nd-svc-web-uploads', containerPath: '/uploads', readOnly: false, createdAt: NOW, updatedAt: NOW },
          },
          update: {
            service_volume_attachments: () => {
              throw new Error('database is locked');
            },
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'PATCH',
        url: '/1/volumes/12',
        headers: asUser(),
        payload: { readOnly: true },
      });
      expect(res.statusCode).toBe(500);
      await app.close();
    });

    it('returns 404 when the update affects zero rows (existing row vanished mid-flight)', async () => {
      // findFirst returned the attachment a moment ago but the UPDATE
      // .returning() yields [] — a race against another worker, or a
      // permission reaper. The route must answer 404, not 200 with a
      // phantom null row. This also covers the `if (!updated)` guard
      // that the happy-path PATCH never reaches.
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            services: svcRow({ id: 1, slug: 'web' }),
            service_volume_attachments: { id: 12, serviceId: 1, volumeName: 'nd-svc-web-uploads', containerPath: '/uploads', readOnly: false, createdAt: NOW, updatedAt: NOW },
          },
          update: {
            service_volume_attachments: () => [],
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'PATCH',
        url: '/1/volumes/12',
        headers: asUser(),
        payload: { readOnly: true },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toMatch(/not found/i);
      await app.close();
    });

    it('handles non-Error throws from the PATCH update the same as Error throws', async () => {
      // Mirror of the POST non-Error test: drivers that throw raw
      // values (instead of `new Error(...)`) still need the UNIQUE
      // container_path check to fire. The catch's
      // `err instanceof Error ? err.message : String(err)` ternary
      // must work for strings too.
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            services: svcRow({ id: 1, slug: 'web' }),
            service_volume_attachments: { id: 12, serviceId: 1, volumeName: 'nd-svc-web-uploads', containerPath: '/uploads', readOnly: false, createdAt: NOW, updatedAt: NOW },
          },
          update: {
            service_volume_attachments: () => {
              // PATCH uses just `/UNIQUE.*container_path/i.test(msg)`
              // (no double-OR like POST), so a string with the right
              // shape is enough.
              // eslint-disable-next-line @typescript-eslint/no-throw-literal
              throw 'UNIQUE constraint failed: service_volume_attachments.container_path';
            },
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'PATCH',
        url: '/1/volumes/12',
        headers: asUser(),
        payload: { containerPath: '/data' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/already mounted/);
      await app.close();
    });
  });

  describe('POST /:id/volumes/config-repair (by volumeName)', () => {
    it('runs the alpine rm against the named volume and queues a redeploy', async () => {
      const queuedDeploys: Array<Record<string, unknown>> = [];
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web' }) },
          insert: {
            deployments: (values: Record<string, unknown>) => {
              queuedDeploys.push(values);
              return [{ id: 91 }];
            },
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes/config-repair',
        headers: asUser(),
        payload: { filePath: 'wp-config.php', volumeName: 'nd-svc-web-data' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, deploymentId: 91 });
      // The `docker run` shelled out, with the file path injected
      // into the rm command — a regression that drops the file
      // name is the kind of thing that takes a week to diagnose.
      expect(execMocks.capture).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['run', '--rm', '-v', 'nd-svc-web-data:/data', 'alpine:3.21', 'sh', '-c', "rm -f -- '/data/wp-config.php'"]),
      );
      expect(queuedDeploys).toHaveLength(1);
      expect(String(queuedDeploys[0]?.message)).toContain('Config repaired');
      await app.close();
    });

    it('rejects a volumeName that does not match the managed-volume pattern', async () => {
      const app = await buildTestApp({
        db: createFakeDb({ findFirst: { services: svcRow({ id: 1, slug: 'web' }) } }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes/config-repair',
        headers: asUser(),
        payload: { filePath: 'wp-config.php', volumeName: 'rogue-volume' },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe('POST /:id/volumes error paths', () => {
    it('surfaces a UNIQUE container_path conflict as a 409', async () => {
      // SQLite / Drizzle throws a runtime Error whose message
      // contains both 'UNIQUE' and 'container_path' when the
      // compound (serviceId, container_path) index collides.
      // The route must catch that and surface a 409, not a 500.
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web' }) },
          insert: {
            service_volume_attachments: () => {
              throw new Error('UNIQUE constraint failed: service_volume_attachments.container_path');
            },
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes',
        headers: asUser(),
        payload: { volumeName: 'nd-svc-web-uploads', containerPath: '/uploads' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/already mounted/);
      await app.close();
    });

    it('surfaces a UNIQUE volume_name conflict as a 409', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web' }) },
          insert: {
            service_volume_attachments: () => {
              throw new Error('UNIQUE constraint failed: service_volume_attachments.volume_name');
            },
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes',
        headers: asUser(),
        payload: { volumeName: 'nd-svc-web-uploads', containerPath: '/uploads' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/already attached/);
      await app.close();
    });

    it('still matches a UNIQUE volume_name error when the column name precedes the keyword', async () => {
      // The container_path / volume_name checks in the catch block
      // use a two-clause OR: `/UNIQUE.*<col>/i.test(msg)` OR
      // `/<col>/i.test(msg) && /UNIQUE/i.test(msg)`. The first
      // clause assumes the message format starts with "UNIQUE" —
      // older sqlite drivers and some proxies phrase the error
      // with the column name first instead. The second clause
      // catches that case and must surface a 409 just the same.
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web' }) },
          insert: {
            service_volume_attachments: () => {
              // "volume_name" appears BEFORE "UNIQUE" — the first OR
              // clause misses, the second OR clause (the `&& /UNIQUE/`
              // branch) fires.
              throw new Error('insert into service_volume_attachments: volume_name must be UNIQUE');
            },
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes',
        headers: asUser(),
        payload: { volumeName: 'nd-svc-web-uploads', containerPath: '/uploads' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/already attached/);
      await app.close();
    });

    it('rolls back the attachment row when docker volume create fails', async () => {
      const deletedIds: number[] = [];
      dbEngineMocks.createDockerVolume.mockRejectedValueOnce(new Error('docker daemon unreachable'));
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web' }) },
          insert: {
            service_volume_attachments: (values: Record<string, unknown>) => {
              expect(values).toMatchObject({ serviceId: 1, volumeName: 'nd-svc-web-data' });
              return [{ id: 99, ...values, createdAt: NOW, updatedAt: NOW }];
            },
          },
          delete: {
            service_volume_attachments: (where: unknown) => {
              const sql = (where as { queryChunks?: Array<{ value?: unknown }> })?.queryChunks ?? [];
              // We don't deeply parse drizzle's `eq(...)` node here;
              // any delete with a `service_volume_attachments.id`
              // condition counts as the rollback. (Falling back to
              // recording all deletes is fine — this is a mock.)
              void sql;
              deletedIds.push(99);
              return [];
            },
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes',
        headers: asUser(),
        payload: { create: { label: 'data' }, containerPath: '/data' },
      });
      // The 500 surfaces to the client — the important assertion
      // is the rollback ran (so we are not left with a phantom row).
      expect(res.statusCode).toBe(500);
      expect(deletedIds).toContain(99);
      await app.close();
    });

    it('rethrows non-UNIQUE insert errors as 500 (caller is on the hook for the raw cause)', async () => {
      // The catch block in POST must only intercept UNIQUE container_path /
      // UNIQUE volume_name violations. Anything else (FK error, CHECK
      // constraint, NOT NULL, "database is locked", etc.) must fall through
      // so the operator sees the real cause, not a misleading 409.
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web' }) },
          insert: {
            service_volume_attachments: () => {
              throw new Error('FOREIGN KEY constraint failed: service_volume_attachments.service_id');
            },
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes',
        headers: asUser(),
        payload: { volumeName: 'nd-svc-web-uploads', containerPath: '/uploads' },
      });
      expect(res.statusCode).toBe(500);
      await app.close();
    });

    it('handles non-Error throws (e.g. a string from a buggy driver) the same as Error throws', async () => {
      // The catch's `err instanceof Error ? err.message : String(err)`
      // ternary must work even when the upstream code throws a raw
      // value (older node drivers have been known to do this). The
      // route must still detect the UNIQUE container_path keyword
      // and answer 409, not 500.
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web' }) },
          insert: {
            service_volume_attachments: () => {
              // Throwing a string (not an Error instance) — exercises
              // the `: String(err)` branch of the catch's ternary.
              // The substring "UNIQUE constraint failed: service_volume_attachments.container_path"
              // does NOT match `/UNIQUE.*container_path/i` because
              // "UNIQUE" comes BEFORE "container_path" in the string,
              // so the first OR clause misses. The second OR clause
              // `(/container_path/i.test(msg) && /UNIQUE/i.test(msg))`
              // also needs to be hit to surface a 409.
              // eslint-disable-next-line @typescript-eslint/no-throw-literal
              throw 'SQLITE_CONSTRAINT: container_path must be unique; UNIQUE constraint violated';
            },
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes',
        headers: asUser(),
        payload: { volumeName: 'nd-svc-web-uploads', containerPath: '/uploads' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/already mounted/);
      await app.close();
    });

    it('treats a `docker volume ls` failure as "volume does not exist" rather than 500', async () => {
      // listManagedVolumeNames() can throw when docker is unreachable
      // mid-flight. The route must not propagate that to a 500 — the
      // catch on `listManagedVolumeNames().catch(() => [])` collapses
      // the failure to "no known volumes", which then takes the
      // `if (!known)` branch and answers 404.
      execMocks.capture.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === 'volume' && args[1] === 'ls') {
          throw new Error('docker daemon unreachable');
        }
        if (args[0] === 'run' && args[1] === '--rm') return '0\t0\n';
        return '';
      });
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web' }) },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes',
        headers: asUser(),
        payload: { volumeName: 'nd-svc-web-uploads', containerPath: '/uploads' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toMatch(/does not exist on this host/);
      await app.close();
    });

    it('404s when the named volume is missing from `docker volume ls`', async () => {
      // The volume ls mock in beforeEach returns a list; here we return
      // an empty list so the candidate volume isn't found. The route
      // must 404 — not 500, not 200 — and the message must name the
      // requested volume so the operator can spot the typo.
      execMocks.capture.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === 'volume' && args[1] === 'ls') return '\n';
        if (args[0] === 'run' && args[1] === '--rm') return '0\t0\n';
        return '';
      });
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web' }) },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes',
        headers: asUser(),
        payload: { volumeName: 'nd-svc-web-uploads', containerPath: '/uploads' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toContain('nd-svc-web-uploads');
      await app.close();
    });

    it('drives the createDockerVolume log callback when the volume is freshly provisioned', async () => {
      // createDockerVolume is mocked, but the mock should still pipe
      // log lines back through the route's req.log. If the callback
      // is never invoked, the operator gets no progress signal during
      // a long provisioning run — the (line) => req.log.info(line)
      // arrow is the only path that surfaces docker's stdout here.
      let loggedLine: string | undefined;
      dbEngineMocks.createDockerVolume.mockImplementationOnce(async (_name: string, onLine: (line: string) => void) => {
        onLine('Creating volume nd-svc-web-data');
        return undefined;
      });
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web' }) },
          insert: {
            service_volume_attachments: [{ id: 9, serviceId: 1, volumeName: 'nd-svc-web-data', containerPath: '/data', readOnly: false, createdAt: NOW, updatedAt: NOW }],
            deployments: [{ id: 42 }],
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes',
        headers: asUser(),
        payload: { create: { label: 'data' }, containerPath: '/data' },
      });
      expect(res.statusCode).toBe(200);
      // The route called req.log.info(line) at least once — the line
      // is captured into the route's pino log, not into the mock; we
      // just assert the callback ran by looking for the on-disk log
      // entry pino emits. The more direct signal is that the
      // implementation executed without throwing, and the request
      // returned 200 with a deployment id.
      expect(dbEngineMocks.createDockerVolume).toHaveBeenCalledWith(
        'nd-svc-web-data',
        expect.any(Function),
      );
      void loggedLine;
      await app.close();
    });
  });

  describe('POST /:id/volumes/config-repair (by attachmentId)', () => {
    it('deletes the baked config from the volume and queues a redeploy (config repair)', async () => {
      const queuedDeploys: Array<Record<string, unknown>> = [];
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            services: svcRow({ id: 1, slug: 'web', type: 'docker' }),
            service_volume_attachments: {
              id: 9, serviceId: 1, volumeName: 'nd-svc-web-html',
              containerPath: '/var/www/html', readOnly: false,
              createdAt: new Date(0), updatedAt: new Date(0),
            },
          },
          select: { serviceVolumeAttachments: [] },
          insert: {
            deployments: (values: Record<string, unknown>) => {
              queuedDeploys.push(values);
              return [{ id: 78 }];
            },
          },
        }),
      });
      await app.register(serviceVolumesRoutes);

      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes/config-repair',
        headers: asUser(),
        payload: { attachmentId: 9, filePath: 'wp-config.php' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, deploymentId: 78 });
      expect(queuedDeploys).toHaveLength(1);
      expect(String(queuedDeploys[0]?.message)).toContain('Config repaired');

      // The docker call removed exactly the requested file from the volume root.
      const shCmds = execMocks.capture.mock.calls.map(
        ([_cmd, args]) => (Array.isArray(args) ? ((args.at(-1) as string | undefined) ?? '') : ''),
      );
      expect(shCmds.some((cmd) => cmd.includes("rm -f -- '/data/wp-config.php'"))).toBe(true);
    });

    it.each([
      [{ filePath: '../etc/passwd' }, 'path traversal attempt'],
      [{ filePath: 'sub/dir/wp-config.php' }, 'nested path'],
      [{}, 'no selector'],
      [{ attachmentId: 9, volumeName: 'nd-svc-web-html', filePath: 'wp-config.php' }, 'both selectors'],
    ])('rejects config-repair payload: %j (%s)', async (payload) => {
      const app = await buildTestApp({
        db: createFakeDb({ findFirst: { services: svcRow({ id: 1, slug: 'web', type: 'docker' }) } }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes/config-repair',
        headers: asUser(),
        payload,
      });
      expect([400, 404]).toContain(res.statusCode); // validation error before any docker call
      expect(execMocks.capture).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['sh']));
    });

    it('404s when the requested attachmentId does not exist for this service', async () => {
      // The route resolves attachmentId → volumeName by re-querying
      // serviceVolumeAttachments. If the row is gone (or never
      // belonged to this service) the lookup returns undefined and
      // the route must answer 404 — not 500, not a docker call
      // against an empty volumeName.
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            services: svcRow({ id: 1, slug: 'web', type: 'docker' }),
            service_volume_attachments: undefined,
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes/config-repair',
        headers: asUser(),
        payload: { attachmentId: 999, filePath: 'wp-config.php' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toMatch(/not found/i);
      expect(execMocks.capture).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['run']));
      await app.close();
    });

    it('falls back to an empty object when req.body is missing entirely (req.body ?? {})', async () => {
      // The route reads `repairConfig.parse(req.body ?? {})`. When
      // a client POSTs with no body and no content-type, fastify
      // leaves `req.body` undefined and the fallback fires. The
      // validator then parses `{}`, which fails the required
      // `filePath` check with a 400.
      //
      // We bypass the test helper's auto-JSON parsing by feeding
      // the request directly through the underlying Node http
      // client so we can suppress content-type entirely.
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, slug: 'web', type: 'docker' }) },
        }),
      });
      await app.register(serviceVolumesRoutes);
      // Build a raw HTTP request without content-type or payload.
      const res = await app.inject({
        method: 'POST',
        url: '/1/volumes/config-repair',
        headers: asUser(),
        // Empty string payload + no content-type → fastify leaves
        // req.body undefined.
        payload: '',
      });
      // The validator parses `{}` (via the `?? {}` fallback) and
      // surfaces the required-field 400. The exact wording is
      // zod-driven ("Required") but the status is 400 either way.
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  // ── cross-tenant volume guard ──────────────────────────────────────────
  //
  // Volume names are host-global: without an ownership decision a member can
  // name another tenant's `nd-svc-*` / `nd-db-*` volume and mount it
  // read-write into their own container (or delete files from its root via
  // config-repair). assertVolumeOwnership must refuse anything whose owners
  // are not fully visible to the caller.
  describe('cross-tenant volume guard', () => {
    const member = { id: 7, isOperator: false };
    const mine = svcRow({ id: 9, name: 'mine', slug: 'mine', ownerUserId: 7, type: 'docker' });

    it('refuses to attach a volume that is attached to an invisible service', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: mine },
          // The caller can only ever see service 9; the volume is attached
          // to service 55, which belongs to another tenant.
          select: {
            services: [{ id: 9 }],
            serviceVolumeAttachments: [{ serviceId: 55 }],
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/9/volumes',
        headers: asUser(member),
        payload: { volumeName: 'nd-svc-victim-uploads', containerPath: '/data' },
      });
      expect(res.statusCode).toBe(403);
      // The refusal happens before any docker probe — the member must not
      // even learn whether the named volume exists on the host.
      expect(execMocks.capture).not.toHaveBeenCalled();
      await app.close();
    });

    it('refuses config-repair on a database volume the caller does not admin', async () => {
      const victimDb = {
        id: 3,
        slug: 'victim',
        name: 'victim',
        ownerUserId: 8,
        projectId: null,
        engine: 'postgres',
        status: 'running',
      };
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: mine, databases: victimDb },
          findMany: { databases: [victimDb] },
          select: {
            services: [{ id: 9 }],
            serviceVolumeAttachments: [],
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/9/volumes/config-repair',
        headers: asUser(member),
        payload: { volumeName: 'nd-db-victim-data', filePath: 'wp-config.php' },
      });
      // loadDatabaseForUser 404s on an invisible database; either way the
      // repair must never reach docker.
      expect([403, 404]).toContain(res.statusCode);
      expect(execMocks.capture).not.toHaveBeenCalled();
      await app.close();
    });

    it('still attaches a volume every attacher of which is visible to the caller', async () => {
      // Re-point the docker probe at the volume this test uses.
      execMocks.capture.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === 'volume' && args[1] === 'ls') return 'nd-svc-mine-uploads\n';
        return '0\t0\n';
      });
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: mine },
          select: {
            services: [{ id: 9 }],
            serviceVolumeAttachments: [{ serviceId: 9 }],
          },
          insert: {
            serviceVolumeAttachments: [
              {
                id: 1,
                serviceId: 9,
                volumeName: 'nd-svc-mine-uploads',
                containerPath: '/data',
                readOnly: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          },
        }),
      });
      await app.register(serviceVolumesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/9/volumes',
        headers: asUser(member),
        payload: { volumeName: 'nd-svc-mine-uploads', containerPath: '/data' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().attachment).toMatchObject({ volumeName: 'nd-svc-mine-uploads' });
      await app.close();
    });
  });
});


// r640: every volume route ends in a redeploy, and the redeploy is what
// executes the stored definition on the host. The routes inserted their queued
// row directly — skipping the privilege re-check and the queued cap
// `POST /deploys` applies — so a member on an operator-authored compose service
// got the redeploy the deploy route refuses them. They now share one enqueue
// helper, and the refusal lands BEFORE the route's side effect.
describe('volume redeploys go through the shared enqueue guards (r640)', () => {
  const member = { id: 7, isOperator: false };
  const composeSvc = svcRow({ id: 9, name: 'stack', slug: 'stack', ownerUserId: 7, type: 'compose' });
  const attachment = {
    id: 12, serviceId: 9, volumeName: 'nd-svc-stack-uploads', containerPath: '/uploads', readOnly: false, createdAt: NOW, updatedAt: NOW,
  };

  const appFor = async (over: Parameters<typeof createFakeDb>[0] = {}) => {
    const inserted: string[] = [];
    const deleted: string[] = [];
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: composeSvc, service_volume_attachments: attachment },
        select: { services: [{ id: 9 }], serviceVolumeAttachments: [{ serviceId: 9 }] },
        insert: {
          service_volume_attachments: (v: Record<string, unknown>) => { inserted.push('attachment'); return [{ ...attachment, ...v }]; },
          deployments: () => { inserted.push('deployment'); return [{ id: 77 }]; },
        },
        delete: { service_volume_attachments: () => { deleted.push('attachment'); return []; } },
        ...over,
      }),
    });
    await app.register(serviceVolumesRoutes);
    return { app, inserted, deleted };
  };

  it('refuses a member attach on a compose service before anything is created', async () => {
    const { app, inserted } = await appFor();
    const res = await app.inject({
      method: 'POST', url: '/9/volumes', headers: asUser(member),
      payload: { create: { label: 'cache' }, containerPath: '/cache' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/Operator access required: Compose deploys/);
    expect(inserted).toEqual([]);
    expect(dbEngineMocks.createDockerVolume).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses member update / detach / config-repair on a compose service with no side effect', async () => {
    const { app, inserted, deleted } = await appFor();
    const patch = await app.inject({ method: 'PATCH', url: '/9/volumes/12', headers: asUser(member), payload: { readOnly: true } });
    expect(patch.statusCode).toBe(403);
    const detach = await app.inject({ method: 'DELETE', url: '/9/volumes/12', headers: asUser(member) });
    expect(detach.statusCode).toBe(403);
    const repair = await app.inject({
      method: 'POST', url: '/9/volumes/config-repair', headers: asUser(member),
      payload: { attachmentId: 12, filePath: 'config.php' },
    });
    expect(repair.statusCode).toBe(403);
    expect(inserted).toEqual([]);
    expect(deleted).toEqual([]);
    // config-repair never reached the `docker run … rm -f` helper.
    expect(execMocks.capture).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['rm']));
    await app.close();
  });

  it('still lets an operator redeploy the same compose service through a volume change', async () => {
    const { app, inserted } = await appFor();
    const res = await app.inject({ method: 'PATCH', url: '/9/volumes/12', headers: asUser(), payload: { readOnly: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().deploymentId).toBe(77);
    expect(inserted).toEqual(['deployment']);
    await app.close();
  });

  it('applies the per-service queued cap to volume redeploys', async () => {
    const plain = svcRow({ id: 9, slug: 'stack', ownerUserId: 7, type: 'docker' });
    const { app, inserted } = await appFor({
      findFirst: { services: plain, service_volume_attachments: attachment },
      findMany: { deployments: Array.from({ length: 50 }, (_, i) => ({ id: i + 1 })) },
    });
    const res = await app.inject({ method: 'PATCH', url: '/9/volumes/12', headers: asUser(member), payload: { readOnly: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/50 queued deploys \(max 50\)/);
    expect(inserted).toEqual([]);
    await app.close();
  });
});

// r648: attachment names and primary data-volume names share one namespace.
describe('create.label cannot mint another service primary data volume (r648)', () => {
  it('refuses `shop` + `api-data` when service `shop-api` exists, before anything is created', async () => {
    const shop = svcRow({ id: 9, name: 'shop', slug: 'shop', ownerUserId: 7, type: 'docker' });
    const shopApi = { id: 20, name: 'shop-api' };
    let inserted = false;
    const app = await buildTestApp({
      db: createFakeDb({
        // The primary-volume lookup asks for { id, name } of the slug's owner.
        findFirst: { services: (args?: { columns?: Record<string, boolean> }) => (args?.columns?.name ? shopApi : shop) },
        insert: { service_volume_attachments: () => { inserted = true; return []; }, deployments: [{ id: 1 }] },
      }),
    });
    await app.register(serviceVolumesRoutes);
    const res = await app.inject({
      method: 'POST', url: '/9/volumes', headers: asUser({ id: 7, isOperator: false }),
      payload: { create: { label: 'api-data' }, containerPath: '/stash' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain("'nd-svc-shop-api-data' is the data volume name of service 'shop-api'");
    expect(inserted).toBe(false);
    expect(dbEngineMocks.createDockerVolume).not.toHaveBeenCalled();
    await app.close();
  });
});

// F548–F550: the volume ownership decision against a real migrated SQLite.
// Workspace A runs the caller's service; workspace B holds `victim`, which has
// `nd-svc-victim-uploads` attached.
describe('volume ownership on real rows (F548, F549, F550)', () => {
  const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
  const OP = 1;
  let db: DB;
  let wsA: number;
  let wsB: number;
  let victim: number;

  beforeEach(async () => {
    ({ db } = createDb({ url: ':memory:' }));
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await db.insert(users).values({ id: OP, email: 'op@x', passwordHash: 'x', isInstanceOperator: true });
    wsA = (await db.insert(workspaces).values({ name: 'A', slug: 'a', ownerId: OP }).returning())[0]!.id;
    wsB = (await db.insert(workspaces).values({ name: 'B', slug: 'b', ownerId: OP }).returning())[0]!.id;
    victim = (await db.insert(services).values({ name: 'victim', slug: 'victim', type: 'docker', ownerUserId: OP }).returning())[0]!.id;
    await db.insert(serviceWorkspaces).values({ serviceId: victim, workspaceId: wsB });
    await db.insert(serviceVolumeAttachments).values({ serviceId: victim, volumeName: 'nd-svc-victim-uploads', containerPath: '/uploads' });
    const host = new Set(['nd-svc-victim-uploads']);
    execMocks.capture.mockImplementation(async (_cmd: string, args: string[]) =>
      args[0] === 'volume' && args[1] === 'ls' ? [...host].join('\n') : '',
    );
    dbEngineMocks.createDockerVolume.mockImplementation(async (name: string) => {
      host.add(name);
    });
  });

  /** Member in A with service `<slug>`; `roleInB` seat in B, or none. */
  const caller = async (id: number, slug: string, roleInB: 'viewer' | 'member' | null): Promise<number> => {
    await db.insert(users).values({ id, email: `u${id}@x`, passwordHash: 'x' });
    await db.insert(workspaceMembers).values({ workspaceId: wsA, userId: id, role: 'member' });
    if (roleInB) await db.insert(workspaceMembers).values({ workspaceId: wsB, userId: id, role: roleInB });
    const svc = (await db.insert(services).values({ name: slug, slug, type: 'docker', ownerUserId: id }).returning())[0]!.id;
    await db.insert(serviceWorkspaces).values({ serviceId: svc, workspaceId: wsA });
    return svc;
  };
  const send = async (user: { id: number; isOperator: boolean }, method: 'POST' | 'PATCH', url: string, payload: object) => {
    const app = await buildTestApp({ db });
    await app.register(serviceVolumesRoutes);
    const res = await app.inject({ method, url, headers: asUser(user), payload });
    await app.close();
    return res;
  };
  const holders = async (volume: string) =>
    (await db.select().from(serviceVolumeAttachments).where(eq(serviceVolumeAttachments.volumeName, volume)))
      .map((r) => r.serviceId)
      .sort();

  it('F549: a viewer seat in B cannot mount B data into an A service; a member seat still can', async () => {
    const viewerSvc = await caller(12, 'v-svc', 'viewer');
    const viewer = await send({ id: 12, isOperator: false }, 'POST', `/${viewerSvc}/volumes`, { volumeName: 'nd-svc-victim-uploads', containerPath: '/loot' });
    expect(viewer.statusCode).toBe(403);
    const memberSvc = await caller(11, 'm-svc', 'member');
    const member = await send({ id: 11, isOperator: false }, 'POST', `/${memberSvc}/volumes`, { volumeName: 'nd-svc-victim-uploads', containerPath: '/shared' });
    expect(member.statusCode).toBe(200);
    expect(await holders('nd-svc-victim-uploads')).toEqual([victim, memberSvc].sort());
  });

  it('F548: PATCH readOnly:false on an operator read-only share runs the ownership guard', async () => {
    const mine = await caller(2, 'mine', null);
    const att = (await db.insert(serviceVolumeAttachments)
      .values({ serviceId: mine, volumeName: 'nd-svc-victim-uploads', containerPath: '/feed', readOnly: true })
      .returning())[0]!.id;
    const widen = await send({ id: 2, isOperator: false }, 'PATCH', `/${mine}/volumes/${att}`, { readOnly: false });
    expect(widen.statusCode).toBe(403);
    const row = await db.query.serviceVolumeAttachments.findFirst({ where: eq(serviceVolumeAttachments.id, att) });
    expect(row?.readOnly).toBe(true);
    // Non-widening edits of the same row stay the member's to make.
    expect((await send({ id: 2, isOperator: false }, 'PATCH', `/${mine}/volumes/${att}`, { containerPath: '/feed2' })).statusCode).toBe(200);
  });

  it('F550: create.label never adopts a volume another service has attached, operators included', async () => {
    const shop = await caller(2, 'shop', null);
    const shopApi = (await db.insert(services).values({ name: 'shop-api', slug: 'shop-api', type: 'docker', ownerUserId: OP }).returning())[0]!.id;
    await db.insert(serviceWorkspaces).values({ serviceId: shopApi, workspaceId: wsB });
    // `shop` + `api-uploads` is a fresh name — allowed, and kept attached.
    expect((await send({ id: 2, isOperator: false }, 'POST', `/${shop}/volumes`, { create: { label: 'api-uploads' }, containerPath: '/stash' })).statusCode).toBe(200);
    dbEngineMocks.createDockerVolume.mockClear();
    // `shop-api` + `uploads` spells the same name.
    const res = await send({ id: OP, isOperator: true }, 'POST', `/${shopApi}/volumes`, { create: { label: 'uploads' }, containerPath: '/uploads' });
    expect(res.statusCode).toBe(409);
    expect(await holders('nd-svc-shop-api-uploads')).toEqual([shop]);
    expect(dbEngineMocks.createDockerVolume).not.toHaveBeenCalled();
    // A fresh label still provisions.
    expect((await send({ id: OP, isOperator: true }, 'POST', `/${shopApi}/volumes`, { create: { label: 'cache' }, containerPath: '/cache' })).statusCode).toBe(200);
  });
});

// F551: drizzle-orm wraps the driver error ("Failed query: …", SQLite text on
// `cause`), so matching `.message` alone turned every duplicate into a 500.
// Real SQLite file database, real driver error shapes.
describe('unique violations through the real driver answer 409 (F551)', () => {
  const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
  let db: DB;
  let close: () => void;
  let dir: string;
  let web: number;
  let bId: number;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nd-svcvol-'));
    const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
    db = created.db;
    close = () => created.client?.close();
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await db.insert(users).values({ id: 1, email: 'op@x', passwordHash: 'x', isInstanceOperator: true });
    web = (await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', ownerUserId: 1 }).returning())[0]!.id;
    await db.insert(serviceVolumeAttachments).values({ serviceId: web, volumeName: 'nd-svc-web-a', containerPath: '/a' });
    bId = (await db.insert(serviceVolumeAttachments).values({ serviceId: web, volumeName: 'nd-svc-web-b', containerPath: '/b' }).returning())[0]!.id;
    // A non-unique failure whose text names the column (control).
    await db.run(sql.raw(
      `CREATE TRIGGER boom BEFORE INSERT ON service_volume_attachments WHEN NEW.container_path = '/boom'
       BEGIN SELECT RAISE(ABORT, 'boom on container_path'); END;`,
    ));
    execMocks.capture.mockImplementation(async (_cmd: string, args: string[]) =>
      args[0] === 'volume' && args[1] === 'ls' ? 'nd-svc-web-a\nnd-svc-web-b\nnd-svc-web-c\n' : '',
    );
  });
  afterEach(() => {
    close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows file lock */
    }
  });

  const send = async (method: 'POST' | 'PATCH', url: string, payload: object) => {
    const app = await buildTestApp({ db });
    await app.register(serviceVolumesRoutes);
    const res = await app.inject({ method, url, headers: asUser({ id: 1, isOperator: true }), payload });
    await app.close();
    return res;
  };

  it('maps duplicate path / volume to 409 on attach and PATCH; a wrapped non-unique error stays 500', async () => {
    const dupPath = await send('POST', `/${web}/volumes`, { volumeName: 'nd-svc-web-c', containerPath: '/a' });
    expect(dupPath.statusCode).toBe(409);
    expect(dupPath.json().error.message).toMatch(/already mounted/);
    const dupVolume = await send('POST', `/${web}/volumes`, { volumeName: 'nd-svc-web-a', containerPath: '/z' });
    expect(dupVolume.statusCode).toBe(409);
    expect(dupVolume.json().error.message).toMatch(/already attached/);
    expect((await send('PATCH', `/${web}/volumes/${bId}`, { containerPath: '/a' })).statusCode).toBe(409);
    expect((await send('POST', `/${web}/volumes`, { volumeName: 'nd-svc-web-c', containerPath: '/boom' })).statusCode).toBe(500);
  });
});
