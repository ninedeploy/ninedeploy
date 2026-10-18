import { randomInt } from 'node:crypto';
import { and, count, eq, isNull } from 'drizzle-orm';
import { userRecoveryCodes, type DB } from '@ninedeploy/db';
import { sha256 } from './crypto.js';

/**
 * 0.16.3: single-use 2FA recovery codes, for the account whose authenticator
 * is lost. Ten per set, each 16 characters of Crockford base32 (80 bits), so
 * a plain sha256 at rest is enough: there is nothing to brute-force. Shown
 * once, in groups of four (`k7m2-9q4x-p0ab-3hrt`).
 */

export const RECOVERY_CODE_COUNT = 10;
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const LENGTH = 16;

/** A fresh, formatted code. */
function newCode(): string {
  let raw = '';
  for (let i = 0; i < LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return raw.match(/.{4}/g)!.join('-');
}

/**
 * The canonical form of what a person typed: case, spaces and dashes do not
 * matter, and the letters Crockford base32 leaves out read as the digits they
 * look like (o → 0, i/l → 1). Null when it cannot be a code.
 */
export function normalizeRecoveryCode(input: string): string | null {
  const raw = input.toLowerCase().replace(/[\s-]/g, '').replace(/o/g, '0').replace(/[il]/g, '1');
  return raw.length === LENGTH && [...raw].every((ch) => ALPHABET.includes(ch)) ? raw : null;
}

/** Replace the user's set with a new one; the codes are returned once and never stored in clear. */
export async function issueRecoveryCodes(db: DB, userId: number): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newCode);
  await db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
  await db.insert(userRecoveryCodes).values(codes.map((code) => ({ userId, codeHash: sha256(normalizeRecoveryCode(code)!) })));
  return codes;
}

/** Drop the user's set (2FA turned off or re-enrolled). */
export async function clearRecoveryCodes(db: DB, userId: number): Promise<void> {
  await db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
}

/**
 * Spend one code. The claim is a conditional UPDATE on an unused row, so two
 * sign-ins racing with the same code cannot both win.
 */
export async function consumeRecoveryCode(db: DB, userId: number, input: string): Promise<boolean> {
  const code = normalizeRecoveryCode(input);
  if (!code) return false;
  const claimed = await db
    .update(userRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(userRecoveryCodes.userId, userId), eq(userRecoveryCodes.codeHash, sha256(code)), isNull(userRecoveryCodes.usedAt)))
    .returning({ id: userRecoveryCodes.id });
  return claimed.length > 0;
}

/** How many unused codes the user has left (0 for an account that never generated a set). */
export async function remainingRecoveryCodes(db: DB, userId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(userRecoveryCodes)
    .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
  return row?.n ?? 0;
}
