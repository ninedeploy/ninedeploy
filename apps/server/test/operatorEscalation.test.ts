/**
 * Regression guard: instance-operator rights must not be self-grantable.
 *
 * The escalation this file exists to prevent:
 *
 *   `isOperator` used to mean "holds owner/admin in at least one workspace".
 *   `POST /v1/workspaces` has no role gate and inserts the caller as `owner`,
 *   and `GET /v1/workspaces` auto-creates an owned workspace for a user with
 *   no memberships. Either request therefore promoted any authenticated user
 *   to a full instance operator on their next call — and because
 *   `lib/hostPrivilege.ts` hangs the host-privilege boundary off that same
 *   flag, "member" was one request away from running arbitrary code on the
 *   host via a PM2 service, a compose file or a deploy lifecycle hook.
 *
 * These tests run against a REAL in-memory database with the real migrations
 * and the real `resolveUser`, because the escalation lived in the interaction
 * between the workspace routes, the users table and the auth resolver — a
 * mocked db would have happily agreed with either implementation.
 */
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, users, workspaceMembers, workspaces, type DB } from '@ninedeploy/db';
import authPlugin from '../src/plugins/auth.js';
import { workspaceRoutes } from '../src/modules/workspaces.js';
import { userRoutes } from '../src/modules/users.js';
import { isOperator } from '../src/lib/resourceAccess.js';
import { issueSessionTokens } from '../src/lib/sessions.js';

// The real traefik plugin recreates the HOST's `ninedeploy-traefik` container
// on ready, pointed at this test's data dir — a test run on a developer box
// would silently re-plumb their local proxy. Same stub as app.test.ts.
vi.mock('../src/plugins/traefik.js', () => ({ default: vi.fn(async () => undefined) }));

const MIGRATIONS = fileURLToPath(
  new URL('../../../packages/db/src/migrations', import.meta.url),
);

let db: DB;
let app: FastifyInstance;

/** A user with no operator flag and no workspace seat — the attacker shape. */
async function makeMember(email: string): Promise<{ id: number; token: string }> {
  const [row] = await db.insert(users).values({ email, passwordHash: 'hash' }).returning();
  const { accessToken } = await issueSessionTokens(db, row!);
  return { id: row!.id, token: accessToken };
}

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  instance.decorate('db', db);
  await instance.register(authPlugin);
  await instance.register(workspaceRoutes, { prefix: '/workspaces' });
  await instance.register(userRoutes, { prefix: '/users' });
  return instance;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await migrate(db, { migrationsFolder: MIGRATIONS });
  app = await buildApp();
});

