import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, runMigrations, services, users, type DB, type Service } from '@ninedeploy/db';

const barrier = vi.hoisted(() => ({ enabled: false, reads: 0, arrived: () => {}, release: Promise.resolve() as Promise<void>, forced: null as unknown }));
vi.mock('../src/lib/settings.js', async original => {
  const actual = await original<typeof import('../src/lib/settings.js')>();
  return { ...actual, getSettingJson: async (...args: Parameters<typeof actual.getSettingJson>) => {
    const value = await actual.getSettingJson(...args);
    if (barrier.forced !== null && args[1] === 'pending_changes:5') return barrier.forced;
    if (barrier.enabled && args[1] === 'pending_changes:5' && barrier.reads < 2) {
      barrier.reads++;
      if (barrier.reads === 2) barrier.arrived();
      await barrier.release;
    }
    return value;
  } };
});
const { clearApplied, readPending, setStaging, stageChanges } = await import('../src/lib/pendingChanges.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');
let db: DB;
let service: Service;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(users).values({ id: 1, email: 'owner@example.test', passwordHash: 'x' });
  const [row] = await db.insert(services).values({ id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 1, port: 3000, healthPath: '/' } as never).returning();
  service = row!;
});
afterEach(() => { barrier.enabled = false; barrier.forced = null; closeMigratedDb(db); });

async function concurrent(first: () => Promise<unknown>, second: () => Promise<unknown>) {
  let release!: () => void;
  const bothRead = new Promise<void>(resolve => { barrier.arrived = resolve; });
  barrier.release = new Promise<void>(resolve => { release = resolve; });
  barrier.reads = 0; barrier.enabled = true;
  const pending = Promise.all([first(), second()]);
  await bothRead;
  release();
  await pending;
  barrier.enabled = false;
}
const view = { fields: { port: 3000, healthPath: '/' }, build: null };

it('retains two independent edits staged concurrently against the same tray', async () => {
  await concurrent(() => stageChanges(db, service, { port: 8080 }, 1, view), () => stageChanges(db, service, { healthPath: '/ready' }, 1, view));
  expect((await readPending(db, 5)).patch).toEqual({ port: 8080, healthPath: '/ready' });
});

it('retains an edit when staging is switched on concurrently', async () => {
  await concurrent(() => stageChanges(db, service, { port: 8080 }, 1, view), () => setStaging(db, service, true, view));
  expect(await readPending(db, 5)).toMatchObject({ staging: true, patch: { port: 8080 } });
});

it('preserves a new edit when an older applied snapshot is cleared concurrently', async () => {
  await stageChanges(db, service, { port: 8080 }, 1, view);
  const applied = await readPending(db, 5);
  await concurrent(() => clearApplied(db, 5, applied), () => stageChanges(db, service, { healthPath: '/ready' }, 1, view));
  expect((await readPending(db, 5)).patch).toEqual({ healthPath: '/ready' });
});

it('retains independent edits from two database connections', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'nd-pending-cas-'));
  const url = `file:${path.join(directory, 'panel.db').split(path.sep).join('/')}`;
  const a = createDb({ url });
  const b = createDb({ url });
  try {
    await runMigrations(a.db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
    await a.db.insert(users).values({ id: 1, email: 'owner@example.test', passwordHash: 'x' });
    const [row] = await a.db.insert(services).values({ id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 1, port: 3000, healthPath: '/' } as never).returning();
    await concurrent(() => stageChanges(a.db, row!, { port: 8080 }, 1, view), () => stageChanges(b.db, row!, { healthPath: '/ready' }, 1, view));
    expect((await readPending(a.db, 5)).patch).toEqual({ port: 8080, healthPath: '/ready' });
  } finally {
    a.client?.close(); b.client?.close();
    // libsql keeps the connection a transaction replaced open past close(); Windows then refuses to
    // delete the file (EPERM). Only the temp directory's removal is skipped there; Linux removes it.
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      if (process.platform !== 'win32') throw err;
    }
  }
});

it('returns a conflict after bounded contention without replacing the latest tray', async () => {
  await stageChanges(db, service, { port: 8080 }, 1, view);
  const prior = await db.query.settings.findFirst({ where: (s, { eq }) => eq(s.key, 'pending_changes:5') });
  await stageChanges(db, service, { healthPath: '/ready' }, 1, view);
  barrier.forced = prior!.value;
  try {
    await expect(stageChanges(db, service, { port: 8081 }, 1, view)).rejects.toMatchObject({ statusCode: 409, code: 'pending_busy' });
  } finally {
    barrier.forced = null;
  }
  expect((await readPending(db, 5)).patch).toEqual({ port: 8080, healthPath: '/ready' });
});
