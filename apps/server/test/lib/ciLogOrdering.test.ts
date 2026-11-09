import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ciAttempts, ciJobs, ciRunners, services, type DB } from '@ninedeploy/db';
import { appendLog, readLog } from '../../src/lib/ci.js';
import { closeMigratedDb, migratedDb } from './githubAppKit.js';
let db: DB; let jobId = 500_000;
beforeEach(async () => {
  jobId++; db = await migratedDb();
  await db.insert(services).values({ id: 1, name: 'log fixture', slug: 'log-fixture', type: 'docker' });
  await db.insert(ciRunners).values({ id: 1, name: 'runner', tokenHash: 'fixture' });
  await db.insert(ciJobs).values({ id: jobId, serviceId: 1, image: 'alpine', script: 'true', status: 'running', attempts: 1, currentAttemptId: 1 });
  await db.insert(ciAttempts).values({ id: 1, jobId, runnerId: 1, number: 1, leaseHash: 'fixture', leaseExpiresAt: 1_800_000_000_000 });
});
afterEach(() => closeMigratedDb(db));
it('sequential chunks and replay preserve exact bytes', async () => {
  await appendLog(db, (await db.query.ciAttempts.findFirst())!, 1, 'first\n');
  expect(await appendLog(db, (await db.query.ciAttempts.findFirst())!, 1, 'ignored\n')).toEqual({ stored: false });
  await appendLog(db, (await db.query.ciAttempts.findFirst())!, 2, 'second\n');
  expect(readLog(jobId,1)).toBe('first\nsecond\n');
});
it('delayed metadata completion cannot invert the accepted file sequence', async () => {
  let enter!: () => void; let release!: () => void; let held = false;
  const ready = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = db.$client.execute.bind(db.$client);
  const spy = vi.spyOn(db.$client,'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
    const stmt = args[0]; const sql = typeof stmt === 'string' ? stmt : stmt.sql;
    const first = !held && /update "ci_attempts" set "log_bytes"|update "ci_attempts" set "log_seq"/i.test(sql);
    if (first) held = true;
    const result = await original(...args); if (first) { enter(); await gate; } return result;
  }) as typeof original);
  const first = appendLog(db, (await db.query.ciAttempts.findFirst())!, 1, 'first\n');
  let second: Promise<{ stored: boolean }> | undefined;
  try {
    await ready;
    second = appendLog(db, (await db.query.ciAttempts.findFirst())!, 2, 'second\n');
    // Native in-memory SQLite operations resolve through promises. These
    // explicit read checkpoints drain their continuations without any sleep.
    for (let i=0; i<10; i++) await db.query.ciAttempts.findFirst();
    release(); expect(await first).toEqual({ stored: true }); expect(await second).toEqual({ stored: true });
    const actual = readLog(jobId,1);
    console.log('EXPECTED:', JSON.stringify('first\nsecond\n'), 'ACTUAL:', JSON.stringify(actual));
    console.log(actual === 'first\nsecond\n' ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
    expect(actual).toBe('first\nsecond\n');
  } finally { release(); await first.catch(() => undefined); await second?.catch(() => undefined); spy.mockRestore(); }
});
it('overlapping retries with the same request snapshot acknowledge once', async () => {
  const snapshot = (await db.query.ciAttempts.findFirst())!;
  const outcomes = await Promise.allSettled([appendLog(db,snapshot,1,'once\n'), appendLog(db,snapshot,1,'once\n')]);
  console.log('EXPECTED: 2 acknowledgements; ACTUAL:', outcomes.filter(r => r.status === 'fulfilled').length);
  console.log(outcomes.every(r => r.status === 'fulfilled') ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
  expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(2);
  expect(readLog(jobId,1)).toBe('once\n');
});
