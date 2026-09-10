import { describe, expect, it, vi } from 'vitest';
import { sweepAutoUpdates } from '../../src/lib/autoUpdate.js';
import { createFakeDb, svcRow } from '../helpers.js';

const IMAGE_SVC = svcRow({
  id: 5,
  name: 'watched',
  slug: 'watched',
  type: 'docker',
  image: 'ghcr.io/acme/web:latest',
  status: 'running',
  autoUpdate: true,
  autoUpdateDigest: 'sha256:old',
});

function baseDb(services: Array<Record<string, unknown>>, deployments: Array<Record<string, unknown>> = []) {
  const updates: Array<Record<string, unknown>> = [];
  const inserts: Array<Record<string, unknown>> = [];
  const db = createFakeDb({
    findMany: { services },
    findFirst: { deployments: deployments[0] ?? null },
    insert: {
      deployments: (v: Record<string, unknown>) => {
        inserts.push(v);
        return [{ ...v, id: 99 }];
      },
    },
    update: {
      services: (v: Record<string, unknown>) => {
        updates.push(v);
        return [v];
      },
    },
  });
  return { db, updates, inserts };
}

const probeOf = (digest: string) => vi.fn().mockResolvedValue(digest);
const probeFails = vi.fn().mockRejectedValue(new Error('registry is unreachable'));

describe('sweepAutoUpdates', () => {
  it('enqueues a deploy when the digest moved and records the new baseline', async () => {
    const { db, updates, inserts } = baseDb([IMAGE_SVC]);
    const probe = probeOf('sha256:new');
    const result = await sweepAutoUpdates(db, probe);
    expect(result).toEqual({ probed: 1, enqueued: 1, skipped: 0 });
    expect(probe).toHaveBeenCalledWith('ghcr.io', 'acme/web', 'latest');
    expect(inserts[0]).toMatchObject({ serviceId: 5, status: 'queued', trigger: 'schedule' });
    expect(String(inserts[0]!.message)).toContain('Auto-update:');
    expect(updates.at(-1)).toMatchObject({ autoUpdateDigest: 'sha256:new' });
  });

  it('treats the first observation as a baseline only', async () => {
    const svc = { ...svcRow(IMAGE_SVC), autoUpdateDigest: null };
    const { db, updates, inserts } = baseDb([svc]);
    const result = await sweepAutoUpdates(db, probeOf('sha256:whatever'));
    expect(result.enqueued).toBe(0);
    expect(inserts).toHaveLength(0);
    expect(updates[0]).toMatchObject({ autoUpdateDigest: 'sha256:whatever' });
  });

  it('does nothing when the digest is unchanged', async () => {
    const { db, updates, inserts } = baseDb([IMAGE_SVC]);
    const result = await sweepAutoUpdates(db, probeOf('sha256:old'));
    expect(result.probed).toBe(1);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('skips without storing while a deployment is queued or in flight', async () => {
    const { db, updates, inserts } = baseDb(
      [IMAGE_SVC],
      [ { id: 40, serviceId: 5, status: 'queued' } ],
    );
    const result = await sweepAutoUpdates(db, probeOf('sha256:new'));
    expect(result.skipped).toBe(1);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('skips a service whose registry cannot be probed', async () => {
    const { db, inserts } = baseDb([IMAGE_SVC]);
    const result = await sweepAutoUpdates(db, probeFails);
    expect(result.skipped).toBe(1);
    expect(inserts).toHaveLength(0);
  });

  it('skips digest-pinned images — they can never move', async () => {
    const pinned = { ...svcRow(IMAGE_SVC), image: 'nginx@sha256:abc' };
    const { db } = baseDb([pinned]);
    const probe = probeOf('sha256:x');
    const result = await sweepAutoUpdates(db, probe);
    expect(result.skipped).toBe(1);
    expect(probe).not.toHaveBeenCalled();
  });

  it('only watches running, image-based, panel-host, opt-in services', async () => {
    const cases = [
      { ...svcRow(IMAGE_SVC), id: 1, status: 'stopped' },
      { ...svcRow(IMAGE_SVC), id: 2, image: null },
      { ...svcRow(IMAGE_SVC), id: 3, autoUpdate: false },
      { ...svcRow(IMAGE_SVC), id: 4, serverId: 3 },
      { ...svcRow(IMAGE_SVC), id: 6, type: 'compose' },
    ];
    const { db } = baseDb(cases);
    const probe = probeOf('sha256:new');
    const result = await sweepAutoUpdates(db, probe);
    expect(result).toEqual({ probed: 0, enqueued: 0, skipped: 0 });
    expect(probe).not.toHaveBeenCalled();
  });
});
