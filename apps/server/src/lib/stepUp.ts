import type { DB, User } from '@ninedeploy/db';
import { verifyPassword } from './crypto.js';
import { HttpError } from './errors.js';
import { verifyJwt } from './jwt.js';
import { findLiveSession } from './sessions.js';

// ── Step-up (r502) ─────────────────────────────────────────────────────────
// Registering a passkey or turning TOTP on plants a DURABLE credential: one
// that outlives the session that created it (and, for passkeys, a password
// change). A briefly stolen access token used to be enough to do either, so
// the thief kept a way back in after the victim logged out everywhere. These
// routes now need proof that the account holder is present: the current
// password, or — for an account that has no usable password (SSO-only) — a
// sign-in fresh enough that it happened just now.
//
// 0.15 (DESIGN §6 M6): moved here unchanged from `modules/auth.ts`, so the
// terminal routes (host shells, enabling host shells) can require the same
// proof. `modules/auth.ts` imports it from here; behaviour is identical.
export const STEP_UP_FRESH_MS = 10 * 60 * 1000;
const REAUTH_REQUIRED_MESSAGE =
  'Confirm your current password to continue. Accounts that sign in only through SSO: sign in again, then retry within 10 minutes.';

export async function assertStepUp(
  db: DB,
  req: { headers: { authorization?: string } },
  user: Pick<User, 'id' | 'passwordHash'>,
  password: string | undefined,
): Promise<void> {
  if (password !== undefined) {
    if (await verifyPassword(user.passwordHash, password)) return;
    // 403 (not 401): the session itself is fine — a 401 would send the web
    // client into a pointless refresh-and-retry.
    throw new HttpError(403, 'invalid_password', 'Invalid password');
  }
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  try {
    const payload = await verifyJwt(bearer);
    const session = payload.type === 'access' && payload.jti ? await findLiveSession(db, payload.jti) : null;
    // `createdAt` is the sign-in time: refresh rotation keeps the row (and
    // its createdAt), so a stolen refresh token cannot make itself "fresh".
    if (session && session.userId === user.id && Date.now() - session.createdAt.getTime() <= STEP_UP_FRESH_MS) return;
  } catch { /* not a verifiable session token — fall through */ }
  throw new HttpError(403, 'reauth_required', REAUTH_REQUIRED_MESSAGE);
}
