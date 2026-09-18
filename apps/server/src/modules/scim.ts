import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { apiTokens, scimTokens, users, workspaces, workspaceMembers, type DB } from '@ninedeploy/db';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { unauthorized } from '../lib/errors.js';

/**
 * SCIM 2.0 user provisioning (RFC 7644) — the deprovisioning half of the
 * SSO story. An identity provider (Okta, Entra ID, JumpCloud, …) is pointed
 * at `${publicUrl}/scim/v2` with a bearer token minted per workspace; every
 * user it pushes lands in that workspace as a member, and disabling or
 * deleting the user at the IdP revokes their access here within one sync
 * cycle — the operation that used to require remembering to do it by hand.
 *
 * Auth is deliberately NOT the panel's JWT guard: IdPs present a long-lived
 * bearer token whose sha256 lives in `scim_tokens` (same envelope as API
 * tokens). Tokens never leave the management API in plaintext.
 *
 * Users are never hard-deleted (audit trail + FK history): DELETE deactivates
 * the account, revokes every credential, and removes it from the token's
 * workspace.
 *
 * r153: a token is scoped to ONE workspace. `/Users/:id` only resolves members
 * of that workspace, instance operators are never deactivated through SCIM,
 * and a DELETE leaves other workspaces' rosters alone. Previously any
 * workspace's IdP could deactivate the operator or strip another tenant's
 * members by numeric id. The SCIM `externalId` and the email are the join keys — a
 * provisioning push for an existing local account adopts it instead of
 * duplicating it (IdPs retry on timeout; duplicates would lock people out).
 */

const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';

const TOKEN_BYTES = 32;

interface ScimUserPayload {
  userName?: unknown;
  name?: { givenName?: unknown; familyName?: unknown } | null;
  displayName?: unknown;
  active?: unknown;
  externalId?: unknown;
  emails?: Array<{ value?: unknown; primary?: boolean }> | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Extract the login email from the SCIM payload (userName wins over emails[]). */
function payloadEmail(body: ScimUserPayload): string | null {
  const userName = str(body.userName);
  if (userName && userName.includes('@')) return userName.toLowerCase();
  const primary = (body.emails ?? []).find((e) => e.primary) ?? (body.emails ?? [])[0];
  const email = str(primary?.value);
  return email && email.includes('@') ? email.toLowerCase() : null;
}

function scimUserBody(
  u: { id: number; email: string; name: string | null; scimExternalId: string | null; deactivatedAt: Date | null },
  workspaceId: number,
): Record<string, unknown> {
  const member = { value: String(workspaceId), display: String(workspaceId), type: 'direct' };
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: String(u.id),
    externalId: u.scimExternalId ?? undefined,
    userName: u.email,
    name: u.name ? { formatted: u.name } : undefined,
    displayName: u.name ?? u.email,
    active: u.deactivatedAt === null,
    emails: [{ value: u.email, primary: true }],
    groups: [member],
    meta: { resourceType: 'User', location: `/scim/v2/Users/${u.id}` },
  };
}

function scimError(status: number, detail: string): {
  statusCode: number;
  payload: Record<string, unknown>;
} {
  return { statusCode: status, payload: { schemas: [SCIM_ERROR_SCHEMA], status: String(status), detail } };
}

async function resolveUser(db: DB, idRaw: string) {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return (await db.query.users.findFirst({ where: eq(users.id, id) })) ?? null;
}

async function isMemberOf(db: DB, userId: number, workspaceId: number): Promise<boolean> {
  const seat = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, workspaceId)),
  });
  return seat !== undefined;
}

/**
 * Whether `workspaceId`'s IdP may lift this account's deactivation: only the
 * workspace that deactivated it may. Rows deactivated before that was recorded
 * fall back to "holds no seat in a workspace another user owns", so no other
 * tenant's deprovision is undone.
 */
