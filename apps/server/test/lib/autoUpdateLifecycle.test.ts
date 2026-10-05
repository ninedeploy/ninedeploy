import { expect, it, vi } from 'vitest';
import { sweepAutoUpdates } from '../../src/lib/autoUpdate.js';
import { createFakeDb, svcRow } from '../helpers.js';
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
async function gatedUpdateCase(change: 'none' | 'disable' | 'image' | 'stop' | 'delete' | 'digest', baseline = false) {
  let current: ReturnType<typeof svcRow> | null = svcRow({ id: 5, image: 'nginx:latest', type: 'docker', status: 'running', autoUpdate: true, autoUpdateDigest: baseline ? null : 'sha256:old', ownerUserId: null });
  const inserts: unknown[] = [], updates: unknown[] = [];
  const db = createFakeDb({
    findMany: { services: () => current ? [{ ...current }] : [] },
    insert: { deployments: (value: unknown) => { inserts.push(value); return [{ id: 10 }]; } },
    update: { services: (value: unknown) => { updates.push(value); if (current) Object.assign(current, value); return current ? [current] : []; } },
  });
  let started!: () => void, release!: (digest: string) => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<string>((resolve) => { release = resolve; });
  const pending = sweepAutoUpdates(db, async () => { started(); return gate; });
  await began;
  if (change === 'disable') { current!.autoUpdate = false; current!.autoUpdateDigest = null; }
  if (change === 'image') current!.image = 'nginx:stable';
  if (change === 'stop') current!.status = 'stopped';
  if (change === 'digest') current!.autoUpdateDigest = 'sha256:other';
  if (change === 'delete') current = null;
  release('sha256:new');
  const result = await pending;
  return { result, inserted: inserts.length, updated: updates.length, digest: current?.autoUpdateDigest ?? null };
}

it.each(['disable', 'image', 'stop', 'delete', 'digest'] as const)('F77: probe completing after %s publishes nothing', async (change) => {
  const result = await gatedUpdateCase(change);
  expect(result.inserted).toBe(0);
  expect(result.updated).toBe(0);
  expect(result.result).toEqual({ probed: 1, skipped: 1, enqueued: 0 });
});
it('F77: a disabled first observation cannot restore the cleared baseline', async () => {
  const result = await gatedUpdateCase('disable', true);
  expect(result.updated).toBe(0);
  expect(result.digest).toBeNull();
});
it('F77: an unchanged service still records a baseline and queues a changed image', async () => {
  const baseline = await gatedUpdateCase('none', true);
  expect(baseline.inserted).toBe(0);
  expect(baseline.updated).toBe(1);
  const changed = await gatedUpdateCase('none');
  expect(changed.inserted).toBe(1);
  expect(changed.result.enqueued).toBe(1);
});
