import { signRequest, type SigV4Credentials } from '../awsSigV4.js';
import { guardedFetch, privateEgressAllowed } from '../egressGuard.js';
import { redactSecrets } from '../redactSecret.js';
import { SecretProviderError } from './vault.js';

/**
 * AWS Secrets Manager client (0.14, DESIGN §4.1), signed with the generic
 * SigV4 signer in `lib/awsSigV4.ts`. No AWS SDK.
 *
 *   GetSecretValue  POST https://secretsmanager.<region>.amazonaws.com/
 *                   X-Amz-Target: secretsmanager.GetSecretValue (JSON 1.1)
 *   AssumeRole      STS query API (optional, `roleArn`), cached until
 *                   expiry − 5 min
 *   test            STS GetCallerIdentity, plus an optional probe secret
 *
 * Static keys only. Instance / ECS roles (IMDS) are refused and deferred:
 * the metadata endpoints are link-local and the egress guard blocks them,
 * and a configured endpoint pointing at them is refused outright.
 * `SecretBinary` is refused — env values are text.
 *
 * Every call goes through `guardedFetch`; a 3xx is an error. Errors never
 * carry a key, a session token or the secret id, and response bodies are
 * cut to 200 characters.
 */

export interface AwsClientConfig {
  region: string;
  endpoint?: string;
  roleArn?: string;
  externalId?: string;
  roleSessionName: string;
}

