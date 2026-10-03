import { describe, expect, it, vi } from 'vitest';

const execMocks = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../../src/lib/exec.js', () => execMocks);

import { listManagedVolumeNames, listUserNetworks, networkMembers, containerRunning, resolveVolumeOwner, resolveVolumeOwnerWithSharing } from '../../src/lib/inventory.js';
import { dbRow, svcRow, NOW } from '../helpers.js';

describe('lib/inventory', () => {
  it('resolveVolumeOwner maps service, database and non-managed names', () => {
    const svcs = [svcRow({ id: 2, slug: 'web', name: 'web', runtimeId: 'web-2' })];
    const dbs = [dbRow({ id: 3, slug: 'pg', name: 'pg', engine: 'postgres', containerName: 'nd-db-pg' })];
    expect(resolveVolumeOwner(svcs, dbs, 'nd-svc-web-data')).toEqual({ kind: 'service', refId: 2, name: 'web', containerName: 'web-2' });
    expect(resolveVolumeOwner(svcs, dbs, 'nd-db-pg-data')).toEqual({ kind: 'database', refId: 3, name: 'pg', engine: 'postgres', containerName: 'nd-db-pg' });
    expect(resolveVolumeOwner(svcs, dbs, 'nd-svc-ghost-data')).toBeNull();
    expect(resolveVolumeOwner(svcs, dbs, 'some-other-volume')).toBeNull(); // non-managed prefix
  });

  it('resolveVolumeOwner consults the attachment table before the legacy heuristic', () => {
    // The volume name does NOT match the legacy `nd-svc-<slug>-data` shape
    // (it has an extra `-uploads` suffix), so without the attachment
    // table the resolver would return null.
    const svcs = [svcRow({ id: 2, slug: 'web', name: 'web', runtimeId: 'web-2' })];
    const dbs: never[] = [];
    const attachments = [
      {
        id: 9,
        serviceId: 2,
        volumeName: 'nd-svc-web-uploads',
        containerPath: '/uploads',
        readOnly: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    expect(resolveVolumeOwner(svcs, dbs, 'nd-svc-web-uploads', attachments)).toEqual({
      kind: 'service',
      refId: 2,
      name: 'web',
      containerName: 'web-2',
    });
  });

  it('resolveVolumeOwner falls back to the legacy heuristic when the attachment table has no row', () => {
    // No row in the table, but the volume still matches `nd-svc-<slug>-data`.
    const svcs = [svcRow({ id: 2, slug: 'web', name: 'web', runtimeId: 'web-2' })];
    expect(resolveVolumeOwner(svcs, [], 'nd-svc-web-data', [])).toEqual({
      kind: 'service',
      refId: 2,
      name: 'web',
      containerName: 'web-2',
    });
  });

  it('resolveVolumeOwnerWithSharing reports how many other services also attach the volume', () => {
    const svcs = [
      svcRow({ id: 2, slug: 'web', name: 'web', runtimeId: 'web-2' }),
      svcRow({ id: 5, slug: 'api', name: 'api', runtimeId: 'api-1' }),
      svcRow({ id: 8, slug: 'worker', name: 'worker', runtimeId: 'worker-1' }),
    ];
    const atts = [
      { id: 1, serviceId: 2, volumeName: 'shared-data', containerPath: '/data', readOnly: false, createdAt: NOW, updatedAt: NOW },
      { id: 2, serviceId: 5, volumeName: 'shared-data', containerPath: '/mnt', readOnly: false, createdAt: NOW, updatedAt: NOW },
      { id: 3, serviceId: 8, volumeName: 'shared-data', containerPath: '/x', readOnly: false, createdAt: NOW, updatedAt: NOW },
    ];
    expect(resolveVolumeOwnerWithSharing(svcs, [], 'shared-data', atts)).toEqual({
      owner: { kind: 'service', refId: 2, name: 'web', containerName: 'web-2' },
      sharedWith: 2,
    });
  });

  it('listManagedVolumeNames filters to nd- prefixed volumes', async () => {
    execMocks.capture.mockResolvedValue('nd-svc-web-data\nrandom-vol\nnd-db-pg-data\n');
    await expect(listManagedVolumeNames()).resolves.toEqual(['nd-svc-web-data', 'nd-db-pg-data']);
  });

  it('listUserNetworks drops builtin networks', async () => {
    execMocks.capture.mockResolvedValue('bridge\tbridge\nhost\thost\nnone\tbridge\nninedeploy\tbridge\n');
    await expect(listUserNetworks()).resolves.toEqual([{ name: 'ninedeploy', driver: 'bridge' }]);
  });

  it('networkMembers parses the inspect output', async () => {
    execMocks.capture.mockResolvedValue('web-2 ninedeploy-traefik ');
    await expect(networkMembers('ninedeploy')).resolves.toEqual(['web-2', 'ninedeploy-traefik']);
  });

  it('containerRunning treats docker failures as not-running', async () => {
    execMocks.capture.mockRejectedValue(new Error('daemon down'));
    await expect(containerRunning('web-2')).resolves.toBe(false);
    await expect(containerRunning(null)).resolves.toBe(false);
    execMocks.capture.mockResolvedValue('  ');
    await expect(containerRunning('web-2')).resolves.toBe(false);
  });
});
