import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { secretProviders, type SecretProvider } from '@ninedeploy/db';
import {
  awsProviderPut,
  azureProviderPut,
  execProviderPut,
  gcpProviderPut,
  onePasswordProviderPut,
  secretProviderKind,
  secretProviderTestRequest,
  vaultProviderPut,
  type SecretProviderKind,
  type SecretProviderView,
} from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { encrypt } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import {
  asConfigured,
  clearSecretProviderCaches,
  credentialsComplete,
  decodeCredentials,
  isNamedKind,
  NAMED_DRIVERS,
  readProviderRow,
  testSecretProvider,
} from '../lib/secretProviders/index.js';
import { secretsManagerEndpoint } from '../lib/secretProviders/awsSecretsManager.js';
import { SecretProviderError, vaultBaseUrl } from '../lib/secretProviders/vault.js';

/**
 * Secret managers (0.14): HashiCorp Vault / OpenBao (KV v2) and AWS Secrets
 * Manager under `/v1/settings/secret-providers`; G3.2 added GCP Secret
 * Manager, Azure Key Vault, 1Password Connect and the exec command (and
 * Parameter Store, which reads with the aws row). Operator only (its own
 * `authenticate` + `requireAdmin` hooks); the existing `settings` token scope
 * applies to the prefix. Design: .temp_files/run_0.14/DESIGN.md §4.2.
 *
 *   GET    /             list every kind; credentials are never returned
 *   PUT    /<kind>       save; an omitted credential field keeps the stored value
 *   DELETE /<kind>       remove; references then stay literal at deploy
 *   POST   /<kind>/test  `{ok, detail}`; updates last_tested_* only
 *
 * Each kind gets its own static paths (not `/:kind`) so an unknown kind is a
 * plain 404 and every route is visible to the audit/authz guards. The
 * existing `/v1/settings/vault` (Infisical / Doppler) routes and the
 * `/vault/allowlist` are unchanged; that allowlist (r510) governs every
 * provider, these included.
 */

const KINDS = secretProviderKind.options;

/** Credential fields per kind — the only keys ever stored in the envelope. */
const CREDENTIAL_FIELDS: Record<SecretProviderKind, readonly string[]> = {
  vault: ['token', 'roleId', 'secretId'],
  aws: ['accessKeyId', 'secretAccessKey', 'sessionToken'],
  gcp: NAMED_DRIVERS.gcp.credentialFields,
  azure: NAMED_DRIVERS.azure.credentialFields,
  onepassword: NAMED_DRIVERS.onepassword.credentialFields,
  exec: NAMED_DRIVERS.exec.credentialFields,
};

const PUT_SCHEMAS = {
  vault: vaultProviderPut,
  aws: awsProviderPut,
  gcp: gcpProviderPut,
  azure: azureProviderPut,
  onepassword: onePasswordProviderPut,
  exec: execProviderPut,
} as const;

/** Which probe field each kind's test takes. */
const PROBE_FIELDS: Record<SecretProviderKind, ReadonlyArray<'probePath' | 'probeSecretId' | 'probeParameter' | 'probeName'>> = {
  vault: ['probePath'],
  aws: ['probeSecretId', 'probeParameter'],
  gcp: ['probeName'],
  azure: ['probeName'],
  onepassword: ['probeName'],
  exec: ['probeName'],
};

function view(kind: SecretProviderKind, row: SecretProvider | undefined): SecretProviderView {
  if (!row) {
    return { kind, configured: false, enabled: false, config: {}, hasCredential: false, lastTestedAt: null, lastTestError: null };
  }
  const creds = decodeCredentials(row.credentialEncrypted);
  return {
    kind,
    // Undecryptable envelope, disabled row or incomplete set: not configured (never a 500).
    configured: asConfigured(row) !== null,
    enabled: row.enabled,
    config: row.configJson ?? {},
    hasCredential: creds !== null && credentialsComplete(kind, row.configJson ?? {}, creds),
    lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
    lastTestError: row.lastTestError ?? null,
  };
}

/**
 * Where the stored credential is sent: the Vault address, a custom Secrets
 * Manager endpoint (the AWS default endpoints are AWS's own whatever the
 * region), or what the named driver reports. null when the config does not
 * name a usable one.
 */
function credentialTarget(kind: SecretProviderKind, config: Record<string, unknown> | null | undefined): string | null {
  try {
    if (isNamedKind(kind)) {
      const driver = NAMED_DRIVERS[kind];
      const parsed = driver.parseConfig(config ?? {});
      return parsed ? driver.target(parsed) : null;
    }
    if (kind === 'vault') return vaultBaseUrl(String(config?.['address'] ?? ''));
    return config?.['endpoint'] ? secretsManagerEndpoint(config as { region: string; endpoint?: string; roleSessionName: string }) : 'aws';
  } catch {
    return null;
  }
}

