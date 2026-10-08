import { guardedFetch, privateEgressAllowed } from '../egressGuard.js';
import { redactSecrets } from '../redactSecret.js';

/**
 * HashiCorp Vault / OpenBao KV v2 client (0.14, DESIGN §4.1).
 *
 *   read   GET  {addr}/v1/{mount}/data/{path}   → `data.data`
 *   login  POST {addr}/v1/auth/{approleMount}/login (AppRole)
 *   test   GET  {addr}/v1/auth/token/lookup-self, or an AppRole login
 *
 * Every call goes through `guardedFetch`: private addresses need
 * NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1, the address must be https (http only
 * together with that switch, as for a GitHub App API base), and a 3xx is an
 * error — a redirect is never followed. KV v1 is refused (a v1 mount answers
 * without the nested `data.data`). Token auth does not renew: use a periodic
 * token or AppRole. A private CA comes from NODE_EXTRA_CA_CERTS.
 *
 * Errors never carry the token, the AppRole ids or the secret path, and a
 * response body is cut to 200 characters.
 */

export interface VaultClientConfig {
  address: string;
  namespace?: string;
  mount: string;
  authMethod: 'token' | 'approle';
  approleMount: string;
}

export interface VaultCredentials {
  token?: string;
  roleId?: string;
  secretId?: string;
}

export interface VaultCallOptions {
  /** Cache key of the stored provider row (id + updatedAt): a saved change drops the cached token. */
  cacheKey: string;
  signal?: AbortSignal;
  /** Extra strings to redact from errors (the path being read). */
  redact?: readonly string[];
}

export class SecretProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretProviderError';
  }
}

const BODY_LIMIT = 200;
/** An AppRole token is re-used until this long before its lease ends. */
const TOKEN_EARLY_MS = 60_000;

/** AppRole tokens: cacheKey → token and the time it stops being used. */
const tokenCache = new Map<string, { token: string; until: number }>();

/** Drop every cached AppRole token (tests; a provider save or delete). */
export function clearVaultTokenCache(): void {
  tokenCache.clear();
}

/** The address as a base URL; https only, http only with private egress. */
export function vaultBaseUrl(address: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new SecretProviderError('The Vault address is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateEgressAllowed())) {
    throw new SecretProviderError(
      `The Vault address must use https (http is allowed only with NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1), got ${url.protocol}//${url.host}`,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new SecretProviderError('The Vault address must not carry credentials, a query or a fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

function secretsOf(creds: VaultCredentials, opts: VaultCallOptions): Array<string | undefined> {
  return [creds.token, creds.roleId, creds.secretId, ...(opts.redact ?? [])];
}

async function call(
  cfg: VaultClientConfig,
  creds: VaultCredentials,
  opts: VaultCallOptions,
  method: 'GET' | 'POST',
  apiPath: string,
  init: { token?: string; body?: unknown },
): Promise<{ status: number; json: unknown }> {
  const url = `${vaultBaseUrl(cfg.address)}/v1/${apiPath}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.token) headers['x-vault-token'] = init.token;
  if (cfg.namespace) headers['x-vault-namespace'] = cfg.namespace;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await guardedFetch(url, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: opts.signal,
    });
  } catch (err) {
    throw new SecretProviderError(`Vault request failed: ${redactSecrets(err, secretsOf(creds, opts))}`);
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new SecretProviderError(`Vault answered with a redirect (${res.status}); redirects are not followed`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const snippet = redactSecrets(text.slice(0, BODY_LIMIT), secretsOf(creds, opts));
    throw new SecretProviderError(`Vault answered ${res.status}${snippet ? `: ${snippet}` : ''}`);
  }
  try {
    return { status: res.status, json: text ? (JSON.parse(text) as unknown) : null };
  } catch {
    throw new SecretProviderError(`Vault answered ${res.status} with a body that is not JSON`);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The token for the next request: the stored one, or a (cached) AppRole login. */
export async function vaultToken(cfg: VaultClientConfig, creds: VaultCredentials, opts: VaultCallOptions): Promise<string> {
  if (cfg.authMethod === 'token') {
    if (!creds.token) throw new SecretProviderError('No Vault token is stored');
    return creds.token;
  }
  if (!creds.roleId || !creds.secretId) throw new SecretProviderError('No AppRole role id / secret id is stored');
  const cached = tokenCache.get(opts.cacheKey);
  if (cached && cached.until > Date.now()) return cached.token;
  const { json } = await call(cfg, creds, opts, 'POST', `auth/${encodePath(cfg.approleMount)}/login`, {
    body: { role_id: creds.roleId, secret_id: creds.secretId },
  });
  const auth = isObject(json) && isObject(json['auth']) ? json['auth'] : null;
  const token = auth && typeof auth['client_token'] === 'string' ? auth['client_token'] : null;
  if (!token) throw new SecretProviderError('The AppRole login answered without a client token');
  const lease = auth && typeof auth['lease_duration'] === 'number' ? auth['lease_duration'] : 0;
  // lease 0 = a token without a TTL: keep it until the provider row changes.
  const until = lease > 0 ? Date.now() + lease * 1000 - TOKEN_EARLY_MS : Number.POSITIVE_INFINITY;
  tokenCache.delete(opts.cacheKey);
  if (until > Date.now()) tokenCache.set(opts.cacheKey, { token, until });
  return token;
}

/** Read one KV v2 secret: the field map under `data.data`. */
export async function readKv2(
  cfg: VaultClientConfig,
  creds: VaultCredentials,
  path: string,
  opts: VaultCallOptions,
): Promise<Record<string, unknown>> {
  const withPath: VaultCallOptions = { ...opts, redact: [...(opts.redact ?? []), path] };
  const token = await vaultToken(cfg, creds, withPath);
  const { json } = await call(cfg, creds, withPath, 'GET', `${encodePath(cfg.mount)}/data/${encodePath(path)}`, { token });
  const outer = isObject(json) ? json['data'] : undefined;
  const inner = isObject(outer) ? outer['data'] : undefined;
  if (!isObject(inner)) {
    throw new SecretProviderError(
      'Vault answered without data.data — the mount is not a KV version 2 engine (KV version 1 is not supported)',
    );
  }
  return inner;
}

/** A KV field as an env value: strings as-is, anything else as JSON. */
export function kvFieldValue(fields: Record<string, unknown>, field: string): string | undefined {
  if (!Object.hasOwn(fields, field)) return undefined;
  const value = fields[field];
  if (value === null || value === undefined) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Connectivity test: authenticate (lookup-self or AppRole login), then optionally read `probePath`. */
export async function testVaultProvider(
  cfg: VaultClientConfig,
  creds: VaultCredentials,
  opts: VaultCallOptions & { probePath?: string },
): Promise<string> {
  let detail: string;
  if (cfg.authMethod === 'token') {
    const token = await vaultToken(cfg, creds, opts);
    await call(cfg, creds, opts, 'GET', 'auth/token/lookup-self', { token });
    detail = 'Token accepted (lookup-self)';
  } else {
    // A test always logs in afresh: a cached token proves nothing about the stored ids.
    tokenCache.delete(opts.cacheKey);
    await vaultToken(cfg, creds, opts);
    detail = 'AppRole login succeeded';
  }
  if (opts.probePath) {
    const fields = await readKv2(cfg, creds, opts.probePath, opts);
    detail += `; probe path readable (${Object.keys(fields).length} field${Object.keys(fields).length === 1 ? '' : 's'})`;
  }
  return detail;
}
