import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { users, type DB, type User } from '@ninedeploy/db';
import { migratedDb, closeMigratedDb } from '../../apps/server/test/lib/githubAppKit.js';
import { issueResetToken, consumeResetToken, RESET_TTL_MS } from '../../apps/server/src/lib/passwordReset.js';
import { sha256, verifyPassword } from '../../apps/server/src/lib/crypto.js';
vi.mock('../../apps/server/src/lib/notifier.js', () => ({ notifyEvent: vi.fn() }));
let db: DB, user: User;
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(async () => { db = await migratedDb(); [user] = await db.insert(users).values({ id: 1, email: 'reset-fixture@example.test', passwordHash: 'fixture' }).returning() as [User]; });
afterEach(() => { vi.restoreAllMocks(); closeMigratedDb(db); });
function interceptInsert(mode: 'hold' | 'fail' | 'hold-fail', pattern = /insert into "password_reset_tokens"/i) {
 const entered = gate(), blocked = gate(); let held = false; let transactionSeen = false; const restores: (() => void)[] = [];
 function instrument(client: Pick<typeof db.$client, 'execute'>) {
  const original = client.execute.bind(client);
  const spy = vi.spyOn(client, 'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
   const s = args[0]; const sql = typeof s === 'string' ? s : s.sql;
   if (!held && pattern.test(sql)) { held = true; entered.release(); if (mode === 'fail') throw new Error('controlled token insert failure'); await blocked.promise; if (mode === 'hold-fail') throw new Error('controlled post-gate insert failure'); }
   return original(...args);
  }) as typeof original); restores.push(() => spy.mockRestore());
 }
 instrument(db.$client); const originalTransaction = db.$client.transaction.bind(db.$client);
 const transactionSpy = vi.spyOn(db.$client, 'transaction').mockImplementation((async (...args: Parameters<typeof originalTransaction>) => { const tx = await originalTransaction(...args); transactionSeen = true; instrument(tx); return tx; }) as typeof originalTransaction);
 return { entered: entered.promise, release: blocked.release, transactionSeen: () => transactionSeen, close: () => { blocked.release(); for (const restore of restores) restore(); transactionSpy.mockRestore(); } };
}

