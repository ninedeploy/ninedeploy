import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../config.js';

const secret = new TextEncoder().encode(config.jwt.secret);

export interface AppJwtPayload extends JWTPayload {
  type: 'access' | 'refresh';
  /** Token-version marker; must match the user's `tokenVersion` or the token is rejected. */
  ver?: number;
  /** Refresh-token session id — must reference a live row in `sessions`. */
  jti?: string;
  /**
   * Refresh-generation marker: the `sessions.expiresAt` value (epoch ms) this
   * refresh token was minted against. Rotation advances the row's expiry, so
   * a refresh token from a PREVIOUS generation fails the match — a replayed
   * or stolen old refresh token cannot mint new pairs.
   */
  gen?: number;
}

function sign(
  userId: number,
  type: 'access' | 'refresh',
  ttl: string,
  ver?: number,
  jti?: string,
  gen?: number,
): Promise<string> {
  const claims: Record<string, unknown> = { type };
  if (ver !== undefined) claims['ver'] = ver;
  if (jti !== undefined) claims['jti'] = jti;
  if (gen !== undefined) claims['gen'] = gen;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret);
}

export const signAccessToken = (userId: number, ver?: number, jti?: string) =>
  sign(userId, 'access', config.jwt.accessTtl, ver, jti);
export const signRefreshToken = (userId: number, ver?: number, jti?: string, gen?: number) =>
  sign(userId, 'refresh', config.jwt.refreshTtl, ver, jti, gen);

export async function verifyJwt(token: string): Promise<AppJwtPayload> {
  // Pin the algorithm explicitly. jose already refuses a non-HMAC `alg` for a
  // symmetric key, so this is defence in depth — but it makes the accepted set
  // a property of THIS code rather than of the library's key-type inference.
  const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
  return payload as AppJwtPayload;
}

const TTL_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** Convert a human TTL ("15m", "7d", "2h", "30s") to seconds (fallback 900). */
export function ttlSeconds(ttl: string): number {
  const unit = TTL_UNITS[ttl.slice(-1)];
  const amount = Number(ttl.slice(0, -1));
  if (!unit || !Number.isFinite(amount) || amount <= 0) return 900;
  return Math.floor(amount) * unit;
}
