import { createHash, createSign, randomBytes } from 'node:crypto';
import { gcpProviderConfig, GCP_PROJECT_RE } from '@ninedeploy/schemas';
import { providerFetch, parseJson, TokenCache, type NamedCallOptions, type NamedSecretDriver } from './named.js';
import { SecretProviderError } from './vault.js';

/**
 * G3.2: Google Cloud Secret Manager, `${{gcp:<secret>[@<version>]}}`.
 *
 * Authenticates as a service account (its JSON key, stored encrypted): an
 * RS256 JWT assertion is exchanged for an access token at Google's token
 * endpoint. The endpoint is fixed — a `token_uri` in the key file is ignored,
 * so the signed assertion never goes anywhere else. The account needs
 * `roles/secretmanager.secretAccessor` on the secrets it reads.
 */

type GcpConfig = { projectId?: string };

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://secretmanager.googleapis.com/v1';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string | null;
}

export function parseServiceAccount(json: string): ServiceAccount {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new SecretProviderError('The service account key is not valid JSON');
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new SecretProviderError('The service account key is not a JSON object');
  if (o['type'] !== undefined && o['type'] !== 'service_account') throw new SecretProviderError('The key file is not a service account key');
  const email = o['client_email'];
  const key = o['private_key'];
  if (typeof email !== 'string' || !email || typeof key !== 'string' || !key.includes('PRIVATE KEY')) {
    throw new SecretProviderError('The service account key has no client_email or private_key');
  }
  const project = typeof o['project_id'] === 'string' && GCP_PROJECT_RE.test(o['project_id']) ? o['project_id'] : null;
  return { client_email: email, private_key: key, project_id: project };
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

function assertion(sa: ServiceAccount): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600, jti: randomBytes(16).toString('hex') }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  let sig: Buffer;
  try {
    sig = signer.sign(sa.private_key);
  } catch {
    throw new SecretProviderError('The service account private_key cannot sign (is it a PEM RSA key?)');
  }
  return `${header}.${payload}.${b64url(sig)}`;
}

const tokens = new TokenCache();

async function accessToken(sa: ServiceAccount, opts: NamedCallOptions, redact: Array<string | undefined>): Promise<string> {
  // The cache key covers the key itself: a re-saved key never reuses a token.
  const key = `${opts.cacheKey}:${createHash('sha256').update(sa.private_key).digest('hex')}`;
  return tokens.get(key, async () => {
    const { text } = await providerFetch(
      'Google OAuth token exchange',
      TOKEN_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertion(sa) }).toString(),
        signal: opts.signal,
      },
      redact,
    );
    const body = parseJson('Google OAuth', text);
    if (typeof body['access_token'] !== 'string') throw new SecretProviderError('Google OAuth answered without an access token');
    return { token: body['access_token'], expiresInSeconds: typeof body['expires_in'] === 'number' ? body['expires_in'] : 3600 };
  });
}

function projectOf(config: GcpConfig, sa: ServiceAccount): string {
  const project = config.projectId ?? sa.project_id;
  if (!project) throw new SecretProviderError('No GCP project: set projectId (the service account key names none)');
  return project;
}

async function access(config: GcpConfig, creds: Record<string, string>, name: string, opts: NamedCallOptions): Promise<string> {
  const sa = parseServiceAccount(creds['serviceAccountJson'] ?? '');
  const at = name.lastIndexOf('@');
  const secret = at === -1 ? name : name.slice(0, at);
  const version = at === -1 ? 'latest' : name.slice(at + 1);
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(secret) || !/^(\d{1,19}|latest)$/.test(version)) {
    throw new SecretProviderError('Invalid GCP secret reference (expected <secret> or <secret>@<version>)');
  }
  const redact = [creds['serviceAccountJson'], sa.private_key];
  const token = await accessToken(sa, opts, redact);
  const url = `${API}/projects/${encodeURIComponent(projectOf(config, sa))}/secrets/${encodeURIComponent(secret)}/versions/${version}:access`;
  const { text } = await providerFetch('Secret Manager', url, { headers: { authorization: `Bearer ${token}` }, signal: opts.signal }, [...redact, token]);
  const data = (parseJson('Secret Manager', text)['payload'] as { data?: unknown } | undefined)?.data;
  if (typeof data !== 'string') throw new SecretProviderError('Secret Manager answered without a payload');
  const value = Buffer.from(data, 'base64');
  const decoded = new TextDecoder('utf-8', { fatal: true });
  try {
    return decoded.decode(value);
  } catch {
    throw new SecretProviderError('The secret is binary, not UTF-8 text');
  }
}

export const gcpDriver: NamedSecretDriver<GcpConfig> = {
  kind: 'gcp',
  label: 'GCP Secret Manager',
  credentialFields: ['serviceAccountJson'],
  requiredCredentials: ['serviceAccountJson'],
  parseConfig: (raw) => {
    const parsed = gcpProviderConfig.safeParse(raw ?? {});
    return parsed.success ? parsed.data : null;
  },
  validate: () => undefined,
  // The key only ever goes to Google; a new project is not a new destination.
  target: () => 'google',
  read: access,
  async test(config, creds, opts) {
    const sa = parseServiceAccount(creds['serviceAccountJson'] ?? '');
    // A test always mints afresh: a cached token proves nothing about the stored key.
    tokens.clear();
    await accessToken(sa, opts, [creds['serviceAccountJson'], sa.private_key]);
    let detail = `Service account ${sa.client_email} accepted (project ${projectOf(config, sa)})`;
    if (opts.probeName) {
      await access(config, creds, opts.probeName, opts);
      detail += '; probe secret readable';
    }
    return detail;
  },
  clearCache: () => tokens.clear(),
};