import { afterAll } from 'vitest';
import { passwordResetTokens } from '@ninedeploy/db';
let failed = false;
afterEach(({ task }) => { if (task.result?.errors?.length) failed = true; });
afterAll(() => { if (!failed) console.log('FIX VERIFIED'); });
it('six overlapping requests leave only the last issued hash', async () => {
 const held = interceptInsert('hold'); const first = issueResetToken(db, user, 'first'); let later: ReturnType<typeof issueResetToken>[] = [];
 try {
  await held.entered; later = Array.from({ length: 5 }, (_, i) => issueResetToken(db, user, `later-${i}`)); const all = Promise.allSettled([first, ...later]); if (held.transactionSeen()) await checkpoint(); else await db.query.users.findFirst(); held.release();
  const settled = await all; expect(settled.every(r => r.status === 'fulfilled')).toBe(true); const final = settled.at(-1)!; if (final.status !== 'fulfilled') throw new Error('last issue failed'); const rows = await db.query.passwordResetTokens.findMany(); expect(rows).toHaveLength(1); expect(rows[0]?.tokenHash).toBe(sha256(final.value.token));
 } finally { held.release(); await Promise.allSettled([first, ...later]); held.close(); }
});
it('different users retain separate active tokens across the shared connection queue', async () => {
 const [other] = await db.insert(users).values({ id: 2, email: 'other-reset@example.test', passwordHash: 'fixture' }).returning(); const held = interceptInsert('hold'); const first = issueResetToken(db, user, 'first'); let second: ReturnType<typeof issueResetToken> | undefined;
 try { await held.entered; second = issueResetToken(db, other!, 'other'); const all = Promise.all([first, second]); if (held.transactionSeen()) await checkpoint(); else await db.query.users.findFirst(); held.release(); const issued = await all; const rows = await db.query.passwordResetTokens.findMany(); expect(rows).toHaveLength(2); for (const [i, id] of [1, 2].entries()) expect(rows.find(r => r.userId === id)?.tokenHash).toBe(sha256(issued[i]!.token)); } finally { held.release(); await Promise.allSettled([first, ...(second ? [second] : [])]); held.close(); }
});
it('an independent database remains usable while this issuance waits', async () => {
 const otherDb = await migratedDb(); const [other] = await otherDb.insert(users).values({ id: 2, email: 'separate@example.test', passwordHash: 'fixture' }).returning(); const held = interceptInsert('hold'); const first = issueResetToken(db, user, 'first');
 try { await held.entered; const independent = await issueResetToken(otherDb, other!, 'separate'); expect((await otherDb.query.passwordResetTokens.findFirst())?.tokenHash).toBe(sha256(independent.token)); } finally { held.release(); await first; held.close(); closeMigratedDb(otherDb); }
});
it('only the surviving link can change the password, and consumption stays single-use', async () => {
 const first = await issueResetToken(db, user, 'first'); const second = await issueResetToken(db, user, 'second'); await expect(consumeResetToken(db, first.token, 'fixture-new-password')).rejects.toThrow('Invalid or expired reset token');
 const updated = await consumeResetToken(db, second.token, 'fixture-new-password'); expect(updated.tokenVersion).toBe(user.tokenVersion + 1); expect(await verifyPassword(updated.passwordHash, 'fixture-new-password')).toBe(true); await expect(consumeResetToken(db, second.token, 'another-fixture-password')).rejects.toThrow('Invalid or expired reset token');
});
for (const stage of ['delete', 'insert'] as const) it(`${stage} failure rolls back previous token rows, then clean retry succeeds`, async () => {
 const delivered = await issueResetToken(db, user, 'delivered'); await db.insert(passwordResetTokens).values({ userId: user.id, tokenHash: sha256('historical-used-fixture'), expiresAt: new Date(Date.now() + 60000), usedAt: new Date(), requestedFrom: 'old' });
 const before = await db.query.passwordResetTokens.findMany(); const held = interceptInsert('fail', stage === 'delete' ? /delete from "password_reset_tokens"/i : /insert into "password_reset_tokens"/i);
 try { await expect(issueResetToken(db, user, 'replacement')).rejects.toThrow(); expect(await db.query.passwordResetTokens.findMany()).toEqual(before); expect(before.some(r => r.tokenHash === sha256(delivered.token))).toBe(true); } finally { held.close(); }
 const retry = await issueResetToken(db, user, undefined); const rows = await db.query.passwordResetTokens.findMany(); expect(rows).toHaveLength(1); expect(rows[0]?.tokenHash).toBe(sha256(retry.token)); expect(rows[0]?.requestedFrom).toBeNull();
});
it('precommit rejection rolls back replacement and releases managed transaction order', async () => {
 const delivered = await issueResetToken(db, user, 'delivered'); const original = db.$client.transaction.bind(db.$client); const failure = new Error('controlled precommit failure'); let commitSpy: { mockRestore: () => void } | undefined;
 const spy = vi.spyOn(db.$client, 'transaction').mockImplementation((async (...args: Parameters<typeof original>) => { const tx = await original(...args); commitSpy = vi.spyOn(tx, 'commit').mockRejectedValueOnce(failure); return tx; }) as typeof original);
 try { await expect(issueResetToken(db, user, 'replacement')).rejects.toBe(failure); expect((await db.query.passwordResetTokens.findFirst())?.tokenHash).toBe(sha256(delivered.token)); } finally { commitSpy?.mockRestore(); spy.mockRestore(); }
 await expect(issueResetToken(db, user, 'retry')).resolves.toHaveProperty('token');
});
it('hash-only storage, source normalization and thirty-minute returned expiry stay intact', async () => {
 const now = Date.now(); const issued = await issueResetToken(db, user, undefined); const row = await db.query.passwordResetTokens.findFirst(); expect(row?.tokenHash).toBe(sha256(issued.token)); expect(row?.tokenHash).not.toBe(issued.token); expect(JSON.stringify(row)).not.toContain(issued.token); expect(row?.requestedFrom).toBeNull(); expect(issued.expiresAt.getTime()).toBeGreaterThanOrEqual(now + RESET_TTL_MS); expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + RESET_TTL_MS);
});
it('a held successful replacement is superseded by the next queued request', async () => {
 const delivered = await issueResetToken(db, user, 'delivered'); const held = interceptInsert('hold'); const first = issueResetToken(db, user, 'first'); let second: ReturnType<typeof issueResetToken> | undefined;
 try { await held.entered; second = issueResetToken(db, user, 'next'); const all = Promise.all([first, second]); held.release(); const issued = await all; const rows = await db.query.passwordResetTokens.findMany(); expect(rows).toHaveLength(1); expect(rows[0]?.tokenHash).toBe(sha256(issued[1]!.token)); expect(rows[0]?.tokenHash).not.toBe(sha256(delivered.token)); } finally { held.release(); await Promise.allSettled([first, ...(second ? [second] : [])]); held.close(); }
});
it('a gated failed replacement rolls back before the next queued request succeeds', async () => {
 await issueResetToken(db, user, 'delivered'); const held = interceptInsert('hold-fail'); const first = issueResetToken(db, user, 'fails'); let second: ReturnType<typeof issueResetToken> | undefined;
 const observed = first.then(() => null, err => err);
 try { await held.entered; second = issueResetToken(db, user, 'next'); const all = Promise.allSettled([observed, second]); held.release(); await all; expect(await observed).toBeInstanceOf(Error); const latest = await second; const rows = await db.query.passwordResetTokens.findMany(); expect(rows).toHaveLength(1); expect(rows[0]?.tokenHash).toBe(sha256(latest.token)); } finally { held.release(); await Promise.allSettled([observed, ...(second ? [second] : [])]); held.close(); }
});