async function mayReactivate(
  db: DB,
  user: { id: number; deactivatedAt: Date | null; deactivatedByWorkspaceId: number | null },
  workspaceId: number,
): Promise<boolean> {
  if (!user.deactivatedAt) return true;
  if (user.deactivatedByWorkspaceId !== null) return user.deactivatedByWorkspaceId === workspaceId;
  const seats = await db.query.workspaceMembers.findMany({ where: eq(workspaceMembers.userId, user.id) });
  for (const seat of seats) {
    if (seat.workspaceId === workspaceId) continue;
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, seat.workspaceId) });
    if (ws && ws.ownerId !== user.id) return false;
  }
  return true;
}

const REACTIVATE_REFUSED = 'This account was deprovisioned by another workspace';

/** A user this workspace's token may act on: an existing member of it. */
async function resolveMember(db: DB, idRaw: string, workspaceId: number) {
  const user = await resolveUser(db, idRaw);
  if (!user || !(await isMemberOf(db, user.id, workspaceId))) return null;
  return user;
}

/**
 * Deactivate (or fully deprovision when `stripMemberships` is set): revoke
 * every credential the account holds — the tokenVersion bump invalidates all
 * outstanding JWTs the way logout does, and API tokens are rows we can
 * delete outright.
 */
async function deactivateUser(
  db: DB,
  userId: number,
  byWorkspaceId: number,
  opts: { leaveWorkspace: boolean },
): Promise<void> {
  await db
    .update(users)
    .set({ deactivatedAt: new Date(), deactivatedByWorkspaceId: byWorkspaceId, tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.id, userId));
  await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
  if (opts.leaveWorkspace) {
    await db
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, byWorkspaceId)));
  }
}

const OPERATOR_REFUSED = 'Instance operators cannot be deprovisioned through SCIM';
const REACTIVATED = { deactivatedAt: null, deactivatedByWorkspaceId: null } as const;

