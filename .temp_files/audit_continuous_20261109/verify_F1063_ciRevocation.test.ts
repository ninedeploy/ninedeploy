import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ciJobs, ciRunners, services, type DB } from '@ninedeploy/db';
import { claimJob, revokeRunner } from '../../apps/server/src/lib/ci.js';
import { closeMigratedDb, migratedDb } from '../../apps/server/test/lib/githubAppKit.js';
let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(services).values({ id: 1, name: 'independent', slug: 'independent', type: 'docker' });
  await db.insert(ciJobs).values({ id: 1, serviceId: 1, image: 'alpine', script: 'true' });
  await db.insert(ciRunners).values([1,2].map(id => ({ id, name: `runner-${id}`, tokenHash: `fixture-${id}` })));
});
afterEach(() => closeMigratedDb(db));
const offer = async (id = 1) => claimJob(db, (await db.query.ciRunners.findMany()).find(r => r.id === id)!, { running: 0 });
function holdInsert(after: boolean) {
  let enter!: () => void; let release!: () => void; let used = false;
  const ready = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = db.$client.execute.bind(db.$client);
  const spy = vi.spyOn(db.$client, 'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
    const statement = args[0]; const sql = typeof statement === 'string' ? statement : statement.sql;
    const held = !used && /insert into "ci_attempts"/i.test(sql); if (held) used = true;
    if (held && !after) { enter(); await gate; }
    const result = await original(...args);
    if (held && after) { enter(); await gate; }
    return result;
  }) as typeof original);
  return { ready, release, close: () => { release(); spy.mockRestore(); } };
}
for (const limit of [1,2]) for (const after of [false,true]) it(`revocation ${after ? 'after' : 'before'} insert with maxAttempts=${limit}`, async () => {
  await db.$client.execute(`UPDATE ci_jobs SET max_attempts=${limit}`);
  const gate = holdInsert(after); const pending = offer();
  try {
    await gate.ready; expect(await revokeRunner(db,1)).toBe(true);
    gate.release(); expect(await pending).toBeNull();
    const job = (await db.query.ciJobs.findFirst())!;
    expect(job.status).toBe(after && limit === 1 ? 'failed' : 'queued');
    expect(job.attempts).toBe(Number(after));
    expect((await db.query.ciAttempts.findMany()).every(a => a.status === 'lost')).toBe(true);
    console.log('EXPECTED:', job.status, 'no offer; ACTUAL:', job.status, 'no offer FIX VERIFIED');
  } finally { gate.release(); await pending.catch(() => undefined); gate.close(); }
});
it('an old claim cannot overwrite a newer runner after pending attempt revocation', async () => {
  const gate = holdInsert(true); const pending = offer();
  try {
    await gate.ready; expect(await revokeRunner(db,1)).toBe(true);
    const fresh = (await offer(2))!; expect(fresh).toMatchObject({ jobId: 1, number: 2 });
    gate.release(); const old = await pending;
    console.log('EXPECTED: old offer null; ACTUAL:', old?.attemptId ?? null);
    console.log(old === null ? 'FIX VERIFIED' : 'PROBLEM CONFIRMED');
    expect(old).toBeNull();
    expect(await db.query.ciJobs.findFirst()).toMatchObject({ status: 'running', attempts: 2, currentAttemptId: fresh.attemptId });
    const attempts = await db.query.ciAttempts.findMany();
    expect(attempts.find(a => a.id === fresh.attemptId)?.status).toBe('running');
    expect(attempts.find(a => a.number === 1)?.status).toBe('lost');
  } finally { gate.release(); await pending.catch(() => undefined); gate.close(); }
});
it('a lost attempt is not published while loss reconciliation still awaits its job read', async () => {
  const gate = holdInsert(true); const pending = offer();
  let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let loss: Promise<boolean> | undefined; let spy: { mockRestore(): void } | undefined;
  try {
    await gate.ready;
    const original = db.query.ciJobs.findFirst.bind(db.query.ciJobs);
    spy = vi.spyOn(db.query.ciJobs,'findFirst').mockImplementationOnce(((...args: Parameters<typeof original>) => (async () => {
      const row = await original(...args); entered(); await blocked; return row;
    })()) as typeof original);
    loss = revokeRunner(db,1); await ready;
    gate.release(); const old = await pending;
    console.log('EXPECTED: lost offer null; ACTUAL:', old?.attemptId ?? null);
    console.log(old === null ? 'FIX VERIFIED' : 'PROBLEM CONFIRMED'); expect(old).toBeNull();
    release(); expect(await loss).toBe(true);
    expect(await db.query.ciJobs.findFirst()).toMatchObject({ status: 'queued', currentAttemptId: null });
  } finally { gate.release(); release(); await pending.catch(() => undefined); await loss?.catch(() => undefined); spy?.mockRestore(); gate.close(); }
});
it('active other runner can claim after revocation and repeated revoke is false', async () => {
  expect(await revokeRunner(db,1)).toBe(true); expect(await revokeRunner(db,1)).toBe(false);
  expect(await offer(2)).toMatchObject({ jobId: 1, number: 1 }); console.log('FIX VERIFIED');
});
it('persisted revocation fences publication before the revoker processes its attempt list', async () => {
  const gate = holdInsert(true); const pending = offer();
  let enter!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { enter = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let loss: Promise<boolean> | undefined; let spy: { mockRestore(): void } | undefined;
  try {
    await gate.ready;
    const original = db.query.ciAttempts.findMany.bind(db.query.ciAttempts);
    spy = vi.spyOn(db.query.ciAttempts,'findMany').mockImplementationOnce(((...args: Parameters<typeof original>) => (async () => {
      const rows = await original(...args); enter(); await blocked; return rows;
    })()) as typeof original);
    loss = revokeRunner(db,1); await ready;
    gate.release(); const old = await pending;
    console.log('EXPECTED: revoked offer null; ACTUAL:', old?.attemptId ?? null);
    console.log(old === null ? 'FIX VERIFIED' : 'PROBLEM CONFIRMED'); expect(old).toBeNull();
    release(); expect(await loss).toBe(true);
    expect(await db.query.ciJobs.findFirst()).toMatchObject({ status: 'queued', currentAttemptId: null });
    expect(await db.query.ciAttempts.findFirst()).toMatchObject({ status: 'lost' });
  } finally { gate.release(); release(); await pending.catch(() => undefined); await loss?.catch(() => undefined); spy?.mockRestore(); gate.close(); }
});
it('a previously revoked runner snapshot cannot create a lease', async () => {
  const snapshot = (await db.query.ciRunners.findFirst())!;
  expect(await revokeRunner(db,snapshot.id)).toBe(true);
  expect(await claimJob(db,snapshot,{running:0})).toBeNull();
  expect(await db.query.ciAttempts.findMany()).toHaveLength(0); console.log('FIX VERIFIED');
});
