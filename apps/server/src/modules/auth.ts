import { and, count, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { apiTokens, type DB, oauthIdentities, oidcProviders, type OidcProvider, sessions as sessionsTable, settings, users, webauthnCredentials, type User } from '@ninedeploy/db';
import type { PublicUser, Register } from '@ninedeploy/schemas';
import { createApiToken, forgotPassword, login, oidcProviderCreate, oidcProviderUpdate, type OidcProviderEntry, type OidcPublicProvider, passkeyLoginVerify, passkeyRegisterVerify, passwordChange, passwordResetWithToken, refresh, register, stepUp, twoFactorDisable, twoFactorEnable, twoFactorSetup } from '@ninedeploy/schemas';
import { config } from '../config.js';
import { decrypt, encrypt, hashPassword, randomToken, secretEquals, sha256, verifyPassword } from '../lib/crypto.js';
import { normalizeEmail } from '../lib/authHelpers.js';
import { oauthProviderFingerprint, resolveOAuthIdentity } from '../lib/oauthIdentity.js';
import { badRequest, conflict, forbidden, HttpError, notFound, parseId, unauthorized } from '../lib/errors.js';
import { verifyJwt, type AppJwtPayload } from '../lib/jwt.js';
import { isLocked, recordFailure, recordSuccess } from '../lib/loginLockout.js';
import { consumeResetToken, issueResetToken, RESET_TTL_MS } from '../lib/passwordReset.js';
import { sendSystemEmail } from '../lib/notifier.js';
import { renderTemplate } from '../lib/emailTemplates.js';
import { getSettingJson, setSettingJson, setSettingString } from '../lib/settings.js';
import { STUDIO_EPOCH_KEY } from './studioProxy.js';
import { generateSecret, otpauthUri } from '../lib/totp.js';
import { consumeTotpCode } from '../lib/totpReplay.js';
import { audit } from '../lib/audit.js';
import { getSetting } from '../lib/settings.js';
import { findLiveSession, issueSessionTokens, refreshSessionTokens, revokeAllSessions, revokeApiTokens } from '../lib/sessions.js';
import { beginAuthentication, beginRegistration, finishAuthentication, finishRegistration, legacyCredentialId } from '../lib/webauthn.js';
import { CLIENT_NONCE_PATTERN, exchangeGitHubCode, exchangeOidcCode, fetchOidcConfiguration, fetchOidcUserInfo, generateOAuthState, verifyOAuthState } from '../lib/oauth.js';
import { ensureDefaultWorkspace, ensureDefaultWorkspaceWithRole } from './workspaces.js';
import { acceptInvitationsForUser } from './invitations.js';
import { iso } from '../lib/serialize.js';
import { isOperator } from '../lib/resourceAccess.js';
import type { workspaceRole } from '@ninedeploy/db';

type WorkspaceRole = (typeof workspaceRole)[number];

const toUser = (u: User, isOp: boolean): PublicUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  isOperator: isOp,
  workspaceCount: 0,
  createdAt: u.createdAt instanceof Date
    ? u.createdAt.toISOString()
    : new Date(u.createdAt as unknown as number).toISOString(),
});

// ── Allowed email domains per provider (r507) ──────────────────────────────
// docs/SECURITY_SSO.md promised domain restriction; nothing implemented it, so
// with auto-enroll on, ANY account at the IdP (a public Google or GitHub one
// included) could create itself a NineDeploy account. Stored in the settings
// table (no migration); an absent or empty list keeps the old behaviour.
const allowedDomainsKey = (providerId: number) => `oidc.allowed_domains.${providerId}`;

async function loadAllowedDomains(db: DB, providerId: number): Promise<string[]> {
  const value = await getSettingJson<unknown>(db, allowedDomainsKey(providerId), []);
  return Array.isArray(value) ? value.filter((d): d is string => typeof d === 'string') : [];
}

/** The IdP-attested email is acceptable for this provider (exact domain match). */
function emailDomainAllowed(email: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const domain = normalizeEmail(email).split('@').pop() ?? '';
  return allowed.includes(domain);
}

function serializeOidc(p: OidcProvider, allowedDomains: string[] = []): OidcProviderEntry {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    issuerUrl: p.issuerUrl,
    clientId: p.clientId,
    scopes: p.scopes,
    enabled: Boolean(p.enabled),
    autoEnroll: Boolean(p.autoEnroll),
    // defaultRole is now a workspace role (owner/admin/member/viewer); coerce
    // to the legacy 'admin' | 'member' surface the public SDK still expects.
    defaultRole: (p.defaultRole === 'owner' || p.defaultRole === 'admin' ? 'admin' : 'member'),
    allowedDomains,
    createdAt: iso(p.createdAt) as string,
    updatedAt: iso(p.updatedAt) as string,
  };
}

/**
 * The OAuth/OIDC callback URL for a provider.
 *
 * Derived from the CONFIGURED public URL, never from `req.hostname` — that is
 * the client's `Host` header, so an attacker could otherwise choose the
 * `redirect_uri` handed to the identity provider and, against a provider with
 * a permissive redirect registration, have the authorization code delivered to
 * a host they control. The same value must be used for the authorize request
 * and the token exchange, so both call sites go through here.
 */
function oidcRedirectUri(slug: string): string {
  return `${config.publicUrl}/v1/auth/oidc/${slug}/callback`;
}

// ── OIDC state cookie (login-CSRF defense) ─────────────────────────────────
// The signed state is a self-contained blob, so the callback alone cannot
// tell WHO started the flow: an attacker can run the login themselves, collect
// a callback URL, and hand it to a victim — the victim's browser then gets
// signed in to the ATTACKER's account (session swap). Binding the state to an
// HttpOnly cookie set by the login route makes the callback reject any flow
// that was not started in the same browser.
const OIDC_STATE_COOKIE_MAX_AGE_S = 600;

