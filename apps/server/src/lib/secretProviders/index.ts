import { eq } from 'drizzle-orm';
import { secretProviders, type DB, type SecretProvider } from '@ninedeploy/db';
import { awsProviderConfig, vaultProviderConfig, type SecretProviderKind } from '@ninedeploy/schemas';
import { decrypt } from '../crypto.js';
import { SECRET_REF_LIMITS, type ExternalSecretRef } from '../secretRefs.js';
import {
  clearAwsCredentialCache,
  getParameter,
  getSecretString,
  jsonSecretKey,
  testAwsProvider,
  type AwsClientConfig,
  type AwsCredentials,
} from './awsSecretsManager.js';
import { azureDriver } from './azure.js';
import { execDriver } from './exec.js';
import { gcpDriver } from './gcp.js';
import { NAMED_KINDS, type NamedKind, type NamedSecretDriver } from './named.js';
import { onePasswordDriver } from './onePassword.js';
import {
  clearVaultTokenCache,
  kvFieldValue,
  readKv2,
  SecretProviderError,
  testVaultProvider,
  type VaultClientConfig,
  type VaultCredentials,
} from './vault.js';

/**
 * Secret managers (0.14): the `secret_providers` table (one row per kind) and
 * deploy-time resolution of `${{vault:…#…}}` / `${{aws:…}}` references.
 * Called from `resolveVaultRefs` (`lib/vault.ts`), which owns the r510 gate.
 *
 * G3.2 added `${{ssm:…}}` (Parameter Store, read with the aws row) and the
 * named kinds — gcp, azure, onepassword, exec — each a `NamedSecretDriver`.
 *
 * A row is "configured" only when it is enabled, its config parses and its
 * credential envelope opens to a complete credential set. Anything else — no
 * row, disabled, an envelope this key ring cannot open — reads as not
 * configured, never as an error: references stay literal (DESIGN §4.1).
 */

export { SecretProviderError } from './vault.js';

export const NAMED_DRIVERS: Record<NamedKind, NamedSecretDriver> = {
  gcp: gcpDriver as unknown as NamedSecretDriver,
  azure: azureDriver as unknown as NamedSecretDriver,
  onepassword: onePasswordDriver as unknown as NamedSecretDriver,
  exec: execDriver as unknown as NamedSecretDriver,
};

export const isNamedKind = (kind: string): kind is NamedKind => (NAMED_KINDS as readonly string[]).includes(kind);

export type ConfiguredProvider =
  | { kind: 'vault'; row: SecretProvider; config: VaultClientConfig; credentials: VaultCredentials; cacheKey: string }
  | { kind: 'aws'; row: SecretProvider; config: AwsClientConfig; credentials: AwsCredentials; cacheKey: string }
  | {
      kind: NamedKind;
      row: SecretProvider;
      config: Record<string, unknown>;
      credentials: Record<string, string>;
      cacheKey: string;
      driver: NamedSecretDriver;
    };

/** The provider row a reference reads with: `ssm` uses the aws row, `op` the onepassword row. */
export function providerKindFor(ref: ExternalSecretRef): SecretProviderKind {
  switch (ref.provider) {
    case 'ssm':
      return 'aws';
    case 'op':
      return 'onepassword';
    default:
      return ref.provider;
  }
}

/** The name a reference's source goes by in deploy logs and errors. */
export function refSourceLabel(ref: ExternalSecretRef): string {
  switch (ref.provider) {
    case 'vault':
      return 'Vault';
    case 'aws':
      return 'AWS Secrets Manager';
    case 'ssm':
      return 'AWS Parameter Store';
    case 'op':
      return NAMED_DRIVERS.onepassword.label;
    default:
      return NAMED_DRIVERS[ref.provider].label;
  }
}

export async function readProviderRow(db: DB, kind: SecretProviderKind): Promise<SecretProvider | undefined> {
  return db.query.secretProviders.findFirst({ where: eq(secretProviders.kind, kind) });
}

/** The decrypted credential object, or null when the envelope cannot be opened or is malformed. */
export function decodeCredentials(envelope: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypt(envelope));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

/** Whether a credential set is complete for the kind / auth method. */
export function credentialsComplete(kind: SecretProviderKind, config: Record<string, unknown>, creds: Record<string, string>): boolean {
  if (isNamedKind(kind)) return NAMED_DRIVERS[kind].requiredCredentials.every((f) => !!creds[f]);
  if (kind === 'aws') return !!creds['accessKeyId'] && !!creds['secretAccessKey'];
  return config['authMethod'] === 'approle' ? !!creds['roleId'] && !!creds['secretId'] : !!creds['token'];
}

