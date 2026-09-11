import { and, count, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { apiTokens, type DB, oidcProviders, type OidcProvider, sessions as sessionsTable, users, webauthnCredentials, type User } from '@ninedeploy/db';
import type { PublicUser, Register } from '@ninedeploy/schemas';
import { createApiToken, forgotPassword, login, oidcProviderCreate, oidcProviderUpdate, type OidcProviderEntry, type OidcPublicProvider, passkeyLoginVerify, passkeyRegisterVerify, passwordChange, passwordResetWithToken, refresh, register, twoFactorCode, twoFactorDisable, twoFactorSetup } from '@ninedeploy/schemas';
import { config } from '../config.js';
import { decrypt, encrypt, hashPassword, randomToken, secretEquals, sha256, verifyPassword } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound, parseId, unauthorized } from '../lib/errors.js';
import { verifyJwt, type AppJwtPayload } from '../lib/jwt.js';
import { isLocked, recordFailure, recordSuccess } from '../lib/loginLockout.js';
import { consumeResetToken, issueResetToken } from '../lib/passwordReset.js';
import { sendSystemEmail } from '../lib/notifier.js';
import { generateSecret, otpauthUri } from '../lib/totp.js';
import { consumeTotpCode } from '../lib/totpReplay.js';
import { audit } from '../lib/audit.js';
import { getSetting } from '../lib/settings.js';
import { findLiveSession, issueSessionTokens, refreshSessionTokens, revokeAllSessions } from '../lib/sessions.js';
import { beginAuthentication, beginRegistration, finishAuthentication, finishRegistration } from '../lib/webauthn.js';
import { exchangeGitHubCode, exchangeOidcCode, fetchOidcConfiguration, fetchOidcUserInfo, generateOAuthState, verifyOAuthState } from '../lib/oauth.js';
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

function serializeOidc(p: OidcProvider): OidcProviderEntry {
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
    const passwordHash = await hashPassword(input.password);
    const [user] = await tx
      .insert(users)
      // The bootstrap user is the only account that receives the
      // instance-operator flag automatically. Everyone else must be granted it
      // by an existing operator (PATCH /v1/users/:id/operator) — creating a
      // workspace does NOT confer it (see lib/resourceAccess.ts:isOperator).
      .values({ email: input.email, passwordHash, name: input.name ?? null, isInstanceOperator: true })
      .returning();
    if (!user) throw badRequest('Could not create user');
    // …and gets a personal workspace so the team surfaces have somewhere to
    // start. The workspace role is unrelated to the operator flag above.
    await ensureDefaultWorkspace(tx, user);
    return { user: toUser(user, true), tokens: await issueSessionTokens(tx, user), rawUser: user };
  });
  const joined = await acceptInvitationsForUser(db, { id: result.rawUser.id, email: result.rawUser.email });
  for (const w of joined) void audit(db, result.rawUser.id, 'workspace.invitation.accept', `auto-accept ${w.email} → workspace #${w.workspaceId} as ${w.role}`);
  return { user: result.user, tokens: result.tokens };
}

/** Register a user. The first user gets a personal workspace; everyone else
 *  lands without any until invited into one. */
