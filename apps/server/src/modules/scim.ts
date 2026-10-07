import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { apiTokens, scimTokens, users, workspaces, workspaceMembers, workspaceRole, type DB } from '@ninedeploy/db';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { unauthorized } from '../lib/errors.js';
import { getSettingJson, setSettingJson, setSettingString } from '../lib/settings.js';
import { STUDIO_EPOCH_KEY } from './studioProxy.js';
import { rehomeOwnedResources } from './workspaces.js';

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
 *
 * r501: two more cross-tenant levers closed. (1) Adoption by email used to pull
 * ANY account on the instance into the token's workspace — after which that
 * workspace's IdP could deactivate it instance-wide. A push may now adopt only
 * an account that is already this workspace's member (or one this workspace
 * itself deprovisioned or suspended); anything else is a SCIM 409. (2)
 * Deactivation is instance-wide only for an account SCIM created that holds no
 * seat in another tenant's workspace; for everyone else a workspace's IdP
 * suspends the seat in ITS workspace and nothing more.
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
  /** r501: the seat in THIS workspace is suspended — the IdP sees the user inactive. */
  suspended = false,
): Record<string, unknown> {
  const member = { value: String(workspaceId), display: String(workspaceId), type: 'direct' };
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: String(u.id),
    externalId: u.scimExternalId ?? undefined,
    userName: u.email,
    name: u.name ? { formatted: u.name } : undefined,
    displayName: u.name ?? u.email,
    active: u.deactivatedAt === null && !suspended,
    emails: [{ value: u.email, primary: true }],
    groups: [member],
    meta: { resourceType: 'User', location: `/scim/v2/Users/${u.id}` },
  };
}

function scimError(status: number, detail: string, scimType?: string): {
  statusCode: number;
  payload: Record<string, unknown>;
} {
  return { statusCode: status, payload: { schemas: [SCIM_ERROR_SCHEMA], status: String(status), ...(scimType && { scimType }), detail } };
}

// ── r501: per-workspace suspension ─────────────────────────────────────────
// A workspace's IdP deactivating someone who is not "its" account removes the
// seat in that workspace only. The seat's role is parked in the settings table
// (no migration) so the same IdP still sees the user — inactive — and can
// reactivate it later with the role it had.
type WorkspaceRole = (typeof workspaceRole)[number];
const suspendedKey = (workspaceId: number) => `scim.suspended.ws${workspaceId}`;

async function suspendedSeats(db: DB, workspaceId: number): Promise<Record<string, WorkspaceRole>> {
  return (await getSettingJson<Record<string, WorkspaceRole>>(db, suspendedKey(workspaceId), {})) ?? {};
}

async function suspendedRole(db: DB, userId: number, workspaceId: number): Promise<WorkspaceRole | null> {
  const role = (await suspendedSeats(db, workspaceId))[String(userId)];
  return role && (workspaceRole as readonly string[]).includes(role) ? role : null;
}

async function setSuspended(db: DB, userId: number, workspaceId: number, role: WorkspaceRole | null): Promise<void> {
  const seats = await suspendedSeats(db, workspaceId);
  if (role) seats[String(userId)] = role;
  else delete seats[String(userId)];
  await setSettingJson(db, suspendedKey(workspaceId), seats);
}

/**
 * r501: whether `workspaceId`'s IdP may deactivate this account INSTANCE-wide.
 * Only an account SCIM itself created — its password is SCIM's unusable random
 * value, never an argon2 hash (adoption never touched it, and a local or SSO
 * signup always has one) — and that holds no seat in another tenant's
 * workspace. A workspace the user owns and is alone in is their personal
 * space, not another tenant. Anything else is somebody else's user too: the
 * IdP gets the seat in its own workspace, not the account.
 */
async function deactivatesInstanceWide(
  db: DB,
  user: { id: number; passwordHash: string },
  workspaceId: number,
): Promise<boolean> {
  if (user.passwordHash.startsWith('$argon2')) return false;
  const seats = await db.query.workspaceMembers.findMany({ where: eq(workspaceMembers.userId, user.id) });
  for (const seat of seats) {
    if (seat.workspaceId === workspaceId) continue;
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, seat.workspaceId) });
    if (!ws) continue;
    if (ws.ownerId !== user.id) return false;
    const roster = await db.query.workspaceMembers.findMany({ where: eq(workspaceMembers.workspaceId, ws.id) });
    if (roster.some((m) => m.userId !== user.id)) return false;
  }
  return true;
}

