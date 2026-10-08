import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { githubAppInstallations, type DB, type GithubApp, type GithubAppInstallation } from '@ninedeploy/db';
import { audit } from './audit.js';
import { decrypt } from './crypto.js';
import { guardedFetch, privateEgressAllowed } from './egressGuard.js';
import { redactSecrets } from './redactSecret.js';

/**
 * GitHub App client (0.13): the App JWT, installation access tokens and a
 * small REST helper. Every outbound call goes through `guardedFetch`, and no
 * message this module throws carries the private key, the App JWT or an
 * installation token.
 *
 * Installation tokens live in this process's memory only — they are never
 * written to the database, a log or an audit entry.
 */

/** The `github_apps` columns this module reads. */
export type GithubAppRef = Pick<GithubApp, 'id' | 'appId' | 'privateKeyEncrypted' | 'apiBaseUrl' | 'updatedAt'>;
/** The `github_app_installations` columns this module reads. */
export type GithubInstallationRef = Pick<GithubAppInstallation, 'id' | 'githubAppId' | 'installationId'> &
  Partial<Pick<GithubAppInstallation, 'suspendedAt' | 'removedAt' | 'accountLogin'>>;

export type GithubAppErrorReason =
  | 'bad_key'
  | 'bad_base_url'
  | 'unreachable'
  | 'removed'
  | 'suspended'
  | 'forbidden'
  | 'not_accessible'
  | 'not_found'
  | 'host_mismatch'
  | 'bad_repo_url'
  | 'no_installation'
  | 'http';

/** A GitHub App failure whose message is safe to log, store and return. */
export class GithubAppError extends Error {
  constructor(
    message: string,
    readonly reason: GithubAppErrorReason,
    /** The HTTP status GitHub answered with; 0 when no answer arrived. */
    readonly status = 0,
  ) {
    super(message);
    this.name = 'GithubAppError';
  }
}

// ── App JWT ────────────────────────────────────────────────────────────────

/** GitHub refuses a JWT whose lifetime exceeds 10 minutes; 60 s back-dating absorbs clock drift. */
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 540;

interface CachedKey {
  updatedAt: number;
  ciphertext: string;
  key: KeyObject;
}
/** Parsed private keys per App row, valid while `(updatedAt, ciphertext)` is unchanged. */
const keyCache = new Map<number, CachedKey>();

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function appPrivateKey(app: GithubAppRef): KeyObject {
  const updatedAt = app.updatedAt.getTime();
  const hit = keyCache.get(app.id);
  // The ciphertext is part of the key: a rotation within the same second as the
  // cached load (updated_at has 1 s resolution) still re-reads the key.
  if (hit && hit.updatedAt === updatedAt && hit.ciphertext === app.privateKeyEncrypted) return hit.key;
  let key: KeyObject;
  try {
    // Accepts GitHub's PKCS#1 (`BEGIN RSA PRIVATE KEY`) as well as PKCS#8.
    key = createPrivateKey({ key: decrypt(app.privateKeyEncrypted), format: 'pem' });
  } catch {
    // Node's parse errors do not echo the PEM, but nothing of it is repeated here either.
    throw new GithubAppError(`GitHub App #${app.id}: the stored private key could not be read as a PEM private key`, 'bad_key');
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new GithubAppError(`GitHub App #${app.id}: the private key is not an RSA key (GitHub signs App JWTs with RS256)`, 'bad_key');
  }
  keyCache.set(app.id, { updatedAt, ciphertext: app.privateKeyEncrypted, key });
  return key;
}

/** An RS256 App JWT (`iss` = the App id), valid for 9 minutes. */
export function appJwt(app: GithubAppRef, now: number = Date.now()): string {
  const key = appPrivateKey(app);
  const seconds = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: seconds - JWT_BACKDATE_S, exp: seconds + JWT_LIFETIME_S, iss: app.appId }));
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${b64url(signature)}`;
}

// ── REST helper ────────────────────────────────────────────────────────────

const API_TIMEOUT_MS = 15_000;
const GITHUB_API_VERSION = '2022-11-28';

/**
 * The App's API base as a URL, refused unless it is https (http only when
 * NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1, for a lab GHES). `guardedFetch` then
 * refuses a private address on top of this.
 */
export function apiBase(app: Pick<GithubApp, 'apiBaseUrl'>): string {
  let url: URL;
  try {
    url = new URL(app.apiBaseUrl);
  } catch {
    throw new GithubAppError('The GitHub App API base URL is not a valid URL', 'bad_base_url');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateEgressAllowed())) {
    throw new GithubAppError(
      `The GitHub App API base URL must use https (http is allowed only with NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1), got ${url.protocol}//${url.host}`,
      'bad_base_url',
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new GithubAppError('The GitHub App API base URL must not carry credentials, a query or a fragment', 'bad_base_url');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export interface GithubApiResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