/** Cache key for in-memory tokens: a saved change (new updatedAt) or a new row never reuses one. */
export const providerCacheKey = (row: Pick<SecretProvider, 'id' | 'updatedAt'>): string =>
  `${row.id}:${row.updatedAt instanceof Date ? row.updatedAt.getTime() : String(row.updatedAt)}`;

/** A row as a usable provider, or null when it is not configured (see the module comment). */
export function asConfigured(row: SecretProvider | undefined): ConfiguredProvider | null {
  if (!row || !row.enabled) return null;
  const creds = decodeCredentials(row.credentialEncrypted);
  if (!creds) return null;
  const cacheKey = providerCacheKey(row);
  if (isNamedKind(row.kind)) {
    const driver = NAMED_DRIVERS[row.kind];
    const config = driver.parseConfig(row.configJson);
    if (!config || !credentialsComplete(row.kind, config, creds)) return null;
    return { kind: row.kind, row, config, credentials: creds, cacheKey, driver };
  }
  if (row.kind === 'vault') {
    const parsed = vaultProviderConfig.safeParse(row.configJson);
    if (!parsed.success || !credentialsComplete('vault', parsed.data, creds)) return null;
    return {
      kind: 'vault',
      row,
      config: parsed.data,
      credentials: { token: creds['token'], roleId: creds['roleId'], secretId: creds['secretId'] },
      cacheKey,
    };
  }
  const parsed = awsProviderConfig.safeParse(row.configJson);
  if (!parsed.success || !credentialsComplete('aws', parsed.data, creds)) return null;
  return {
    kind: 'aws',
    row,
    config: parsed.data,
    credentials: { accessKeyId: creds['accessKeyId'], secretAccessKey: creds['secretAccessKey'], sessionToken: creds['sessionToken'] },
    cacheKey,
  };
}

export async function loadConfiguredProvider(db: DB, kind: SecretProviderKind): Promise<ConfiguredProvider | null> {
  return asConfigured(await readProviderRow(db, kind));
}

/** Drop cached AppRole tokens, assumed-role sessions and access tokens (a provider was saved or deleted). */
export function clearSecretProviderCaches(): void {
  clearVaultTokenCache();
  clearAwsCredentialCache();
  for (const driver of Object.values(NAMED_DRIVERS)) driver.clearCache();
}

/** Where a reference's value is fetched from: one call per distinct path / secret id / name. */
const fetchKey = (ref: ExternalSecretRef): string =>
  ref.provider === 'vault' ? `vault ${ref.path}` : ref.provider === 'aws' ? `aws ${ref.secretId}` : `${ref.provider} ${ref.name}`;

async function fetchSource(
  provider: ConfiguredProvider,
  ref: ExternalSecretRef,
  signal: AbortSignal,
): Promise<Record<string, unknown> | string> {
  if (provider.kind === 'vault' && ref.provider === 'vault') {
    return readKv2(provider.config, provider.credentials, ref.path, { cacheKey: provider.cacheKey, signal });
  }
  if (provider.kind === 'aws' && ref.provider === 'aws') {
    return getSecretString(provider.config, provider.credentials, ref.secretId, { cacheKey: provider.cacheKey, signal });
  }
  if (provider.kind === 'aws' && ref.provider === 'ssm') {
    return getParameter(provider.config, provider.credentials, ref.name, { cacheKey: provider.cacheKey, signal });
  }
  if (isNamedKind(provider.kind) && 'driver' in provider && ref.provider !== 'vault' && ref.provider !== 'aws' && ref.provider !== 'ssm') {
    if (providerKindFor(ref) !== provider.kind) throw new SecretProviderError(`A ${ref.provider} reference cannot be read from the ${provider.kind} provider`);
    provider.driver.validate(provider.config);
    return provider.driver.read(provider.config, provider.credentials, ref.name, { cacheKey: provider.cacheKey, signal });
  }
  throw new SecretProviderError(`A ${ref.provider} reference cannot be read from the ${provider.kind} provider`);
}

/**
 * Resolve external references against configured providers. Each distinct
 * path, secret id or name is fetched once; every call gets 15 s and all of
 * them together 60 s. Returns raw reference → value. A missing field / key,
 * an oversized value or any provider error throws (the deploy fails rather
 * than starting with a half-resolved environment). Messages name the env key
 * and the provider, never the path, the secret id or a credential.
 *
 * `refs` maps each distinct raw reference to the env keys that use it;
 * `providers` holds the loaded row of each kind (see `providerKindFor`).
 */
