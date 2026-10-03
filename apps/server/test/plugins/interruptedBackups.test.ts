/**
 * r543 — backups and drills a stopped process left `running` are marked
 * failed. A manual DB backup, a volume backup and a backup drill each insert a
 * `running` row and flip it when they finish; a crash or restart in between
 * left the row `running` forever. Real migrated SQLite: the sweep is a pair
 * of conditional UPDATEs over Date and unix-seconds columns.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, backupDrills, backups, createDb, databases, jobRuns, scheduledJobs, services, type DB } from '@ninedeploy/db';

// The tick's docker prune must never reach a real daemon.
vi.mock('../../src/lib/exec.js', () => ({ run: vi.fn(async () => undefined) }));

const {
  default: housekeepingPlugin,
  failInterruptedOperations,
  failInterruptedJobRuns,
  INTERRUPTED_JOB_RUN_OUTPUT,
} = await import('../../src/plugins/housekeeping.js');

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));
const HOUR = 60 * 60 * 1000;

let db: DB;
let close: () => void;
let dir: string;
let databaseId: number;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-interrupted-'));
  const created = createDb({ url: `file:${path.join(dir, 'test.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const [d] = await db.insert(databases).values({ name: 'pg', slug: 'pg', engine: 'postgres', passwordEncrypted: 'x' }).returning();
  databaseId = d!.id;
});

afterEach(() => {
  close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

async function seed() {
  const ago = (ms: number) => new Date(Date.now() - ms);
  const [manual] = await db.insert(backups).values({ databaseId, scope: 'db', status: 'running', path: '/m', createdAt: ago(2 * HOUR) }).returning();
  const [volume] = await db
    .insert(backups)
    .values({ volumeName: 'nd-svc-a-data', scope: 'volumes', status: 'running', path: '/v', createdAt: ago(30 * HOUR) })
    .returning();
  const [done] = await db.insert(backups).values({ databaseId, scope: 'db', status: 'completed', path: '/d', createdAt: ago(40 * HOUR) }).returning();
  const [drill] = await db
    .insert(backupDrills)
    .values({ databaseId, backupId: done!.id, status: 'running', engine: 'postgres', startedAt: ago(30 * HOUR) })
    .returning();
  const [passed] = await db
    .insert(backupDrills)
    .values({ databaseId, backupId: done!.id, status: 'passed', engine: 'postgres', startedAt: ago(30 * HOUR) })
    .returning();
  return { manual: manual!, volume: volume!, done: done!, drill: drill!, passed: passed! };
}

const statusOf = async (id: number) => (await db.query.backups.findFirst({ where: eq(backups.id, id) }))?.status;

describe('r543: interrupted backups and drills', () => {
  it('marks running rows older than the cutoff failed / unverifiable and leaves finished and newer ones alone', async () => {
    const rows = await seed();
    const result = await failInterruptedOperations(db, new Date(Date.now() - 24 * HOUR));

    expect(result).toEqual({ backups: [rows.volume.id], drills: [rows.drill.id] });
    expect(await statusOf(rows.volume.id)).toBe('failed');
    expect(await statusOf(rows.manual.id)).toBe('running'); // 2h old: could still be dumping
    expect(await statusOf(rows.done.id)).toBe('completed');
    const drill = await db.query.backupDrills.findFirst({ where: eq(backupDrills.id, rows.drill.id) });
    expect(drill).toMatchObject({ status: 'unverifiable', error: expect.stringMatching(/interrupted/) });
    expect(drill?.completedAt).toBeGreaterThan(0);
    expect((await db.query.backupDrills.findFirst({ where: eq(backupDrills.id, rows.passed.id) }))?.status).toBe('passed');

    const trail = await db.select().from(auditLog).where(eq(auditLog.action, 'backup.interrupted'));
    expect(trail).toHaveLength(1);
    expect(trail[0]!.meta).toEqual({ backupIds: [rows.volume.id], drillIds: [rows.drill.id] });
  });

  it('is a no-op (and audits nothing) when nothing is stuck', async () => {
    expect(await failInterruptedOperations(db, new Date())).toEqual({ backups: [], drills: [] });
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it('the housekeeping plugin heals every row left running by the previous process at boot', async () => {
    const rows = await seed();
    const app = Fastify({ logger: false });
    app.decorate('db', db);
    await app.register(housekeepingPlugin);
    await app.ready();
    try {
      // Boot cutoff is "now": even the 2-hour-old manual backup cannot belong
      // to this process, which has not run anything yet.
      expect(await statusOf(rows.manual.id)).toBe('failed');
      expect(await statusOf(rows.volume.id)).toBe('failed');
      expect((await db.query.backupDrills.findFirst({ where: eq(backupDrills.id, rows.drill.id) }))?.status).toBe(
        'unverifiable',
      );
    } finally {
      await app.close();
    }
  });
});

// r594: r543 closed backups and drills only. An exec job inserts a `running`
// job_runs row and writes its outcome when `docker exec` returns, so a crash
// in between left the run "in progress" in the job history forever.
describe('r594: interrupted scheduled-job runs', () => {
  async function seedRuns() {
    const ago = (ms: number) => new Date(Date.now() - ms);
    const [svc] = await db.insert(services).values({ name: 's', slug: 's' }).returning();
    const [job] = await db.insert(scheduledJobs).values({ serviceId: svc!.id, name: 'nightly', cron: '0 3 * * *', kind: 'exec', command: 'true' }).returning();
    const insert = async (status: 'running' | 'completed', createdAt: Date) =>
      (await db.insert(jobRuns).values({ jobId: job!.id, status, startedAt: createdAt, createdAt }).returning())[0]!;
    return {
      recent: await insert('running', ago(2 * HOUR)),
      stale: await insert('running', ago(30 * HOUR)),
      done: await insert('completed', ago(40 * HOUR)),
    };
  }
  const runOf = async (id: number) => db.query.jobRuns.findFirst({ where: eq(jobRuns.id, id) });

  it('the hourly backstop fails runs older than the cutoff with a clear output and leaves the rest alone', async () => {
    const rows = await seedRuns();
    expect(await failInterruptedJobRuns(db, new Date(Date.now() - 24 * HOUR))).toEqual([rows.stale.id]);

    const stale = await runOf(rows.stale.id);
    expect(stale).toMatchObject({ status: 'failed', output: INTERRUPTED_JOB_RUN_OUTPUT, exitCode: null });
    expect(stale?.finishedAt).toBeInstanceOf(Date);
    expect((await runOf(rows.recent.id))?.status).toBe('running'); // 2h old: could still be executing
    expect((await runOf(rows.done.id))?.status).toBe('completed');

    const trail = await db.select().from(auditLog).where(eq(auditLog.action, 'job.interrupted'));
    expect(trail).toHaveLength(1);
    expect(trail[0]!.meta).toEqual({ jobRunIds: [rows.stale.id] });
  });

  it('is a no-op (and audits nothing) when nothing is stuck', async () => {
    expect(await failInterruptedJobRuns(db, new Date())).toEqual([]);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it('the housekeeping plugin closes every run left running by the previous process at boot', async () => {
    const rows = await seedRuns();
    const app = Fastify({ logger: false });
    app.decorate('db', db);
    await app.register(housekeepingPlugin);
    await app.ready();
    try {
      expect((await runOf(rows.recent.id))?.status).toBe('failed');
      expect((await runOf(rows.stale.id))?.status).toBe('failed');
      expect((await runOf(rows.done.id))?.status).toBe('completed');
    } finally {
      await app.close();
    }
  });
});