export const scimRoutes: FastifyPluginAsync = async (app) => {
  const bearer = async (req: { headers: Record<string, unknown> }): Promise<number> => {
    const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw unauthorized('Missing SCIM bearer token');
    const [row] = await app.db
      .select()
      .from(scimTokens)
      .where(and(eq(scimTokens.tokenHash, sha256(token)), isNull(scimTokens.revokedAt)))
      .limit(1);
    if (!row) throw unauthorized('Invalid SCIM bearer token');
    await app.db.update(scimTokens).set({ lastUsedAt: new Date() }).where(eq(scimTokens.id, row.id));
    return row.workspaceId;
  };

  const scimReply = (reply: unknown, res: { statusCode: number; payload: Record<string, unknown> }) =>
    (reply as { code: (c: number) => { send: (p: unknown) => unknown } }).code(res.statusCode).send(res.payload);

  // ── Discovery: IdPs probe these before/while configuring the app. ────────
  app.get('/ServiceProviderConfig', async () => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    filter: { supported: true, maxResults: 200 },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'OAuth Bearer Token' }],
  }));
  app.get('/Schemas', async () => ({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: 1,
    Resources: [
      {
        id: SCIM_USER_SCHEMA,
        name: 'User',
        attributes: [
          { name: 'userName', type: 'string', mutability: 'readWrite', required: true },
          { name: 'active', type: 'boolean', mutability: 'readWrite', required: false },
        ],
      },
    ],
  }));

  // ── Create / adopt ───────────────────────────────────────────────────────
  app.post<{ Body: ScimUserPayload }>('/Users', async (req, reply) => {
    const workspaceId = await bearer(req);
    const email = payloadEmail(req.body);
    if (!email) return scimReply(reply, scimError(400, 'userName (an email address) is required'));
    const existing = await app.db.query.users.findFirst({ where: sql`lower(${users.email}) = lower(${email})` });
    if (existing) {
      // Adopt the account: record the IdP's externalId, ensure membership,
      // and reactivate if a previous deprovision left it disabled.
      const externalId = str(req.body.externalId);
      const name = str(req.body.displayName) ?? str(req.body.name?.givenName);
      // A push from workspace A must not undo a deprovision another tenant
      // performed (r153) — see mayReactivate.
      const alreadyMember = await isMemberOf(app.db, existing.id, workspaceId);
      const reactivate = existing.deactivatedAt !== null && (await mayReactivate(app.db, existing, workspaceId));
      await app.db
        .update(users)
        .set({
          scimExternalId: externalId ?? existing.scimExternalId,
          name: name ?? existing.name,
          ...(reactivate ? REACTIVATED : {}),
        })
        .where(eq(users.id, existing.id));
      if (!alreadyMember) {
        await app.db.insert(workspaceMembers).values({ workspaceId, userId: existing.id, role: 'member' });
      }
      const fresh = (await resolveUser(app.db, String(existing.id)))!;
      return scimReply(reply, {
        statusCode: 200,
        payload: scimUserBody(fresh, workspaceId),
      });
    }
    // Fresh provision: an unusable random password — the account signs in via
    // the SSO provider, never via this secret.
    const [created] = await app.db
      .insert(users)
      .values({
        email,
        passwordHash: randomUUID() + randomUUID(),
        name: str(req.body.displayName) ?? str(req.body.name?.givenName) ?? null,
        scimExternalId: str(req.body.externalId),
      })
      .returning();
    await app.db.insert(workspaceMembers).values({ workspaceId, userId: created!.id, role: 'member' });
    void audit(app.db, null, 'scim.provision', email);
    return scimReply(reply, { statusCode: 201, payload: scimUserBody(created!, workspaceId) });
  });

  // ── Read one / list (with the `userName eq "…"` filter IdPs send) ────────
  app.get<{ Params: { id: string } }>('/Users/:id', async (req, reply) => {
    const workspaceId = await bearer(req);
    const user = await resolveMember(app.db, (req.params as { id: string }).id, workspaceId);
    if (!user) return scimReply(reply, scimError(404, 'User not found'));
    return scimUserBody(user, workspaceId);
  });

  app.get<{ Querystring: { filter?: string; startIndex?: string; count?: string } }>('/Users', async (req) => {
    const workspaceId = await bearer(req);
    const filter = (req.query as { filter?: string }).filter ?? '';
    const eqMatch = /userName\s+eq\s+"([^"]+)"/i.exec(filter);
    const rows = await app.db.query.users.findMany();
    const memberships = await app.db.query.workspaceMembers.findMany({ where: eq(workspaceMembers.workspaceId, workspaceId) });
    const memberIds = new Set(memberships.map((m) => m.userId));
    const inWorkspace = rows.filter((u) => memberIds.has(u.id));
    const matched = eqMatch ? inWorkspace.filter((u) => u.email.toLowerCase() === eqMatch[1]!.toLowerCase()) : inWorkspace;
    const start = Math.max(1, Number((req.query as { startIndex?: string }).startIndex ?? 1) || 1);
    const count = Math.min(200, Math.max(0, Number((req.query as { count?: string }).count ?? 100) || 100));
    const page = matched.slice(start - 1, start - 1 + count);
    return {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: matched.length,
      startIndex: start,
      itemsPerPage: page.length,
      Resources: page.map((u) => scimUserBody(u, workspaceId)),
    };
  });

  // ── Patch (the deprovision workhorse: {"op":"replace","path":"active"}) ──
  app.patch<{ Params: { id: string }; Body: { Operations?: Array<{ op?: unknown; path?: unknown; value?: unknown }> } }>(
    '/Users/:id',
    async (req, reply) => {
      const workspaceId = await bearer(req);
      const user = await resolveMember(app.db, (req.params as { id: string }).id, workspaceId);
      if (!user) return scimReply(reply, scimError(404, 'User not found'));
      for (const op of req.body.Operations ?? []) {
        const path = str(op.path)?.toLowerCase();
        const active = op.value;
        if ((str(op.op)?.toLowerCase() === 'replace' || str(op.op)?.toLowerCase() === 'remove') && (path === 'active' || !path)) {
          if (active === false || active === 'False' || active === 'false') {
            if (user.isInstanceOperator) return scimReply(reply, scimError(403, OPERATOR_REFUSED));
            await deactivateUser(app.db, user.id, workspaceId, { leaveWorkspace: false });
            void audit(app.db, null, 'scim.deactivate', user.email);
          } else if (active === true || active === 'True' || active === 'true') {
            if (!(await mayReactivate(app.db, user, workspaceId))) return scimReply(reply, scimError(403, REACTIVATE_REFUSED));
            await app.db.update(users).set(REACTIVATED).where(eq(users.id, user.id));
            void audit(app.db, null, 'scim.reactivate', user.email);
          }
        }
      }
      const fresh = (await resolveUser(app.db, String(user.id)))!;
      return scimUserBody(fresh, workspaceId);
    },
  );

  // ── Replace (PUT) — IdPs that don't use PATCH rewrite the whole record ───
  app.put<{ Params: { id: string }; Body: ScimUserPayload }>('/Users/:id', async (req, reply) => {
    const workspaceId = await bearer(req);
    const user = await resolveMember(app.db, (req.params as { id: string }).id, workspaceId);
    if (!user) return scimReply(reply, scimError(404, 'User not found'));
    const name = str(req.body.displayName) ?? str(req.body.name?.givenName);
    const active = req.body.active;
    if (active === false && user.isInstanceOperator) return scimReply(reply, scimError(403, OPERATOR_REFUSED));
    if (active === true && !(await mayReactivate(app.db, user, workspaceId))) {
      return scimReply(reply, scimError(403, REACTIVATE_REFUSED));
    }
    if (active === false) await deactivateUser(app.db, user.id, workspaceId, { leaveWorkspace: false });
    else if (active === true && user.deactivatedAt) await app.db.update(users).set(REACTIVATED).where(eq(users.id, user.id));
    await app.db.update(users).set({ name: name ?? user.name, scimExternalId: str(req.body.externalId) ?? user.scimExternalId }).where(eq(users.id, user.id));
    const fresh = (await resolveUser(app.db, String(user.id)))!;
    return scimUserBody(fresh, workspaceId);
  });

  // ── Delete — deprovision: deactivate + leave this workspace ──────────────
  app.delete<{ Params: { id: string } }>('/Users/:id', async (req, reply) => {
    const workspaceId = await bearer(req);
    const user = await resolveMember(app.db, (req.params as { id: string }).id, workspaceId);
    if (!user) return scimReply(reply, scimError(404, 'User not found'));
    if (user.isInstanceOperator) return scimReply(reply, scimError(403, OPERATOR_REFUSED));
    await deactivateUser(app.db, user.id, workspaceId, { leaveWorkspace: true });
    void audit(app.db, null, 'scim.deprovision', user.email);
    return { schemas: [SCIM_USER_SCHEMA], id: String(user.id) };
  });
};

