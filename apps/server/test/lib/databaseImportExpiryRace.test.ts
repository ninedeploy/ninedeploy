import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDb, databases, databaseImports, runMigrations, users } from '@ninedeploy/db';
import { expireStaleImports, STALE_IMPORT_MS } from '../../src/lib/databaseImport.js';

const NOW = Date.UTC(2026, 10, 16, 12);
const OLD = new Date(NOW - STALE_IMPORT_MS - 60_000);
let created: ReturnType<typeof createDb>;
let directory: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'nd-import-expiry-race-'));
  created = createDb({ url: ':memory:' });
  await created.ready;
  await runMigrations(created.db, fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url)));
  await created.db.insert(users).values({ id: 1, email: 'expiry@example.test', passwordHash: 'x' });
  await created.db.insert(databases).values({ id: 1, ownerUserId: 1, name: 'app', slug: 'app', engine: 'postgres', passwordEncrypted: 'x' });
});

afterEach(() => {
  vi.restoreAllMocks();
  created.client?.close();
  if (dirname(directory) !== tmpdir() || !basename(directory).startsWith('nd-import-expiry-race-')) throw new Error('Invalid expiry fixture cleanup path');
  rmSync(directory, { recursive: true, force: true });
});

async function seed(id: number, status: 'uploading' | 'pending' = 'uploading', updatedAt = OLD) {
  const stagingPath = join(directory, `${id}.part`);
  writeFileSync(stagingPath, 'dump');
  await created.db.insert(databaseImports).values({ id, databaseId: 1, source: 'upload', status, sizeBytes: 8, receivedBytes: 4, chunkSize: 4, stagingPath, updatedAt });
  // The schema's insert hook sets updated_at: pin the fixture explicitly.
  await created.db.update(databaseImports).set({ updatedAt }).where(eq(databaseImports.id, id));
  return stagingPath;
}

function gateSelection() {
  const selected = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const query = created.db.query.databaseImports;
  const original = query.findMany.bind(query);
  vi.spyOn(query, 'findMany').mockImplementation(async (...args) => {
    const rows = await original(...args);
    selected.resolve();
    await release.promise;
    return rows;
  });
  return { selected: selected.promise, release: () => release.resolve() };
}

it.each(['uploading', 'pending'] as const)('retains a refreshed %s import selected by an older expiry scan', async status => {
  const renewed = await seed(1, status);
  const stale = await seed(2, status);
  const gate = gateSelection();
  const sweeping = expireStaleImports(created.db, NOW);
  try {
    await gate.selected;
    // A chunk acknowledgement or completed upload refreshes the real row
    // after the sweep has read its old snapshot, before its expiry update.
    await created.db.update(databaseImports).set({ updatedAt: new Date(NOW), receivedBytes: 8 }).where(eq(databaseImports.id, 1));
  } finally { gate.release(); }
  const expired = await sweeping;
  const row = await created.db.query.databaseImports.findFirst({ where: eq(databaseImports.id, 1) });
  const control = expired.includes(2) && !existsSync(stale);
  const retained = row?.status === status && existsSync(renewed) && !expired.includes(1);
  console.log(`CONTROL: unchanged stale import expires = ${control}`);
  console.log(`EXPECTED: refreshed import and staging retained | ACTUAL: status=${row?.status}, file=${existsSync(renewed)}, expired=${expired.join(',')}`);
  console.log(retained && control ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
  expect(control).toBe(true);
  expect(retained).toBe(true);
});

it('keeps the exact cutoff and fresh rows, expires older rows once', async () => {
  const boundary = await seed(1, 'pending', new Date(NOW - STALE_IMPORT_MS));
  const fresh = await seed(2, 'uploading', new Date(NOW));
  const stale = await seed(3);
  expect(await expireStaleImports(created.db, NOW)).toEqual([3]);
  expect(existsSync(boundary)).toBe(true);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(stale)).toBe(false);
  expect(await expireStaleImports(created.db, NOW)).toEqual([]);
});

it('keeps an import that starts while the expiry scan is paused', async () => {
  const staging = await seed(1, 'pending');
  const gate = gateSelection();
  const sweeping = expireStaleImports(created.db, NOW);
  try {
    await gate.selected;
    await created.db.update(databaseImports).set({ status: 'running', updatedAt: new Date(NOW) }).where(eq(databaseImports.id, 1));
  } finally { gate.release(); }
  expect(await sweeping).toEqual([]);
  expect(existsSync(staging)).toBe(true);
});