/**
 * The credential set after a save: submitted fields win, omitted ones keep
 * the stored value — except where the stored value belonged to something
 * the save replaced (a different auth method, role id, access key id, or the
 * address it would be sent to), which must then come with its own secret: an
 * operator can never read a stored credential, so repointing the provider at
 * another server must not carry it along.
 */
function mergeCredentials(
  kind: SecretProviderKind,
  stored: Record<string, string> | null,
  submitted: Record<string, string | undefined> | undefined,
  storedAuthMethod: unknown,
  nextAuthMethod: unknown,
  sameTarget: boolean,
): Record<string, string> {
  const base: Record<string, string> = {};
  const keepStored =
    stored !== null &&
    sameTarget &&
    (kind !== 'vault' || storedAuthMethod === nextAuthMethod) &&
    !(kind === 'aws' && submitted?.['accessKeyId'] && submitted['accessKeyId'] !== stored['accessKeyId']) &&
    !(kind === 'vault' && submitted?.['roleId'] && submitted['roleId'] !== stored['roleId']);
  // A new access key id never inherits the old key's secret or session token.
  if (keepStored) {
    for (const field of CREDENTIAL_FIELDS[kind]) if (stored[field]) base[field] = stored[field];
  }
  for (const field of CREDENTIAL_FIELDS[kind]) {
    const value = submitted?.[field];
    if (value !== undefined) base[field] = value;
  }
  if (kind === 'vault') {
    // Only the chosen auth method's fields are kept.
    if (nextAuthMethod === 'approle') delete base['token'];
    else {
      delete base['roleId'];
      delete base['secretId'];
    }
  }
  return base;
}

/** The https rule, the IMDS refusal, the exec opt-in: a bad config is a 400 now, not a failed deploy later. */
function checkConfig(kind: SecretProviderKind, config: Record<string, unknown>): void {
  if (isNamedKind(kind)) {
    const driver = NAMED_DRIVERS[kind];
    const parsed = driver.parseConfig(config);
    if (!parsed) throw new SecretProviderError(`Invalid ${kind} settings`);
    driver.validate(parsed);
  } else if (kind === 'vault') vaultBaseUrl((config as { address: string }).address);
  else secretsManagerEndpoint(config as { region: string; endpoint?: string; roleSessionName: string });
}

function missingCredentials(kind: SecretProviderKind, config: Record<string, unknown>): string {
  if (isNamedKind(kind)) return NAMED_DRIVERS[kind].requiredCredentials.map((f) => `credentials.${f}`).join(' and ');
  if (kind === 'aws') return 'credentials.accessKeyId and credentials.secretAccessKey';
  return config['authMethod'] === 'approle' ? 'credentials.roleId and credentials.secretId' : 'credentials.token';
}

