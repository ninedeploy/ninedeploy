import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ciJobs, services, type DB } from '@ninedeploy/db';
import { authenticateRunner, claimJob, createRunner, revokeRunner } from '../../src/lib/ci.js';
import { closeMigratedDb, migratedDb } from './githubAppKit.js';
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
for (const mode of ['queue-read', 'before-insert', 'after-insert'] as const) it(`revocation during ${mode} prevents a new lease`, async () => {
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
      const match = !held && /insert into "ci_attempts"/i.test(sql);
      if (match) held = true;
      if (match && mode === 'before-insert') { entered(); await gate; }
      const result = await original(...args);
      if (match && mode === 'after-insert') { entered(); await gate; }
      return result;
    }) as typeof original);
  }
  const pending = claimJob(db, runner, { running: 0 });
  try {
    await Promise.race([ready, pending.then(() => { throw new Error('claim barrier missed'); })]);
    expect(await revokeRunner(db, runner.id)).toBe(true);
    expect(await authenticateRunner(db, token)).toBeNull();
    release(); const offered = await pending;
    const attempts = await db.query.ciAttempts.findMany();
    const count = mode === 'after-insert' ? 1 : 0;
    console.log('EXPECTED: no claim /', count, 'closed attempts; ACTUAL:', offered?.jobId ?? null, '/', attempts.map(a => a.status));
    console.log(offered === null && attempts.length === count && attempts.every(a => a.status === 'lost') ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
    expect(offered).toBeNull(); expect(attempts).toHaveLength(count);
    expect(attempts.every(a => a.status === 'lost')).toBe(true);
    expect(await db.query.ciJobs.findFirst()).toMatchObject({ status: 'queued', attempts: count, currentAttemptId: null });
    expect((await db.query.ciRunners.findFirst())?.revokedAt).not.toBeNull();
  } finally { release(); await pending.catch(() => undefined); spy.mockRestore(); }
});

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
it('an old claim cannot overwrite a newer runner after pending attempt revocation', async () => {
  await enrolled(); await enrolled();
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
  await enrolled(); await enrolled();
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

it('persisted revocation fences publication before the revoker processes its attempt list', async () => {
  await enrolled(); await enrolled();
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
