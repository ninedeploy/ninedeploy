import { eq } from 'drizzle-orm';
import { apiTokens, sessions, type DB } from '@ninedeploy/db';
import { z } from 'zod';

/** A revocable reference, never the bearer credential itself. Non-enumerable
 * request metadata prevents it becoming part of user/API serialization. */
const reference = Symbol('authenticated-credential');
const credential = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), jti: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('api-token'), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal('legacy-access'), expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
]);
export type AuthCredential = z.infer<typeof credential>;
export function bindAuthCredential<T extends object>(user: T, value: AuthCredential): T {
  Object.defineProperty(user, reference, { value }); return user;
}
export function authCredentialOf(user: object): AuthCredential | undefined {
  return (user as { [reference]?: AuthCredential })[reference];
}
export function encodeAuthCredential(value: AuthCredential): string {
  return Buffer.from(JSON.stringify(credential.parse(value))).toString('base64url');
}
export function decodeAuthCredential(value: string): AuthCredential | null {
  if (!/^[a-zA-Z0-9_-]{1,2048}$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) return null;
    return credential.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch { return null; }
}
export async function authCredentialIsLive(db: DB, userId: number, value: AuthCredential, now = Date.now()): Promise<boolean> {
  if (value.kind === 'legacy-access') return value.expiresAt * 1000 > now;
  if (value.kind === 'session') {
    const row = await db.query.sessions.findFirst({ where: eq(sessions.jti, value.jti) });
    return !!row && row.userId === userId && !row.revokedAt && row.expiresAt.getTime() > now;
  }
  const row = await db.query.apiTokens.findFirst({ where: eq(apiTokens.hash, value.hash) });
  if (!row || row.userId !== userId || row.expiresAt && row.expiresAt.getTime() <= now) return false;
  const scopes = Array.isArray(row.scopes) ? row.scopes : [];
  return scopes.length === 0 || scopes.includes('operator');
}
