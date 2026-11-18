import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDb, runMigrations, services, users, volumeImports } from '@ninedeploy/db';
import { expireStaleVolumeImports, STALE_VOLUME_IMPORT_MS } from '../../src/lib/volumeImport.js';

const NOW = Date.UTC(2026, 10, 16, 12);
const OLD = new Date(NOW - STALE_VOLUME_IMPORT_MS - 60_000);
let created: ReturnType<typeof createDb>;
let directory: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'nd-volume-expiry-race-'));
  created = createDb({ url: ':memory:' });
  await created.ready;
  await runMigrations(created.db, fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url)));
  await created.db.insert(users).values({ id: 1, email: 'volume-expiry@example.test', passwordHash: 'x' });
  await created.db.insert(services).values({ id: 1, ownerUserId: 1, name: 'app', slug: 'app', type: 'docker', volumeMount: '/data' });
});

afterEach(() => {
  vi.restoreAllMocks();
  created.client?.close();
  if (dirname(directory) !== tmpdir() || !basename(directory).startsWith('nd-volume-expiry-race-')) throw new Error('Invalid volume expiry fixture cleanup path');
  rmSync(directory, { recursive: true, force: true });
});

async function seed(id: number, status: 'uploading' | 'pending' = 'uploading', updatedAt = OLD) {
  const stagingPath = join(directory, `${id}.part`);
  writeFileSync(stagingPath, 'dump');
  await created.db.insert(volumeImports).values({ id, serviceId: 1, volumeName: 'nd-svc-app-data', status, sizeBytes: 8, receivedBytes: 4, chunkSize: 4, sha256: 'a'.repeat(64), stagingPath });
  await created.db.update(volumeImports).set({ updatedAt }).where(eq(volumeImports.id, id));
  return stagingPath;
}

function gateSelection() {
  const selected = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const query = created.db.query.volumeImports;
  const original = query.findMany.bind(query);
  vi.spyOn(query, 'findMany').mockImplementation(async (...args) => {
    const rows = await original(...args);
    selected.resolve();
    await release.promise;
    return rows;
  });
  return { selected: selected.promise, release: () => release.resolve() };
}

it.each(['uploading', 'pending'] as const)('retains refreshed volume staging when a chunk leaves the import %s', async status => {
  const renewed = await seed(1);
  const stale = await seed(2, 'pending');
  const gate = gateSelection();
  const sweeping = expireStaleVolumeImports(created.db, NOW);
  try {
    await gate.selected;
    // Match the chunk route's update after the old snapshot: a later chunk
    // keeps uploading, while the final chunk switches to pending.
    await created.db.update(volumeImports).set({ status, updatedAt: new Date(NOW), receivedBytes: status === 'pending' ? 8 : 4 }).where(eq(volumeImports.id, 1));
  } finally { gate.release(); }
  const expired = await sweeping;
  const row = await created.db.query.volumeImports.findFirst({ where: eq(volumeImports.id, 1) });
  const control = expired.includes(2) && !existsSync(stale);
  const retained = row?.status === status && existsSync(renewed) && !expired.includes(1);
  console.log(`CONTROL: unchanged stale volume import expires = ${control}`);
  console.log(`EXPECTED: refreshed volume staging retained | ACTUAL: status=${row?.status}, file=${existsSync(renewed)}, expired=${expired.join(',')}`);
  console.log(retained && control ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
  expect(control).toBe(true);
  expect(retained).toBe(true);
});

it('keeps the exact cutoff and fresh rows, expires older rows only once', async () => {
  const boundary = await seed(1, 'pending', new Date(NOW - STALE_VOLUME_IMPORT_MS));
  const fresh = await seed(2, 'uploading', new Date(NOW));
  const stale = await seed(3);
  expect(await expireStaleVolumeImports(created.db, NOW)).toEqual([3]);
  expect(existsSync(boundary)).toBe(true);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(stale)).toBe(false);
  expect(await expireStaleVolumeImports(created.db, NOW)).toEqual([]);
});

it('keeps staging when a selected pending import starts before expiry', async () => {
  const staging = await seed(1, 'pending');
  const gate = gateSelection();
  const sweeping = expireStaleVolumeImports(created.db, NOW);
  try {
    await gate.selected;
    await created.db.update(volumeImports).set({ status: 'running', updatedAt: new Date(NOW) }).where(eq(volumeImports.id, 1));
  } finally { gate.release(); }
  expect(await sweeping).toEqual([]);
  expect(existsSync(staging)).toBe(true);
});

it('rechecks the cutoff even when the refreshed timestamp is exactly the boundary', async () => {
  const staging = await seed(1);
  const gate = gateSelection();
  const sweeping = expireStaleVolumeImports(created.db, NOW);
  try {
    await gate.selected;
    await created.db.update(volumeImports).set({ updatedAt: new Date(NOW - STALE_VOLUME_IMPORT_MS) }).where(eq(volumeImports.id, 1));
  } finally { gate.release(); }
  expect(await sweeping).toEqual([]);
  expect(existsSync(staging)).toBe(true);
});
