import { guardedFetch, privateEgressAllowed } from '../egressGuard.js';
import { redactSecrets } from '../redactSecret.js';
import { SecretProviderError } from './vault.js';

/**
 * G3.2: the secret managers whose references are a plain name (plus an
 * optional `#jsonKey`): GCP Secret Manager, Azure Key Vault, 1Password
 * Connect and the operator's exec command. Each is one driver behind this
 * interface; `secretProviders/index.ts` stores, loads and resolves them the
 * same way it does Vault and AWS (one `secret_providers` row per kind).
 */

export type NamedKind = 'gcp' | 'azure' | 'onepassword' | 'exec';
export const NAMED_KINDS = ['gcp', 'azure', 'onepassword', 'exec'] as const satisfies readonly NamedKind[];

/** The reference prefix of each kind (`${{op:…}}` reads the onepassword row). */
export const REF_PREFIX = { gcp: 'gcp', azure: 'azure', onepassword: 'op', exec: 'exec' } as const satisfies Record<NamedKind, string>;

export interface NamedCallOptions {
  /** Cache key of the stored provider row (id + updatedAt). */
  cacheKey: string;
  signal?: AbortSignal;
}

export interface NamedSecretDriver<C = Record<string, unknown>> {
  kind: NamedKind;
  /** Shown in deploy logs and errors. */
  label: string;
  /** The only keys ever stored in the credential envelope. */
  credentialFields: readonly string[];
  /** The keys a usable credential set must have. */
  requiredCredentials: readonly string[];
  /** The stored config, or null when it no longer parses. */
  parseConfig(raw: unknown): C | null;
  /**
   * Checks the schema cannot express (the https rule, an operator opt-in).
   * Throws a SecretProviderError; called on save and before every use.
   */
  validate(config: C): void;
  /** Where the stored credential is sent; a save that changes it must bring the secret again. */
  target(config: C): string | null;
  /** The value of one reference name. */
  read(config: C, creds: Record<string, string>, name: string, opts: NamedCallOptions): Promise<string>;
  /** Proves the settings; with `probeName`, also resolves that name. */
  test(config: C, creds: Record<string, string>, opts: NamedCallOptions & { probeName?: string }): Promise<string>;
  clearCache(): void;
}

const BODY_LIMIT = 200;

/**
 * One provider HTTP call through the egress guard. A 3xx is an error (no
 * redirect is followed); errors carry the status and at most 200 characters
 * of the body, with every value in `redact` removed.
 */
export async function providerFetch(
  what: string,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  redact: readonly (string | undefined)[],
): Promise<{ status: number; text: string }> {
  let res: Response;
  try {
    res = await guardedFetch(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body, signal: init.signal, redirect: 'manual' });
  } catch (err) {
    throw new SecretProviderError(`${what} request failed: ${redactSecrets(err, redact)}`);
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new SecretProviderError(`${what} answered with a redirect (${res.status}); redirects are not followed`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const snippet = redactSecrets(text.slice(0, BODY_LIMIT), redact);
    throw new SecretProviderError(`${what} answered ${res.status}${snippet ? `: ${snippet}` : ''}`);
  }
  return { status: res.status, text };
}

/** A provider base URL: https (http only with private egress), no credentials, query or fragment. */
export function providerBase(address: string, label: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new SecretProviderError(`The ${label} address is not a valid URL`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateEgressAllowed())) {
    throw new SecretProviderError(
      `The ${label} address must use https (http is allowed only with NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1), got ${url.protocol}//${url.host}`,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new SecretProviderError(`The ${label} address must not carry credentials, a query or a fragment`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function parseJson(what: string, text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SecretProviderError(`${what} answered with a body that is not JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SecretProviderError(`${what} answered with an unexpected body`);
  return parsed as Record<string, unknown>;
}

/** A bearer token cached per provider row until shortly before it expires. */
export class TokenCache {
  private readonly tokens = new Map<string, { token: string; expires: number }>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly earlyMs = 5 * 60_000) {}

  async get(key: string, mint: () => Promise<{ token: string; expiresInSeconds: number }>): Promise<string> {
    const cached = this.tokens.get(key);
    if (cached && cached.expires - this.earlyMs > Date.now()) return cached.token;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = mint()
      .then(({ token, expiresInSeconds }) => {
        this.tokens.set(key, { token, expires: Date.now() + expiresInSeconds * 1000 });
        return token;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  delete(key: string): void {
    this.tokens.delete(key);
  }

  clear(): void {
    this.tokens.clear();
  }
}
