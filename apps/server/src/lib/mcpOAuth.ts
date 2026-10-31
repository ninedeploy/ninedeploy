import { createHash } from 'node:crypto';
import { and, eq, like, lt } from 'drizzle-orm';
import { apiTokens, settings, type DB } from '@ninedeploy/db';
import { randomToken, secretEquals, sha256 } from './crypto.js';
import { MCP_TOKEN_PREFIX } from './mcpAudience.js';
import { getSettingJson, setSettingJson } from './settings.js';

/**
 * R4 remote MCP: the OAuth 2.1 authorization server the MCP authorization
 * spec asks for (public clients, PKCE S256, dynamic client registration,
 * refresh-token rotation, revocation).
 *
 * An access token is an `api_tokens` row of its user whose raw value starts
 * with `ndmcp_`. That reuses the token checks the API already has (expiry,
 * row deletion as revocation, coarse `read` scope), and the user sees each
 * grant in Settings → Security → API tokens, where deleting it ends the
 * grant: its refresh token then fails. `resolveUser` accepts an `ndmcp_`
 * token only for the MCP endpoint and the tool calls it makes (audience).
 *
 * Storage needs no migration: clients and refresh tokens are settings rows,
 * authorization codes live in memory for a minute.
 */

const REFRESH_PREFIX = 'ndmcpr_';
export const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 30 * 24 * 3600_000;
const CODE_TTL_MS = 60_000;
const CLIENT_KEY = 'oauth_client:';
const REFRESH_KEY = 'oauth_refresh:';
/** Registration is anonymous (the spec's dynamic registration): a hard ceiling on what it can store. */
export const MAX_CLIENTS = 500;
/** A client no grant has used within this long is removed by the sweep. */
const UNUSED_CLIENT_MS = 24 * 3600_000;

export type McpAccess = 'read' | 'full';

export interface OAuthClient {
  name: string;
  redirectUris: string[];
  createdAt: number;
  lastUsedAt: number | null;
}

interface RefreshRow {
  tokenId: number;
  clientId: string;
  userId: number;
  expiresAt: number;
}

/** The address a client is sent back to: https, or http on the loopback (native apps, RFC 8252). */
export function redirectUriAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

export async function registerClient(db: DB, name: string, redirectUris: string[], now = Date.now()): Promise<{ clientId: string; client: OAuthClient }> {
  const rows = await db.select().from(settings).where(like(settings.key, `${CLIENT_KEY}%`));
  if (rows.length >= MAX_CLIENTS) {
    // Full: make room by dropping the oldest client that never completed a sign-in, so anonymous
    // registrations cannot lock real clients out; clients in use are never dropped.
    const unused = rows
      .map((r) => ({ key: r.key, c: storedValue<OAuthClient>(r.value) }))
      .filter((r) => !r.c || r.c.lastUsedAt === null)
      .sort((a, b) => (a.c?.createdAt ?? 0) - (b.c?.createdAt ?? 0));
    if (!unused[0]) throw new Error('too_many_clients');
    await db.delete(settings).where(eq(settings.key, unused[0].key));
  }
  const clientId = `ndc_${randomToken(16)}`;
  const client: OAuthClient = { name, redirectUris, createdAt: now, lastUsedAt: null };
  await setSettingJson(db, `${CLIENT_KEY}${clientId}`, client);
  return { clientId, client };
}

export async function getClient(db: DB, clientId: string): Promise<OAuthClient | null> {
  if (!/^ndc_[A-Za-z0-9_-]{10,40}$/.test(clientId)) return null;
  return getSettingJson<OAuthClient>(db, `${CLIENT_KEY}${clientId}`, null);
}

// ── authorization codes (in memory, single use) ─────────────────────────────

interface CodeGrant {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: number;
  access: McpAccess;
  resource: string;
  expiresAt: number;
}
const codes = new Map<string, CodeGrant>();

export function issueCode(grant: Omit<CodeGrant, 'expiresAt'>, now = Date.now()): string {
  for (const [k, v] of codes) if (v.expiresAt < now) codes.delete(k);
  if (codes.size >= 1000) throw new Error('Too many pending authorizations; try again in a minute');
  const code = randomToken(32);
  codes.set(sha256(code), { ...grant, expiresAt: now + CODE_TTL_MS });
  return code;
}

/** Take a code once. Returns null when unknown, spent or expired. */
export function takeCode(code: string, now = Date.now()): CodeGrant | null {
  const key = sha256(code);
  const grant = codes.get(key);
  codes.delete(key);
  return grant && grant.expiresAt >= now ? grant : null;
}

export function resetCodes(): void {
  codes.clear();
}

