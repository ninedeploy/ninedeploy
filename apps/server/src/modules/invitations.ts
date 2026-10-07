import { randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  type DB,
  users,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
} from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import {
  type WorkspaceInvitationCreate,
  type WorkspaceInvitationEntry,
  type WorkspaceInvitationPublic,
  type WorkspaceRole,
  workspaceInvitationCreate,
} from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import {
  conflict,
  forbidden,
  isUniqueViolation,
  notFound,
  parseId,
} from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';
import { config } from '../config.js';
import { iso } from '../lib/serialize.js';
import { sendSystemEmail } from '../lib/notifier.js';
import { renderTemplate } from '../lib/emailTemplates.js';

const INVITATION_TTL_DAYS = 7;

export interface CreateInvitationResult {
  /** Token in cleartext (returned only once at create time so the caller can email or display it). */
  token: string;
  invitation: typeof workspaceInvitations.$inferSelect;
}

/**
 * Create or refresh a pending invitation for the given (workspace, email).
 * The caller MUST have already verified the address is not a member of the
 * workspace yet and that it is authorized to invite (r604: whether an account
 * exists for the address does not matter); this helper is the lower-level
 * write path. The
 * returned `token` is the cleartext value (used in the accept URL); only the
 * hash lives in storage.
 */
export async function createOrRefreshInvitation(
  db: DB,
  args: {
    workspaceId: number;
    email: string;
    role: WorkspaceRole;
    invitedByUserId: number;
  },
): Promise<CreateInvitationResult> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const token = generateInvitationToken();
  // Store the sha256 hash, never the token itself: a leaked DB file/backup
  // (without the encryption master key) must not expose live, unexpired
  // membership-granting tokens. Same scheme as API and password-reset tokens.
  const tokenHash = sha256(token);

  const existing = await db.query.workspaceInvitations.findFirst({
    where: and(
      eq(workspaceInvitations.workspaceId, args.workspaceId),
      sql`lower(${workspaceInvitations.email}) = lower(${args.email})`,
      isNull(workspaceInvitations.revokedAt),
      isNull(workspaceInvitations.acceptedAt),
    ),
  });

  let created: typeof workspaceInvitations.$inferSelect | undefined;
  if (existing) {
    [created] = await db
      .update(workspaceInvitations)
      .set({
        role: args.role,
        token: tokenHash,
        invitedByUserId: args.invitedByUserId,
        expiresAt,
        updatedAt: now,
      })
      .where(eq(workspaceInvitations.id, existing.id))
      .returning();
  } else {
    [created] = await db
      .insert(workspaceInvitations)
      .values({
        workspaceId: args.workspaceId,
        email: args.email,
        role: args.role,
        token: tokenHash,
        invitedByUserId: args.invitedByUserId,
        expiresAt,
      })
      .returning();
  }
  if (!created) throw new Error('Could not create invitation');
  return { token, invitation: created };
}

/** Generate an unguessable invitation token. 32 bytes (256 bits) hex; safe for URL paths. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString('hex');
}

/** Constant-time compare for invitation token strings. */
export function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

interface CallerMembership {
  role: WorkspaceRole;
  isAdmin: boolean;
}

/** Resolve whether the caller is allowed to manage invitations in this workspace. */
async function resolveInviteAuthority(
  db: DB,
  workspaceId: number,
  userId: number,
  isOperator: boolean,
): Promise<CallerMembership | null> {
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (!ws) return null;
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
  });
  const isOwner = ws.ownerId === userId;
  const isMemberAdmin = membership?.role === 'owner' || membership?.role === 'admin';
  if (!isOperator && !isOwner && !isMemberAdmin) return null;
  return { role: (membership?.role as WorkspaceRole | undefined) ?? (isOwner ? 'owner' : 'admin'), isAdmin: isOperator || isMemberAdmin };
}

function serializeInvitation(
  inv: typeof workspaceInvitations.$inferSelect,
  invitedBy: { name: string | null; id: number },
): WorkspaceInvitationEntry {
  return {
    id: inv.id,
    workspaceId: inv.workspaceId,
    email: inv.email,
    role: inv.role as WorkspaceRole,
    invitedByUserId: invitedBy.id,
    invitedByName: invitedBy.name,
    expiresAt: iso(inv.expiresAt) as string,
    acceptedAt: inv.acceptedAt ? (iso(inv.acceptedAt) as string) : null,
    acceptedByUserId: inv.acceptedByUserId,
    revokedAt: inv.revokedAt ? (iso(inv.revokedAt) as string) : null,
    createdAt: iso(inv.createdAt) as string,
  };
}

function buildAcceptUrl(token: string): string {
  return `${config.publicUrl}/invite/${token}`;
}

