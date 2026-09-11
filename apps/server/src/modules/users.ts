import { eq, sql } from 'drizzle-orm';
import { audit } from '../lib/audit.js';
import { users, workspaceMembers } from '@ninedeploy/db';
import { revokeAllSessions, revokeApiTokens } from '../lib/sessions.js';
import type { FastifyPluginAsync } from 'fastify';
import { operatorGrant, passwordReset, userCreate } from '@ninedeploy/schemas';
import { badRequest, forbidden, notFound, parseId } from '../lib/errors.js';
import { hashPassword } from '../lib/crypto.js';
import { issueResetToken } from '../lib/passwordReset.js';
import { config } from '../config.js';

/** How many accounts currently carry the instance-operator flag. */
async function operatorCount(db: import('@ninedeploy/db').DB): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.isInstanceOperator, true));
  return rows.length;
}

interface UserListEntry {
  id: number;
  email: string;
  name: string | null;
  isOperator: boolean;
  workspaceCount: number;
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
        email: input.email,
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

    // Deleting a user cascade-clears their sessions, api tokens, workspace
    // memberships, webauthn credentials, and detaches their owned resources.
    const deleted = await app.db.delete(users).where(eq(users.id, id)).returning({ id: users.id });
    if (deleted.length === 0) throw notFound('User not found');
    void audit(app.db, req.user!.id, 'user.delete', String(id));
    return { ok: true };
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
