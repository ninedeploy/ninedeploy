import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, users, type DB } from '@ninedeploy/db';
import { eq } from 'drizzle-orm';
import { totpAt } from '../../src/lib/totp.js';

/**
 * L-10 regression: a TOTP code is single-use.
 *
 * Runs against a REAL in-memory SQLite with the real migrations, because the
 * whole point of the fix is a conditional UPDATE — a fake db that ignores
 * WHERE clauses would report success no matter what the code did.
 */

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

// The module decrypts the stored secret; here "encryption" is the identity so
// the test does not need a master key.
vi.mock('../../src/lib/crypto.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/crypto.js')>('../../src/lib/crypto.js');
  return { ...actual, decrypt: (value: string) => value };
});

const { consumeTotpCode } = await import('../../src/lib/totpReplay.js');

const NOW = 1_800_000_000_000; // fixed instant; step = NOW/1000/30

async function freshDb(): Promise<DB> {
  const { db, ready } = createDb({ url: ':memory:' });
  await ready;
  await runMigrations(db);
  await db.insert(users).values({
    email: 'u@example.com',
    passwordHash: 'x',
    isOperator: true,
    totpEnabled: true,
    totpSecretEncrypted: SECRET,
  });
  return db;
}

let db: DB;
let user: { id: number; totpSecretEncrypted: string | null };

beforeEach(async () => {
  db = await freshDb();
  const row = await db.query.users.findFirst({ where: eq(users.email, 'u@example.com') });
  user = { id: row!.id, totpSecretEncrypted: row!.totpSecretEncrypted };
});

describe('consumeTotpCode', () => {
  it('accepts a valid code once', async () => {
    expect(await consumeTotpCode(db, user, totpAt(SECRET, NOW), NOW)).toBe(true);
  });

  it('REFUSES the same code a second time inside its validity window', async () => {
    const code = totpAt(SECRET, NOW);
    expect(await consumeTotpCode(db, user, code, NOW)).toBe(true);
    // Same instant, and 29 seconds later — still inside the ±1-step window
    // where the old `verifyTotp` would have said yes.
    expect(await consumeTotpCode(db, user, code, NOW)).toBe(false);
    expect(await consumeTotpCode(db, user, code, NOW + 29_000)).toBe(false);
  });

  it('refuses the PREVIOUS step once a newer one has been spent', async () => {
    const previous = totpAt(SECRET, NOW - 30_000);
    const current = totpAt(SECRET, NOW);
    expect(await consumeTotpCode(db, user, current, NOW)).toBe(true);
    // `previous` is still inside the drift window, but it is not newer.
    expect(await consumeTotpCode(db, user, previous, NOW)).toBe(false);
  });

  it('accepts the next step when the clock moves on', async () => {
    expect(await consumeTotpCode(db, user, totpAt(SECRET, NOW), NOW)).toBe(true);
    expect(await consumeTotpCode(db, user, totpAt(SECRET, NOW + 30_000), NOW + 30_000)).toBe(true);
  });

  it('rejects a wrong code without spending anything', async () => {
    expect(await consumeTotpCode(db, user, '000000', NOW)).toBe(false);
    const row = await db.query.users.findFirst({ where: eq(users.id, user.id) });
    expect(row?.totpLastStep).toBeNull();
    // the real code still works afterwards
    expect(await consumeTotpCode(db, user, totpAt(SECRET, NOW), NOW)).toBe(true);
  });

  it('rejects a malformed code', async () => {
    expect(await consumeTotpCode(db, user, 'abcdef', NOW)).toBe(false);
    expect(await consumeTotpCode(db, user, '12345', NOW)).toBe(false);
  });

  it('returns false when the account has no secret', async () => {
    expect(await consumeTotpCode(db, { id: user.id, totpSecretEncrypted: null }, '123456', NOW)).toBe(false);
  });

  it('lets only ONE of two concurrent uses of the same code win', async () => {
    const code = totpAt(SECRET, NOW);
    const results = await Promise.all([
      consumeTotpCode(db, user, code, NOW),
      consumeTotpCode(db, user, code, NOW),
      consumeTotpCode(db, user, code, NOW),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('records the spent step on the user row', async () => {
    await consumeTotpCode(db, user, totpAt(SECRET, NOW), NOW);
    const row = await db.query.users.findFirst({ where: eq(users.id, user.id) });
    expect(row?.totpLastStep).toBe(Math.floor(NOW / 1000 / 30));
  });
});
