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
  notFound,
  parseId,
} from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';
import { config } from '../config.js';
import { iso } from '../lib/serialize.js';
import { sendSystemEmail } from '../lib/notifier.js';

const INVITATION_TTL_DAYS = 7;

export interface CreateInvitationResult {
  /** Token in cleartext (returned only once at create time so the caller can email or display it). */
  token: string;
  invitation: typeof workspaceInvitations.$inferSelect;
}

/**
 * Create or refresh a pending invitation for the given (workspace, email).
 * The caller MUST have already verified the user doesn't yet exist and is
 * authorized to invite; this helper is the lower-level write path. The
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

function buildInviteEmail(
  workspaceName: string,
  role: WorkspaceRole,
  invitedByName: string | null,
  acceptUrl: string,
): { subject: string; text: string } {
  const inviter = invitedByName ?? 'A workspace owner';
  return {
    subject: `You're invited to join ${workspaceName} on NineDeploy`,
    text: [
      `${inviter} invited you to join the "${workspaceName}" workspace on NineDeploy as ${role}.`,
      '',
      'Click the link below to accept:',
      acceptUrl,
      '',
      `This invitation expires in ${INVITATION_TTL_DAYS} days.`,
      '',
      "If you don't have an account yet, you'll be asked to create one before accepting.",
    ].join('\n'),
  };
}

export { buildInviteEmail };

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
  // Hash-first lookup: rows created since tokens were hashed are found here.
  const row =
    (await db.query.workspaceInvitations.findFirst({ where: eq(workspaceInvitations.token, sha256(token)) })) ??
    // Legacy rows (created before hashing) still hold the cleartext token.
    // Accept them once and rewrite the row to the hash so the fallback is
    // self-retiring — outstanding emailed links keep working across the
    // upgrade without leaving plaintext tokens in storage.
    (await db.query.workspaceInvitations.findFirst({ where: eq(workspaceInvitations.token, token) }));
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.acceptedAt) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  if (row.token === token) {
    await db
      .update(workspaceInvitations)
      .set({ token: sha256(token), updatedAt: now })
      .where(eq(workspaceInvitations.id, row.id));
  }
  return row;
}

/**
 * Apply every pending invitation whose email matches the given user. Called
 * after register/login/OIDC completes so that someone who created an account
 * to accept an invite is silently promoted to the right workspace role(s)
 * without having to re-click the link. Returns the list of workspaces joined.
 *
 * Accepts the same `Pick<DB, ...>` subset that other auth helpers do so the
 * caller can pass either a top-level `db` or a transaction handle. Audit
 * logging is performed by the caller (which has a full `DB` reference) so the
 * transaction body stays small.
 */
export async function acceptInvitationsForUser(
  db: Pick<DB, 'query' | 'select' | 'insert' | 'update'>,
  user: { id: number; email: string },
): Promise<Array<{ workspaceId: number; role: WorkspaceRole; email: string }>> {
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

      // If the address is already a registered user, signal that the caller
      // should use the direct add-member endpoint instead. We return the same
      // 404 shape the member-add route does so the L-12 enumeration channel
      // stays closed.
      const existingUser = await app.db.query.users.findFirst({ where: eq(users.email, input.email) });
      if (existingUser) throw notFound('That email address cannot be invited to this workspace');

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
      const emailBody = buildInviteEmail(ws.name, created.role as WorkspaceRole, inviter?.name ?? null, acceptUrl);
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
    // Idempotent: a member who clicks accept twice should not error out.
    const existing = await app.db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, inv.workspaceId), eq(workspaceMembers.userId, req.user!.id)),
    });
    const now = new Date();
    if (!existing) {
      await app.db.insert(workspaceMembers).values({
        workspaceId: inv.workspaceId,
        userId: req.user!.id,
        role: inv.role as WorkspaceRole,
      });
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
