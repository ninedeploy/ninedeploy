import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ciJobs, ciRunners, services, type DB } from '@ninedeploy/db';
import { cancelJob, claimJob } from '../../apps/server/src/lib/ci.js';
import { closeMigratedDb, migratedDb } from '../../apps/server/test/lib/githubAppKit.js';
let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(services).values({ id: 1, name: 'claim fixture', slug: 'claim-fixture', type: 'docker' });
  await db.insert(ciRunners).values({ id: 1, name: 'runner', tokenHash: 'synthetic' });
  await db.insert(ciJobs).values({ id: 1, serviceId: 1, image: 'alpine', script: 'true' });
});
afterEach(() => closeMigratedDb(db));
const claim = async () => claimJob(db, (await db.query.ciRunners.findFirst())!, { running: 0 });

it('an ordinary claim remains owned and cancellation closes its attempt', async () => {
  expect(await claim()).toMatchObject({ jobId: 1 });
  expect(await cancelJob(db, 1, null)).toBe(true);
  expect(await db.query.ciJobs.findFirst()).toMatchObject({ status: 'cancelled' });
  expect(await db.query.ciAttempts.findFirst()).toMatchObject({ status: 'cancelled' });
});

it('cancellation uses the current attempt rather than its earlier queued snapshot', async () => {
  let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = db.query.ciJobs.findFirst.bind(db.query.ciJobs);
  const spy = vi.spyOn(db.query.ciJobs, 'findFirst').mockImplementationOnce(((...args: Parameters<typeof original>) => (async () => {
    const row = await original(...args); entered(); await gate; return row;
  })()) as typeof original);
  const cancellation = cancelJob(db, 1, null);
  try {
    await ready; expect(await claim()).toMatchObject({ jobId: 1 });
    release(); expect(await cancellation).toBe(true);
    const attempt = await db.query.ciAttempts.findFirst();
    console.log('EXPECTED: cancelled; ACTUAL:', attempt?.status);
    console.log(attempt?.status === 'cancelled' ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
    expect(attempt).toMatchObject({ status: 'cancelled' });
  } finally { release(); await cancellation.catch(() => undefined); spy.mockRestore(); }
});

it('a claim cannot publish an attempt after cancellation won before publication', async () => {
  let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const execute = db.$client.execute.bind(db.$client);
  const spy = vi.spyOn(db.$client, 'execute').mockImplementation((async (...args: Parameters<typeof execute>) => {
    const result = await execute(...args);
    const statement = args[0];
    const sql = typeof statement === 'string' ? statement : statement.sql;
    if (/insert into "ci_attempts"/i.test(sql)) { entered(); await gate; }
    return result;
  }) as typeof execute);
  const pending = claim();
  try {
    await Promise.race([ready, pending.then(() => { throw new Error('attempt insertion gate missed'); })]);
    expect(await cancelJob(db, 1, null)).toBe(true);
    release(); const offered = await pending;
    const attempt = await db.query.ciAttempts.findFirst();
    console.log('EXPECTED: no offer / cancelled attempt; ACTUAL:', offered?.jobId ?? null, '/', attempt?.status);
    console.log(offered === null && attempt?.status === 'cancelled' ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
    expect(offered).toBeNull(); expect(attempt).toMatchObject({ status: 'cancelled' });
    expect(await db.query.ciJobs.findFirst()).toMatchObject({ status: 'cancelled', currentAttemptId: null });
  } finally { release(); await pending.catch(() => undefined); spy.mockRestore(); }
});