const OWNER_REFUSED = 'The workspace owner cannot be deprovisioned through the SCIM token of that same workspace';
const ADOPT_REFUSED =
  'An account with this email already exists on this instance but is not a member of this workspace. ' +
  'Add it to the workspace first (invite it from the workspace settings), then retry the provisioning push.';

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

/**
 * A user this workspace's token may act on: an existing member of it, or one
 * whose seat in it this IdP suspended (r501) — `suspended` then carries the
 * parked role.
 */
async function resolveMember(db: DB, idRaw: string, workspaceId: number) {
  const user = await resolveUser(db, idRaw);
  if (!user) return null;
  if (await isMemberOf(db, user.id, workspaceId)) return { user, suspended: null };
  const parked = await suspendedRole(db, user.id, workspaceId);
  return parked ? { user, suspended: parked } : null;
}

/**
 * The single deprovision path for PATCH/PUT active=false (r501): instance-wide
 * when this workspace's IdP owns the account (see deactivatesInstanceWide),
 * otherwise only the seat in this workspace is suspended. Returns the SCIM
 * error to send, or null.
 */
async function deprovisionFor(
  db: DB,
  user: { id: number; email: string; passwordHash: string; isInstanceOperator: boolean | null },
  workspaceId: number,
  alreadySuspended: boolean,
): Promise<{ statusCode: number; payload: Record<string, unknown> } | null> {
  if (user.isInstanceOperator) return scimError(403, OPERATOR_REFUSED);
  if (alreadySuspended) return null;
  if (await deactivatesInstanceWide(db, user, workspaceId)) {
    await deactivateUser(db, user.id, workspaceId, { leaveWorkspace: false });
    void audit(db, null, 'scim.deactivate', user.email);
    return null;
  }
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (ws?.ownerId === user.id) return scimError(403, OWNER_REFUSED);
  const seat = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.workspaceId, workspaceId)),
  });
  await setSuspended(db, user.id, workspaceId, (seat?.role as WorkspaceRole | undefined) ?? 'member');
  await db
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.workspaceId, workspaceId)));
  // r695: the API's member removal hands what the user created here to the
  // workspace owner (r097); the IdP's removal paths never did, so a team
  // service kept an absent owner — whose seat the deploy pipeline consults
  // before injecting the project's shared env.
  if (ws) await rehomeOwnedResources(db, workspaceId, user.id, ws.ownerId);
  void audit(db, null, 'scim.suspend', `${user.email} in workspace #${workspaceId}`);
  return null;
}

