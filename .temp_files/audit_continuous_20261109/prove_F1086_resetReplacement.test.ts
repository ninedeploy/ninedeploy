import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { users, type DB, type User } from '@ninedeploy/db';
import { migratedDb, closeMigratedDb } from '../../apps/server/test/lib/githubAppKit.js';
import { issueResetToken } from '../../apps/server/src/lib/passwordReset.js';
import { sha256 } from '../../apps/server/src/lib/crypto.js';
vi.mock('../../apps/server/src/lib/notifier.js', () => ({ notifyEvent: vi.fn() }));
let db: DB, user: User;
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(async () => { db = await migratedDb(); [user] = await db.insert(users).values({ id: 1, email: 'reset-fixture@example.test', passwordHash: 'fixture' }).returning() as [User]; });
afterEach(() => { vi.restoreAllMocks(); closeMigratedDb(db); });
function interceptInsert(mode: 'hold' | 'fail') {
 const entered = gate(), blocked = gate(); let held = false; let transactionSeen = false; const restores: (() => void)[] = [];
 function instrument(client: Pick<typeof db.$client, 'execute'>) {
  const original = client.execute.bind(client);
  const spy = vi.spyOn(client, 'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
   const s = args[0]; const sql = typeof s === 'string' ? s : s.sql;
   if (!held && /insert into "password_reset_tokens"/i.test(sql)) { held = true; entered.release(); if (mode === 'fail') throw new Error('controlled token insert failure'); await blocked.promise; }
   return original(...args);
  }) as typeof original); restores.push(() => spy.mockRestore());
 }
 instrument(db.$client); const originalTransaction = db.$client.transaction.bind(db.$client);
 const transactionSpy = vi.spyOn(db.$client, 'transaction').mockImplementation((async (...args: Parameters<typeof originalTransaction>) => { const tx = await originalTransaction(...args); transactionSeen = true; instrument(tx); return tx; }) as typeof originalTransaction);
 return { entered: entered.promise, release: blocked.release, transactionSeen: () => transactionSeen, close: () => { blocked.release(); for (const restore of restores) restore(); transactionSpy.mockRestore(); } };
}
it('control: sequential issuance keeps one hash and invalidates the previous token', async () => {
 const first = await issueResetToken(db, user, 'first'); const second = await issueResetToken(db, user, undefined); const rows = await db.query.passwordResetTokens.findMany(); expect(rows).toHaveLength(1); expect(rows[0]?.tokenHash).toBe(sha256(second.token)); expect(rows[0]?.tokenHash).not.toBe(sha256(first.token));
});
it('failed replacement preserves the previously issued token', async () => {
 const old = await issueResetToken(db, user, 'delivered'); const held = interceptInsert('fail');
 try {
  await expect(issueResetToken(db, user, 'replacement')).rejects.toThrow(); const rows = await db.query.passwordResetTokens.findMany(); console.log('EXPECTED: previous active hash retained; ACTUAL token rows:', rows.length); console.log(rows.length === 1 && rows[0]?.tokenHash === sha256(old.token) ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED'); expect(rows).toHaveLength(1); expect(rows[0]?.tokenHash).toBe(sha256(old.token));
 } finally { held.close(); }
});