export { buildAcceptUrl };

/**
 * r610: the invitation email goes through the template engine, so the
 * inviting workspace's `workspace-invitation` override is what the invitee
 * receives. This used to be a hardcoded builder — an override was stored,
 * listed and previewed, and never sent. With no override the built-in
 * default renders the exact text the builder produced.
 */
async function renderInviteEmail(
  db: DB,
  workspaceId: number,
  workspaceName: string,
  role: WorkspaceRole,
  invitedByName: string | null,
  acceptUrl: string,
): Promise<{ subject: string; text: string }> {
  return renderTemplate(
    db,
    'workspace-invitation',
    {
      inviter: invitedByName ?? 'A workspace owner',
      workspaceName,
      role,
      acceptUrl,
      ttlDays: INVITATION_TTL_DAYS,
    },
    { workspaceId },
  );
}

export { renderInviteEmail };

/**
 * Look up a pending invitation by token. A pending invitation is one that
 * has not been revoked, has not been accepted, and has not expired.
 */
export async function findPendingInvitationByToken(
  db: DB,
  token: string,
): Promise<typeof workspaceInvitations.$inferSelect | null> {
  if (!token || token.length < 32) return null;
  const now = new Date();
  // F160: hash-only lookup. The old fallback matched the presented value
  // against the stored column verbatim (for pre-0.3.0 cleartext rows), but a
  // stored hash is itself 64 hex — so the hash from a leaked DB/backup worked
  // as a live token. A pre-0.3.0 cleartext row no longer resolves; inviting
  // the address again refreshes it with a hashed token.
  const row = await db.query.workspaceInvitations.findFirst({
    where: eq(workspaceInvitations.token, sha256(token)),
  });
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.acceptedAt) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  return row;
}

/**
 * Apply pending invitations only when the sign-in provider attests ownership
 * of the email address. Password and passkey authentication prove account
 * control, not ownership of the address supplied at registration; those users
 * must present the invitation token through the explicit accept route.
 *
 * Accepts the same `Pick<DB, ...>` subset that other auth helpers do so the
 * caller can pass either a top-level `db` or a transaction handle. Audit
 * logging is performed by the caller (which has a full `DB` reference) so the
 * transaction body stays small.
 */
export async function acceptInvitationsForUser(
  db: Pick<DB, 'query' | 'select' | 'insert' | 'update'>,
  user: { id: number; email: string; emailVerified?: boolean },
): Promise<Array<{ workspaceId: number; role: WorkspaceRole; email: string }>> {
  if (user.emailVerified !== true) return [];
  // F1004: a deactivated account takes no seat; its invitations stay pending.
  if ((await db.query.users.findFirst({ where: eq(users.id, user.id) }))?.deactivatedAt) return [];
  const now = new Date();
  const pending = await db
    .select()
    .from(workspaceInvitations)
    .where(
      and(
        sql`lower(${workspaceInvitations.email}) = lower(${user.email})`,
        isNull(workspaceInvitations.revokedAt),
        isNull(workspaceInvitations.acceptedAt),
        gt(workspaceInvitations.expiresAt, now),
      ),
    );

  const joined: Array<{ workspaceId: number; role: WorkspaceRole; email: string }> = [];
  for (const inv of pending) {
    const existing = await db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, inv.workspaceId), eq(workspaceMembers.userId, user.id)),
    });
    if (existing) {
      // Already a member — just mark the invite consumed so it doesn't stick around.
      await db
        .update(workspaceInvitations)
        .set({ acceptedAt: now, acceptedByUserId: user.id, updatedAt: now })
        .where(eq(workspaceInvitations.id, inv.id));
      continue;
    }
    await db.insert(workspaceMembers).values({
      workspaceId: inv.workspaceId,
      userId: user.id,
      role: inv.role as WorkspaceRole,
    });
    await db
      .update(workspaceInvitations)
      .set({ acceptedAt: now, acceptedByUserId: user.id, updatedAt: now })
      .where(eq(workspaceInvitations.id, inv.id));
    joined.push({ workspaceId: inv.workspaceId, role: inv.role as WorkspaceRole, email: inv.email });
  }
  return joined;
}

/**
 * Authenticated invitation routes — mounted at /v1/workspaces/:id/invitations
 * (and listing/management endpoints). These require a logged-in user and
 * workspace ownership/admin authority. Routes inside are written WITHOUT the
 * `/workspaces` prefix so the registration prefix can be applied.
 */