// ── Management API: operator-side token lifecycle ──────────────────────────
export const scimManagementRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/tokens', { preHandler: [app.requireAdmin] }, async () => {
    const rows = await app.db.select().from(scimTokens);
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      workspaceId: t.workspaceId,
      createdAt: t.createdAt?.toISOString() ?? null,
      lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      revoked: t.revokedAt !== null,
    }));
  });

  // The plaintext token is returned EXACTLY once — only its sha256 persists.
  app.post<{ Body: { name?: string; workspaceId?: number } }>('/tokens', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const workspaceId = Number((req.body as { workspaceId?: number }).workspaceId);
    if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
      return reply.code(400).send({ error: { message: 'workspaceId is required' } });
    }
    const ws = await app.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (!ws) return reply.code(404).send({ error: { message: 'Workspace not found' } });
    const token = `scim_${randomToken(TOKEN_BYTES)}`;
    const [row] = await app.db
      .insert(scimTokens)
      .values({
        name: str((req.body as { name?: string }).name) ?? 'IdP integration',
        tokenHash: sha256(token),
        workspaceId,
      })
      .returning();
    void audit(app.db, req.user!.id, 'scim.token.create', `${row!.name} -> workspace #${workspaceId}`);
    return { id: row!.id, token };
  });

  app.delete<{ Params: { id: string } }>('/tokens/:id', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const [row] = await app.db.update(scimTokens).set({ revokedAt: new Date() }).where(eq(scimTokens.id, id)).returning();
    if (!row) return reply.code(404).send({ error: { message: 'Token not found' } });
    void audit(app.db, req.user!.id, 'scim.token.revoke', `${row.name} (workspace #${row.workspaceId})`);
    return { ok: true };
  });
};
