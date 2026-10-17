/**
 * F1026 — the suspension holds of access grants are two settings rows per
 * workspace (admin holds: a list, IdP holds: a user→ids map), read, changed
 * and written back whole. Overlapping mutations in one workspace lost one of
 * the changes: a second admin hold vanished (so the IdP's reinstatement lifted
 * a grant an admin had suspended), or a user's IdP hold vanished. Real
 * migrated SQLite; both calls submit their read before either write lands, so
 * no timing is involved.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessGrants, createDb, projects, users, workspaces, type DB } from '@ninedeploy/db';
import {
  addAdminHold,
  adminHeldGrantIds,
  idpHeldGrantIds,
  reinstateGrantsForMember,
  suspendGrantsForMember,
} from '../src/lib/accessGrants.js';

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));

let db: DB;
let close: () => void;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-grant-holds-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  await created.ready;
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

afterAll(() => {
  try {
    close();
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may hold the file a moment longer */
  }
});

async function world() {
  const [u1] = await db.insert(users).values({ email: 'a@x.test', name: 'a', passwordHash: 'x' }).returning();
  const [u2] = await db.insert(users).values({ email: 'b@x.test', name: 'b', passwordHash: 'x' }).returning();
  const [ws] = await db.insert(workspaces).values({ name: 'W', slug: 'w', ownerId: u1!.id }).returning();
  const projectIds: number[] = [];
  for (const slug of ['p1', 'p2']) {
    const [p] = await db.insert(projects).values({ name: slug, slug, workspaceId: ws!.id }).returning();
    projectIds.push(p!.id);
  }
  const grant = async (userId: number, projectId: number) =>
    (
      await db
        .insert(accessGrants)
        .values({ workspaceId: ws!.id, userId, projectId, targetKey: `p:${projectId}`, role: 'viewer' })
        .returning()
    )[0]!;
  return { workspaceId: ws!.id, userIds: [u1!.id, u2!.id], projectIds, grant };
}

describe('grant suspension holds under overlap (F1026)', () => {
  it('keeps every hold, so an IdP reinstatement cannot lift a grant an admin suspended', async () => {
    const { workspaceId, userIds, projectIds, grant } = await world();
    const a = await grant(userIds[0]!, projectIds[0]!);
    const b = await grant(userIds[0]!, projectIds[1]!);
    const c = await grant(userIds[1]!, projectIds[0]!);

    await Promise.all([addAdminHold(db, workspaceId, a.id), addAdminHold(db, workspaceId, b.id)]);
    expect((await adminHeldGrantIds(db, workspaceId)).sort()).toEqual([a.id, b.id].sort());
    for (const g of [a, b]) await db.update(accessGrants).set({ suspendedAt: new Date() }).where(eq(accessGrants.id, g.id));

    await Promise.all([suspendGrantsForMember(db, workspaceId, userIds[0]!), suspendGrantsForMember(db, workspaceId, userIds[1]!)]);
    expect((await idpHeldGrantIds(db, workspaceId, userIds[0]!)).length).toBe(2);
    expect(await idpHeldGrantIds(db, workspaceId, userIds[1]!)).toEqual([c.id]);

    await reinstateGrantsForMember(db, workspaceId, userIds[0]!);
    const still = (id: number) => db.query.accessGrants.findFirst({ where: eq(accessGrants.id, id) }).then((r) => r!.suspendedAt);
    expect(await still(a.id)).not.toBeNull();
    expect(await still(b.id)).not.toBeNull();
  });
});