/** GitHub's `message` field, or a status line — never the request. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body?.message === 'string' && body.message) return body.message.slice(0, 300);
  } catch {
    /* not JSON */
  }
  return `HTTP ${res.status}`;
}

/**
 * One GitHub REST call through the egress guard. `token` is the App JWT or an
 * installation token; `path` starts with `/` and is appended to the App's
 * API base. Redirects are not followed (`guardedFetch` is `redirect: manual`).
 * Non-2xx answers throw a `GithubAppError` carrying the status.
 */
export async function githubApi<T = unknown>(
  app: Pick<GithubApp, 'apiBaseUrl'>,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<GithubApiResponse<T>> {
  if (!path.startsWith('/')) throw new GithubAppError('GitHub API path must start with /', 'http');
  const url = `${apiBase(app)}${path}`;
  const label = `GitHub API ${method} ${path.split('?')[0]}`;
  let res: Response;
  try {
    res = await guardedFetch(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'NineDeploy',
        'x-github-api-version': GITHUB_API_VERSION,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GithubAppError(`${label} unreachable: ${redactSecrets(err, [token])}`, 'unreachable');
  }
  if (res.status >= 300 && res.status < 400) {
    throw new GithubAppError(`${label} answered with a redirect (HTTP ${res.status}), which is not followed`, 'http', res.status);
  }
  if (!res.ok) {
    const detail = redactSecrets(await errorDetail(res), [token]);
    const reason: GithubAppErrorReason = res.status === 404 ? 'not_found' : res.status === 403 ? 'forbidden' : 'http';
    throw new GithubAppError(`${label} failed (HTTP ${res.status}): ${detail}`, reason, res.status);
  }
  let data: unknown = null;
  if (res.status !== 204) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }
  return { status: res.status, data: data as T, headers: res.headers };
}

/** Whether a `Link` header announces another page. */
export function hasNextPage(headers: Headers): boolean {
  return /<[^>]*>\s*;\s*rel="next"/.test(headers.get('link') ?? '');
}

/**
 * Follow a paginated GET while GitHub's `Link` header says there is a next
 * page, up to `maxPages`. Page URLs are built here (`page=N`), never taken
 * from the response, so the token only ever goes to the App's own API base.
 */
export async function githubApiPages<T, R>(
  app: Pick<GithubApp, 'apiBaseUrl'>,
  token: string,
  path: string,
  pick: (data: T) => R[],
  opts: { perPage?: number; maxPages?: number } = {},
): Promise<{ rows: R[]; truncated: boolean }> {
  const perPage = opts.perPage ?? 100;
  const maxPages = opts.maxPages ?? 10;
  const sep = path.includes('?') ? '&' : '?';
  const rows: R[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await githubApi<T>(app, token, 'GET', `${path}${sep}per_page=${perPage}&page=${page}`);
    rows.push(...pick(res.data));
    if (!hasNextPage(res.headers)) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/** The repository fields NineDeploy reads from GitHub. */
export interface GithubRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  clone_url: string;
  default_branch: string;
  archived?: boolean;
  owner?: { login: string };
}

/** `GET /installation/repositories` (installation token), every page up to `maxPages`. */
export async function listInstallationRepositories(
  app: Pick<GithubApp, 'apiBaseUrl'>,
  token: string,
  opts: { maxPages?: number } = {},
): Promise<{ repositories: GithubRepository[]; truncated: boolean }> {
  const { rows, truncated } = await githubApiPages<{ repositories?: GithubRepository[] }, GithubRepository>(
    app,
    token,
    '/installation/repositories',
    (data) => (Array.isArray(data?.repositories) ? data.repositories : []),
    { maxPages: opts.maxPages ?? 10 },
  );
  return { repositories: rows, truncated };
}

// ── Installation tokens ────────────────────────────────────────────────────

/** A cached token is reused until this long before GitHub's `expires_at`. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

interface CachedToken {
  token: string;
  expiresAt: number;
  installationRowId: number;
}
const tokenCache = new Map<string, CachedToken>();

export interface InstallationTokenOptions {
  /** Scope the token to these repositories; omitted = every repository the installation can see. */
  repositoryIds?: readonly number[];
  /** Narrow the token's permissions (e.g. `{ contents: 'read' }`); omitted = everything granted. */
  permissions?: Readonly<Record<string, string>>;
  /** Clock override for tests. */
  now?: number;
}

function tokenCacheKey(inst: GithubInstallationRef, opts: InstallationTokenOptions): string {
  const repos = opts.repositoryIds ? [...new Set(opts.repositoryIds)].sort((a, b) => a - b).join(',') : '*';
  const perms = opts.permissions
    ? Object.entries(opts.permissions)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
    : '*';
  return `${inst.githubAppId}:${inst.id}:${inst.installationId}|${repos}|${perms}`;
}

function evictInstallation(installationRowId: number): void {
  for (const [key, entry] of tokenCache) if (entry.installationRowId === installationRowId) tokenCache.delete(key);
}

/** Drop every cached token (tests, key rotation). */
export function clearGithubAppCaches(): void {
  tokenCache.clear();
  keyCache.clear();
}

async function markInstallation(db: DB, inst: GithubInstallationRef, state: 'removed' | 'suspended'): Promise<void> {
  evictInstallation(inst.id);
  const now = new Date();
  try {
    const column = state === 'removed' ? githubAppInstallations.removedAt : githubAppInstallations.suspendedAt;
    const changed = await db
      .update(githubAppInstallations)
      .set(state === 'removed' ? { removedAt: now } : { suspendedAt: now })
      .where(and(eq(githubAppInstallations.id, inst.id), isNull(column)))
      .returning({ id: githubAppInstallations.id });
    if (changed.length > 0) {
      // Discovered by the panel, not done by a user: a null actor (operators only).
      await audit(db, null, `github_installation.${state}`, inst.accountLogin ?? `installation#${inst.installationId}`, {
        installationRowId: inst.id,
        installationId: inst.installationId,
        githubAppId: inst.githubAppId,
        detectedBy: 'token',
      });
    }
  } catch {
    /* the refusal below is what matters; the row catches up on the next sync or webhook */
  }
}

/**
 * An installation access token, from the in-memory cache while it has more
 * than 5 minutes left, else freshly minted with
 * `POST /app/installations/{id}/access_tokens`. Each distinct
 * `(installation, repositories, permissions)` scope has its own cache entry.
 *
 * A 404 marks the installation removed; a 403 for a suspended installation
 * marks it suspended. Both evict its cached tokens.
 */
export async function installationToken(
  db: DB,
  app: GithubAppRef,
  inst: GithubInstallationRef,
  opts: InstallationTokenOptions = {},
): Promise<string> {
  if (inst.githubAppId !== app.id) {
    throw new GithubAppError(`Installation #${inst.id} does not belong to GitHub App #${app.id}`, 'no_installation');
  }
  const now = opts.now ?? Date.now();
  const key = tokenCacheKey(inst, opts);
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) return hit.token;
  tokenCache.delete(key);

  const jwt = appJwt(app, now);
  const body: Record<string, unknown> = {};
  if (opts.repositoryIds) body['repository_ids'] = [...new Set(opts.repositoryIds)];
  if (opts.permissions) body['permissions'] = { ...opts.permissions };
  const who = inst.accountLogin ? `${inst.accountLogin} (installation ${inst.installationId})` : `installation ${inst.installationId}`;
  let res: GithubApiResponse<{ token?: unknown; expires_at?: unknown }>;
  try {
    res = await githubApi(app, jwt, 'POST', `/app/installations/${inst.installationId}/access_tokens`, body);
  } catch (err) {
    if (!(err instanceof GithubAppError)) throw new GithubAppError(redactSecrets(err, [jwt]), 'http');
    if (err.status === 404) {
      await markInstallation(db, inst, 'removed');
      throw new GithubAppError(
        `The GitHub App installation on ${who} no longer exists (it was uninstalled). Reinstall the App and link the service again.`,
        'removed',
        404,
      );
    }
    if (err.status === 403 && /suspend/i.test(err.message)) {
      await markInstallation(db, inst, 'suspended');
      throw new GithubAppError(
        `The GitHub App installation on ${who} is suspended. Unsuspend it in the account's GitHub settings (Installed GitHub Apps → Configure).`,
        'suspended',
        403,
      );
    }
    if (err.status === 422) {
      throw new GithubAppError(
        `The GitHub App installation on ${who} cannot access the requested repository: it is not among the installation's selected repositories, or it was deleted. Add it under Installed GitHub Apps → Configure → Repository access.`,
        'not_accessible',
        422,
      );
    }
    if (err.status === 403) {
      throw new GithubAppError(`${err.message} — the installation may not have granted the permissions requested.`, 'forbidden', 403);
    }
    throw err;
  }
  const token = res.data?.token;
  if (typeof token !== 'string' || !token) {
    throw new GithubAppError(`GitHub did not return an access token for ${who}`, 'http', res.status);
  }
  const expiresAt = typeof res.data.expires_at === 'string' ? Date.parse(res.data.expires_at) : Number.NaN;
  if (Number.isFinite(expiresAt)) tokenCache.set(key, { token, expiresAt, installationRowId: inst.id });
  return token;
}

/**
 * Revoke an installation token early (`DELETE /installation/token`), e.g.
 * after a node job. Best effort: never throws, and the token is dropped from
 * the cache whatever GitHub answers. True when GitHub confirmed (204).
 */
export async function revokeInstallationToken(app: Pick<GithubApp, 'apiBaseUrl'>, token: string): Promise<boolean> {
  for (const [key, entry] of tokenCache) if (entry.token === token) tokenCache.delete(key);
  try {
    const res = await githubApi(app, token, 'DELETE', '/installation/token');
    return res.status === 204;
  } catch {
    return false;
  }
}