export const invitationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  /** Create a new pending invitation. */
  app.post(
    '/:id/invitations',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const workspaceId = parseId((req.params as { id: string }).id);
      const input: WorkspaceInvitationCreate = workspaceInvitationCreate.parse(req.body);

      // Workspace existence check first so a non-member probing an unknown
      // id gets the 404 (consistent with the rest of the workspace routes)
      // instead of a 403 that would confirm the id is wrong vs. the caller
      // not being authorised.
      const ws = await app.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
      if (!ws) throw notFound('Workspace not found');

      // Same rule for an EXISTING workspace: a non-member must not be able to
      // tell "private workspace" (would be 403) apart from "no workspace" (404).
      const seat = await app.db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, req.user!.id)),
      });
      if (!seat && !req.user!.isOperator) throw notFound('Workspace not found');

      const authority = await resolveInviteAuthority(app.db, workspaceId, req.user!.id, req.user!.isOperator);
      if (!authority) throw forbidden('Admin or Owner role required to invite workspace members');

      // r604: a registered address used to 404 here ("use add-member") while
      // an unknown one got an invitation — an account-existence oracle for any
      // workspace admin. Now only an address that is already a member of THIS
      // workspace (visible in its member list anyway) is refused; everyone
      // else gets the same invitation, accepted from their account.
      const existingUser = await app.db.query.users.findFirst({ where: sql`lower(${users.email}) = ${input.email.toLowerCase()}` });
      if (existingUser) {
        const alreadyMember = await app.db.query.workspaceMembers.findFirst({
          where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, existingUser.id)),
        });
        if (alreadyMember) throw notFound('That email address cannot be invited to this workspace');
      }

      const { token, invitation: created } = await createOrRefreshInvitation(app.db, {
        workspaceId,
        email: input.email,
        role: input.role,
        invitedByUserId: req.user!.id,
      });

      const isRefresh = created.createdAt.getTime() !== created.updatedAt.getTime();
      void audit(
        app.db,
        req.user!.id,
        isRefresh ? 'workspace.invitation.refresh' : 'workspace.invitation.create',
        `${input.email} (${input.role}) to ${ws.name}`,
      );

      // Best-effort: try to email the invite, but never fail the request on a
      // missing SMTP channel. The UI will still surface the accept URL so the
      // owner can copy it manually when no email channel is configured.
      const inviter = await app.db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
      const acceptUrl = buildAcceptUrl(token);
      const emailBody = await renderInviteEmail(
        app.db,
        workspaceId,
        ws.name,
        created.role as WorkspaceRole,
        inviter?.name ?? null,
        acceptUrl,
      );
      void sendSystemEmail(app.db, created.email, emailBody.subject, emailBody.text).catch(() => undefined);

      reply.header('x-invitation-token', token);
      return serializeInvitation(
        created,
        { name: inviter?.name ?? null, id: req.user!.id },
      );
    },
  );

  /** List invitations for a workspace (pending + recent history). */
  app.get('/:id/invitations', async (req) => {
    const workspaceId = parseId((req.params as { id: string }).id);
    // Non-members get the same 404 a missing workspace gets — no id oracle.
    const ws = await app.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (!ws) throw notFound('Workspace not found');
    const seat = await app.db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, req.user!.id)),
    });
    if (!seat && !req.user!.isOperator) throw notFound('Workspace not found');

    const authority = await resolveInviteAuthority(app.db, workspaceId, req.user!.id, req.user!.isOperator);
    if (!authority) throw forbidden('Only workspace members can view invitations');

    const rows = await app.db.query.workspaceInvitations.findMany({
      where: eq(workspaceInvitations.workspaceId, workspaceId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });

    const inviterIds = [...new Set(rows.map((r) => r.invitedByUserId))];
    const inviters = inviterIds.length
      ? await app.db.query.users.findMany({
          where: (t, { inArray }) => inArray(t.id, inviterIds),
        })
      : [];
    const inviterMap = new Map<number, { name: string | null; id: number }>();
    for (const u of inviters) inviterMap.set(u.id, { name: u.name, id: u.id });

    return rows.map((r) => {
      const inviter = inviterMap.get(r.invitedByUserId) ?? { name: null, id: r.invitedByUserId };
      return serializeInvitation(r, inviter);
    });
  });

  /** Revoke a pending invitation. */
  app.delete('/:id/invitations/:inviteId', async (req) => {
    const workspaceId = parseId((req.params as { id: string }).id);
    const inviteId = parseId((req.params as { inviteId: string }).inviteId);
    // Non-members get the same 404 a missing workspace gets — no id oracle.
    const ws = await app.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (!ws) throw notFound('Workspace not found');
    const seat = await app.db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, req.user!.id)),
    });
    if (!seat && !req.user!.isOperator) throw notFound('Workspace not found');

    const authority = await resolveInviteAuthority(app.db, workspaceId, req.user!.id, req.user!.isOperator);
    if (!authority) throw forbidden('Admin or Owner role required to revoke invitations');

    const inv = await app.db.query.workspaceInvitations.findFirst({
      where: and(eq(workspaceInvitations.id, inviteId), eq(workspaceInvitations.workspaceId, workspaceId)),
    });
    if (!inv) throw notFound('Invitation not found');
    if (inv.revokedAt) throw conflict('Invitation already revoked');
    if (inv.acceptedAt) throw conflict('Invitation already accepted');

    const now = new Date();
    await app.db
      .update(workspaceInvitations)
      .set({ revokedAt: now, updatedAt: now })
      .where(eq(workspaceInvitations.id, inviteId));
    void audit(app.db, req.user!.id, 'workspace.invitation.revoke', `${inv.email} from workspace #${workspaceId}`);
    return { ok: true };
  });
};

