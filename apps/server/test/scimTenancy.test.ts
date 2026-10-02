/**
 * r501 — SCIM tenancy against a real migrated SQLite: which account a
 * workspace's IdP may adopt, and whether its "deactivate" reaches the whole
 * instance or only the seat in its own workspace. Membership rosters,
 * ownership and the parked-seat setting are SQL state a fake db cannot model.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, scimTokens, users, workspaceMembers, workspaces, type DB } from '@ninedeploy/db';
import { scimRoutes } from '../src/modules/scim.js';
import { sha256 } from '../src/lib/crypto.js';
import { buildTestApp } from './helpers.js';

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const TOKEN_A = ['scim', 'tenant-a', 'token'].join('_');
/** A real local/SSO account always has an argon2 hash; SCIM-created ones never do. */
const LOCAL_HASH = '$argon2id$v=19$m=19456,t=2,p=1$fixture$fixture';

let db: DB;
let close: () => void;
let dir: string;
let app: FastifyInstance;
let wsA: number;
let wsB: number;
let ownerA: number;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-scim-tenancy-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const [oa] = await db.insert(users).values({ email: 'owner-a@x.test', passwordHash: LOCAL_HASH }).returning();
  const [ob] = await db.insert(users).values({ email: 'owner-b@x.test', passwordHash: LOCAL_HASH }).returning();
  ownerA = oa!.id;
  const [a] = await db.insert(workspaces).values({ name: 'A', slug: 'a', ownerId: oa!.id }).returning();
  const [b] = await db.insert(workspaces).values({ name: 'B', slug: 'b', ownerId: ob!.id }).returning();
  wsA = a!.id;
  wsB = b!.id;
  await db.insert(workspaceMembers).values([
    { workspaceId: wsA, userId: oa!.id, role: 'owner' },
    { workspaceId: wsB, userId: ob!.id, role: 'owner' },
  ]);
  await db.insert(scimTokens).values({ name: 'IdP A', tokenHash: sha256(TOKEN_A), workspaceId: wsA });
  app = await buildTestApp({ db });
  await app.register(scimRoutes, { prefix: '/scim/v2' });
});

afterEach(async () => {
  await app.close();
  close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

const auth = { authorization: `Bearer ${TOKEN_A}` };
const deactivate = (id: number) =>
  app.inject({
    method: 'PATCH',
    url: `/scim/v2/Users/${id}`,
    headers: auth,
    payload: { Operations: [{ op: 'replace', path: 'active', value: false }] },
  });
const reactivate = (id: number) =>
  app.inject({
    method: 'PATCH',
    url: `/scim/v2/Users/${id}`,
    headers: auth,
    payload: { Operations: [{ op: 'replace', path: 'active', value: true }] },
  });
const seat = async (userId: number, workspaceId: number) =>
  db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, workspaceId)),
  });
const userById = async (id: number) => db.query.users.findFirst({ where: eq(users.id, id) });

async function localUserIn(...memberships: Array<[number, 'admin' | 'member']>) {
  const [u] = await db.insert(users).values({ email: `local-${Math.random()}@x.test`, passwordHash: LOCAL_HASH }).returning();
  for (const [workspaceId, role] of memberships) await db.insert(workspaceMembers).values({ workspaceId, userId: u!.id, role });
  return u!;
}

