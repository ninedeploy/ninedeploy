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
 * G3.2 adds, each with the optional `#<jsonKey>` of the aws form except `op`:
 *
 *   ${{ssm:<parameter name>}}                 AWS Systems Manager Parameter Store
 *                                             (the aws provider's credentials)
 *   ${{gcp:<secret>[@<version>]}}             Google Cloud Secret Manager
 *   ${{azure:<name>[@<version>]}}             Azure Key Vault
 *   ${{op:<vault>/<item>[/<section>]/<field>}} 1Password Connect
 *   ${{exec:<name>}}                          the operator's exec command
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
const JSON_KEY = '[A-Za-z0-9_.-]{1,256}';
/** Parameter Store names: `/a/b-c.d_e`, at most 2048 characters. */
const SSM_NAME = '[A-Za-z0-9/_.-]{1,2048}';
/** GCP secret ids are 1–255 of `[A-Za-z0-9_-]`; a version is a number or `latest`. */
const GCP_NAME = String.raw`[A-Za-z0-9_-]{1,255}(?:@(?:\d{1,19}|latest))?`;
/** Azure Key Vault secret names are 1–127 of `[A-Za-z0-9-]`; a version is 32 hex digits. */
const AZURE_NAME = '[A-Za-z0-9-]{1,127}(?:@[0-9a-fA-F]{32})?';
/** A 1Password vault, item, section or field: a name or id, spaces allowed inside. */
const OP_SEGMENT = String.raw`[A-Za-z0-9_.@()+-](?:[A-Za-z0-9 _.@()+-]{0,126}[A-Za-z0-9_.@()+-])?`;
const OP_PATH = `${OP_SEGMENT}/${OP_SEGMENT}(?:/${OP_SEGMENT}){1,2}`;
/** Never starts with `-`: as its own argv element a name must not read as an option. */
const EXEC_NAME = '[A-Za-z0-9_./:@][A-Za-z0-9_./:@-]{0,255}';

const SOURCE =
  String.raw`\$\{\{(?:` +
  String.raw`(?<lp>infisical|doppler):(?<lk>[\w.-]+)` +
  `|vault:(?<vp>${VAULT_PATH})#(?<vf>${FIELD})` +
  `|aws:(?<ai>${AWS_ID})(?:#(?<ak>${JSON_KEY}))?` +
  `|ssm:(?<sn>${SSM_NAME})(?:#(?<sk>${JSON_KEY}))?` +
  `|gcp:(?<gn>${GCP_NAME})(?:#(?<gk>${JSON_KEY}))?` +
  `|azure:(?<zn>${AZURE_NAME})(?:#(?<zk>${JSON_KEY}))?` +
  `|op:(?<on>${OP_PATH})` +
  `|exec:(?<en>${EXEC_NAME})(?:#(?<ek>${JSON_KEY}))?` +
  String.raw`)\}\}`;

/** A fresh global regex per call: a shared `g` regex carries `lastIndex` between callers. */
const anyRef = (): RegExp => new RegExp(SOURCE, 'g');

/** The G3.2 reference prefixes, all of the `name` (+ optional `jsonKey`) shape. */
export type NamedRefProvider = 'ssm' | 'gcp' | 'azure' | 'op' | 'exec';

export type SecretRef =
  | { provider: 'infisical' | 'doppler'; raw: string; key: string }
  | { provider: 'vault'; raw: string; path: string; field: string }
  | { provider: 'aws'; raw: string; secretId: string; jsonKey: string | null }
  | { provider: NamedRefProvider; raw: string; name: string; jsonKey: string | null };

export type ExternalSecretRef = Exclude<SecretRef, { provider: 'infisical' | 'doppler' }>;

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

function toRef(raw: string, g: Record<string, string | undefined>): SecretRef {
  if (g['lp'] !== undefined) return { provider: g['lp'] as 'infisical' | 'doppler', raw, key: g['lk']! };
  if (g['vp'] !== undefined) return { provider: 'vault', raw, path: g['vp'], field: g['vf']! };
  if (g['ai'] !== undefined) return { provider: 'aws', raw, secretId: g['ai'], jsonKey: g['ak'] ?? null };
  if (g['sn'] !== undefined) return { provider: 'ssm', raw, name: g['sn'], jsonKey: g['sk'] ?? null };
  if (g['gn'] !== undefined) return { provider: 'gcp', raw, name: g['gn'], jsonKey: g['gk'] ?? null };
  if (g['zn'] !== undefined) return { provider: 'azure', raw, name: g['zn'], jsonKey: g['zk'] ?? null };
  if (g['on'] !== undefined) return { provider: 'op', raw, name: g['on'], jsonKey: null };
  return { provider: 'exec', raw, name: g['en']!, jsonKey: g['ek'] ?? null };
}

/** True when the value contains at least one secret reference of any provider. */
export function hasSecretRef(value: string): boolean {
  return anyRef().test(value);
}

/** Every reference in `value`, in order (duplicates kept). */
export function findSecretRefs(value: string): SecretRef[] {
  return [...value.matchAll(anyRef())].map((m) => toRef(m[0], m.groups ?? {}));
}

/** Replace every reference in one left-to-right pass: a resolved value is never re-scanned. */
export function replaceSecretRefs(value: string, fn: (ref: SecretRef) => string): string {
  // With named groups, replace() hands the callback the groups object last.
  return value.replace(anyRef(), (...args: unknown[]) => fn(toRef(args[0] as string, args[args.length - 1] as Record<string, string | undefined>)));
}