/** PKCE S256: base64url(sha256(verifier)) equals the challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return secretEquals(createHash('sha256').update(verifier).digest('base64url'), challenge);
}

// ── tokens ──────────────────────────────────────────────────────────────────

export interface TokenSet {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

const scopeOf = (access: McpAccess) => (access === 'read' ? 'mcp:read' : 'mcp:full');
const scopesFor = (access: McpAccess) => (access === 'read' ? ['read'] : []);

async function newRefresh(db: DB, row: Omit<RefreshRow, 'expiresAt'>, now: number): Promise<string> {
  const refresh = `${REFRESH_PREFIX}${randomToken(32)}`;
  await setSettingJson<RefreshRow>(db, `${REFRESH_KEY}${sha256(refresh)}`, { ...row, expiresAt: now + REFRESH_TTL_MS });
  return refresh;
}

/** A code exchanged: a new grant (an api_tokens row) and its first refresh token. */
export async function issueTokens(db: DB, grant: CodeGrant, clientName: string, now = Date.now()): Promise<TokenSet> {
  const access = `${MCP_TOKEN_PREFIX}${randomToken(32)}`;
  const [row] = await db
    .insert(apiTokens)
    .values({
      userId: grant.userId,
      name: `MCP: ${clientName}`.slice(0, 100),
      hash: sha256(access),
      scopes: scopesFor(grant.access),
      expiresAt: new Date(now + ACCESS_TTL_S * 1000),
    })
    .returning({ id: apiTokens.id });
  if (!row) throw new Error('Could not issue the token');
  const refresh = await newRefresh(db, { tokenId: row.id, clientId: grant.clientId, userId: grant.userId }, now);
  await touchClient(db, grant.clientId, now);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopeOf(grant.access) };
}

async function touchClient(db: DB, clientId: string, now: number): Promise<void> {
  const client = await getClient(db, clientId);
  if (client) await setSettingJson(db, `${CLIENT_KEY}${clientId}`, { ...client, lastUsedAt: now });
}

/**
 * Rotate a refresh token: the grant's row gets a new access token and expiry,
 * the old refresh token is spent. Null when the refresh token is unknown,
 * expired, another client's, or its grant was revoked (row deleted).
 */
export async function refreshTokens(db: DB, refresh: string, clientId: string, now = Date.now()): Promise<TokenSet | null> {
  if (!refresh.startsWith(REFRESH_PREFIX)) return null;
  const key = `${REFRESH_KEY}${sha256(refresh)}`;
  const row = await getSettingJson<RefreshRow>(db, key, null);
  if (!row) return null;
  // Spent either way: a refresh token is single use.
  await db.delete(settings).where(eq(settings.key, key));
  if (row.clientId !== clientId || row.expiresAt < now) return null;
  const grant = await db.query.apiTokens.findFirst({ where: and(eq(apiTokens.id, row.tokenId), eq(apiTokens.userId, row.userId)) });
  if (!grant) return null;
  const access = `${MCP_TOKEN_PREFIX}${randomToken(32)}`;
  await db.update(apiTokens).set({ hash: sha256(access), expiresAt: new Date(now + ACCESS_TTL_S * 1000) }).where(eq(apiTokens.id, grant.id));
  const next = await newRefresh(db, { tokenId: grant.id, clientId, userId: row.userId }, now);
  await touchClient(db, clientId, now);
  const scopes = Array.isArray(grant.scopes) ? grant.scopes : [];
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: next, scope: scopeOf(scopes.includes('read') ? 'read' : 'full') };
}

/** RFC 7009: end the grant behind an access or refresh token. Unknown tokens are not an error. */
/** Revoke an access or refresh token. Answers whose grant it was, or null when it was unknown. */
export async function revokeToken(db: DB, token: string): Promise<number | null> {
  if (token.startsWith(MCP_TOKEN_PREFIX)) {
    const gone = await db.delete(apiTokens).where(eq(apiTokens.hash, sha256(token))).returning({ userId: apiTokens.userId });
    return gone[0]?.userId ?? null;
  }
  if (!token.startsWith(REFRESH_PREFIX)) return null;
  const key = `${REFRESH_KEY}${sha256(token)}`;
  const row = await getSettingJson<RefreshRow>(db, key, null);
  await db.delete(settings).where(eq(settings.key, key));
  if (!row) return null;
  await db.delete(apiTokens).where(and(eq(apiTokens.id, row.tokenId), eq(apiTokens.userId, row.userId)));
  return row.userId;
}

/** A settings value as stored (json mode) or as text; null when it cannot be read. */
function storedValue<T>(v: unknown): T | null {
  if (v !== null && typeof v === 'object') return v as T;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return null;
  }
}

/**
 * Housekeeping: expired refresh tokens and the grants left with none (once
 * their access token has expired too), and registered clients no grant ever
 * used after a day. Returns the rows removed.
 */
export async function sweepMcpOAuth(db: DB, now = Date.now()): Promise<number> {
  let removed = 0;
  for (const r of await db.select().from(settings).where(like(settings.key, `${REFRESH_KEY}%`))) {
    const row = storedValue<RefreshRow>(r.value);
    if (row && row.expiresAt >= now) continue;
    await db.delete(settings).where(eq(settings.key, r.key));
    removed++;
    if (row) {
      const gone = await db.delete(apiTokens).where(and(eq(apiTokens.id, row.tokenId), lt(apiTokens.expiresAt, new Date(now)))).returning({ id: apiTokens.id });
      removed += gone.length;
    }
  }
  for (const r of await db.select().from(settings).where(like(settings.key, `${CLIENT_KEY}%`))) {
    const c = storedValue<OAuthClient>(r.value);
    if (c && (c.lastUsedAt !== null || now - c.createdAt < UNUSED_CLIENT_MS)) continue;
    await db.delete(settings).where(eq(settings.key, r.key));
    removed++;
  }
  return removed;
}
