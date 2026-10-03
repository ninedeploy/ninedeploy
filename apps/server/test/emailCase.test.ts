/**
 * r159 — email addresses are stored in canonical (lowercased) form and looked
 * up case-insensitively. Runs against a real migrated SQLite database: the
 * bug lived in the gap between a case-SENSITIVE unique index and the
 * `lower(email)` comparisons that invitations, login and SSO use, which a
 * fake db cannot reproduce.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, users, type DB } from '@ninedeploy/db';
import { findUserByEmail } from '../src/lib/authHelpers.js';
import { registerAccount } from '../src/modules/auth.js';

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));

let db: DB;
let close: () => void;
let dir: string;

// A file, not `:memory:` — libsql opens a fresh connection for a transaction,
// and a second connection to `:memory:` is a different, empty database.
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-email-'));
  const created = createDb({ url: `file:${path.join(dir, 'test.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

afterEach(() => {
  close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

describe('r159: email case', () => {
  it('stores a registration in lowercase and refuses a case-variant duplicate', async () => {
    await registerAccount(db, { email: 'Victim@Corp.com', password: 'correct-horse-battery' });
    const [row] = await db.select().from(users);
    expect(row!.email).toBe('victim@corp.com');

    await expect(
      registerAccount(db, { email: 'VICTIM@corp.COM', password: 'another-password-1' }),
    ).rejects.toMatchObject({ code: 'email_taken' });
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it('finds a legacy mixed-case row regardless of the casing it is looked up with', async () => {
    await db.insert(users).values({ email: 'Alice@Corp.com', passwordHash: 'x' });
    const found = await findUserByEmail(db, 'alice@corp.com');
    expect(found?.email).toBe('Alice@Corp.com');
  });

  it('migration 0060 adds the SCIM deactivation-owner column', async () => {
    const [row] = await db
      .insert(users)
      .values({ email: 'x@y.z', passwordHash: 'x', deactivatedAt: new Date(), deactivatedByWorkspaceId: 7 })
      .returning();
    expect(row!.deactivatedByWorkspaceId).toBe(7);
  });
});