/** Give a suspended seat back (r501) — the IdP re-enabled the user. */
async function reinstateSeat(db: DB, userId: number, email: string, workspaceId: number, role: WorkspaceRole): Promise<void> {
  if (!(await isMemberOf(db, userId, workspaceId))) {
    await db.insert(workspaceMembers).values({ workspaceId, userId, role });
  }
  await setSuspended(db, userId, workspaceId, null);
  void audit(db, null, 'scim.reinstate', `${email} in workspace #${workspaceId}`);
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
    // r695: same hand-over as an API removal (see deprovisionFor).
    // F884: but the account is now deactivated instance-wide, and its only other
    // seats are its own solo workspaces — they keep nothing, so hand over all.
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, byWorkspaceId) });
    if (ws && ws.ownerId !== userId) await rehomeOwnedResources(db, byWorkspaceId, userId, ws.ownerId, 'account-deletion');
  }
  // r444: "every credential the account holds" includes the 8-hour studio
  // cookie — a pre-authenticated DB client that must not outlive the
  // deprovisioning. Same instance-wide epoch bump the password resets use.
  try {
    await setSettingString(db, STUDIO_EPOCH_KEY, String(Date.now()));
  } catch { /* a fixture without the settings table */ }
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
      const alreadyMember = await isMemberOf(app.db, existing.id, workspaceId);
      const parked = alreadyMember ? null : await suspendedRole(app.db, existing.id, workspaceId);
      // r501: only this workspace's own people — a member, a seat this IdP
      // suspended, or an account this workspace deprovisioned. Adopting any
      // other account by email handed it to this IdP's deactivation switch.
      if (!alreadyMember && !parked && existing.deactivatedByWorkspaceId !== workspaceId) {
        void audit(app.db, null, 'scim.adopt_refused', `${email} -> workspace #${workspaceId}`);
        return scimReply(reply, scimError(409, ADOPT_REFUSED, 'uniqueness'));
      }
      // A push from workspace A must not undo a deprovision another tenant
      // performed (r153) — see mayReactivate.
      const reactivate = existing.deactivatedAt !== null && (await mayReactivate(app.db, existing, workspaceId));
      await app.db
        .update(users)
        .set({
          scimExternalId: externalId ?? existing.scimExternalId,
          name: name ?? existing.name,
          ...(reactivate ? REACTIVATED : {}),
        })
        .where(eq(users.id, existing.id));
      if (parked) {
        await reinstateSeat(app.db, existing.id, existing.email, workspaceId, parked);
      } else if (!alreadyMember) {
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
    const found = await resolveMember(app.db, (req.params as { id: string }).id, workspaceId);
    if (!found) return scimReply(reply, scimError(404, 'User not found'));
    return scimUserBody(found.user, workspaceId, found.suspended !== null);
  });

  app.get<{ Querystring: { filter?: string; startIndex?: string; count?: string } }>('/Users', async (req, reply) => {
    const workspaceId = await bearer(req);
    const filter = String((req.query as { filter?: unknown }).filter ?? '').trim();
    const eqMatch = /^userName\s+eq\s+"([^"]*)"$/i.exec(filter);
    // F149: a filter we cannot evaluate is invalidFilter (RFC 7644 §3.4.2.2),
    // never "every member" — IdPs link Resources[0] of a lookup.
    if (filter && !eqMatch) {
      return scimReply(reply, scimError(400, 'Only the filter userName eq "<value>" is supported', 'invalidFilter'));
    }
    const rows = await app.db.query.users.findMany();
    const memberships = await app.db.query.workspaceMembers.findMany({ where: eq(workspaceMembers.workspaceId, workspaceId) });
    const memberIds = new Set(memberships.map((m) => m.userId));
    // r501: suspended seats stay visible to their IdP (as inactive users).
    const suspended = new Set(Object.keys(await suspendedSeats(app.db, workspaceId)).map(Number));
    const inWorkspace = rows.filter((u) => memberIds.has(u.id) || suspended.has(u.id));
    const matched = eqMatch ? inWorkspace.filter((u) => u.email.toLowerCase() === eqMatch[1]!.toLowerCase()) : inWorkspace;
    const start = Math.max(1, Number((req.query as { startIndex?: string }).startIndex ?? 1) || 1);
    // F150: count=0 is legal ("totalResults only", RFC 7644 §3.4.2.4) — only absent/NaN means the default.
    const countRaw = String((req.query as { count?: unknown }).count ?? '').trim();
    const countNum = countRaw === '' ? 100 : Number(countRaw);
    const count = Math.min(200, Math.max(0, Number.isNaN(countNum) ? 100 : countNum));
    const page = matched.slice(start - 1, start - 1 + count);
    return {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: matched.length,
      startIndex: start,
      itemsPerPage: page.length,
      Resources: page.map((u) => scimUserBody(u, workspaceId, !memberIds.has(u.id))),
    };
  });

  // ── Patch (the deprovision workhorse: {"op":"replace","path":"active"}) ──
  app.patch<{ Params: { id: string }; Body: { Operations?: Array<{ op?: unknown; path?: unknown; value?: unknown }> } }>(
    '/Users/:id',
    async (req, reply) => {
      const workspaceId = await bearer(req);
      const found = await resolveMember(app.db, (req.params as { id: string }).id, workspaceId);
      if (!found) return scimReply(reply, scimError(404, 'User not found'));
      const { user } = found;
      let suspended = found.suspended;
      for (const op of req.body.Operations ?? []) {
        const path = str(op.path)?.toLowerCase();
        let active = op.value;
        // F148: a path-less replace carries an attribute object (RFC 7644
        // §3.5.2.3) — Okta deactivates with {"op":"replace","value":{"active":false}}.
        if (!path && active && typeof active === 'object' && !Array.isArray(active)) {
          const key = Object.keys(active).find((k) => k.toLowerCase() === 'active');
          active = key === undefined ? undefined : (active as Record<string, unknown>)[key];
        }
        if ((str(op.op)?.toLowerCase() === 'replace' || str(op.op)?.toLowerCase() === 'remove') && (path === 'active' || !path)) {
          if (active === false || active === 'False' || active === 'false') {
            const refused = await deprovisionFor(app.db, user, workspaceId, suspended !== null);
            if (refused) return scimReply(reply, refused);
            suspended = await suspendedRole(app.db, user.id, workspaceId);
          } else if (active === true || active === 'True' || active === 'true') {
            if (user.deactivatedAt && !(await mayReactivate(app.db, user, workspaceId))) {
              return scimReply(reply, scimError(403, REACTIVATE_REFUSED));
            }
            if (suspended) {
              await reinstateSeat(app.db, user.id, user.email, workspaceId, suspended);
              suspended = null;
            }
            await app.db.update(users).set(REACTIVATED).where(eq(users.id, user.id));
            void audit(app.db, null, 'scim.reactivate', user.email);
          }
        }
      }
      const fresh = (await resolveUser(app.db, String(user.id)))!;
      return scimUserBody(fresh, workspaceId, suspended !== null);
    },
  );

  // ── Replace (PUT) — IdPs that don't use PATCH rewrite the whole record ───
  app.put<{ Params: { id: string }; Body: ScimUserPayload }>('/Users/:id', async (req, reply) => {
    const workspaceId = await bearer(req);
    const found = await resolveMember(app.db, (req.params as { id: string }).id, workspaceId);
    if (!found) return scimReply(reply, scimError(404, 'User not found'));
    const { user } = found;
    let suspended = found.suspended;
    const name = str(req.body.displayName) ?? str(req.body.name?.givenName);
    const active = req.body.active;
    if (active === true && !(await mayReactivate(app.db, user, workspaceId))) {
      return scimReply(reply, scimError(403, REACTIVATE_REFUSED));
    }
    if (active === false) {
      const refused = await deprovisionFor(app.db, user, workspaceId, suspended !== null);
      if (refused) return scimReply(reply, refused);
      suspended = await suspendedRole(app.db, user.id, workspaceId);
    } else if (active === true) {
      if (suspended) {
        await reinstateSeat(app.db, user.id, user.email, workspaceId, suspended);
        suspended = null;
      }
      if (user.deactivatedAt) {
        await app.db.update(users).set(REACTIVATED).where(eq(users.id, user.id));
        void audit(app.db, null, 'scim.reactivate', user.email);
      }
    }
    await app.db.update(users).set({ name: name ?? user.name, scimExternalId: str(req.body.externalId) ?? user.scimExternalId }).where(eq(users.id, user.id));
    const fresh = (await resolveUser(app.db, String(user.id)))!;
    return scimUserBody(fresh, workspaceId, suspended !== null);
  });

  // ── Delete — deprovision: deactivate + leave this workspace ──────────────
  app.delete<{ Params: { id: string } }>('/Users/:id', async (req, reply) => {
    const workspaceId = await bearer(req);
    const found = await resolveMember(app.db, (req.params as { id: string }).id, workspaceId);
    if (!found) return scimReply(reply, scimError(404, 'User not found'));
    const { user } = found;
    if (user.isInstanceOperator) return scimReply(reply, scimError(403, OPERATOR_REFUSED));
    if (await deactivatesInstanceWide(app.db, user, workspaceId)) {
      await deactivateUser(app.db, user.id, workspaceId, { leaveWorkspace: true });
      if (found.suspended) await setSuspended(app.db, user.id, workspaceId, null);
      void audit(app.db, null, 'scim.deprovision', user.email);
      return { schemas: [SCIM_USER_SCHEMA], id: String(user.id) };
    }
    // r501: someone else's user too — leave THIS workspace, keep the account.
    const ws = await app.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (ws?.ownerId === user.id) return scimReply(reply, scimError(403, OWNER_REFUSED));
    await app.db
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.workspaceId, workspaceId)));
    // r695: same hand-over as an API removal (see deprovisionFor).
    if (ws) await rehomeOwnedResources(app.db, workspaceId, user.id, ws.ownerId);
    if (found.suspended) await setSuspended(app.db, user.id, workspaceId, null);
    void audit(app.db, null, 'scim.deprovision', `${user.email} (left workspace #${workspaceId})`);
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