/**
 * Authenticated accept route — mounted standalone (no prefix) so the public
 * path /v1/invitations/:token/accept lands here. Auth required: the caller's
 * email must match the address the invite was sent to.
 */
export const acceptInvitationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.post('/invitations/:token/accept', async (req, reply) => {
    const token = String((req.params as { token: string }).token);
    const inv = await findPendingInvitationByToken(app.db, token);
    if (!inv) {
      reply.status(404);
      return { error: { code: 'invitation_not_found', message: 'Invitation is invalid, expired, or already used' } };
    }
    // The auth pre-handler only attaches id+role; resolve the email from the
    // users table to compare against the invite's intended recipient.
    const me = await app.db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
    if (!me) {
      reply.status(401);
      return { error: { code: 'auth_required', message: 'Sign in or create an account to accept this invitation' } };
    }
    if (inv.email.toLowerCase() !== me.email.toLowerCase()) {
      reply.status(403);
      return { error: { code: 'invitation_email_mismatch', message: 'This invitation was sent to a different email address' } };
    }
    // F1004: state at seat time — authenticate refuses a deactivated caller,
    // but a deactivation can land after it. The invitation stays pending.
    if (me.deactivatedAt) {
      reply.status(409);
      return { error: { code: 'user_deactivated', message: 'This account is deactivated. Reactivate it before adding it to a workspace.' } };
    }
    // Idempotent: a member who clicks accept twice should not error out.
    const existing = await app.db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, inv.workspaceId), eq(workspaceMembers.userId, req.user!.id)),
    });
    const now = new Date();
    if (!existing) {
      try {
        await app.db.insert(workspaceMembers).values({
          workspaceId: inv.workspaceId,
          userId: req.user!.id,
          role: inv.role as WorkspaceRole,
        });
      } catch (err) {
        // r425: two tabs accepting concurrently both passed the
        // existence check; the loser hit the unique (workspace, user) index
        // and answered 500 — the loser's acceptance is the same fact, so
        // treat the collision as success like the idempotent re-accept.
        if (!isUniqueViolation(err, /workspace_members_workspace_user_idx|UNIQUE constraint failed/)) throw err;
      }
    }
    await app.db
      .update(workspaceInvitations)
      .set({ acceptedAt: now, acceptedByUserId: req.user!.id, updatedAt: now })
      .where(eq(workspaceInvitations.id, inv.id));
    void audit(
      app.db,
      req.user!.id,
      'workspace.invitation.accept',
      `${inv.email} → workspace #${inv.workspaceId} as ${inv.role}`,
    );

    return { ok: true, workspaceId: inv.workspaceId, role: inv.role as WorkspaceRole };
  });
};

/** Public-accept endpoint, mounted standalone (no auth). */
export const publicInvitationRoutes: FastifyPluginAsync = async (app) => {
  /** Look up an invitation's public preview by token. */
  app.get('/invitations/:token', async (req, reply) => {
    const token = String((req.params as { token: string }).token);
    const inv = await findPendingInvitationByToken(app.db, token);
    if (!inv) {
      reply.status(404);
      return { error: { code: 'invitation_not_found', message: 'Invitation is invalid, expired, or already used' } };
    }
    const ws = await app.db.query.workspaces.findFirst({ where: eq(workspaces.id, inv.workspaceId) });
    if (!ws) {
      reply.status(404);
      return { error: { code: 'invitation_not_found', message: 'Invitation is invalid, expired, or already used' } };
    }
    const inviter = await app.db.query.users.findFirst({ where: eq(users.id, inv.invitedByUserId) });
    const out: WorkspaceInvitationPublic = {
      workspaceId: ws.id,
      workspaceName: ws.name,
      workspaceSlug: ws.slug,
      email: inv.email,
      role: inv.role as WorkspaceRole,
      invitedByName: inviter?.name ?? null,
      expiresAt: iso(inv.expiresAt) as string,
    };
    return out;
  });
};
