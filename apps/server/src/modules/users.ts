import { and, eq, sql } from 'drizzle-orm';
import { audit } from '../lib/audit.js';
import { type DB, users, workspaceMembers, workspaces } from '@ninedeploy/db';
import { revokeAllSessions, revokeApiTokens } from '../lib/sessions.js';
import type { FastifyPluginAsync } from 'fastify';
import { operatorGrant, passwordReset, userCreate } from '@ninedeploy/schemas';
import { badRequest, forbidden, notFound, parseId } from '../lib/errors.js';
import { hashPassword } from '../lib/crypto.js';
import { setSettingString } from '../lib/settings.js';
import { STUDIO_EPOCH_KEY } from './studioProxy.js';
import { issueResetToken } from '../lib/passwordReset.js';
import { config } from '../config.js';
import { normalizeEmail } from '../lib/authHelpers.js';
import { rehomeOwnedResources } from './workspaces.js';

/** How many accounts currently carry the instance-operator flag. */
async function operatorCount(db: import('@ninedeploy/db').DB): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.isInstanceOperator, true));
  return rows.length;
}

/**
 * r540: hand everything a user is about to take down with them to someone who
 * stays. `workspaces.owner_id` is `ON DELETE CASCADE`, so deleting an owner
 * used to delete each workspace they owned — and through it every project,
 * environment, label, invitation, SCIM token and OTHER member's seat in it.
 * Rebuilding the table to change the rule is not an option on a live
 * database, so the route moves ownership first:
 *   - each owned workspace goes to `toUserId`, who gets (or is promoted to)
 *     an owner seat so the ownership row and the membership agree;
 *   - services and databases the user owned inside ANY workspace they sat in
 *     go to that workspace's (possibly new) owner — what removing the member
 *     does (r097). Left alone they would be detached (`ON DELETE SET NULL`),
 *     and an ownerless service skips the job/webhook deploy authorization.
 * Returns the transferred workspaces so the caller can audit each one.
 */
export async function transferUserHoldings(
  db: Pick<DB, 'select' | 'insert' | 'update' | 'query'>,
  fromUserId: number,
  toUserId: number,
): Promise<Array<{ id: number; name: string }>> {
  const owned = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.ownerId, fromUserId));
  for (const ws of owned) {
    const seat = await db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, ws.id), eq(workspaceMembers.userId, toUserId)),
    });
    if (seat) {
      await db.update(workspaceMembers).set({ role: 'owner' }).where(eq(workspaceMembers.id, seat.id));
    } else {
      await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: toUserId, role: 'owner' });
    }
    await db.update(workspaces).set({ ownerId: toUserId }).where(eq(workspaces.id, ws.id));
  }
  const seats = await db
    .select({ workspaceId: workspaceMembers.workspaceId, ownerId: workspaces.ownerId })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, fromUserId));
  for (const seat of seats) {
    if (seat.ownerId !== fromUserId) await rehomeOwnedResources(db, seat.workspaceId, fromUserId, seat.ownerId, 'account-deletion');
  }
  return owned;
}

interface UserListEntry {
  id: number;
  email: string;
  name: string | null;
  isOperator: boolean;
  workspaceCount: number;
  ownedWorkspaces: Array<{ id: number; name: string }>;
  createdAt: string;
}

