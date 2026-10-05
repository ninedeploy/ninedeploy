/**
 * r710 — the one-shot hand-over of resources whose creator lost their seat
 * before r695 (SCIM removals up to 0.10.42), against a real migrated SQLite:
 * seats, tags and project workspaces are SQL state a fake db cannot model.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  databases,
  projects,
  serviceProjects,
  serviceWorkspaces,
  services,
  users,
  workspaceMembers,
  workspaces,
  type DB,
} from '@ninedeploy/db';
import { OWNERSHIP_BACKFILL_KEY, ensureOwnershipBackfilled, rehomeSeatlessOwners } from '../src/lib/ownershipBackfill.js';
import { filterTrustworthyProjectLinks } from '../src/engine/pipeline.js';
import { getSettingString } from '../src/lib/settings.js';

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const HASH = '$argon2id$v=19$m=19456,t=2,p=1$fixture$fixture';

let db: DB;
let close: () => void;
let dir: string;
let n = 0;

async function user(isInstanceOperator = false): Promise<number> {
  const [u] = await db.insert(users).values({ email: `u${++n}@x.test`, passwordHash: HASH, isInstanceOperator }).returning();
  return u!.id;
}
async function workspace(ownerId: number): Promise<number> {
  const [w] = await db.insert(workspaces).values({ name: `W${++n}`, slug: `w${n}`, ownerId }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: w!.id, userId: ownerId, role: 'owner' });
  return w!.id;
}
async function service(ownerUserId: number | null, wsIds: number[]): Promise<number> {
  const [s] = await db.insert(services).values({ name: `s${++n}`, slug: `s${n}`, ownerUserId }).returning();
  for (const workspaceId of wsIds) await db.insert(serviceWorkspaces).values({ serviceId: s!.id, workspaceId });
  return s!.id;
}
async function database(ownerUserId: number, workspaceId: number | null): Promise<number> {
  const [p] = await db.insert(projects).values({ name: `p${++n}`, slug: `p${n}`, workspaceId }).returning();
  const [d] = await db
    .insert(databases)
    .values({ name: `d${n}`, slug: `d${n}`, engine: 'postgres', projectId: p!.id, ownerUserId, passwordEncrypted: 'x' })
    .returning();
  return d!.id;
}
const ownerOf = async (id: number) => (await db.query.services.findFirst({ where: eq(services.id, id) }))!.ownerUserId;
const dbOwnerOf = async (id: number) => (await db.query.databases.findFirst({ where: eq(databases.id, id) }))!.ownerUserId;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-owner-backfill-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

afterEach(() => {
  close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may hold the file a moment longer */
  }
});

describe('ownership backfill (r710)', () => {
  it('hands a seatless creator’s team service and database to the workspace owner, restoring shared env', async () => {
    const owner = await user();
    const ws = await workspace(owner);
    const leaver = await user(); // SCIM removed the seat before 0.10.43; ownership stayed
    const svc = await service(leaver, [ws]);
    const dbId = await database(leaver, ws);
    const [proj] = await db.insert(projects).values({ name: 'team', slug: 'team', workspaceId: ws }).returning();
    await db.insert(serviceProjects).values({ serviceId: svc, projectId: proj!.id });

    // The deploy-time symptom: the project's shared env was dropped.
    const svcRow = { ownerUserId: leaver };
    expect(await filterTrustworthyProjectLinks(db, svcRow, [{ projectId: proj!.id }])).toEqual([]);

    const result = await rehomeSeatlessOwners(db);
    expect(result).toEqual({ services: [svc], databases: [dbId], ambiguous: [] });
    expect(await ownerOf(svc)).toBe(owner);
    expect(await dbOwnerOf(dbId)).toBe(owner);
    expect(await filterTrustworthyProjectLinks(db, { ownerUserId: owner }, [{ projectId: proj!.id }])).toHaveLength(1);
  });

  it('leaves seated creators, personal resources and operator-owned resources alone', async () => {
    const owner = await user();
    const ws = await workspace(owner);
    const member = await user();
    await db.insert(workspaceMembers).values({ workspaceId: ws, userId: member, role: 'viewer' });
    const seatedSvc = await service(member, [ws]);
    const seatedDb = await database(member, ws);
    const loner = await user();
    const personalSvc = await service(loner, []);
    const personalDb = await database(loner, null);
    const operator = await user(true);
    const opSvc = await service(operator, [ws]);
    const opDb = await database(operator, ws);
    const ownerless = await service(null, [ws]);

    const result = await rehomeSeatlessOwners(db);
    expect(result).toEqual({ services: [], databases: [], ambiguous: [] });
    expect(await ownerOf(seatedSvc)).toBe(member);
    expect(await dbOwnerOf(seatedDb)).toBe(member);
    expect(await ownerOf(personalSvc)).toBe(loner);
    expect(await dbOwnerOf(personalDb)).toBe(loner);
    expect(await ownerOf(opSvc)).toBe(operator);
    expect(await dbOwnerOf(opDb)).toBe(operator);
    expect(await ownerOf(ownerless)).toBeNull();
  });

  it('keeps a creator seated in any one of the service’s workspaces, and never picks between two owners', async () => {
    const ownerA = await user();
    const ownerB = await user();
    const wsA = await workspace(ownerA);
    const wsB = await workspace(ownerB);
    const creator = await user();
    await db.insert(workspaceMembers).values({ workspaceId: wsB, userId: creator, role: 'member' });
    const stillSeated = await service(creator, [wsA, wsB]);
    const gone = await user();
    const split = await service(gone, [wsA, wsB]);

    const result = await rehomeSeatlessOwners(db);
    expect(result.services).toEqual([]);
    expect(result.ambiguous).toEqual([split]);
    expect(await ownerOf(stillSeated)).toBe(creator);
    expect(await ownerOf(split)).toBe(gone);
  });

  it('runs once per install and records what it moved', async () => {
    const owner = await user();
    const ws = await workspace(owner);
    const leaver = await user();
    const svc = await service(leaver, [ws]);
    const logged: string[] = [];

    const first = await ensureOwnershipBackfilled(db, (msg) => logged.push(msg));
    expect(first?.services).toEqual([svc]);
    expect(logged.join('\n')).toMatch(/r710/);
    expect(await getSettingString(db, OWNERSHIP_BACKFILL_KEY, null)).not.toBeNull();
    const audits = await db.query.auditLog.findMany();
    expect(audits.some((a) => a.action === 'ownership.backfill')).toBe(true);

    // A later seatless creator is the live paths' job (r097/r695), not a reboot's.
    const later = await service(await user(), [ws]);
    expect(await ensureOwnershipBackfilled(db)).toBeNull();
    expect(await ownerOf(later)).not.toBe(owner);
  });
});
