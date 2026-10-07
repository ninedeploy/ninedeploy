/**
 * D1/F146 — a user always owns the personal workspace created for them,
 * whichever path created it. The OIDC callback used to seat an auto-enrolled
 * user in their own personal workspace (workspaces.ownerId = the user) with
 * the provider's defaultRole, so a 'member'/'viewer' default left them unable
 * to rename, invite into or repair the workspace they owned. F1000: the boot
 * repair upgrades exactly that seat on installs that already hold such rows.
 *
 * Real migrated SQLite: seats, invitations and ownership are SQL state a fake
 * db cannot model. The IdP network seam (lib/oauth.js) is faked; state signing
 * and the state cookie check stay real.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, asc, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  oidcProviders,
  users,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
  type DB,
} from '@ninedeploy/db';

const idp = vi.hoisted(() => ({ sub: 'sub-1', email: 'sso@corp.test', name: 'Sso User', emailVerified: true }));

vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/oauth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/oauth.js')>();
  return {
    ...actual,
    fetchOidcConfiguration: vi.fn(async (issuer: string) => ({
      authorization_endpoint: `${issuer}/auth`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
    })),
    exchangeOidcCode: vi.fn(async () => ({ access_token: 'fake-at' })),
    fetchOidcUserInfo: vi.fn(async () => ({ ...idp })),
  };
});

const { authRoutes } = await import('../src/modules/auth.js');
const { workspaceRoutes, ensureDefaultWorkspaceWithRole } = await import('../src/modules/workspaces.js');
const { repairOwnerSeats } = await import('../src/lib/ownerSeatRepair.js');
const { encrypt, sha256 } = await import('../src/lib/crypto.js');
const { generateOAuthState } = await import('../src/lib/oauth.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const HASH = '$argon2id$v=19$m=19456,t=2,p=1$fixture$fixture';
type Role = 'owner' | 'admin' | 'member' | 'viewer';

let db: DB;
let close: () => void;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-sso-personal-owner-'));
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
    /* Windows SQLite file lock */
  }
});

async function user(email: string, isInstanceOperator = false): Promise<number> {
  const [u] = await db.insert(users).values({ email, passwordHash: HASH, isInstanceOperator }).returning();
  return u!.id;
}
async function provider(defaultRole: Role): Promise<void> {
  await db.insert(oidcProviders).values({
    name: 'corp',
    slug: 'corp',
    issuerUrl: 'https://corp.idp.example.test',
    clientId: 'cid',
    clientSecretEncrypted: encrypt(['client', 'secret'].join('-')),
    autoEnroll: true,
    defaultRole,
  });
}
async function seatRole(workspaceId: number, userId: number): Promise<string | null> {
  const seat = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
  });
  return seat?.role ?? null;
}
async function oidcLogin(email: string, sub: string): Promise<number> {
  Object.assign(idp, { email, sub });
  const app = await buildTestApp({ db });
  await app.register(authRoutes, { prefix: '/v1/auth' });
  const state = generateOAuthState('corp', '/');
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/oidc/corp/callback',
    headers: { cookie: `ninedeploy_oidc_corp=${sha256(state)}` },
    payload: { code: 'c0de', state },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { user: { id: number } }).user.id;
}
async function rename(userId: number, workspaceId: number): Promise<number> {
  const app = await buildTestApp({ db });
  await app.register(workspaceRoutes, { prefix: '/workspaces' });
  const res = await app.inject({
    method: 'PATCH',
    url: `/workspaces/${workspaceId}`,
    headers: asUser({ id: userId, isOperator: false }),
    payload: { name: 'Renamed' },
  });
  return res.statusCode;
}

describe('D1/F146: SSO auto-enroll owns its personal workspace', () => {
  it.each(['member', 'viewer', 'admin'] as const)('defaultRole %s → owner seat, and the owner can rename it', async (role) => {
    await user('op@corp.test', true); // not the instance's first user
    await provider(role);
    const uid = await oidcLogin(`${role}@corp.test`, `s-${role}`);
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.ownerId, uid) });
    expect(ws).toBeDefined();
    expect(await seatRole(ws!.id, uid)).toBe('owner');
    expect(await rename(uid, ws!.id)).toBe(200);
  });

  it('a team invitation keeps its own role; only the personal seat is owner', async () => {
    const op = await user('op@corp.test', true);
    const [team] = await db.insert(workspaces).values({ name: 'Team', slug: 'team', ownerId: op }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: team!.id, userId: op, role: 'owner' });
    await db.insert(workspaceInvitations).values({
      workspaceId: team!.id,
      email: 'inv@corp.test',
      role: 'viewer',
      token: sha256('d1-invite'),
      invitedByUserId: op,
      expiresAt: new Date('2999-01-01T00:00:00.000Z'),
    });
    await provider('member');
    const uid = await oidcLogin('inv@corp.test', 's-inv');
    expect(await seatRole(team!.id, uid)).toBe('viewer');
    const owned = (await db.select().from(workspaces)).filter((w) => w.ownerId === uid);
    expect(owned).toHaveLength(1);
    expect(await seatRole(owned[0]!.id, uid)).toBe('owner');
  });
});

describe('F1000: repairOwnerSeats (boot repair)', () => {
  it('upgrades a pre-fix SSO personal seat so its owner can manage it again', async () => {
    const uid = await user('legacy@corp.test');
    // The exact pre-fix call shape the OIDC callback used (defaultRole 'member').
    const ws = await ensureDefaultWorkspaceWithRole(db, { id: uid, name: 'Legacy' }, 'member');
    expect(await rename(uid, ws.id)).toBe(403);
    expect((await repairOwnerSeats(db)).repaired).toHaveLength(1);
    expect(await seatRole(ws.id, uid)).toBe('owner');
    expect(await rename(uid, ws.id)).toBe(200);
  });

  it('touches only ownerId’s own seat, skips ambiguous workspaces, never inserts, and is idempotent', async () => {
    const [u1, u2, u3, u4, u5] = [await user('a@x'), await user('b@x'), await user('c@x'), await user('d@x'), await user('e@x')];
    const ws = async (slug: string, ownerId: number) =>
      (await db.insert(workspaces).values({ name: slug, slug, ownerId }).returning())[0]!.id;
    const seat = async (workspaceId: number, userId: number, role: Role) =>
      (await db.insert(workspaceMembers).values({ workspaceId, userId, role }).returning())[0]!.id;
    const broken = await ws('broken', u1);
    const s1 = await seat(broken, u1, 'viewer');
    await seat(broken, u2, 'member');
    const ambiguous = await ws('ambiguous', u3);
    await seat(ambiguous, u3, 'admin');
    await seat(ambiguous, u4, 'owner');
    const seatlessOwner = await ws('seatless-owner', u5);
    await seat(seatlessOwner, u2, 'member');

    const rows = () => db.select().from(workspaceMembers).orderBy(asc(workspaceMembers.id));
    const before = await rows();
    const first = await repairOwnerSeats(db);
    expect(first).toEqual({ repaired: [s1], ambiguous: [ambiguous] });
    const after = await rows();
    expect(after).toHaveLength(before.length);
    expect(after.filter((r, i) => JSON.stringify(r) !== JSON.stringify(before[i])).map((r) => r.id)).toEqual([s1]);
    expect(await seatRole(broken, u1)).toBe('owner');
    expect(await seatRole(broken, u2)).toBe('member');
    expect(await seatRole(ambiguous, u3)).toBe('admin');
    expect(await seatRole(seatlessOwner, u5)).toBeNull();

    expect((await repairOwnerSeats(db)).repaired).toEqual([]);
    expect(await rows()).toEqual(after);
  });
});