export const secretProviderRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireAdmin);

  app.get('/', async () => {
    const rows = await app.db.query.secretProviders.findMany();
    return KINDS.map((kind) => view(kind, rows.find((r) => r.kind === kind)));
  });

  const save = async (kind: SecretProviderKind, body: unknown, userId: number) => {
    const input = PUT_SCHEMAS[kind].parse(body) as { enabled?: boolean; config: Record<string, unknown>; credentials?: Record<string, string | undefined> };
    try {
      checkConfig(kind, input.config);
    } catch (err) {
      if (err instanceof SecretProviderError) throw badRequest(err.message);
      throw err;
    }
    const existing = await readProviderRow(app.db, kind);
    const stored = existing ? decodeCredentials(existing.credentialEncrypted) : null;
    const config = input.config;
    const credentials = mergeCredentials(
      kind,
      stored,
      input.credentials,
      existing?.configJson?.['authMethod'],
      config['authMethod'],
      !existing || (credentialTarget(kind, existing.configJson) !== null && credentialTarget(kind, existing.configJson) === credentialTarget(kind, config)),
    );
    if (!credentialsComplete(kind, config, credentials)) throw badRequest(`${missingCredentials(kind, config)} required`);
    const values = {
      enabled: input.enabled ?? existing?.enabled ?? true,
      configJson: config,
      credentialEncrypted: encrypt(JSON.stringify(credentials)),
      // The previous test result described the previous settings.
      lastTestedAt: null,
      lastTestError: null,
      updatedAt: new Date(),
    };
    const row = existing
      ? (await app.db.update(secretProviders).set(values).where(eq(secretProviders.id, existing.id)).returning())[0]
      : (await app.db.insert(secretProviders).values({ kind, createdByUserId: userId, ...values }).returning())[0];
    clearSecretProviderCaches();
    // Audit meta: ids and switches only, never an address path, a command or a credential.
    const meta: Record<string, unknown> = { kind, enabled: values.enabled, created: !existing };
    if (kind === 'vault') meta['authMethod'] = config['authMethod'];
    else if (kind === 'aws') meta['assumeRole'] = config['roleArn'] !== undefined;
    return { view: view(kind, row), meta };
  };

  const remove = async (kind: SecretProviderKind) => {
    const deleted = await app.db.delete(secretProviders).where(eq(secretProviders.kind, kind)).returning();
    clearSecretProviderCaches();
    return { ok: true, deleted: deleted.length > 0 };
  };

  const test = async (kind: SecretProviderKind, body: unknown) => {
    const probe = secretProviderTestRequest.parse(body ?? {});
    for (const [field, value] of Object.entries(probe)) {
      if (value !== undefined && !PROBE_FIELDS[kind].includes(field as never)) {
        throw badRequest(`${field} does not belong to the ${kind} provider`);
      }
    }
    const row = await readProviderRow(app.db, kind);
    const provider = asConfigured(row);
    if (!row || !provider) {
      const detail = !row
        ? `No ${kind} secret manager is configured`
        : !row.enabled
          ? `The ${kind} secret manager is disabled`
          : `The ${kind} secret manager is not configured: its stored credentials cannot be read (re-enter them)`;
      return { ok: false, detail };
    }
    const result = await testSecretProvider(provider, probe);
    await app.db
      .update(secretProviders)
      .set({ lastTestedAt: new Date(), lastTestError: result.ok ? null : result.detail })
      .where(eq(secretProviders.id, row.id));
    return result;
  };

  // Spelled out per kind, not looped: the r222 audit-coverage guard and the
  // authz matrix read literal paths, and a looped route would hide from both.
  const saveRoute = async (kind: SecretProviderKind, req: { body: unknown; user?: { id: number } | null }) => {
    const saved = await save(kind, req.body, req.user!.id);
    return { saved, userId: req.user!.id };
  };
  const removeRoute = async (kind: SecretProviderKind) => remove(kind);

  app.put('/vault', async (req) => {
    const { saved, userId } = await saveRoute('vault', req);
    void audit(app.db, userId, 'settings.secret_provider.save', 'vault', saved.meta);
    return saved.view;
  });
  app.put('/aws', async (req) => {
    const { saved, userId } = await saveRoute('aws', req);
    void audit(app.db, userId, 'settings.secret_provider.save', 'aws', saved.meta);
    return saved.view;
  });
  app.put('/gcp', async (req) => {
    const { saved, userId } = await saveRoute('gcp', req);
    void audit(app.db, userId, 'settings.secret_provider.save', 'gcp', saved.meta);
    return saved.view;
  });
  app.put('/azure', async (req) => {
    const { saved, userId } = await saveRoute('azure', req);
    void audit(app.db, userId, 'settings.secret_provider.save', 'azure', saved.meta);
    return saved.view;
  });
  app.put('/onepassword', async (req) => {
    const { saved, userId } = await saveRoute('onepassword', req);
    void audit(app.db, userId, 'settings.secret_provider.save', 'onepassword', saved.meta);
    return saved.view;
  });
  app.put('/exec', async (req) => {
    const { saved, userId } = await saveRoute('exec', req);
    void audit(app.db, userId, 'settings.secret_provider.save', 'exec', saved.meta);
    return saved.view;
  });
  app.delete('/vault', async (req) => {
    const result = await removeRoute('vault');
    if (result.deleted) void audit(app.db, req.user!.id, 'settings.secret_provider.delete', 'vault', { kind: 'vault' });
    return result;
  });
  app.delete('/aws', async (req) => {
    const result = await removeRoute('aws');
    if (result.deleted) void audit(app.db, req.user!.id, 'settings.secret_provider.delete', 'aws', { kind: 'aws' });
    return result;
  });
  app.delete('/gcp', async (req) => {
    const result = await removeRoute('gcp');
    if (result.deleted) void audit(app.db, req.user!.id, 'settings.secret_provider.delete', 'gcp', { kind: 'gcp' });
    return result;
  });
  app.delete('/azure', async (req) => {
    const result = await removeRoute('azure');
    if (result.deleted) void audit(app.db, req.user!.id, 'settings.secret_provider.delete', 'azure', { kind: 'azure' });
    return result;
  });
  app.delete('/onepassword', async (req) => {
    const result = await removeRoute('onepassword');
    if (result.deleted) void audit(app.db, req.user!.id, 'settings.secret_provider.delete', 'onepassword', { kind: 'onepassword' });
    return result;
  });
  app.delete('/exec', async (req) => {
    const result = await removeRoute('exec');
    if (result.deleted) void audit(app.db, req.user!.id, 'settings.secret_provider.delete', 'exec', { kind: 'exec' });
    return result;
  });
  app.post('/vault/test', async (req) => test('vault', req.body));
  app.post('/aws/test', async (req) => test('aws', req.body));
  app.post('/gcp/test', async (req) => test('gcp', req.body));
  app.post('/azure/test', async (req) => test('azure', req.body));
  app.post('/onepassword/test', async (req) => test('onepassword', req.body));
  app.post('/exec/test', async (req) => test('exec', req.body));
};