function oidcStateCookieName(slug: string): string {
  return `ninedeploy_oidc_${slug.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function oidcStateCookie(name: string, value: string, maxAgeS: number, isHttps: boolean): string {
  // SameSite=None (+Secure) so cross-site IdP form_post callbacks still carry
  // it; plain-HTTP dev servers fall back to Lax, which is enough for the
  // redirect flow they exercise.
  const sameSite = isHttps ? 'SameSite=None; Secure' : 'SameSite=Lax';
  return `${name}=${value}; Path=/v1/auth; Max-Age=${maxAgeS}; HttpOnly; ${sameSite}`;
}

/** Set or clear the browser-bound state cookie. */
function writeOidcStateCookie(req: { protocol?: string }, reply: { header: (k: string, v: string) => void }, slug: string, state: string | null): void {
  const name = oidcStateCookieName(slug);
  const isHttps = req.protocol === 'https';
  reply.header('Set-Cookie', oidcStateCookie(name, state ? sha256(state) : '', state ? OIDC_STATE_COOKIE_MAX_AGE_S : 0, isHttps));
}

/** Read + verify the state cookie; throws when the browser that delivered the
 *  callback is not the browser that started the flow. */
function verifyOidcStateCookie(req: { protocol?: string; headers: Record<string, unknown> }, reply: { header: (k: string, v: string) => void }, slug: string, state: string): void {
  const name = oidcStateCookieName(slug);
  const cookieHeader = (req.headers.cookie as string | undefined) ?? '';
  const expected = sha256(state);
  const carried = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  // Clear whichever (missing/stale) cookie is on the browser now.
  writeOidcStateCookie(req, reply, slug, null);
  if (!carried || !secretEquals(carried, expected)) {
    throw unauthorized('OAuth state cookie mismatch — restart the sign-in flow from this browser');
  }
}

// ── Step-up (r502) ─────────────────────────────────────────────────────────
// Registering a passkey or turning TOTP on plants a DURABLE credential: one
// that outlives the session that created it (and, for passkeys, a password
// change). A briefly stolen access token used to be enough to do either, so
// the thief kept a way back in after the victim logged out everywhere. These
// routes now need proof that the account holder is present: the current
// password, or — for an account that has no usable password (SSO-only) — a
// sign-in fresh enough that it happened just now.
const STEP_UP_FRESH_MS = 10 * 60 * 1000;
const REAUTH_REQUIRED_MESSAGE =
  'Confirm your current password to continue. Accounts that sign in only through SSO: sign in again, then retry within 10 minutes.';

async function assertStepUp(
  db: DB,
  req: { headers: { authorization?: string } },
  user: Pick<User, 'id' | 'passwordHash'>,
  password: string | undefined,
): Promise<void> {
  if (password !== undefined) {
    if (await verifyPassword(user.passwordHash, password)) return;
    // 403 (not 401): the session itself is fine — a 401 would send the web
    // client into a pointless refresh-and-retry.
    throw new HttpError(403, 'invalid_password', 'Invalid password');
  }
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  try {
    const payload = await verifyJwt(bearer);
    const session = payload.type === 'access' && payload.jti ? await findLiveSession(db, payload.jti) : null;
    // `createdAt` is the sign-in time: refresh rotation keeps the row (and
    // its createdAt), so a stolen refresh token cannot make itself "fresh".
    if (session && session.userId === user.id && Date.now() - session.createdAt.getTime() <= STEP_UP_FRESH_MS) return;
  } catch { /* not a verifiable session token — fall through */ }
  throw new HttpError(403, 'reauth_required', REAUTH_REQUIRED_MESSAGE);
}

/** Count existing users (used to decide first-user-is-admin). */
async function userCount(db: Pick<DB, 'select'>): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users);
  return row?.n ?? 0;
}

/**
 * Create the very first user (becomes owner of a personal workspace). Count +
 * insert run inside a single transaction so two concurrent bootstrap requests
 * cannot both become the first user. After the transaction commits, any
 * pending workspace invitations for the new user are auto-accepted and
 * audit-logged.
 */
export async function createFirstAdmin(db: DB, input: Register) {
  const result = await db.transaction(async (tx) => {
    if ((await userCount(tx)) > 0) throw conflict('Instance is already initialized');
    const email = normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    const [user] = await tx
      .insert(users)
      // The bootstrap user is the only account that receives the
      // instance-operator flag automatically. Everyone else must be granted it
      // by an existing operator (PATCH /v1/users/:id/operator) — creating a
      // workspace does NOT confer it (see lib/resourceAccess.ts:isOperator).
      .values({ email, passwordHash, name: input.name ?? null, isInstanceOperator: true })
      .returning();
    if (!user) throw badRequest('Could not create user');
    // …and gets a personal workspace so the team surfaces have somewhere to
    // start. The workspace role is unrelated to the operator flag above.
    await ensureDefaultWorkspace(tx, user);
    return { user: toUser(user, true), tokens: await issueSessionTokens(tx, user), rawUser: user };
  });
  // r222: a new account (or the first admin) is a security event of its own.
  void audit(db, result.rawUser.id, 'auth.register', result.rawUser.email);
  return { user: result.user, tokens: result.tokens };
}

/** Register a user. The first user gets a personal workspace; everyone else
 *  lands without any until invited into one. */
export async function registerAccount(db: DB, input: Register) {
  // Same transactional guard as the bootstrap: the count-then-insert race
  // between two simultaneous first registrations must not create two users.
  const result = await db.transaction(async (tx) => {
    const isFirst = (await userCount(tx)) === 0;
    // r159: the unique index on users.email is case-sensitive, while login,
    // invitations and domain transfers match on lower(email). Registering
    // `Victim@corp.com` next to `victim@corp.com` auto-accepted the victim's
    // pending invitations and made login ambiguous. Store the canonical form
    // and refuse a case-variant of an existing address.
    const email = normalizeEmail(input.email);
    const taken = await tx.query.users.findFirst({ where: sql`lower(${users.email}) = ${email}` });
    if (taken) throw badRequest('Email is already registered', 'email_taken');
    const passwordHash = await hashPassword(input.password);
    let user: User | undefined;
    try {
      [user] = await tx
        .insert(users)
        // Only the very first registration on an empty instance is an
        // operator; open registration must never mint one.
        .values({ email, passwordHash, name: input.name ?? null, isInstanceOperator: isFirst })
        .returning();
    } catch {
      throw badRequest('Email is already registered', 'email_taken');
    }
    if (!user) throw badRequest('Could not create user');
    let operator = false;
    if (isFirst) {
      // First user gets a personal workspace so the instance has someone who
      // can act as an operator out of the gate.
      await ensureDefaultWorkspace(tx, user);
      operator = true;
    }
    return { user: toUser(user, operator), tokens: await issueSessionTokens(tx, user), rawUser: user };
  });
  // r222: a new account (or the first admin) is a security event of its own.
  void audit(db, result.rawUser.id, 'auth.register', result.rawUser.email);
  return { user: result.user, tokens: result.tokens };
}

/**
 * Default for the `allow_registration` setting when an admin has never set it.
 *
 * Closed by default: this is a deployment control plane, and an instance that
 * hands out member accounts to anonymous visitors turns any authorization gap
 * into an unauthenticated one. First-run bootstrap is unaffected — the first
 * registration on an empty instance still becomes the admin.
 * Admins can re-open registration from Settings.
 */
export const ALLOW_REGISTRATION_DEFAULT = false;

/** Tighter rate limit for credential-bearing endpoints (brute-force / credential-stuffing defense). */
const AUTH_LIMIT = { max: 20, timeWindow: '1 minute' };
/** Reset requests are cheap to spam (each mints a token + maybe an email). */
const FORGOT_LIMIT = { max: 5, timeWindow: '1 minute' };

export const authRoutes: FastifyPluginAsync = async (app) => {
  // Public: whether the instance has any users yet (drives first-run setup UI)
  // and whether open registration is currently allowed (drives the register form).
  app.get('/status', async () => ({
    initialized: (await userCount(app.db)) > 0,
    allowRegistration: await getSetting(app.db, 'allow_registration', ALLOW_REGISTRATION_DEFAULT),
  }));

  /**
   * `GET /v1/auth/token` — introspect the current bearer
   * token. Returns the same shape for both interactive
   * sessions (JWT) and opaque API tokens, so the MCP /
   * CLI can use one endpoint to discover "what scopes
   * does this credential carry" without an extra round
   * trip to a `me` + token lookup.
   *
   * Interactive sessions (JWT) report `scopes: ['session']`
   * which is the implicit full-authority marker. API tokens
   * report their stored `scopes` array (empty means
   * "unrestricted legacy" — same semantics as the
   * pre-0.3.5 behaviour).
   */
  // Like every other authenticated route in this module, the hook must be
  // declared explicitly — `req.user` is only the decorated null otherwise,
  // which turned this endpoint into a guaranteed 401 for its entire life.
  app.get('/token', { onRequest: [app.authenticate] }, async (req) => {
    if (!req.user) throw unauthorized();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw unauthorized();
    const isJwt = token.split('.').length === 3;
    if (isJwt) {
      return {
        kind: 'session' as const,
        userId: req.user.id,
        scopes: ['session'],
        expiresAt: null,
        isOperator: req.user.isOperator,
      };
    }
    // Opaque API token: look up the row by hash to surface
    // the persistent id + expiry alongside the scopes.
    const row = await app.db.query.apiTokens.findFirst({ where: eq(apiTokens.hash, sha256(token)) });
    if (!row) throw unauthorized();
    return {
      kind: 'api' as const,
      tokenId: row.id,
      name: row.name,
      userId: req.user.id,
      scopes: Array.isArray(row.scopes) ? row.scopes : [],
      expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : null,
      isOperator: req.user.isOperator,
    };
  });

  app.post('/register', { config: { rateLimit: AUTH_LIMIT } }, async (req) => {
    // Open registration can be disabled by an admin (anyone who finds the
    // panel URL could otherwise self-provision a member account). Bootstrap
    // stays possible: when no user exists yet the first registration becomes
    // the admin regardless of the flag (same rule as /setup).
    const noUsers = (await userCount(app.db)) === 0;
    if (!noUsers && !(await getSetting(app.db, 'allow_registration', ALLOW_REGISTRATION_DEFAULT))) {
      throw forbidden('Registration is disabled on this instance');
    }
    return registerAccount(app.db, register.parse(req.body));
  });

  app.post('/login', { config: { rateLimit: AUTH_LIMIT } }, async (req) => {
    const input = login.parse(req.body);
    // Failed-login lockout (complements the per-IP rate limit): the response is
    // deliberately identical to a wrong password so the lock state isn't a probe.
    // The lock is keyed per (account, source IP): a single host guessing
    // passwords locks ITSELF out, not the victim — otherwise 5 wrong
    // passwords from anyone would hold a known account hostage (DoS).
    if (isLocked(input.email, req.ip)) throw unauthorized('Invalid email or password');
    const user = await app.db.query.users.findFirst({
      where: sql`lower(${users.email}) = lower(${input.email})`,
    });
    // r504: an unknown email still pays one full argon2 verify (against a
    // dummy hash — see verifyPassword), so response timing does not reveal
    // which addresses have an account.
    const passwordOk = await verifyPassword(user?.passwordHash ?? '', input.password);
    if (!user || !passwordOk) {
      const locked = recordFailure(input.email, req.ip);
      if (locked) void audit(app.db, null, 'auth.lockout', input.email);
      throw unauthorized('Invalid email or password');
    }
    // 2FA: a missing code gets a distinct (but non-enumerating) error; a wrong
    // code counts as a failed login for lockout purposes.
    if (user.totpEnabled && user.totpSecretEncrypted) {
      if (!input.totpCode) throw unauthorized('Two-factor code required', 'totp_required');
      // L-10: consume, don't just verify — a replayed code is refused even
      // though it is still inside its drift window.
      if (!(await consumeTotpCode(app.db, user, input.totpCode))) {
        const locked = recordFailure(input.email, req.ip);
        if (locked) void audit(app.db, null, 'auth.lockout', input.email);
        throw unauthorized('Invalid two-factor code', 'totp_invalid');
      }
    }
    // SCIM-deprovisioned accounts verify fine (their credentials were hashed
    // randomly at provision time anyway) but must never get a session.
    if (user.deactivatedAt) throw unauthorized('This account has been deactivated', 'account_deactivated');
    recordSuccess(input.email, req.ip);
    // Password authentication does not verify email ownership; invitation
    // membership is granted only through the token-bearing accept route.
    void audit(app.db, user.id, 'auth.login', user.email, undefined, { ip: req.ip, userAgent: req.headers['user-agent'] });
    return {
      user: toUser(user, await isOperator(app.db, user)),
      tokens: await issueSessionTokens(app.db, user, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      }),
    };
  });

  // ── Passkeys (WebAuthn) ──────────────────────────────────────────────────
  // Registration ceremony: options (challenge) → browser prompt → verify.
  app.post('/passkey/register/options', { onRequest: [app.authenticate, app.requireInteractive], config: { rateLimit: AUTH_LIMIT } }, async (req) => {
    const user = await app.db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
    if (!user) throw unauthorized();
    // r502: fail before the browser prompt; verify re-checks (it stores).
    await assertStepUp(app.db, req, user, stepUp.parse(req.body ?? {}).password);
    const existing = await app.db
      .select({ credentialId: webauthnCredentials.credentialId, transports: webauthnCredentials.transports })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, user.id));
    return { options: await beginRegistration(user, existing) };
  });

  app.post('/passkey/register/verify', { onRequest: [app.authenticate, app.requireInteractive], config: { rateLimit: AUTH_LIMIT } }, async (req) => {
    const input = passkeyRegisterVerify.parse(req.body);
    const user = await app.db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
    if (!user) throw unauthorized();
    // r502: a passkey is a durable credential — never from a bare session.
    await assertStepUp(app.db, req, user, input.password);
    const existing = await app.db
      .select({ credentialId: webauthnCredentials.credentialId })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, user.id));
    let stored: { credentialId: string; publicKey: string; counter: number; transports: string[] };
    try {
      stored = await finishRegistration(user, existing, input.response);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : 'Passkey verification failed');
    }
    const [row] = await app.db
      .insert(webauthnCredentials)
      .values({ userId: user.id, ...stored, name: input.name })
      .returning();
    if (!row) throw badRequest('Could not store passkey');
    void audit(app.db, user.id, 'auth.passkey_added', user.email, { name: input.name });
    return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() };
  });

  app.get('/passkey', { onRequest: [app.authenticate] }, async (req) => {
    const rows = await app.db
      .select({ id: webauthnCredentials.id, name: webauthnCredentials.name, createdAt: webauthnCredentials.createdAt })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, req.user!.id));
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt.toISOString() }));
  });

  app.delete('/passkey/:id', { onRequest: [app.authenticate, app.requireInteractive] }, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    // r691: someone else's (or no) passkey id answered 200 and audited a
    // removal that never happened. The delete stays owner-scoped; a miss is
    // now the same 404 for "not yours" and "does not exist".
    const gone = await app.db
      .delete(webauthnCredentials)
      .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, req.user!.id)))
      .returning({ id: webauthnCredentials.id });
    if (!gone[0]) throw notFound('Passkey not found');
    void audit(app.db, req.user!.id, 'auth.passkey_removed', undefined, { id });
    return { ok: true };
  });

  // Authentication ceremony (public — the credential IS the proof of identity;
  // discoverable credentials let the user pick an account in the browser prompt).
  app.post('/passkey/login/options', { config: { rateLimit: AUTH_LIMIT } }, async () => {
    // L-5: no database read at all. This used to return every credentialId on
    // the instance to an anonymous caller; the discoverable-credential flow
    // needs none of them.
    return { options: await beginAuthentication() };
  });

  app.post('/passkey/login/verify', { config: { rateLimit: AUTH_LIMIT } }, async (req) => {
    const input = passkeyLoginVerify.parse(req.body);
    const id = String((input.response as { id?: unknown }).id ?? '');
    if (!id) throw unauthorized('Invalid passkey response');
    let cred = await app.db.query.webauthnCredentials.findFirst({
      where: eq(webauthnCredentials.credentialId, id),
    });
    // D2/F989 LEGACY FALLBACK — remove after 2–3 releases (with
    // legacyCredentialId in lib/webauthn.ts). Passkeys registered before F340
    // hold base64url(utf8(id)); look that form up only when the canonical id
    // misses. The row is rewritten to the canonical id below, after the
    // assertion verifies, so each legacy row takes this path at most once.
    let legacyId: string | null = null;
    if (!cred) {
      legacyId = legacyCredentialId(id);
      cred = await app.db.query.webauthnCredentials.findFirst({
        where: eq(webauthnCredentials.credentialId, legacyId),
      });
    }
    if (!cred) throw unauthorized('Unknown passkey');
    let newCounter: number;
    try {
      newCounter = await finishAuthentication(cred, input.response);
    } catch (err) {
      throw unauthorized(err instanceof Error ? err.message : 'Passkey verification failed');
    }
    await app.db
      .update(webauthnCredentials)
      .set({ counter: newCounter })
      .where(eq(webauthnCredentials.id, cred.id));
    if (legacyId) {
      // D2/F989 (legacy fallback, remove with it): migrate the verified row to
      // the canonical id. Conditional on the OLD value, so a concurrent login
      // that already migrated it (or any other change since the read) turns
      // this into a no-op instead of a clobber. Best-effort: the sign-in is
      // already proven, and an unmigrated row still works through the fallback.
      try {
        await app.db
          .update(webauthnCredentials)
          .set({ credentialId: id })
          .where(and(eq(webauthnCredentials.id, cred.id), eq(webauthnCredentials.credentialId, legacyId)));
      } catch (err) {
        req.log.warn({ err, credentialRowId: cred.id }, 'passkey: could not migrate a pre-F340 credential id');
      }
    }
    const user = await app.db.query.users.findFirst({ where: eq(users.id, cred.userId) });
    if (!user) throw unauthorized();
    void audit(app.db, user.id, 'auth.passkey_login', user.email, undefined, { ip: req.ip, userAgent: req.headers['user-agent'] });
    return {
      user: toUser(user, await isOperator(app.db, user)),
      tokens: await issueSessionTokens(app.db, user, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      }),
    };
  });

  // ── Session management ───────────────────────────────────────────────────
  app.get('/sessions', { onRequest: [app.authenticate] }, async (req) => {
    const rows = await app.db.query.sessions.findMany({ where: eq(sessionsTable.userId, req.user!.id) });
    // The current session is flagged by matching the access token's jti
    // claim (both token types carry it) — failures simply flag no row.
    const authHeader = req.headers.authorization ?? '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    let currentJti: string | undefined;
    try {
      currentJti = (await verifyJwt(bearer)).jti;
    } catch {
      currentJti = undefined;
    }
    return rows
      .filter((r) => !r.revokedAt && r.expiresAt.getTime() > Date.now())
      .sort((a, b) => (b.lastUsedAt?.getTime() ?? 0) - (a.lastUsedAt?.getTime() ?? 0))
      .map((r) => ({
        id: r.id,
        ip: r.ip,
        userAgent: r.userAgent,
        createdAt: r.createdAt.toISOString(),
        lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
        current: currentJti === r.jti,
      }));
  });

  app.delete('/sessions/:id', { onRequest: [app.authenticate] }, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    // r691: owner-scoped as before, but a miss is a 404 — another user's
    // session id used to answer 200 and leave an `auth.session_revoked` audit
    // row for a revocation that never happened. Re-revoking one's own session
    // still succeeds.
    const hit = await app.db
      .update(sessionsTable)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessionsTable.id, id), eq(sessionsTable.userId, req.user!.id)))
      .returning({ id: sessionsTable.id });
    if (!hit[0]) throw notFound('Session not found');
    void audit(app.db, req.user!.id, 'auth.session_revoked', undefined, { id });
    return { ok: true };
  });

  // ── Two-factor (TOTP) setup / enable / disable ───────────────────────────
  // Setup generates (or regenerates) a pending secret + otpauth URI; enable
  // verifies a code from the user's authenticator and flips the flag; disable
  // requires the password AND a valid code, then bumps tokenVersion.
  // r502: setup and enable also need step-up — an attacker holding only a
  // session could otherwise enrol THEIR authenticator and lock the owner out
  // of their own account (the owner has no code to sign in with).
  app.post('/2fa/setup', { onRequest: [app.authenticate, app.requireInteractive], config: { rateLimit: AUTH_LIMIT } }, async (req) => {
    const user = await app.db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
    if (!user) throw unauthorized();
    // Regenerating the secret also flips totpEnabled off — when 2FA is active
    // this must not be reachable with a bare token: require the password.
    if (user.totpEnabled) {
      const input = twoFactorSetup.parse(req.body ?? {});
      if (!(await verifyPassword(user.passwordHash, input.password))) throw unauthorized('Invalid password');
    } else {
      await assertStepUp(app.db, req, user, stepUp.parse(req.body ?? {}).password);
    }
    const secret = generateSecret();
    await app.db
      .update(users)
      .set({ totpSecretEncrypted: encrypt(secret), totpEnabled: false })
      .where(eq(users.id, user.id));
    void audit(app.db, user.id, 'auth.2fa_setup', user.email);
    return { secret, otpauthUri: otpauthUri(secret, user.email) };
  });

  app.post('/2fa/enable', { onRequest: [app.authenticate, app.requireInteractive], config: { rateLimit: AUTH_LIMIT } }, async (req) => {
    const input = twoFactorEnable.parse(req.body);
    const user = await app.db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
    if (!user?.totpSecretEncrypted) throw badRequest('Start 2FA setup first');
    await assertStepUp(app.db, req, user, input.password);
    if (!(await consumeTotpCode(app.db, user, input.code))) throw badRequest('Invalid two-factor code');
    await app.db.update(users).set({ totpEnabled: true }).where(eq(users.id, user.id));
    void audit(app.db, user.id, 'auth.2fa_enabled', user.email);
    return { ok: true, totpEnabled: true };
  });

  app.post('/2fa/disable', { onRequest: [app.authenticate, app.requireInteractive], config: { rateLimit: AUTH_LIMIT } }, async (req) => {
    const input = twoFactorDisable.parse(req.body);
    const user = await app.db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
    if (!user) throw unauthorized();
    if (!(await verifyPassword(user.passwordHash, input.password))) throw unauthorized('Invalid password');
    if (user.totpEnabled && user.totpSecretEncrypted) {
      if (!(await consumeTotpCode(app.db, user, input.code))) {
        throw badRequest('Invalid two-factor code');
      }
    }
    // Bump tokenVersion: every outstanding session is re-issued without 2FA claims pending.
    await app.db
      .update(users)
      .set({ totpEnabled: false, totpSecretEncrypted: null, tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, user.id));
    await revokeAllSessions(app.db, user.id);
    void audit(app.db, user.id, 'auth.2fa_disabled', user.email);
    return { ok: true, totpEnabled: false };
  });

  // Forgot password: always answers the same way (no user enumeration). When
  // the account exists, a single-use 30-minute reset token is minted and — if
  // an email notification channel is configured — the reset link is emailed.
  // Without SMTP the token is still consumable via an admin-issued link.
  app.post('/forgot-password', { config: { rateLimit: FORGOT_LIMIT } }, async (req) => {
    const input = forgotPassword.parse(req.body);
    const user = await app.db.query.users.findFirst({
      where: sql`lower(${users.email}) = lower(${input.email})`,
    });
    if (user) {
      const { token } = await issueResetToken(app.db, user, req.ip);
      const link = `${config.publicUrl}/reset-password?token=${encodeURIComponent(token)}`;
      // Best-effort delivery — failures never change the response.
      // r610: rendered by the template engine (the preview route shows this
      // exact text). The reset email is instance-scoped: no workspace's
      // override ever applies to the email that carries an account's reset link.
      await renderTemplate(app.db, 'password-reset', {
        email: input.email,
        ttlMinutes: RESET_TTL_MS / 60_000,
        resetUrl: link,
      })
        .then((mail) => sendSystemEmail(app.db, user.email, mail.subject, mail.text))
        .catch(() => false);
      void audit(app.db, user.id, 'auth.forgot_password', user.email);
    }
    return { ok: true };
  });

  // Complete a reset: consume the single-use token, set the new password, and
  // revoke every outstanding session (tokenVersion bump).
  app.post('/reset-password', { config: { rateLimit: AUTH_LIMIT } }, async (req) => {
    const input = passwordResetWithToken.parse(req.body);
    const user = await consumeResetToken(app.db, input.token, input.newPassword);
    // r441: the reset revoked every session — the 8-hour studio cookies (live
    // shells into database GUIs) must not outlive it. One epoch bump kills
    // them all instance-wide; each studio iframe then asks to start again.
    try {
      await setSettingString(app.db, STUDIO_EPOCH_KEY, String(Date.now()));
    } catch { /* a fixture without the settings table */ }
    void audit(app.db, user.id, 'auth.reset_password', user.email);
    return { ok: true };
  });

  app.post('/refresh', { config: { rateLimit: AUTH_LIMIT } }, async (req) => {
    const input = refresh.parse(req.body);
    let payload: AppJwtPayload;
    try {
      payload = await verifyJwt(input.refreshToken);
    } catch {
      throw unauthorized('Invalid refresh token');
    }
    if (payload.type !== 'refresh' || !payload.jti) throw unauthorized('Invalid refresh token');
    const session = await findLiveSession(app.db, payload.jti);
    if (!session) throw unauthorized('Invalid refresh token');
    const userId = Number(payload.sub);
    const user = await app.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw unauthorized();
    // Reject refresh tokens minted before the user's tokenVersion was bumped
    // (logout / role change / password change) — otherwise a revoked session
    // could simply mint fresh tokens here. ver is mandatory.
    if (payload.ver === undefined || payload.ver !== user.tokenVersion) {
      throw unauthorized('Invalid refresh token');
    }
    if (session.userId !== user.id) throw unauthorized('Invalid refresh token');
    // `payload.gen` binds this refresh token to the generation it was minted
    // against — see refreshSessionTokens. Absent on pre-rotation tokens.
    return {
      user: toUser(user, await isOperator(app.db, user)),
      tokens: await refreshSessionTokens(app.db, user, payload.jti, payload.gen),
    };
  });

  app.get('/me', { onRequest: [app.authenticate] }, async (req) => {
    const user = await app.db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
    if (!user) throw unauthorized();
    return toUser(user, req.user!.isOperator);
  });

  // Logout: bump the user's tokenVersion so every outstanding JWT (access +
  // refresh) for this user is rejected on its next verification, and mark the
  // backing session rows revoked so they disappear from the session list.
  app.post('/logout', { onRequest: [app.authenticate] }, async (req) => {
    await app.db
      .update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, req.user!.id));
    await revokeAllSessions(app.db, req.user!.id);
    return { ok: true };
  });

  // Self-service password change. Requires the CURRENT password; bumps
  // tokenVersion so every other session of this user is logged out, then
  // issues a fresh token pair for the caller.
  app.post('/password', { onRequest: [app.authenticate, app.requireInteractive], config: { rateLimit: AUTH_LIMIT } }, async (req) => {
    const input = passwordChange.parse(req.body);
    const user = await app.db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
    if (!user || !(await verifyPassword(user.passwordHash, input.currentPassword))) {
      throw unauthorized('Invalid current password');
    }
    const passwordHash = await hashPassword(input.newPassword);
    const [updated] = await app.db
      .update(users)
      .set({ passwordHash, tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, user.id))
      .returning();
    if (!updated) throw unauthorized();
    // r441: same reasoning as /reset-password — a changed password ends every
    // studio cookie with the sessions it ended.
    try {
      await setSettingString(app.db, STUDIO_EPOCH_KEY, String(Date.now()));
    } catch { /* a fixture without the settings table */ }
    await revokeAllSessions(app.db, user.id);
    await revokeApiTokens(app.db, user.id);
    // r603: passkeys are an independent credential and deliberately survive a
    // password CHANGE (a reset deletes them) — but someone changing a password
    // they think leaked must see that the passkeys still sign in. The count
    // rides along (additive) so the UI can point at the list.
    const [pk] = await app.db
      .select({ n: count() })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, user.id));
    const passkeysRemaining = Number(pk?.n ?? 0);
    void audit(app.db, user.id, 'auth.password_changed', user.email, { passkeysRemaining }, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return {
      user: toUser(updated, await isOperator(app.db, updated)),
      tokens: await issueSessionTokens(app.db, updated, { ip: req.ip, userAgent: req.headers['user-agent'] }),
      passkeysRemaining,
    };
  });

  // ── API tokens (for the CLI / CI) ────────────────────────────────────────
  app.post('/tokens', { onRequest: [app.authenticate, app.requireInteractive] }, async (req) => {
    const input = createApiToken.parse(req.body ?? {});
    // A token can never grant more than its creator holds: asking for the
    // `operator` scope as a non-operator would otherwise mint a credential
    // that outranks the account behind it.
    if (input.scopes.includes('operator') && !req.user!.isOperator) {
      throw forbidden('Only an instance operator can issue an operator-scoped token');
    }
    const raw = randomToken(32);
    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
      : null;
    const [tok] = await app.db
      .insert(apiTokens)
      .values({
        userId: req.user!.id,
        name: input.name,
        hash: sha256(raw),
        scopes: input.scopes,
        expiresAt,
      })
      .returning();
    if (!tok) throw badRequest('Could not create token');
    void audit(app.db, req.user!.id, 'token.create', `${tok.name} [${input.scopes.join(',') || 'unrestricted'}]`);
    return {
      id: tok.id,
      name: tok.name,
      token: raw,
      scopes: input.scopes,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      createdAt: tok.createdAt.toISOString(),
    };
  });

  app.get('/tokens', { onRequest: [app.authenticate] }, async (req) => {
    const rows = await app.db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        scopes: apiTokens.scopes,
        lastUsedAt: apiTokens.lastUsedAt,
        expiresAt: apiTokens.expiresAt,
        createdAt: apiTokens.createdAt,
      })
      .from(apiTokens)
      .where(eq(apiTokens.userId, req.user!.id));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      // An empty list is a legacy, unrestricted token — surfaced as-is so the
      // UI can flag it rather than pretending it is scoped.
      scopes: Array.isArray(r.scopes) ? r.scopes : [],
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }));
  });

  app.delete('/tokens/:id', { onRequest: [app.authenticate] }, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const gone = await app.db
      .delete(apiTokens)
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, req.user!.id)))
      .returning({ name: apiTokens.name });
    // r691: a token id outside the caller's own answered 200 ("revoked") while
    // nothing was revoked — a script could not tell a typo from success.
    if (!gone[0]) throw notFound('API token not found');
    void audit(app.db, req.user!.id, 'auth.token_revoked', gone[0].name);
    return { ok: true };
  });

  // ── OIDC & OAuth2 SSO Provider Management (Admin) ─────────────────────────
  app.get('/oidc/providers/public', async (): Promise<OidcPublicProvider[]> => {
    const rows = await app.db.query.oidcProviders.findMany({
      where: eq(oidcProviders.enabled, true),
    });
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      authUrl: `/v1/auth/oidc/${p.slug}/login`,
    }));
  });

  app.get('/oidc/providers', { onRequest: [app.authenticate, app.requireAdmin] }, async (): Promise<OidcProviderEntry[]> => {
    const rows = await app.db.query.oidcProviders.findMany();
    return Promise.all(rows.map(async (p) => serializeOidc(p, await loadAllowedDomains(app.db, p.id))));
  });

  app.post('/oidc/providers', { onRequest: [app.authenticate, app.requireAdmin] }, async (req) => {
    const input = oidcProviderCreate.parse(req.body);
    const existing = await app.db.query.oidcProviders.findFirst({ where: eq(oidcProviders.slug, input.slug) });
    if (existing) throw conflict(`Provider with slug "${input.slug}" already exists`);

    const clientSecretEncrypted = encrypt(input.clientSecret);
    const [created] = await app.db
      .insert(oidcProviders)
      .values({
        name: input.name,
        slug: input.slug,
        issuerUrl: input.issuerUrl ?? null,
        clientId: input.clientId,
        clientSecretEncrypted,
        scopes: input.scopes,
        enabled: input.enabled,
        autoEnroll: input.autoEnroll,
        defaultRole: input.defaultRole,
      })
      .returning();

    const domains = [...new Set(input.allowedDomains ?? [])];
    if (domains.length > 0) await setSettingJson(app.db, allowedDomainsKey(created!.id), domains);
    void audit(app.db, req.user!.id, 'oidc_provider.create', created!.name, domains.length > 0 ? { allowedDomains: domains } : undefined);
    return serializeOidc(created!, domains);
  });

  app.patch('/oidc/providers/:id', { onRequest: [app.authenticate, app.requireAdmin] }, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const input = oidcProviderUpdate.parse(req.body);

    const existing = await app.db.query.oidcProviders.findFirst({ where: eq(oidcProviders.id, id) });
    if (!existing) throw notFound('OIDC provider not found');

    // An issuer/client change defines a different identity namespace. Never
    // retain links merely because the provider row and subject string match.
    if ((input.issuerUrl !== undefined && (input.issuerUrl ?? null) !== existing.issuerUrl) ||
        (input.clientId !== undefined && input.clientId !== existing.clientId)) {
      await app.db.delete(oauthIdentities).where(eq(oauthIdentities.providerId, id));
    }
    const [updated] = await app.db
      .update(oidcProviders)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.issuerUrl !== undefined && { issuerUrl: input.issuerUrl ?? null }),
        ...(input.clientId !== undefined && { clientId: input.clientId }),
        ...(input.clientSecret !== undefined && { clientSecretEncrypted: encrypt(input.clientSecret) }),
        ...(input.scopes !== undefined && { scopes: input.scopes }),
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...(input.autoEnroll !== undefined && { autoEnroll: input.autoEnroll }),
        ...(input.defaultRole !== undefined && { defaultRole: input.defaultRole }),
        // r507: a domain-list-only PATCH changes no column — keep the SET
        // non-empty (and the provider's updatedAt honest).
        updatedAt: new Date(),
      })
      .where(eq(oidcProviders.id, id))
      .returning();

    if (input.allowedDomains !== undefined) {
      await setSettingJson(app.db, allowedDomainsKey(id), [...new Set(input.allowedDomains)]);
    }
    const domains = await loadAllowedDomains(app.db, id);
    void audit(app.db, req.user!.id, 'oidc_provider.update', updated!.name, input.allowedDomains !== undefined ? { allowedDomains: domains } : undefined);
    return serializeOidc(updated!, domains);
  });

  app.delete('/oidc/providers/:id', { onRequest: [app.authenticate, app.requireAdmin] }, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const existing = await app.db.query.oidcProviders.findFirst({ where: eq(oidcProviders.id, id) });
    if (!existing) throw notFound('OIDC provider not found');

    await app.db.delete(oidcProviders).where(eq(oidcProviders.id, id));
    // The id is never reused, but a stale list must not outlive its provider.
    await app.db.delete(settings).where(eq(settings.key, allowedDomainsKey(id)));
    void audit(app.db, req.user!.id, 'oidc_provider.delete', existing.name);
    return { ok: true };
  });

  // ── OIDC & OAuth2 Login Initiation ─────────────────────────────────────────
  const startOidc = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply, linking = false) => {
    const { slug } = req.params as { slug: string };
    const query = req.query as { returnTo?: string; json?: string; nonce?: string };
    const returnTo = query?.returnTo;
    const json = query?.json;
    // r505: the web's per-tab sign-in nonce, echoed back with the tokens.
    // Optional so a page loaded before the upgrade can still start a flow
    // (its tokens are then refused by the new SPA — see handleOidcCallback).
    const clientNonce = query?.nonce;
    if (clientNonce !== undefined && !CLIENT_NONCE_PATTERN.test(clientNonce)) throw badRequest('Invalid sign-in nonce');

    const provider = await app.db.query.oidcProviders.findFirst({
      where: and(eq(oidcProviders.slug, slug), eq(oidcProviders.enabled, true)),
    });
    if (!provider) throw notFound(`OAuth2/OIDC provider "${slug}" not found or disabled`);

    let link: import('../lib/oauth.js').OAuthLinkContext | undefined;
    if (linking) {
      const token = req.headers.authorization?.slice('Bearer '.length).trim() ?? '';
      const payload = await verifyJwt(token);
      const session = payload.jti ? await findLiveSession(app.db, payload.jti) : null;
      if (payload.type !== 'access' || !session || session.userId !== req.user!.id || payload.ver === undefined) {
        throw unauthorized('A live interactive session is required to link this provider');
      }
      link = { userId: req.user!.id, sessionJti: session.jti, tokenVersion: payload.ver, providerFingerprint: oauthProviderFingerprint(provider) };
    }
    const state = generateOAuthState(slug, returnTo, link, linking ? undefined : clientNonce);
    // Bind this flow to the browser that started it (see the cookie helpers).
    writeOidcStateCookie(req, reply, slug, state);
    const redirectUri = oidcRedirectUri(slug);

    let authUrl: string;
    if (slug === 'github' || (!provider.issuerUrl && slug.includes('github'))) {
      const params = new URLSearchParams({
        client_id: provider.clientId,
        redirect_uri: redirectUri,
        scope: provider.scopes,
        state,
      });
      authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;
    } else {
      if (!provider.issuerUrl) throw badRequest(`Provider "${slug}" is missing an issuer URL`);
      const oidcConfig = await fetchOidcConfiguration(provider.issuerUrl);
      // F856: discovery may omit authorization_endpoint (the callback needs only
      // token_endpoint); without this the browser was sent to "undefined?…".
      if (!oidcConfig.authorization_endpoint) {
        throw new HttpError(502, 'oidc_discovery_invalid', `OIDC discovery document for provider "${slug}" has no authorization_endpoint`);
      }
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: provider.clientId,
        redirect_uri: redirectUri,
        scope: provider.scopes,
        state,
      });
      authUrl = `${oidcConfig.authorization_endpoint}?${params.toString()}`;
    }

    if (linking) void audit(app.db, req.user!.id, 'auth.sso_link_started', provider.name);
    if (linking || json === 'true' || json === '1') {
      return { authUrl };
    }
    return reply.redirect(authUrl);
  };
  app.get('/oidc/:slug/login', async (req, reply) => startOidc(req, reply));
  app.post('/oidc/:slug/link', { onRequest: [app.authenticate, app.requireInteractive], config: { rateLimit: AUTH_LIMIT } }, async (req, reply) => startOidc(req, reply, true));

  // ── OIDC & OAuth2 Login Callback ───────────────────────────────────────────
  const handleOidcCallback = async (req: any, reply: any, isPost: boolean) => {
    const { slug } = req.params as { slug: string };
    const query = (isPost ? req.body : req.query) as { code?: string; state?: string; error?: string; error_description?: string };

    if (query.error) {
      throw unauthorized(query.error_description || query.error);
    }
    if (!query.code || !query.state) {
      throw badRequest('Missing OAuth code or state parameter');
    }

    const stateData = verifyOAuthState(query.state);
    if (!stateData || stateData.slug !== slug) {
      throw unauthorized('Invalid or expired OAuth state parameter');
    }

    const provider = await app.db.query.oidcProviders.findFirst({
      where: and(eq(oidcProviders.slug, slug), eq(oidcProviders.enabled, true)),
    });
    if (!provider) throw notFound(`OAuth2/OIDC provider "${slug}" not found or disabled`);
    // The signature proves the state is authentic; the cookie proves THIS
    // browser is the one that started the flow (login-CSRF defense). Runs
    // after the provider lookup so a deleted provider still answers 404.
    verifyOidcStateCookie(req, reply, slug, query.state);

    const clientSecret = decrypt(provider.clientSecretEncrypted);
    const redirectUri = oidcRedirectUri(slug);

    let userInfo: { sub: string; email: string; emailVerified: boolean; name?: string | null };

    if (slug === 'github' || (!provider.issuerUrl && slug.includes('github'))) {
      userInfo = await exchangeGitHubCode(provider.clientId, clientSecret, query.code, redirectUri);
    } else {
      if (!provider.issuerUrl) throw badRequest(`Provider "${slug}" is missing an issuer URL`);
      const oidcConfig = await fetchOidcConfiguration(provider.issuerUrl);
      const tokens = await exchangeOidcCode(oidcConfig.token_endpoint, provider.clientId, clientSecret, query.code, redirectUri);
      const userinfoEndpoint = oidcConfig.userinfo_endpoint || `${provider.issuerUrl.replace(/\/+$/, '')}/userinfo`;
      userInfo = await fetchOidcUserInfo(userinfoEndpoint, tokens.access_token);
    }

    // r507: refuse before resolveOAuthIdentity can create (auto-enroll) or
    // sign in anyone. Applies to every flow through this provider — a domain
    // list that only gated enrollment would still let an already-enrolled
    // outsider back in after the operator tightened it.
    const allowedDomains = await loadAllowedDomains(app.db, provider.id);
    if (!emailDomainAllowed(userInfo.email, allowedDomains)) {
      void audit(app.db, null, 'auth.sso_domain_refused', `${provider.name} (${userInfo.email})`);
      throw new HttpError(
        403,
        'sso_domain_not_allowed',
        `This sign-in provider only accepts accounts from: ${allowedDomains.join(', ')}`,
      );
    }
    const resolved = await resolveOAuthIdentity(app.db, provider, userInfo, stateData.link);
    const user = resolved.user;
    if (stateData.link) {
      void audit(app.db, user.id, 'auth.sso_link', provider.name);
      if (isPost) return { ok: true, linked: true };
      return reply.redirect(`${config.publicUrl}/settings?oidcLinked=1`);
    }
    if (resolved.created) {
      const roleForFirstWorkspace: WorkspaceRole = resolved.firstUser ? 'owner' : (provider.defaultRole as WorkspaceRole);
      await ensureDefaultWorkspaceWithRole(app.db, user, roleForFirstWorkspace);
    }
    // For users who already existed (no auto-enroll block above) we still
    // make sure they have a personal workspace, in case one was wiped.
    await ensureDefaultWorkspace(app.db, user);
    // Only this provider-verified email may auto-accept invitations.
    const joined = await acceptInvitationsForUser(app.db, { id: user.id, email: user.email, emailVerified: userInfo.emailVerified && normalizeEmail(user.email) === normalizeEmail(userInfo.email) });
    for (const w of joined) void audit(app.db, user.id, 'workspace.invitation.accept', `auto-accept ${w.email} → workspace #${w.workspaceId} as ${w.role}`);

    const tokens = await issueSessionTokens(app.db, user, { ip: req.ip, userAgent: req.headers['user-agent'] });
    void audit(app.db, user.id, 'auth.sso_login', `${provider.name} (${userInfo.email})`, undefined, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    if (isPost) {
      return { user: toUser(user, await isOperator(app.db, user)), tokens };
    }

    // Redirect browser with tokens in hash fragment. The returnTo target must
    // stay same-origin: a protocol-relative "//evil.com" (or "/\evil.com",
    // which browsers normalize the same way) passes a naive startsWith('/')
    // check and would carry the tokens in the fragment to the attacker's site.
    const rawReturnTo = stateData.returnTo;
    const returnToSafe = (() => {
      if (typeof rawReturnTo !== 'string') return false;
      const hasUnsafeCharacter = [...rawReturnTo].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f || character === '\\';
      });
      if (hasUnsafeCharacter) return false;
      try {
        // Resolve against the configured public URL, never the request Host.
        // This rejects protocol-relative paths as well as parser quirks such
        // as `/\t/evil.example` that browsers normalize into another origin.
        return new URL(rawReturnTo, config.publicUrl).origin === new URL(config.publicUrl).origin;
      } catch {
        return false;
      }
    })();
    const returnTo = returnToSafe ? rawReturnTo : '/';
    // r505: a flow the web started with a nonce lands on the SPA's dedicated
    // callback route, which takes tokens from the fragment ONLY there and only
    // when the nonce matches the one this tab stored. A flow without one (a
    // page loaded before the upgrade) keeps the old redirect; the new SPA
    // refuses those tokens and asks the user to sign in again.
    if (stateData.clientNonce) {
      const fragment = new URLSearchParams({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        nonce: stateData.clientNonce,
        return_to: returnTo,
      });
      return reply.redirect(`/auth/callback#${fragment.toString()}`);
    }
    return reply.redirect(`${returnTo}#access_token=${tokens.accessToken}&refresh_token=${tokens.refreshToken}`);
  };

  app.get('/oidc/:slug/callback', async (req, reply) => handleOidcCallback(req, reply, false));
  app.post('/oidc/:slug/callback', async (req, reply) => handleOidcCallback(req, reply, true));
};
