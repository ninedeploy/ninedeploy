import { eq } from 'drizzle-orm';
import { secretProviders, type DB, type SecretProvider } from '@ninedeploy/db';
import { awsProviderConfig, vaultProviderConfig, type SecretProviderKind } from '@ninedeploy/schemas';
import { decrypt } from '../crypto.js';
import { SECRET_REF_LIMITS, type ExternalSecretRef } from '../secretRefs.js';
import {
  clearAwsCredentialCache,
  getSecretString,
  jsonSecretKey,
  testAwsProvider,
  type AwsClientConfig,
  type AwsCredentials,
} from './awsSecretsManager.js';
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
 * A row is "configured" only when it is enabled, its config parses and its
 * credential envelope opens to a complete credential set. Anything else — no
 * row, disabled, an envelope this key ring cannot open — reads as not
 * configured, never as an error: references stay literal (DESIGN §4.1).
 */

export { SecretProviderError } from './vault.js';

export type ConfiguredProvider =
  | { kind: 'vault'; row: SecretProvider; config: VaultClientConfig; credentials: VaultCredentials; cacheKey: string }
  | { kind: 'aws'; row: SecretProvider; config: AwsClientConfig; credentials: AwsCredentials; cacheKey: string };

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

/** Drop cached AppRole tokens and assumed-role sessions (a provider was saved or deleted). */
export function clearSecretProviderCaches(): void {
  clearVaultTokenCache();
  clearAwsCredentialCache();
}

/** Where a reference's value is fetched from: one call per distinct path / secret id. */
const fetchKey = (ref: ExternalSecretRef): string => (ref.provider === 'vault' ? `vault ${ref.path}` : `aws ${ref.secretId}`);

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
  throw new SecretProviderError(`A ${ref.provider} reference cannot be read from the ${provider.kind} provider`);
}

/**
 * Resolve vault/aws references against configured providers. Each distinct
 * path or secret id is fetched once; every call gets 15 s and all of them
 * together 60 s. Returns raw reference → value. A missing field / key, an
 * oversized value or any provider error throws (the deploy fails rather than
 * starting with a half-resolved environment). Messages name the env key and
 * the provider, never the path, the secret id or a credential.
 *
 * `refs` maps each distinct raw reference to the env keys that use it.
 */
export async function resolveExternalRefs(
  providers: { vault?: ConfiguredProvider | null; aws?: ConfiguredProvider | null },
  refs: Map<string, { ref: ExternalSecretRef; envKeys: string[] }>,
  limits: { callTimeoutMs?: number; totalTimeoutMs?: number } = {},
): Promise<Map<string, string>> {
  if (refs.size > SECRET_REF_LIMITS.maxRefs) {
    throw new SecretProviderError(
      `This deploy references ${refs.size} distinct vault/aws secrets; at most ${SECRET_REF_LIMITS.maxRefs} are resolved per deploy`,
    );
  }
  const total = AbortSignal.timeout(limits.totalTimeoutMs ?? SECRET_REF_LIMITS.totalTimeoutMs);
  const callSignal = () => AbortSignal.any([total, AbortSignal.timeout(limits.callTimeoutMs ?? SECRET_REF_LIMITS.callTimeoutMs)]);
  const fetched = new Map<string, Record<string, unknown> | string>();
  const out = new Map<string, string>();
  for (const [raw, { ref, envKeys }] of refs) {
    const where = `env key ${envKeys.join(', ')}`;
    const provider = ref.provider === 'vault' ? providers.vault : providers.aws;
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
        throw new SecretProviderError(`${ref.provider === 'vault' ? 'Vault' : 'AWS Secrets Manager'} reference (${where}): ${message}`);
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
        throw new SecretProviderError(`AWS Secrets Manager reference (${where}): ${(err as Error).message}`);
      }
      if (value === undefined) throw new SecretProviderError(`AWS secret key "${ref.jsonKey}" not found (${where})`);
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
  probe: { probePath?: string; probeSecretId?: string },
): Promise<{ ok: boolean; detail: string }> {
  const signal = AbortSignal.timeout(SECRET_REF_LIMITS.callTimeoutMs);
  try {
    const detail =
      provider.kind === 'vault'
        ? await testVaultProvider(provider.config, provider.credentials, { cacheKey: provider.cacheKey, signal, probePath: probe.probePath })
        : await testAwsProvider(provider.config, provider.credentials, {
            cacheKey: provider.cacheKey,
            signal,
            probeSecretId: probe.probeSecretId,
          });
    return { ok: true, detail };
  } catch (err) {
    const message = err instanceof SecretProviderError ? err.message : 'the provider call failed';
    return { ok: false, detail: message.slice(0, 500) };
  }
}
