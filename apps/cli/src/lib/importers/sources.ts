/**
 * HTTP clients for the import sources (A1 step 1). Native fetch only. The
 * credentials come from the caller (an env var or a hidden prompt, never
 * argv) and never appear in an error message.
 */
import type { SourceGet } from './plan.js';
import { stripUserinfo } from './plan.js';

export class SourceError extends Error {}
/** CapRover asked for a two-factor code (status 1114). */
export class OtpRequiredError extends SourceError {}

type Fetch = typeof fetch;

/** `https://host[:port][/prefix]` without a trailing slash or userinfo. */
export function normaliseBase(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SourceError(`Not a URL: ${stripUserinfo(raw)}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SourceError('The source URL must start with https:// (or http://).');
  return stripUserinfo(`${u.origin}${u.pathname}`).replace(/\/+$/, '');
}

async function body(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function httpError(res: Response, what: string, hint = ''): SourceError {
  return new SourceError(`${what} answered HTTP ${res.status}${hint ? `: ${hint}` : ''}`);
}

/** Coolify: `Authorization: Bearer <token>`; a plain `read` token is enough. */
export function coolifySource(base: string, token: string, f: Fetch = fetch): SourceGet {
  return async (path) => {
    const res = await f(`${base}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    const data = await body(res);
    if (res.ok) return data;
    const message = typeof data === 'object' && data && 'message' in data ? String((data as { message: unknown }).message) : '';
    if (res.status === 403 && /api is disabled/i.test(message)) throw httpError(res, 'Coolify', 'the API is off. Turn it on under Settings → Advanced → API access.');
    if (res.status === 401) throw httpError(res, 'Coolify', 'the token was refused (create one under Keys & Tokens → API tokens, with "read").');
    if (res.status === 403) throw httpError(res, 'Coolify', message || 'the token lacks access (IP allow-list, scope or ability).');
    throw httpError(res, `Coolify ${path}`, message);
  };
}

/** Dokploy: `x-api-key`, tRPC procedures as `GET /api/<procedure>?<input>`. */
export function dokploySource(base: string, apiKey: string, f: Fetch = fetch): SourceGet {
  return async (path) => {
    const res = await f(`${base}${path}`, { headers: { 'x-api-key': apiKey, accept: 'application/json' } });
    const data = await body(res);
    if (res.ok) return data;
    if (res.status === 401) throw httpError(res, 'Dokploy', 'the API key was refused (create one under Profile → API keys, for this organization).');
    const message = typeof data === 'object' && data && 'message' in data ? String((data as { message: unknown }).message) : '';
    throw httpError(res, `Dokploy ${path.split('?')[0]}`, message);
  };
}

interface CaproverEnvelope { status?: number; description?: string; data?: unknown }

/**
 * CapRover: sign in once (never retried: each wrong password starts a 30 s
 * back-off), then send `x-captain-auth`. Errors arrive with HTTP 200 and a
 * non-100 `status` in the envelope.
 */
export async function caproverSource(base: string, password: string, otp: string | undefined, f: Fetch = fetch): Promise<SourceGet> {
  const res = await f(`${base}/api/v2/login/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-namespace': 'captain' },
    body: JSON.stringify(otp ? { password, otpToken: otp } : { password }),
  });
  if (!res.ok) throw httpError(res, 'CapRover sign-in');
  const env = (await body(res)) as CaproverEnvelope | null;
  if (env?.status === 1114) throw new OtpRequiredError('CapRover asks for a two-factor code.');
  if (env?.status === 1113) throw new SourceError('CapRover is pausing sign-ins after a wrong password; wait 30 seconds and try again.');
  if (env?.status === 1105) throw new SourceError('CapRover refused the password (or the two-factor code).');
  const token = (env?.data as { token?: unknown } | undefined)?.token;
  if (env?.status !== 100 || typeof token !== 'string') throw new SourceError(`CapRover sign-in failed (status ${env?.status ?? '?'}).`);
  return async (path) => {
    const r = await f(`${base}${path}`, { headers: { 'x-captain-auth': token, 'x-namespace': 'captain', accept: 'application/json' } });
    if (!r.ok) throw httpError(r, `CapRover ${path}`);
    const e = (await body(r)) as CaproverEnvelope | null;
    if (e?.status === 1106) throw new SourceError('CapRover no longer accepts the session (it restarted, or the password changed); run the import again.');
    if (e?.status !== 100) throw new SourceError(`CapRover ${path} failed (status ${e?.status ?? '?'}${e?.description ? `: ${e.description}` : ''}).`);
    return e.data;
  };
}