export async function registerAccount(db: DB, input: Register) {
  // Same transactional guard as the bootstrap: the count-then-insert race
  // between two simultaneous first registrations must not create two users.
  const result = await db.transaction(async (tx) => {
    const isFirst = (await userCount(tx)) === 0;
    const passwordHash = await hashPassword(input.password);
    let user: User | undefined;
    try {
      [user] = await tx
        .insert(users)
        // Only the very first registration on an empty instance is an
        // operator; open registration must never mint one.
        .values({ email: input.email, passwordHash, name: input.name ?? null, isInstanceOperator: isFirst })
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
  const joined = await acceptInvitationsForUser(db, { id: result.rawUser.id, email: result.rawUser.email });
  for (const w of joined) void audit(db, result.rawUser.id, 'workspace.invitation.accept', `auto-accept ${w.email} → workspace #${w.workspaceId} as ${w.role}`);
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
    if (!user || !(await verifyPassword(user.passwordHash, input.password))) {
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
    recordSuccess(input.email);
    // Auto-accept any pending workspace invitations for this email so a user
    // who created their account to redeem an invite lands inside that
    // workspace without re-clicking the link.
    const joined = await acceptInvitationsForUser(app.db, { id: user.id, email: user.email });
    for (const w of joined) void audit(app.db, user.id, 'workspace.invitation.accept', `auto-accept ${w.email} → workspace #${w.workspaceId} as ${w.role}`);
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
    await app.db
      .delete(webauthnCredentials)
      .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, req.user!.id)));
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
    const cred = await app.db.query.webauthnCredentials.findFirst({
      where: eq(webauthnCredentials.credentialId, id),
    });
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
    const user = await app.db.query.users.findFirst({ where: eq(users.id, cred.userId) });
    if (!user) throw unauthorized();
    const joined = await acceptInvitationsForUser(app.db, { id: user.id, email: user.email });
    for (const w of joined) void audit(app.db, user.id, 'workspace.invitation.accept', `auto-accept ${w.email} → workspace #${w.workspaceId} as ${w.role}`);
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
    await app.db
      .update(sessionsTable)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessionsTable.id, id), eq(sessionsTable.userId, req.user!.id)));
    void audit(app.db, req.user!.id, 'auth.session_revoked', undefined, { id });
    return { ok: true };
  });

  // ── Two-factor (TOTP) setup / enable / disable ───────────────────────────
  // Setup generates (or regenerates) a pending secret + otpauth URI; enable
  // verifies a code from the user's authenticator and flips the flag; disable
  // requires the password AND a valid code, then bumps tokenVersion.
  app.post('/2fa/setup', { onRequest: [app.authenticate, app.requireInteractive], config: { rateLimit: AUTH_LIMIT } }, async (req) => {
    const user = await app.db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
    if (!user) throw unauthorized();
    // Regenerating the secret also flips totpEnabled off — when 2FA is active
    // this must not be reachable with a bare token: require the password.
    if (user.totpEnabled) {
      const input = twoFactorSetup.parse(req.body ?? {});
      if (!(await verifyPassword(user.passwordHash, input.password))) throw unauthorized('Invalid password');
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
    const input = twoFactorCode.parse(req.body);
    const user = await app.db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
    if (!user?.totpSecretEncrypted) throw badRequest('Start 2FA setup first');
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
      await sendSystemEmail(
        app.db,
        user.email,
        'NineDeploy password reset',
        `A password reset was requested for ${input.email}.\n\nOpen this link within 30 minutes to set a new password:\n${link}\n\nIf you did not request this, you can ignore this email.`,
      ).catch(() => false);
      void audit(app.db, user.id, 'auth.forgot_password', user.email);
    }
    return { ok: true };
  });

  // Complete a reset: consume the single-use token, set the new password, and
  // revoke every outstanding session (tokenVersion bump).
  app.post('/reset-password', { config: { rateLimit: AUTH_LIMIT } }, async (req) => {
    const input = passwordResetWithToken.parse(req.body);
    const user = await consumeResetToken(app.db, input.token, input.newPassword);
    await revokeAllSessions(app.db, user.id);
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
    await revokeAllSessions(app.db, user.id);
    return { user: toUser(updated, await isOperator(app.db, updated)), tokens: await issueSessionTokens(app.db, updated, { ip: req.ip, userAgent: req.headers['user-agent'] }) };
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
    await app.db.delete(apiTokens).where(and(eq(apiTokens.id, id), eq(apiTokens.userId, req.user!.id)));
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
    return rows.map(serializeOidc);
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

    void audit(app.db, req.user!.id, 'oidc_provider.create', created!.name);
    return serializeOidc(created!);
  });

  app.patch('/oidc/providers/:id', { onRequest: [app.authenticate, app.requireAdmin] }, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const input = oidcProviderUpdate.parse(req.body);

    const existing = await app.db.query.oidcProviders.findFirst({ where: eq(oidcProviders.id, id) });
    if (!existing) throw notFound('OIDC provider not found');

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
      })
      .where(eq(oidcProviders.id, id))
      .returning();

    void audit(app.db, req.user!.id, 'oidc_provider.update', updated!.name);
    return serializeOidc(updated!);
  });

  app.delete('/oidc/providers/:id', { onRequest: [app.authenticate, app.requireAdmin] }, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const existing = await app.db.query.oidcProviders.findFirst({ where: eq(oidcProviders.id, id) });
    if (!existing) throw notFound('OIDC provider not found');

    await app.db.delete(oidcProviders).where(eq(oidcProviders.id, id));
    void audit(app.db, req.user!.id, 'oidc_provider.delete', existing.name);
    return { ok: true };
  });

  // ── OIDC & OAuth2 Login Initiation ─────────────────────────────────────────
  app.get('/oidc/:slug/login', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const query = req.query as { returnTo?: string; json?: string };
    const returnTo = query?.returnTo;
    const json = query?.json;

    const provider = await app.db.query.oidcProviders.findFirst({
      where: and(eq(oidcProviders.slug, slug), eq(oidcProviders.enabled, true)),
    });
    if (!provider) throw notFound(`OAuth2/OIDC provider "${slug}" not found or disabled`);

    const state = generateOAuthState(slug, returnTo);
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
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: provider.clientId,
        redirect_uri: redirectUri,
        scope: provider.scopes,
        state,
      });
      authUrl = `${oidcConfig.authorization_endpoint}?${params.toString()}`;
    }

    if (json === 'true' || json === '1') {
      return { authUrl };
    }
    return reply.redirect(authUrl);
  });

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

    let user = await app.db.query.users.findFirst({
      where: sql`lower(${users.email}) = lower(${userInfo.email})`,
    });
    if (userInfo.emailVerified === false) {
      // Never admit an unverified (e.g. synthetic-namespace or unconfirmed
      // secondary) SSO identity, in either direction: linking it to a
      // pre-existing local account would let an attacker who pre-registered
      // the address silently share the real SSO user's account, and
      // auto-enrolling it would let the attacker claim the address outright —
      // including auto-accepting workspace invitations sent to the victim.
      // Refusing (fail closed) turns both into, at worst, a denial of service.
      throw forbidden('SSO email address is not verified; refusing to link or auto-enroll an account');
    }
    if (!user) {
      if (!provider.autoEnroll) {
        throw forbidden('Auto-enrollment is disabled for this SSO provider');
      }
      const randomPassword = randomToken(32);
      const passwordHash = await hashPassword(randomPassword);
      // Legacy `users.role` was dropped: the new model only knows workspace
      // membership. The provider's `defaultRole` is the workspace role we'll
      // grant this user in their auto-created personal workspace.
      const firstUser = (await userCount(app.db)) === 0;

      const [created] = await app.db
        .insert(users)
        .values({
          email: userInfo.email,
          passwordHash,
          name: userInfo.name ?? null,
          // Same bootstrap rule as /auth/register: only the very first account
          // on an empty instance becomes an instance operator. A provider's
          // `defaultRole` is a WORKSPACE role and must never mint one — that
          // would hand instance-wide control to whoever the IdP admits.
          isInstanceOperator: firstUser,
        })
        .returning();

      user = created!;
      // Auto-create a personal workspace with the SSO user's chosen role. The
      // first user on the instance always becomes 'owner' (operator), every
      // subsequent SSO login gets the provider's configured default role.
      const roleForFirstWorkspace: WorkspaceRole = firstUser
        ? 'owner'
        : (provider.defaultRole as WorkspaceRole);
      await ensureDefaultWorkspaceWithRole(app.db, user, roleForFirstWorkspace);
    }

    // For users who already existed (no auto-enroll block above) we still
    // make sure they have a personal workspace, in case one was wiped.
    await ensureDefaultWorkspace(app.db, user);
    // Pull the user into any pending invitations addressed to their email —
    // an SSO account is the same shape as a password one from the workspace's
    // perspective, so the join-on-first-login flow is the same.
    const joined = await acceptInvitationsForUser(app.db, { id: user.id, email: user.email });
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
    return reply.redirect(`${returnTo}#access_token=${tokens.accessToken}&refresh_token=${tokens.refreshToken}`);
  };

  app.get('/oidc/:slug/callback', async (req, reply) => handleOidcCallback(req, reply, false));
  app.post('/oidc/:slug/callback', async (req, reply) => handleOidcCallback(req, reply, true));
};