describe('r501: SCIM adoption is limited to the workspace', () => {
  it("cannot pull another tenant's user into its workspace by email", async () => {
    const victim = await localUserIn([wsB, 'member']);
    const res = await app.inject({ method: 'POST', url: '/scim/v2/Users', headers: auth, payload: { userName: victim.email, externalId: 'evil-1' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().scimType).toBe('uniqueness');
    expect(await seat(victim.id, wsA)).toBeUndefined();
    expect((await userById(victim.id))!.scimExternalId).toBeNull();
    // …so its deactivation switch cannot reach the victim either.
    expect((await deactivate(victim.id)).statusCode).toBe(404);
    expect((await userById(victim.id))!.deactivatedAt).toBeNull();
  });

  it('still adopts an account that is already a member (IdP retry / first sync)', async () => {
    const member = await localUserIn([wsA, 'member']);
    const res = await app.inject({ method: 'POST', url: '/scim/v2/Users', headers: auth, payload: { userName: member.email, externalId: 'okta-42' } });
    expect(res.statusCode).toBe(200);
    expect((await userById(member.id))!.scimExternalId).toBe('okta-42');
  });
});

describe('r501: SCIM deactivation reaches only what the workspace owns', () => {
  it('a member of several tenants is only suspended in this workspace — and can be reinstated with their role', async () => {
    const shared = await localUserIn([wsA, 'admin'], [wsB, 'member']);
    const off = await deactivate(shared.id);
    expect(off.statusCode).toBe(200);
    expect(off.json().active).toBe(false);
    // The account itself and the other tenant's seat are untouched.
    expect((await userById(shared.id))!.deactivatedAt).toBeNull();
    expect(await seat(shared.id, wsB)).toBeDefined();
    expect(await seat(shared.id, wsA)).toBeUndefined();
    // The IdP still sees its (inactive) user…
    const get = await app.inject({ method: 'GET', url: `/scim/v2/Users/${shared.id}`, headers: auth });
    expect(get.statusCode).toBe(200);
    expect(get.json().active).toBe(false);
    const list = await app.inject({ method: 'GET', url: `/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${shared.email}"`)}`, headers: auth });
    expect(list.json().Resources[0]).toMatchObject({ id: String(shared.id), active: false });
    // …and re-enabling gives the seat back with the role it had.
    const on = await reactivate(shared.id);
    expect(on.statusCode).toBe(200);
    expect(on.json().active).toBe(true);
    expect((await seat(shared.id, wsA))!.role).toBe('admin');
  });

  it('a local (non-SCIM) account in this workspace only is suspended, not deactivated', async () => {
    const local = await localUserIn([wsA, 'member']);
    expect((await deactivate(local.id)).statusCode).toBe(200);
    expect((await userById(local.id))!.deactivatedAt).toBeNull();
    expect(await seat(local.id, wsA)).toBeUndefined();
  });

  it('an account SCIM created here, with no other tenant, is deactivated instance-wide as before', async () => {
    const created = await app.inject({ method: 'POST', url: '/scim/v2/Users', headers: auth, payload: { userName: 'fresh@corp.test', externalId: 'okta-1' } });
    expect(created.statusCode).toBe(201);
    const id = Number(created.json().id);
    // Their own personal workspace (alone in it) is not another tenant.
    const [personal] = await db.insert(workspaces).values({ name: 'Mine', slug: 'mine', ownerId: id }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: personal!.id, userId: id, role: 'owner' });
    expect((await deactivate(id)).statusCode).toBe(200);
    expect((await userById(id))!.deactivatedAt).not.toBeNull();
    expect((await userById(id))!.deactivatedByWorkspaceId).toBe(wsA);
  });

  it('a SCIM-created account that another tenant also seated is only suspended', async () => {
    const created = await app.inject({ method: 'POST', url: '/scim/v2/Users', headers: auth, payload: { userName: 'both@corp.test' } });
    const id = Number(created.json().id);
    await db.insert(workspaceMembers).values({ workspaceId: wsB, userId: id, role: 'member' });
    expect((await deactivate(id)).statusCode).toBe(200);
    expect((await userById(id))!.deactivatedAt).toBeNull();
    expect(await seat(id, wsB)).toBeDefined();
  });

  it("refuses to strip the workspace owner's own seat", async () => {
    await db.insert(workspaceMembers).values({ workspaceId: wsB, userId: ownerA, role: 'member' });
    const res = await deactivate(ownerA);
    expect(res.statusCode).toBe(403);
    expect(await seat(ownerA, wsA)).toBeDefined();
  });

  it('DELETE of a shared user leaves this workspace and forgets the parked seat', async () => {
    const shared = await localUserIn([wsA, 'member'], [wsB, 'member']);
    await deactivate(shared.id);
    const del = await app.inject({ method: 'DELETE', url: `/scim/v2/Users/${shared.id}`, headers: auth });
    expect(del.statusCode).toBe(200);
    expect((await userById(shared.id))!.deactivatedAt).toBeNull();
    expect(await seat(shared.id, wsB)).toBeDefined();
    expect((await app.inject({ method: 'GET', url: `/scim/v2/Users/${shared.id}`, headers: auth })).statusCode).toBe(404);
  });

  it('a re-provisioning push for a suspended member reinstates the seat', async () => {
    const shared = await localUserIn([wsA, 'member'], [wsB, 'member']);
    await deactivate(shared.id);
    const push = await app.inject({ method: 'POST', url: '/scim/v2/Users', headers: auth, payload: { userName: shared.email } });
    expect(push.statusCode).toBe(200);
    expect(await seat(shared.id, wsA)).toBeDefined();
  });
});
