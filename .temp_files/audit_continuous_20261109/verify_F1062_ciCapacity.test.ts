import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ciAttempts, ciJobs, ciRunners, createDb, services, type DB } from '@ninedeploy/db';
import { migrate } from '../../apps/server/node_modules/drizzle-orm/libsql/migrator.js';
import { cancelJob, claimJob } from '../../apps/server/src/lib/ci.js';
import { closeMigratedDb, migratedDb } from '../../apps/server/test/lib/githubAppKit.js';
let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(services).values({ id: 1, name: 'independent', slug: 'independent', type: 'docker' });
  await db.insert(ciRunners).values([1,2].map(id => ({ id, name: `runner-${id}`, tokenHash: `fixture-${id}`, capacity: 1 })));
  await db.insert(ciJobs).values([1,2,3,4,5].map(id => ({ id, serviceId: 1, image: 'alpine', script: 'true' })));
});
afterEach(() => closeMigratedDb(db));
const runner = async (id = 1) => (await db.query.ciRunners.findMany()).find(r => r.id === id)!;
const offer = async (id = 1, running = 0) => claimJob(db, await runner(id), { running });
function holdFirstInsert(holdFailure = false) {
  let enter!: () => void; let release!: () => void; let fail!: () => void; let failRelease!: () => void; let used = false;
  const ready = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const failed = new Promise<void>(resolve => { fail = resolve; });
  const failureGate = new Promise<void>(resolve => { failRelease = resolve; });
  const original = db.$client.execute.bind(db.$client);
  const spy = vi.spyOn(db.$client, 'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
    const statement = args[0]; const sql = typeof statement === 'string' ? statement : statement.sql;
    const held = !used && /insert into "ci_attempts"/i.test(sql);
    if (held) { used = true; enter(); await gate; }
    try { return await original(...args); }
    catch (err) { if (held && holdFailure) { fail(); await failureGate; } throw err; }
  }) as typeof original);
  return { ready, failed, release, failRelease, close: () => { release(); failRelease(); spy.mockRestore(); } };
}
for (const capacity of [1,2,3]) it(`five explicit overlapping claims reserve only ${capacity} slots`, async () => {
  await db.$client.execute(`UPDATE ci_runners SET capacity=${capacity} WHERE id=1`);
  let enter!: () => void; let release!: () => void; let reads = 0;
  const ready = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = db.query.ciJobs.findMany.bind(db.query.ciJobs);
  const spy = vi.spyOn(db.query.ciJobs, 'findMany').mockImplementation(((...args: Parameters<typeof original>) => (async () => {
    const rows = await original(...args); if (++reads === 5) enter(); await gate; return rows;
  })()) as typeof original);
  const pending = Promise.all(Array.from({ length: 5 }, () => offer()));
  try {
    await Promise.race([ready, pending.then(() => { throw new Error('barrier missed'); })]); release();
    expect((await pending).filter(Boolean)).toHaveLength(capacity);
    expect(await db.query.ciAttempts.findMany()).toHaveLength(capacity);
    expect((await db.query.ciJobs.findMany()).filter(j => j.status === 'queued').every(j => j.attempts === 0 && j.currentAttemptId === null && j.startedAt === null)).toBe(true);
    console.log('EXPECTED:', capacity, 'ACTUAL:', (await db.query.ciAttempts.findMany()).length, 'FIX VERIFIED');
  } finally { release(); await pending.catch(() => undefined); spy.mockRestore(); }
});
it('reported capacity exhaustion does not consume a job or create an attempt', async () => {
  expect(await offer(1,1)).toBeNull(); expect(await db.query.ciAttempts.findMany()).toHaveLength(0);
  expect((await db.query.ciJobs.findMany()).every(j => j.status === 'queued' && j.attempts === 0)).toBe(true); console.log('FIX VERIFIED');
});
it('different runners retain independent capacity', async () => {
  const offers = await Promise.all([offer(1), offer(2)]);
  expect(offers.filter(Boolean)).toHaveLength(2);
  const attempts = await db.query.ciAttempts.findMany(); expect(attempts.map(a => a.runnerId).sort()).toEqual([1,2]); console.log('FIX VERIFIED');
});
it('a losing retry restores prior count/start and can later claim the same attempt number', async () => {
  const before = 1_700_000_000;
  await db.$client.execute(`UPDATE ci_jobs SET attempts=1, started_at=${before} WHERE id=1`);
  await db.insert(ciAttempts).values({ jobId: 1, runnerId: 1, number: 1, leaseHash: 'historical', leaseExpiresAt: 0, status: 'lost' });
  const gate = holdFirstInsert(); const pending = offer();
  try {
    await gate.ready; const winner = (await offer())!; expect(winner.jobId).toBe(2);
    gate.release(); expect(await pending).toBeNull();
    const queued = (await db.query.ciJobs.findMany()).find(j => j.id === 1)!;
    expect(queued).toMatchObject({ status: 'queued', attempts: 1, currentAttemptId: null });
    expect(queued.startedAt?.getTime()).toBe(before * 1000);
    expect(await cancelJob(db, winner.jobId, null)).toBe(true);
    expect(await offer()).toMatchObject({ jobId: 1, number: 2 }); console.log('FIX VERIFIED');
  } finally { gate.release(); await pending.catch(() => undefined); gate.close(); }
});
it('capacity failure delivered after cancellation cannot requeue the cancelled job', async () => {
  const gate = holdFirstInsert(true); const pending = offer();
  try {
    await gate.ready; expect(await offer()).toMatchObject({ jobId: 2 });
    gate.release(); await Promise.race([gate.failed, pending.then(() => { throw new Error('failure barrier missed'); })]);
    expect(await cancelJob(db, 1, null)).toBe(true);
    gate.failRelease(); expect(await pending).toBeNull();
    expect((await db.query.ciJobs.findMany()).find(j => j.id === 1)).toMatchObject({ status: 'cancelled', currentAttemptId: null });
    expect(await db.query.ciAttempts.findMany()).toHaveLength(1); console.log('FIX VERIFIED');
  } finally { gate.release(); gate.failRelease(); await pending.catch(() => undefined); gate.close(); }
});
it('unrelated attempt insertion errors propagate rather than becoming capacity rejection', async () => {
  await db.$client.execute("CREATE TRIGGER fail_attempt BEFORE INSERT ON ci_attempts BEGIN SELECT RAISE(ABORT, 'synthetic unrelated'); END");
  await expect(offer()).rejects.toThrow(); expect(await db.query.ciAttempts.findMany()).toHaveLength(0); console.log('FIX VERIFIED');
});
it('independent SQLite connections share the atomic runner budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nd-ci-capacity-two-clients-'));
  const a = createDb({ url: `file:${join(dir, 'capacity.db')}` });
  const b = createDb({ url: `file:${join(dir, 'capacity.db')}` });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let enter!: () => void; let reads = 0; const ready = new Promise<void>(resolve => { enter = resolve; });
  const spies: Array<{ mockRestore(): void }> = [];
  let pending: Promise<unknown[]> | undefined;
  try {
    await migrate(a.db, { migrationsFolder: fileURLToPath(new URL('../../packages/db/src/migrations', import.meta.url)) });
    await a.db.insert(services).values({ id: 1, name: 'shared', slug: 'shared', type: 'docker' });
    await a.db.insert(ciRunners).values({ id: 1, name: 'runner', tokenHash: 'shared-fixture', capacity: 1 });
    await a.db.insert(ciJobs).values([1,2].map(id => ({ id, serviceId: 1, image: 'alpine', script: 'true' })));
    for (const connection of [a.db, b.db]) {
      const original = connection.query.ciJobs.findMany.bind(connection.query.ciJobs);
      spies.push(vi.spyOn(connection.query.ciJobs, 'findMany').mockImplementation(((...args: Parameters<typeof original>) => (async () => {
        const rows = await original(...args); if (++reads === 2) enter(); await gate; return rows;
      })()) as typeof original));
    }
    const r = (await a.db.query.ciRunners.findFirst())!;
    pending = Promise.all([claimJob(a.db, r, { running: 0 }), claimJob(b.db, r, { running: 0 })]);
    await Promise.race([ready, pending.then(() => { throw new Error('shared-file barrier missed'); })]);
    release(); expect((await pending).filter(Boolean)).toHaveLength(1);
    expect(await b.db.query.ciAttempts.findMany()).toHaveLength(1);
    expect((await a.db.query.ciJobs.findMany()).filter(j => j.status === 'queued')).toHaveLength(1);
    console.log('EXPECTED: 1 shared-file attempt; ACTUAL:', (await b.db.query.ciAttempts.findMany()).length, 'FIX VERIFIED');
  } finally {
    release(); await pending?.catch(() => undefined); spies.forEach(spy => spy.mockRestore());
    a.client?.close(); b.client?.close();
    // libSQL native file handles can outlive close on Windows. Retain this
    // disposable fixture rather than treating deletion timing as capacity proof.
    console.log('TEMP_FIXTURE_RETAINED:', dir);
  }
});