describe('instance-operator rights cannot be self-granted', () => {
  it('creating a workspace does not make the creator an operator', async () => {
    const member = await makeMember('member@example.com');
    expect(await isOperator(db, member)).toBe(false);

    const created = await app.inject({
      method: 'POST',
      url: '/workspaces',
      headers: bearer(member.token),
      payload: { name: 'Totally Legit Team' },
    });
    expect(created.statusCode).toBe(200);
    // They really are an `owner` of that workspace…
    expect(created.json()).toMatchObject({ myRole: 'owner' });
    const seats = await db.query.workspaceMembers.findMany({
      where: eq(workspaceMembers.userId, member.id),
    });
    expect(seats.map((s) => s.role)).toEqual(['owner']);

    // …and that confers exactly nothing at instance level.
    expect(await isOperator(db, member)).toBe(false);
  });

  it('listing workspaces auto-creates a personal one without conferring operator', async () => {
    const member = await makeMember('lister@example.com');

    const listed = await app.inject({
      method: 'GET',
      url: '/workspaces',
      headers: bearer(member.token),
    });
    expect(listed.statusCode).toBe(200);
    // The convenience workspace is still created (the UI depends on it)…
    expect(listed.json()).toHaveLength(1);
    expect(await db.query.workspaces.findMany()).toHaveLength(1);
    // …but the flag stays off.
    expect(await isOperator(db, member)).toBe(false);
  });

  it('an operator-only route stays 403 after the workspace is created', async () => {
    const member = await makeMember('escalator@example.com');
    await app.inject({
      method: 'POST',
      url: '/workspaces',
      headers: bearer(member.token),
      payload: { name: 'Escalation Attempt' },
    });

    // /users is the canonical operator-only surface.
    const listed = await app.inject({ method: 'GET', url: '/users', headers: bearer(member.token) });
    expect(listed.statusCode).toBe(403);
  });

  it('a member cannot grant themselves the flag through the users route', async () => {
    const member = await makeMember('greedy@example.com');
    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${member.id}/operator`,
      headers: bearer(member.token),
      payload: { isOperator: true },
    });
    expect(res.statusCode).toBe(403);
    const after = await db.query.users.findFirst({ where: eq(users.id, member.id) });
    expect(after?.isInstanceOperator).toBe(false);
  });
});

describe('the operator flag is the thing that actually grants access', () => {
  it('a user carrying the flag reaches operator-only routes', async () => {
    const operator = await makeMember('boss@example.com');
    await db.update(users).set({ isInstanceOperator: true }).where(eq(users.id, operator.id));

    expect(await isOperator(db, operator)).toBe(true);
    const listed = await app.inject({ method: 'GET', url: '/users', headers: bearer(operator.token) });
    expect(listed.statusCode).toBe(200);
  });

  it('an operator can grant and then revoke the flag for someone else', async () => {
    const operator = await makeMember('boss@example.com');
    await db.update(users).set({ isInstanceOperator: true }).where(eq(users.id, operator.id));
    const member = await makeMember('promoted@example.com');

    const granted = await app.inject({
      method: 'PATCH',
      url: `/users/${member.id}/operator`,
      headers: bearer(operator.token),
      payload: { isOperator: true },
    });
    expect(granted.statusCode).toBe(200);
    // Recomputed per request, so it takes effect immediately — no re-login.
    const nowAllowed = await app.inject({ method: 'GET', url: '/users', headers: bearer(member.token) });
    expect(nowAllowed.statusCode).toBe(200);

    const revoked = await app.inject({
      method: 'PATCH',
      url: `/users/${member.id}/operator`,
      headers: bearer(operator.token),
      payload: { isOperator: false },
    });
    expect(revoked.statusCode).toBe(200);
    const denied = await app.inject({ method: 'GET', url: '/users', headers: bearer(member.token) });
    expect(denied.statusCode).toBe(403);
  });

  it('refuses to strip the flag from the last operator', async () => {
    const operator = await makeMember('only-one@example.com');
    await db.update(users).set({ isInstanceOperator: true }).where(eq(users.id, operator.id));

    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${operator.id}/operator`,
      headers: bearer(operator.token),
      payload: { isOperator: false },
    });
    expect(res.statusCode).toBe(400);
    const after = await db.query.users.findFirst({ where: eq(users.id, operator.id) });
    expect(after?.isInstanceOperator).toBe(true);
  });
});

describe('migration 0038 backfill', () => {
  it('promotes the bootstrap user and the founding workspace admins only', async () => {
    // Rebuild the pre-migration world: a bootstrap admin who owns the first
    // workspace, a colleague made admin there, and an "attacker" who owned a
    // workspace of their own — the exact shape the escalation produced.
    const [boss] = await db.insert(users).values({ email: 'boss@x', passwordHash: 'h' }).returning();
    const [mate] = await db.insert(users).values({ email: 'mate@x', passwordHash: 'h' }).returning();
    const [attacker] = await db.insert(users).values({ email: 'evil@x', passwordHash: 'h' }).returning();
    const [first] = await db
      .insert(workspaces)
      .values({ name: 'Founding', slug: 'founding', ownerId: boss!.id })
      .returning();
    const [own] = await db
      .insert(workspaces)
      .values({ name: 'Self Served', slug: 'self-served', ownerId: attacker!.id })
      .returning();
    await db.insert(workspaceMembers).values([
      { workspaceId: first!.id, userId: boss!.id, role: 'owner' },
      { workspaceId: first!.id, userId: mate!.id, role: 'admin' },
      { workspaceId: own!.id, userId: attacker!.id, role: 'owner' },
    ]);

    // Re-run the backfill statements from 0038 against this state.
    const { sql } = await import('drizzle-orm');
    await db.run(
      sql`UPDATE users SET is_instance_operator = true WHERE id = (SELECT MIN(id) FROM users)`,
    );
    await db.run(sql`
      UPDATE users SET is_instance_operator = true
       WHERE id IN (
         SELECT user_id FROM workspace_members
          WHERE workspace_id = (SELECT MIN(id) FROM workspaces)
            AND role IN ('owner', 'admin')
       )`);

    const after = await db.query.users.findMany();
    const flags = Object.fromEntries(after.map((u) => [u.email, u.isInstanceOperator]));
    expect(flags['boss@x']).toBe(true);
    expect(flags['mate@x']).toBe(true);
    // The self-served workspace owner is deliberately NOT carried over.
    expect(flags['evil@x']).toBe(false);
  });
});