export async function resolveExternalRefs(
  providers: Partial<Record<SecretProviderKind, ConfiguredProvider | null>>,
  refs: Map<string, { ref: ExternalSecretRef; envKeys: string[] }>,
  limits: { callTimeoutMs?: number; totalTimeoutMs?: number } = {},
): Promise<Map<string, string>> {
  if (refs.size > SECRET_REF_LIMITS.maxRefs) {
    throw new SecretProviderError(
      `This deploy references ${refs.size} distinct external secrets; at most ${SECRET_REF_LIMITS.maxRefs} are resolved per deploy`,
    );
  }
  const total = AbortSignal.timeout(limits.totalTimeoutMs ?? SECRET_REF_LIMITS.totalTimeoutMs);
  const callSignal = () => AbortSignal.any([total, AbortSignal.timeout(limits.callTimeoutMs ?? SECRET_REF_LIMITS.callTimeoutMs)]);
  const fetched = new Map<string, Record<string, unknown> | string>();
  const out = new Map<string, string>();
  for (const [raw, { ref, envKeys }] of refs) {
    const where = `env key ${envKeys.join(', ')}`;
    const label = refSourceLabel(ref);
    const provider = providers[providerKindFor(ref)];
    if (!provider) continue; // not configured: the caller keeps it literal
    const key = fetchKey(ref);
    let source = fetched.get(key);
    if (source === undefined) {
      if (total.aborted) {
        throw new SecretProviderError(`Resolving secret references took longer than ${(limits.totalTimeoutMs ?? SECRET_REF_LIMITS.totalTimeoutMs) / 1000} s`);
      }
      try {
        source = await fetchSource(provider, ref, callSignal());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new SecretProviderError(`${label} reference (${where}): ${message}`);
      }
      fetched.set(key, source);
    }
    let value: string | undefined;
    if (ref.provider === 'vault') {
      value = kvFieldValue(source as Record<string, unknown>, ref.field);
      if (value === undefined) throw new SecretProviderError(`Vault secret field "${ref.field}" not found (${where})`);
    } else if (ref.jsonKey !== null) {
      try {
        value = jsonSecretKey(source as string, ref.jsonKey);
      } catch (err) {
        throw new SecretProviderError(`${label} reference (${where}): ${(err as Error).message}`);
      }
      if (value === undefined) {
        throw new SecretProviderError(`${ref.provider === 'aws' ? 'AWS secret' : label} key "${ref.jsonKey}" not found (${where})`);
      }
    } else {
      value = source as string;
    }
    if (Buffer.byteLength(value, 'utf8') > SECRET_REF_LIMITS.maxValueBytes) {
      throw new SecretProviderError(`A resolved secret is larger than ${SECRET_REF_LIMITS.maxValueBytes / 1024} KiB (${where})`);
    }
    out.set(raw, value);
  }
  return out;
}

/** POST /:kind/test — `{ok, detail}`; never throws. */
export async function testSecretProvider(
  provider: ConfiguredProvider,
  probe: { probePath?: string; probeSecretId?: string; probeParameter?: string; probeName?: string },
): Promise<{ ok: boolean; detail: string }> {
  const signal = AbortSignal.timeout(SECRET_REF_LIMITS.callTimeoutMs);
  try {
    let detail: string;
    if (provider.kind === 'vault') {
      detail = await testVaultProvider(provider.config, provider.credentials, { cacheKey: provider.cacheKey, signal, probePath: probe.probePath });
    } else if (provider.kind === 'aws') {
      detail = await testAwsProvider(provider.config, provider.credentials, {
        cacheKey: provider.cacheKey,
        signal,
        probeSecretId: probe.probeSecretId,
      });
      if (probe.probeParameter) {
        await getParameter(provider.config, provider.credentials, probe.probeParameter, { cacheKey: provider.cacheKey, signal });
        detail += '; probe parameter readable';
      }
    } else {
      provider.driver.validate(provider.config);
      detail = await provider.driver.test(provider.config, provider.credentials, { cacheKey: provider.cacheKey, signal, probeName: probe.probeName });
    }
    return { ok: true, detail };
  } catch (err) {
    const message = err instanceof SecretProviderError ? err.message : 'the provider call failed';
    return { ok: false, detail: message.slice(0, 500) };
  }
}
