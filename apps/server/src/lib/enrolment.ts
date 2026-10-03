import type { DB } from '@ninedeploy/db';
import { decrypt, encrypt, randomToken, secretEquals } from './crypto.js';
import { unauthorized } from './errors.js';
import { getSettingString, setSettingString } from './settings.js';

/**
 * M-6: an admin-issued enrolment secret for `POST /v1/servers/announce`.
 *
 * That route is the one unauthenticated write in the product. Without a shared
 * secret, any host that can reach the panel can insert a `servers` row with an
 * attacker-chosen name, host, port and agent token. The row lands in `pending`
 * and needs approval, so it is a spoofing primitive rather than direct access
 * — but an approved rogue node receives `docker.runEnv` operations, i.e. the
 * service environment files including every secret. It also lets an anonymous
 * party fill the registry UI with plausible-looking entries, which is exactly
 * the noise an operator has to click "Approve" through.
 *
 * The secret is stored reversibly (AES-GCM, like every other operator secret
 * here) rather than hashed, because the admin has to read it back once to put
 * it in the agent's environment.
 *
 * **Fail closed.** With no secret configured, announce is refused. Enrolment
 * is an explicit, occasional act by an operator, so "off until you turn it on"
 * is the correct default — the alternative silently keeps the hole open on
 * every instance that never visits the setting.
 */
export const ENROLMENT_SETTING_KEY = 'agent_enrolment_token';

/** Header the agent presents. */
export const ENROLMENT_HEADER = 'x-ninedeploy-enrolment';

/** The configured enrolment secret in clear, or null when enrolment is off. */
export async function getEnrolmentToken(db: DB): Promise<string | null> {
  const stored = await getSettingString(db, ENROLMENT_SETTING_KEY, null);
  if (!stored) return null;
  try {
    return decrypt(stored);
  } catch {
    // A key rotation that dropped the old key leaves an undecryptable value.
    // Treat it as "not configured" so announce fails closed rather than 500s.
    return null;
  }
}

/** Generate, store and return a fresh enrolment secret. */
export async function rotateEnrolmentToken(db: DB): Promise<string> {
  const raw = randomToken(32);
  await setSettingString(db, ENROLMENT_SETTING_KEY, encrypt(raw));
  return raw;
}

/** Turn enrolment off; announce then refuses everything. */
export async function clearEnrolmentToken(db: DB): Promise<void> {
  await setSettingString(db, ENROLMENT_SETTING_KEY, '');
}

/**
 * Throw 401 unless `presented` matches the configured enrolment secret.
 * Comparison is constant-time — this runs on a public route.
 */
export async function assertEnrolmentAllowed(db: DB, presented: string | undefined): Promise<void> {
  const expected = await getEnrolmentToken(db);
  if (!expected) {
    throw unauthorized(
      'Node enrolment is disabled. An administrator must generate an enrolment token in Settings and set NINEDEPLOY_ENROLMENT_TOKEN on the agent.',
      'enrolment_disabled',
    );
  }
  if (!presented || !secretEquals(expected, presented)) {
    throw unauthorized('Invalid or missing node enrolment token', 'enrolment_invalid');
  }
}