export interface AwsCredentials {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

export interface AwsCallOptions {
  /** Cache key of the stored provider row (id + updatedAt). */
  cacheKey: string;
  signal?: AbortSignal;
  /** Extra strings to redact from errors (the secret id being read). */
  redact?: readonly string[];
}

const BODY_LIMIT = 200;
/** Assumed-role credentials are re-used until this long before they expire. */
const ASSUMED_EARLY_MS = 5 * 60_000;
const STS_VERSION = '2011-06-15';
/** Instance and container metadata endpoints (IMDS v1/v2, ECS task roles). */
const METADATA_HOSTS = new Set(['169.254.169.254', '169.254.170.2', '[fd00:ec2::254]']);

/** cacheKey → assumed-role credentials and their expiry (ms). */
const assumedCache = new Map<string, { creds: SigV4Credentials; expires: number }>();

export function clearAwsCredentialCache(): void {
  assumedCache.clear();
}

const domainFor = (region: string): string => (region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com');

/** The Secrets Manager endpoint: the configured one (https; http only with private egress) or the regional default. */
export function secretsManagerEndpoint(cfg: AwsClientConfig): string {
  if (!cfg.endpoint) return `https://secretsmanager.${cfg.region}.${domainFor(cfg.region)}/`;
  let url: URL;
  try {
    url = new URL(cfg.endpoint);
  } catch {
    throw new SecretProviderError('The Secrets Manager endpoint is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateEgressAllowed())) {
    throw new SecretProviderError(
      `The Secrets Manager endpoint must use https (http is allowed only with NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1), got ${url.protocol}//${url.host}`,
    );
  }
  if (METADATA_HOSTS.has(url.hostname)) {
    throw new SecretProviderError('Instance metadata credentials (IMDS) are not supported; store an access key instead');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new SecretProviderError('The Secrets Manager endpoint must not carry credentials, a query or a fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/`;
}

const stsEndpoint = (region: string): string => `https://sts.${region}.${domainFor(region)}/`;

function baseCredentials(creds: AwsCredentials): SigV4Credentials {
  if (!creds.accessKeyId || !creds.secretAccessKey) {
    throw new SecretProviderError('No AWS access key is stored (instance metadata credentials are not supported)');
  }
  return {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
  };
}

function secretsOf(creds: AwsCredentials, extra: readonly (string | undefined)[]): Array<string | undefined> {
  return [creds.accessKeyId, creds.secretAccessKey, creds.sessionToken, ...extra];
}

async function send(
  what: string,
  url: string,
  body: string,
  headers: Record<string, string>,
  service: string,
  region: string,
  signer: SigV4Credentials,
  redact: Array<string | undefined>,
  signal: AbortSignal | undefined,
): Promise<string> {
  const signed = signRequest({ method: 'POST', url, headers, body, service, region }, signer);
  const { host: _host, ...sendHeaders } = signed.headers;
  let res: Response;
  try {
    res = await guardedFetch(url, { method: 'POST', headers: sendHeaders, body, signal });
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
  return text;
}

const xmlTag = (xml: string, tag: string): string | undefined => {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'") : undefined;
};

async function stsCall(
  cfg: AwsClientConfig,
  creds: AwsCredentials,
  params: Record<string, string>,
  opts: AwsCallOptions,
  extraRedact: Array<string | undefined> = [],
): Promise<string> {
  const body = new URLSearchParams({ ...params, Version: STS_VERSION }).toString();
  return send(
    `STS ${params['Action']}`,
    stsEndpoint(cfg.region),
    body,
    { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    'sts',
    cfg.region,
    baseCredentials(creds),
    secretsOf(creds, [...extraRedact, ...(opts.redact ?? [])]),
    opts.signal,
  );
}

/** The credentials Secrets Manager calls are signed with: the stored key, or a cached AssumeRole result. */
export async function effectiveCredentials(
  cfg: AwsClientConfig,
  creds: AwsCredentials,
  opts: AwsCallOptions,
): Promise<SigV4Credentials> {
  const base = baseCredentials(creds);
  if (!cfg.roleArn) return base;
  const cached = assumedCache.get(opts.cacheKey);
  if (cached && cached.expires - ASSUMED_EARLY_MS > Date.now()) return cached.creds;
  const params: Record<string, string> = {
    Action: 'AssumeRole',
    RoleArn: cfg.roleArn,
    RoleSessionName: cfg.roleSessionName,
    DurationSeconds: '3600',
  };
  if (cfg.externalId) params['ExternalId'] = cfg.externalId;
  const xml = await stsCall(cfg, creds, params, opts, [cfg.externalId]);
  const accessKeyId = xmlTag(xml, 'AccessKeyId');
  const secretAccessKey = xmlTag(xml, 'SecretAccessKey');
  const sessionToken = xmlTag(xml, 'SessionToken');
  const expiration = Date.parse(xmlTag(xml, 'Expiration') ?? '');
  if (!accessKeyId || !secretAccessKey || !sessionToken || !Number.isFinite(expiration)) {
    throw new SecretProviderError('STS AssumeRole answered without credentials');
  }
  const assumed = { accessKeyId, secretAccessKey, sessionToken };
  assumedCache.set(opts.cacheKey, { creds: assumed, expires: expiration });
  return assumed;
}

/** GetSecretValue → the SecretString. `SecretBinary` is refused. */
export async function getSecretString(
  cfg: AwsClientConfig,
  creds: AwsCredentials,
  secretId: string,
  opts: AwsCallOptions,
): Promise<string> {
  const signer = await effectiveCredentials(cfg, creds, opts);
  const text = await send(
    'Secrets Manager GetSecretValue',
    secretsManagerEndpoint(cfg),
    JSON.stringify({ SecretId: secretId }),
    { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'secretsmanager.GetSecretValue' },
    'secretsmanager',
    cfg.region,
    signer,
    [...secretsOf(creds, [secretId, ...(opts.redact ?? [])]), signer.secretAccessKey, signer.sessionToken],
    opts.signal,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SecretProviderError('Secrets Manager answered with a body that is not JSON');
  }
  const o = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  if (typeof o['SecretString'] === 'string') return o['SecretString'];
  if (o['SecretBinary'] !== undefined) {
    throw new SecretProviderError('The secret holds SecretBinary, which is not supported — store it as a SecretString');
  }
  throw new SecretProviderError('Secrets Manager answered without a SecretString');
}

/**
 * One key of a JSON SecretString. undefined when the key is absent (the
 * caller reports it); a SecretString that is not a JSON object throws.
 */
export function jsonSecretKey(secretString: string, key: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new SecretProviderError('The secret is not a JSON object, so a #key cannot be read from it');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SecretProviderError('The secret is not a JSON object, so a #key cannot be read from it');
  }
  const o = parsed as Record<string, unknown>;
  if (!Object.hasOwn(o, key) || o[key] === null || o[key] === undefined) return undefined;
  return typeof o[key] === 'string' ? (o[key] as string) : JSON.stringify(o[key]);
}

/** Connectivity test: GetCallerIdentity (and AssumeRole when configured), then optionally read the probe secret. */
export async function testAwsProvider(
  cfg: AwsClientConfig,
  creds: AwsCredentials,
  opts: AwsCallOptions & { probeSecretId?: string },
): Promise<string> {
  const xml = await stsCall(cfg, creds, { Action: 'GetCallerIdentity' }, opts);
  const arn = xmlTag(xml, 'Arn');
  let detail = arn ? `Credentials accepted (${arn})` : 'Credentials accepted';
  if (cfg.roleArn) {
    // A test always assumes afresh: a cached session proves nothing about the stored key.
    assumedCache.delete(opts.cacheKey);
    await effectiveCredentials(cfg, creds, opts);
    detail += '; AssumeRole succeeded';
  }
  if (opts.probeSecretId) {
    await getSecretString(cfg, creds, opts.probeSecretId, opts);
    detail += '; probe secret readable';
  }
  return detail;
}
