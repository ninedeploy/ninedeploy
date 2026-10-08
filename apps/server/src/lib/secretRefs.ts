/**
 * Secret-reference grammar (0.14, DESIGN §4.1) — the ONE detector every gate
 * relies on. `lib/vault.ts` `hasVaultRef` delegates to `hasSecretRef`, so the
 * env write gate, the PR-preview refusal, templates, service bundles and the
 * preview withholding at deploy all cover every form below.
 *
 *   ${{infisical:KEY}} / ${{doppler:KEY}}     legacy, settings-based provider
 *   ${{vault:<path>#<field>}}                 HashiCorp Vault / OpenBao KV v2
 *   ${{aws:<secretId>}}                       AWS Secrets Manager, whole SecretString
 *   ${{aws:<secretId>#<jsonKey>}}             one key of a JSON SecretString
 *
 * Every piece is a closed character class without `}` or `#`, so a match can
 * never run across a `}}` or swallow extra syntax. A string that matches none
 * of these is not a reference anywhere — not at deploy, not at a gate — which
 * keeps detection and resolution identical by construction.
 */

/** A Vault path segment that is not `.` or `..`, followed by more segments. */
const VAULT_SEGMENT = String.raw`(?!\.\.?(?:\/|#))[A-Za-z0-9_.-]+`;
const VAULT_PATH = String.raw`${VAULT_SEGMENT}(?:\/${VAULT_SEGMENT})*`;
const FIELD = '[A-Za-z0-9_.-]+';
const AWS_ID = '[A-Za-z0-9/_+=.@:-]{1,2048}';
const AWS_KEY = '[A-Za-z0-9_.-]{1,256}';

/** Group order: 1 legacy provider, 2 legacy key, 3 vault path, 4 vault field, 5 aws id, 6 aws json key. */
const SOURCE = String.raw`\$\{\{(?:(infisical|doppler):([\w.-]+)|vault:(${VAULT_PATH})#(${FIELD})|aws:(${AWS_ID})(?:#(${AWS_KEY}))?)\}\}`;

/** A fresh global regex per call: a shared `g` regex carries `lastIndex` between callers. */
const anyRef = (): RegExp => new RegExp(SOURCE, 'g');

export type SecretRef =
  | { provider: 'infisical' | 'doppler'; raw: string; key: string }
  | { provider: 'vault'; raw: string; path: string; field: string }
  | { provider: 'aws'; raw: string; secretId: string; jsonKey: string | null };

export type ExternalSecretRef = Extract<SecretRef, { provider: 'vault' | 'aws' }>;

/** Deploy-time limits for the vault / aws providers (Infisical and Doppler are unchanged). */
export const SECRET_REF_LIMITS = {
  /** Distinct vault/aws references one deploy may resolve. */
  maxRefs: 100,
  /** Per provider call. */
  callTimeoutMs: 15_000,
  /** All provider calls of one deploy together. */
  totalTimeoutMs: 60_000,
  /** One resolved value, in UTF-8 bytes. */
  maxValueBytes: 64 * 1024,
} as const;

function toRef(m: RegExpMatchArray): SecretRef {
  const raw = m[0];
  if (m[1] !== undefined) return { provider: m[1] as 'infisical' | 'doppler', raw, key: m[2]! };
  if (m[3] !== undefined) return { provider: 'vault', raw, path: m[3], field: m[4]! };
  return { provider: 'aws', raw, secretId: m[5]!, jsonKey: m[6] ?? null };
}

/** True when the value contains at least one secret reference of any provider. */
export function hasSecretRef(value: string): boolean {
  return anyRef().test(value);
}

/** Every reference in `value`, in order (duplicates kept). */
export function findSecretRefs(value: string): SecretRef[] {
  return [...value.matchAll(anyRef())].map(toRef);
}

/** Replace every reference in one left-to-right pass: a resolved value is never re-scanned. */
export function replaceSecretRefs(value: string, fn: (ref: SecretRef) => string): string {
  // replace() hands the callback (match, g1…g6, offset, input) — the same
  // indices toRef reads from a match array.
  return value.replace(anyRef(), (...args: unknown[]) => fn(toRef(args as unknown as RegExpMatchArray)));
}
