/**
 * r710 — the one-shot hand-over of resources whose creator lost their seat
 * before r695 (SCIM removals up to 0.10.42), against a real migrated SQLite:
 * seats, tags and project workspaces are SQL state a fake db cannot model.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import {
  DEACTIVATED_OWNER_REPAIR_KEY,
  OWNERSHIP_BACKFILL_KEY,
  ensureDeactivatedOwnersRepaired,
  ensureOwnershipBackfilled,
  rehomeSeatlessOwners,
} from '../src/lib/ownershipBackfill.js';
import { filterTrustworthyProjectLinks } from '../src/engine/pipeline.js';
import { getSettingString, setSettingString } from '../src/lib/settings.js';

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

  it('F976: a deactivated creator’s own workspace neither keeps nor inherits a team service', async () => {
    const owner = await user();
    const team = await workspace(owner);
    // ≤0.10.42 instance-wide SCIM DELETE: deactivated, team seat removed, nothing re-homed.
    const gone = await user();
    await db.update(users).set({ deactivatedAt: new Date(0) }).where(eq(users.id, gone));
    const personal = await workspace(gone);
    const shared = await service(gone, [team, personal]);
    const personalOnly = await service(gone, [personal]);
    // SCIM PATCH keeps the seat: a team seat a deactivated user still holds still counts.
    const paused = await user();
    await db.update(users).set({ deactivatedAt: new Date(0) }).where(eq(users.id, paused));
    await db.insert(workspaceMembers).values({ workspaceId: team, userId: paused, role: 'member' });
    const pausedSvc = await service(paused, [team, await workspace(paused)]);
    // An active creator's personal seat still keeps a shared service (r710 rule).
    const active = await user();
    const activeSvc = await service(active, [team, await workspace(active)]);

    const result = await rehomeSeatlessOwners(db);
    expect(result).toEqual({ services: [shared], databases: [], ambiguous: [] });
    expect(await ownerOf(shared)).toBe(owner);
    expect(await ownerOf(personalOnly)).toBe(gone);
    expect(await ownerOf(pausedSvc)).toBe(paused);
    expect(await ownerOf(activeSvc)).toBe(active);
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

  it('F1002: after an r710-marked upgrade the r976 repair hands a deactivated owner’s team service over, once', async () => {
    const owner = await user();
    const team = await workspace(owner);
    const gone = await user();
    await db.update(users).set({ deactivatedAt: new Date(0) }).where(eq(users.id, gone));
    const shared = await service(gone, [team, await workspace(gone)]); // left behind by the pre-F976 backfill
    const teamDb = await database(gone, team);
    const ownerB = await user();
    const split = await service(gone, [team, await workspace(ownerB)]); // two heirs: never picked
    const active = await user();
    const activeSvc = await service(active, [team]); // seatless but active: the repair is not r710 again
    await setSettingString(db, OWNERSHIP_BACKFILL_KEY, '2026-09-30T00:00:00.000Z');
    expect(await ensureOwnershipBackfilled(db)).toBeNull();
    const logged: string[] = [];

    const result = await ensureDeactivatedOwnersRepaired(db, (msg) => logged.push(msg));
    expect(result).toEqual({ services: [shared], databases: [teamDb], ambiguous: [split] });
    expect(await ownerOf(shared)).toBe(owner);
    expect(await dbOwnerOf(teamDb)).toBe(owner);
    expect(await ownerOf(split)).toBe(gone);
    expect(await ownerOf(activeSvc)).toBe(active);
    const audits = (await db.query.auditLog.findMany()).filter((a) => a.action === 'ownership.backfill');
    expect(audits.map((a) => a.meta)).toEqual([
      { kind: 'service', id: shared, from: gone, to: owner, repair: 'r976' },
      { kind: 'database', id: teamDb, from: gone, to: owner, repair: 'r976' },
    ]);
    expect(logged).toHaveLength(3);
    expect(logged.every((m) => m.includes('(r976)'))).toBe(true);
    expect(await getSettingString(db, DEACTIVATED_OWNER_REPAIR_KEY, null)).not.toBeNull();

    // Second boot: the marker makes it a no-op.
    const later = await service(gone, [team]);
    expect(await ensureDeactivatedOwnersRepaired(db)).toBeNull();
    expect(await ownerOf(later)).toBe(gone);
  });

  it('F1002: the repair runs without the r710 marker and is wired at boot after r710', async () => {
    const owner = await user();
    const team = await workspace(owner);
    const gone = await user();
    await db.update(users).set({ deactivatedAt: new Date(0) }).where(eq(users.id, gone));
    const svc = await service(gone, [team]);
    expect(await getSettingString(db, OWNERSHIP_BACKFILL_KEY, null)).toBeNull();
    expect((await ensureDeactivatedOwnersRepaired(db))?.services).toEqual([svc]);
    expect(await ownerOf(svc)).toBe(owner);

    // Assert the mount, not just the unit: plugins/db.ts calls it after r710.
    const boot = readFileSync(fileURLToPath(new URL('../src/plugins/db.ts', import.meta.url)), 'utf8');
    const r710 = boot.indexOf('await ensureOwnershipBackfilled(db');
    expect(r710).toBeGreaterThan(0);
    expect(boot.indexOf('await ensureDeactivatedOwnersRepaired(db')).toBeGreaterThan(r710);
  });
});
