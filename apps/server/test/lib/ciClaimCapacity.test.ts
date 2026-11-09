import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ciJobs, ciRunners, services, type DB } from '@ninedeploy/db';
import { claimJob } from '../../src/lib/ci.js';
import { closeMigratedDb, migratedDb } from './githubAppKit.js';
let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(services).values({ id: 1, name: 'capacity fixture', slug: 'capacity-fixture', type: 'docker' });
  await db.insert(ciRunners).values({ id: 1, name: 'runner', tokenHash: 'synthetic', capacity: 1 });
  await db.insert(ciJobs).values([1, 2, 3].map(id => ({ id, serviceId: 1, image: 'alpine', script: 'true' })));
});
afterEach(() => closeMigratedDb(db));
it('sequential under-reported claims cannot exceed capacity', async () => {
  const runner = (await db.query.ciRunners.findFirst())!;
  expect(await claimJob(db, runner, { running: 0 })).not.toBeNull();
  expect(await claimJob(db, runner, { running: 0 })).toBeNull();
  expect(await db.query.ciAttempts.findMany()).toHaveLength(1);
});
for (const capacity of [1, 2]) it(`overlapping claims cannot exceed runner capacity ${capacity}`, async () => {
  await db.$client.execute(`UPDATE ci_runners SET capacity=${capacity}`);
  const runner = (await db.query.ciRunners.findFirst())!;
  let entered!: () => void; let release!: () => void; let reads = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = db.query.ciJobs.findMany.bind(db.query.ciJobs);
  const spy = vi.spyOn(db.query.ciJobs, 'findMany').mockImplementation(((...args: Parameters<typeof original>) => (async () => {
    const rows = await original(...args); if (++reads === 3) entered(); await gate; return rows;
  })()) as typeof original);
  const pending = Promise.all(Array.from({ length: 3 }, () => claimJob(db, runner, { running: 0 })));
  try {
    await Promise.race([ready, pending.then(() => { throw new Error('capacity-read overlap gate missed'); })]);
    release(); const offers = (await pending).filter(Boolean);
    const attempts = await db.query.ciAttempts.findMany();
    console.log('EXPECTED:', capacity, 'ACTUAL:', attempts.length);
    console.log(attempts.length === capacity ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
    expect(offers).toHaveLength(capacity); expect(attempts).toHaveLength(capacity);
    const jobs = await db.query.ciJobs.findMany();
    expect(jobs.filter(job => job.status === 'running')).toHaveLength(capacity);
    expect(jobs.filter(job => job.status === 'queued').every(job => job.attempts === 0 && job.currentAttemptId === null)).toBe(true);
  } finally { release(); await pending.catch(() => undefined); spy.mockRestore(); }
});
