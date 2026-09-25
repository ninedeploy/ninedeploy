/**
 * r301 — re-inviting an address whose previous invite was revoked (or
 * accepted) must create a fresh invite, not a 500. Runs against a real
 * migrated SQLite database: the bug was a full UNIQUE index on
 * (workspace_id, email) that a fake db cannot reproduce, while
 * `createOrRefreshInvitation` only refreshes a PENDING row and INSERTs
 * otherwise.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DB, users, workspaceInvitations, workspaces } from '@ninedeploy/db';
import { createOrRefreshInvitation } from '../src/modules/invitations.js';

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));

let db: DB;
let close: () => void;
let dir: string;
let workspaceId: number;
let ownerId: number;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-invite-'));
  const created = createDb({ url: `file:${path.join(dir, 'test.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const [owner] = await db.insert(users).values({ email: 'owner@example.com', passwordHash: 'x' }).returning();
  ownerId = owner!.id;
  const [ws] = await db.insert(workspaces).values({ name: 'W', slug: 'w', ownerId }).returning();
  workspaceId = ws!.id;
});

afterEach(() => {
  close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

const invite = () =>
  createOrRefreshInvitation(db, { workspaceId, email: 'new@example.com', role: 'member', invitedByUserId: ownerId });

describe('r301: invitation re-issue', () => {
  it('re-invites an address whose previous invite was revoked, as a new row', async () => {
    const first = await invite();
    await db
      .update(workspaceInvitations)
      .set({ revokedAt: new Date() })
      .where(eq(workspaceInvitations.id, first.invitation.id));

    const second = await invite();
    expect(second.invitation.id).not.toBe(first.invitation.id);
    expect(second.invitation.revokedAt).toBeNull();
    // History is kept: the revoked row is still there.
    expect(await db.select().from(workspaceInvitations)).toHaveLength(2);
  });

  it('re-invites an address whose previous invite was accepted', async () => {
    const first = await invite();
    await db
      .update(workspaceInvitations)
      .set({ acceptedAt: new Date() })
      .where(eq(workspaceInvitations.id, first.invitation.id));

    const second = await invite();
    expect(second.invitation.id).not.toBe(first.invitation.id);
  });

  it('still allows only one OUTSTANDING invite per (workspace, email)', async () => {
    const first = await invite();
    // The create path refreshes the pending row in place…
    const again = await invite();
    expect(again.invitation.id).toBe(first.invitation.id);
    // …and the database still refuses a second pending row outright.
    await expect(
      db.insert(workspaceInvitations).values({
        workspaceId,
        email: 'new@example.com',
        token: 'b'.repeat(64),
        invitedByUserId: ownerId,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/UNIQUE/) }) });
  });
});