/** User management (operator only). Mounted under /users. */
export const userRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  // Operator guard. The `isOperator` flag is resolved by the auth plugin on
  // every request from `users.is_instance_operator`, so we don't need to
  // re-query here — the guard is a pure read of `req.user.isOperator`.
  // Centralising the check in the auth plugin keeps the semantics in one place.
  app.addHook('preHandler', async (req) => {
    if (req.user?.isOperator !== true) {
      throw forbidden('Operator access required');
    }
  });

  app.get('/', async () => {
    // List every user together with their workspace-count and operator flag.
    // Operators can see all users so the People view stays useful; non-operator
    // users never hit this endpoint (the guard above rejects them with 403).
    const rows = await app.db.query.users.findMany({
      orderBy: (u, { asc }) => [asc(u.id)],
    });
    const memberships = await app.db
      .select({ userId: workspaceMembers.userId, workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
      .from(workspaceMembers);
    const ownedRows = await app.db
      .select({ id: workspaces.id, name: workspaces.name, ownerId: workspaces.ownerId })
      .from(workspaces);
    const owned = new Map<number, Array<{ id: number; name: string }>>();
    for (const w of ownedRows ?? []) {
      const arr = owned.get(w.ownerId) ?? [];
      arr.push({ id: w.id, name: w.name });
      owned.set(w.ownerId, arr);
    }
    const byUser = new Map<number, Array<{ role: string }>>();
    for (const m of memberships) {
      const arr = byUser.get(m.userId) ?? [];
      arr.push({ role: m.role });
      byUser.set(m.userId, arr);
    }
    return rows.map<UserListEntry>((u) => {
      const ms = byUser.get(u.id) ?? [];
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        // Read the flag, don't infer it. This list previously derived
        // "operator" from holding owner/admin in any workspace (or owning
        // one), which is exactly the self-granting rule that migration 0038
        // removed — leaving it here would have shown every member as an
        // operator in the People view.
        isOperator: u.isInstanceOperator === true,
        workspaceCount: ms.length,
        // r540: what a delete would hand over — the People view names these
        // in its delete confirmation.
        ownedWorkspaces: owned.get(u.id) ?? [],
        createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : new Date(u.createdAt as unknown as number).toISOString(),
      };
    });
  });

  // Direct user creation — the operator path for teams with open registration
  // disabled (otherwise /v1/auth/register is the self-service route).
  app.post('/', async (req) => {
    const input = userCreate.parse(req.body);
    const existing = await app.db.query.users.findFirst({ where: sql`lower(${users.email}) = ${input.email.toLowerCase()}` });
    if (existing) throw badRequest('Email is already registered', 'email_taken');
    const [created] = await app.db
      .insert(users)
      .values({
        email: normalizeEmail(input.email),
        name: input.name ?? null,
        passwordHash: await hashPassword(input.password),
      })
      .returning();
    if (!created) throw notFound('Could not create user');
    void audit(app.db, req.user!.id, 'user.create', input.email);
    return {
      id: created.id,
      email: created.email,
      name: created.name,
      isOperator: false,
      workspaceCount: 0,
      ownedWorkspaces: [],
      createdAt: created.createdAt instanceof Date
        ? created.createdAt.toISOString()
        : new Date(created.createdAt as unknown as number).toISOString(),
    };
  });

  // NOTE: the legacy `PATCH /users/:id/role` endpoint was removed with the
  // global `users.role` column. WORKSPACE role changes go through
  // `PATCH /v1/workspaces/:id/members/:memberId`. The endpoint below is a
  // different thing: the INSTANCE-operator flag, which is what actually gates
  // host-privileged deploys, user management and system import/export.
  app.patch('/:id/operator', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const { isOperator } = operatorGrant.parse(req.body);
    const target = await app.db.query.users.findFirst({ where: eq(users.id, id) });
    if (!target) throw notFound('User not found');

    // Never let the instance end up with zero operators — nobody could grant
    // the flag back. Self-demotion is the realistic way to hit this.
    if (!isOperator && (await operatorCount(app.db)) <= 1 && target.isInstanceOperator) {
      throw badRequest('Cannot remove the last instance operator');
    }

    await app.db.update(users).set({ isInstanceOperator: isOperator }).where(eq(users.id, id));
    void audit(
      app.db,
      req.user!.id,
      isOperator ? 'user.operator.grant' : 'user.operator.revoke',
      target.email,
    );
    return { ok: true, id, isOperator };
  });

  app.delete('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === req.user!.id) throw badRequest('Cannot delete yourself');

    // Deleting the last operator would lock the instance out of every
    // operator-only route, including the one that grants the flag back.
    const target = await app.db.query.users.findFirst({ where: eq(users.id, id) });
    if (target?.isInstanceOperator && (await operatorCount(app.db)) <= 1) {
      throw badRequest('Cannot delete the last instance operator');
    }

    // r540: workspaces the user owns are handed over, never deleted with
    // them. The heir defaults to the acting operator; `transferTo` (query or
    // JSON body) names another existing, active account.
    const rawHeir =
      (req.query as { transferTo?: string } | undefined)?.transferTo ??
      (req.body && typeof req.body === 'object' ? (req.body as { transferTo?: unknown }).transferTo : undefined);
    const heirId =
      rawHeir === undefined || rawHeir === null || rawHeir === ''
        ? req.user!.id
        : parseId(String(rawHeir), 'transferTo must be a user id');
    if (heirId === id) throw badRequest('transferTo cannot be the user being deleted');
    if (heirId !== req.user!.id) {
      const heir = await app.db.query.users.findFirst({ where: eq(users.id, heirId) });
      if (!heir) throw badRequest('transferTo user not found');
      if (heir.deactivatedAt) throw badRequest('transferTo user is deactivated');
    }

    // What the delete still cascade-clears is the user's own: sessions, API
    // tokens, passkeys, linked SSO identities, reset tokens, their workspace
    // seats, and invitations / domain transfers they started. Services and
    // databases they owned outside any workspace are detached (owner NULL).
    const result = await app.db.transaction(async (tx) => {
      const transferred = await transferUserHoldings(tx, id, heirId);
      const deleted = await tx.delete(users).where(eq(users.id, id)).returning({ id: users.id });
      if (deleted.length === 0) throw notFound('User not found');
      return transferred;
    });
    for (const ws of result) {
      void audit(app.db, req.user!.id, 'workspace.owner_transfer', ws.name, {
        workspaceId: ws.id,
        fromUserId: id,
        toUserId: heirId,
        reason: 'user.delete',
      });
    }
    void audit(app.db, req.user!.id, 'user.delete', String(id));
    return { ok: true, transferredWorkspaces: result.map((w) => w.id), transferredTo: heirId };
  });

  // Operator-initiated password reset: sets a new password and bumps
  // tokenVersion so the target user's sessions (including stolen ones) are
  // all revoked.
  app.patch('/:id/password', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const input = passwordReset.parse(req.body);
    const passwordHash = await hashPassword(input.newPassword);
    const [updated] = await app.db
      .update(users)
      .set({ passwordHash, tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, id))
      .returning();
    if (!updated) throw notFound('User not found');
    // The tokenVersion bump only kills JWTs; session rows and API tokens are
    // separate credentials and must go too (r094).
    await revokeAllSessions(app.db, id);
    await revokeApiTokens(app.db, id);
    // r444: this is an admin-forced version of the self-service reset — the
    // same "every credential the account holds" revocation. The 8-hour studio
    // cookie fronts a pre-authenticated DB client (Redis studios even carry
    // the decrypted password), so it must not outlive this either.
    try {
      await setSettingString(app.db, STUDIO_EPOCH_KEY, String(Date.now()));
    } catch { /* a fixture without the settings table */ }
    void audit(app.db, req.user!.id, 'user.password', `reset for #${id}`);
    return { ok: true };
  });

  // Operator-issued one-time reset link: mints a 30-minute single-use token
  // and returns the raw link exactly once (webhook-secret pattern). For
  // instances without an email channel the operator hands the link to the
  // user directly.
  app.post('/:id/reset-link', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const target = await app.db.query.users.findFirst({ where: eq(users.id, id) });
    if (!target) throw notFound('User not found');
    const { token, expiresAt } = await issueResetToken(app.db, target, `admin:${req.user!.id}`);
    void audit(app.db, req.user!.id, 'user.reset_link', target.email);
    return {
      url: `${config.publicUrl}/reset-password?token=${encodeURIComponent(token)}`,
      expiresAt: expiresAt.toISOString(),
    };
  });
};
