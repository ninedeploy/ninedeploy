import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { users, type DB } from '@ninedeploy/db';
import { decrypt } from './crypto.js';
import { verifyTotpStep } from './totp.js';

/**
 * L-10: spend a TOTP code so it cannot be replayed.
 *
 * `verifyTotp` alone accepts a code for the whole ±1-step window — 90 seconds
 * during which the same six digits authenticate again. That is the window a
 * phishing proxy or a shoulder-surfer works in, and per-account lockout does
 * not help: the attacker is not guessing, they have the code.
 *
 * The fix is one monotonic counter per user (`users.totp_last_step`). A code
 * is accepted only if its step is strictly greater than the last one spent,
 * and the claim is made by a CONDITIONAL UPDATE, so two requests arriving with
 * the same code in the same tick cannot both win — SQLite serialises the
 * writes and the loser gets zero rows back. (This mirrors how single-use
 * password-reset tokens are claimed elsewhere in this codebase.)
 */
export async function consumeTotpCode(
  db: DB,
  user: { id: number; totpSecretEncrypted: string | null },
  code: string,
  timestampMs = Date.now(),
): Promise<boolean> {
  if (!user.totpSecretEncrypted) return false;

  const step = verifyTotpStep(decrypt(user.totpSecretEncrypted), code, timestampMs);
  if (step === null) return false;

  const claimed = await db
    .update(users)
    .set({ totpLastStep: step })
    .where(
      and(
        eq(users.id, user.id),
        // strictly newer than whatever was last spent; NULL = nothing spent yet
        or(isNull(users.totpLastStep), lt(users.totpLastStep, sql`${step}`)),
      ),
    )
    .returning({ id: users.id });

  return claimed.length > 0;
}
