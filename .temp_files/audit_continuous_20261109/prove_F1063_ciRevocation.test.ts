import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ciJobs, ciRunners, services, type DB } from '@ninedeploy/db';
import { authenticateRunner, claimJob, createRunner, revokeRunner } from '../../apps/server/src/lib/ci.js';
import { closeMigratedDb, migratedDb } from '../../apps/server/test/lib/githubAppKit.js';
let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(services).values({ id: 1, name: 'revocation fixture', slug: 'revocation-fixture', type: 'docker' });
  await db.insert(ciJobs).values({ id: 1, serviceId: 1, image: 'alpine', script: 'true' });
});
afterEach(() => closeMigratedDb(db));
async function enrolled() {
  const { token } = await createRunner(db, { name: 'runner', labels: [], capacity: 1 }, null as never);
  return { token, runner: (await authenticateRunner(db, token))! };
}
it('an active runner can claim and revocation loses its assigned attempt', async () => {
  const { runner, token } = await enrolled();
  expect(await claimJob(db, runner, { running: 0 })).toMatchObject({ jobId: 1 });
  expect(await revokeRunner(db, runner.id)).toBe(true);
  expect(await authenticateRunner(db, token)).toBeNull();
  expect(await db.query.ciAttempts.findFirst()).toMatchObject({ status: 'lost' });
  expect(await db.query.ciJobs.findFirst()).toMatchObject({ status: 'queued' });
});
for (const mode of ['queue-read', 'before-insert'] as const) it(`revocation during ${mode} prevents a new lease`, async () => {
  const { runner, token } = await enrolled();
  let entered!: () => void; let release!: () => void; let held = false;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let spy: { mockRestore(): void };
  if (mode === 'queue-read') {
    const original = db.query.ciJobs.findMany.bind(db.query.ciJobs);
    spy = vi.spyOn(db.query.ciJobs, 'findMany').mockImplementationOnce(((...args: Parameters<typeof original>) => (async () => {
      const rows = await original(...args); entered(); await gate; return rows;
    })()) as typeof original);
  } else {
    const original = db.$client.execute.bind(db.$client);
    spy = vi.spyOn(db.$client, 'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
      const statement = args[0]; const sql = typeof statement === 'string' ? statement : statement.sql;
      if (!held && /insert into "ci_attempts"/i.test(sql)) { held = true; entered(); await gate; }
      return original(...args);
    }) as typeof original);
  }
  const pending = claimJob(db, runner, { running: 0 });
  try {
    await Promise.race([ready, pending.then(() => { throw new Error('claim barrier missed'); })]);
    expect(await revokeRunner(db, runner.id)).toBe(true);
    expect(await authenticateRunner(db, token)).toBeNull();
    release(); const offered = await pending;
    const attempts = await db.query.ciAttempts.findMany();
    console.log('EXPECTED: no claim / 0 attempts; ACTUAL:', offered?.jobId ?? null, '/', attempts.length);
    console.log(offered === null && attempts.length === 0 ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
    expect(offered).toBeNull(); expect(attempts).toHaveLength(0);
    expect(await db.query.ciJobs.findFirst()).toMatchObject({ status: 'queued', attempts: 0, currentAttemptId: null });
    expect((await db.query.ciRunners.findFirst())?.revokedAt).not.toBeNull();
  } finally { release(); await pending.catch(() => undefined); spy.mockRestore(); }
});
