import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { secretProviders, type SecretProvider } from '@ninedeploy/db';
import {
  awsProviderPut,
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
  readProviderRow,
  testSecretProvider,
} from '../lib/secretProviders/index.js';
import { secretsManagerEndpoint } from '../lib/secretProviders/awsSecretsManager.js';
import { SecretProviderError, vaultBaseUrl } from '../lib/secretProviders/vault.js';

/**
 * Secret managers (0.14): HashiCorp Vault / OpenBao (KV v2) and AWS Secrets
 * Manager under `/v1/settings/secret-providers`. Operator only (its own
 * `authenticate` + `requireAdmin` hooks); the existing `settings` token scope
 * applies to the prefix. Design: .temp_files/run_0.14/DESIGN.md §4.2.
 *
 *   GET    /                list both kinds; credentials are never returned
 *   PUT    /vault | /aws    save; an omitted credential field keeps the stored value
 *   DELETE /vault | /aws    remove; references then stay literal at deploy
 *   POST   /vault/test | /aws/test   `{ok, detail}`; updates last_tested_* only
 *
 * The two kinds are spelled out as static paths (not `/:kind`) so an unknown
 * kind is a plain 404 and every route is visible to the audit/authz guards.
 * The existing `/v1/settings/vault` (Infisical / Doppler) routes and the
 * `/vault/allowlist` are unchanged; that allowlist (r510) governs every
 * provider, these included.
 */

const KINDS = ['vault', 'aws'] as const satisfies readonly SecretProviderKind[];

/** Credential fields per kind — the only keys ever stored in the envelope. */
const CREDENTIAL_FIELDS: Record<SecretProviderKind, readonly string[]> = {
  vault: ['token', 'roleId', 'secretId'],
  aws: ['accessKeyId', 'secretAccessKey', 'sessionToken'],
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
 * The credential set after a save: submitted fields win, omitted ones keep
 * the stored value — except where the stored value belonged to something
 * the save replaced (a different auth method, role id or access key id),
 * which must then come with its own secret.
 */
function mergeCredentials(
  kind: SecretProviderKind,
  stored: Record<string, string> | null,
  submitted: Record<string, string | undefined> | undefined,
  storedAuthMethod: unknown,
  nextAuthMethod: unknown,
): Record<string, string> {
  const base: Record<string, string> = {};
  const keepStored =
    stored !== null &&
    (kind === 'aws' || storedAuthMethod === nextAuthMethod) &&
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

export const secretProviderRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireAdmin);

  app.get('/', async () => {
    const rows = await app.db.query.secretProviders.findMany();
    return KINDS.map((kind) => view(kind, rows.find((r) => r.kind === kind)));
  });

  const save = async (kind: SecretProviderKind, body: unknown, userId: number) => {
    const input = kind === 'vault' ? vaultProviderPut.parse(body) : awsProviderPut.parse(body);
    // The https rule (http only with private egress) and the IMDS refusal
    // are checked here too, so a bad address is a 400 now, not a failed deploy later.
    try {
      if (kind === 'vault') vaultBaseUrl((input.config as { address: string }).address);
      else secretsManagerEndpoint(input.config as { region: string; endpoint?: string; roleSessionName: string });
    } catch (err) {
      if (err instanceof SecretProviderError) throw badRequest(err.message);
      throw err;
    }
    const existing = await readProviderRow(app.db, kind);
    const stored = existing ? decodeCredentials(existing.credentialEncrypted) : null;
    const config = input.config as Record<string, unknown>;
    const credentials = mergeCredentials(
      kind,
      stored,
      input.credentials as Record<string, string | undefined> | undefined,
      existing?.configJson?.['authMethod'],
      config['authMethod'],
    );
    if (!credentialsComplete(kind, config, credentials)) {
      const need =
        kind === 'aws'
          ? 'accessKeyId and secretAccessKey'
          : config['authMethod'] === 'approle'
            ? 'roleId and secretId'
            : 'token';
      throw badRequest(`credentials.${need.replace(' and ', ' and credentials.')} required`);
    }
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
    // Audit meta: ids and switches only, never an address path or a credential.
    const meta: Record<string, unknown> = { kind, enabled: values.enabled, created: !existing };
    if (kind === 'vault') meta['authMethod'] = config['authMethod'];
    else meta['assumeRole'] = config['roleArn'] !== undefined;
    return { view: view(kind, row), meta };
  };

  const remove = async (kind: SecretProviderKind) => {
    const deleted = await app.db.delete(secretProviders).where(eq(secretProviders.kind, kind)).returning();
    clearSecretProviderCaches();
    return { ok: true, deleted: deleted.length > 0 };
  };

  const test = async (kind: SecretProviderKind, body: unknown) => {
    const probe = secretProviderTestRequest.parse(body ?? {});
    if (kind === 'vault' && probe.probeSecretId !== undefined) throw badRequest('probeSecretId belongs to the aws provider');
    if (kind === 'aws' && probe.probePath !== undefined) throw badRequest('probePath belongs to the vault provider');
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

  app.put('/vault', async (req) => {
    const saved = await save('vault', req.body, req.user!.id);
    void audit(app.db, req.user!.id, 'settings.secret_provider.save', 'vault', saved.meta);
    return saved.view;
  });
  app.put('/aws', async (req) => {
    const saved = await save('aws', req.body, req.user!.id);
    void audit(app.db, req.user!.id, 'settings.secret_provider.save', 'aws', saved.meta);
    return saved.view;
  });
  app.delete('/vault', async (req) => {
    const result = await remove('vault');
    if (result.deleted) void audit(app.db, req.user!.id, 'settings.secret_provider.delete', 'vault', { kind: 'vault' });
    return result;
  });
  app.delete('/aws', async (req) => {
    const result = await remove('aws');
    if (result.deleted) void audit(app.db, req.user!.id, 'settings.secret_provider.delete', 'aws', { kind: 'aws' });
    return result;
  });
  app.post('/vault/test', async (req) => test('vault', req.body));
  app.post('/aws/test', async (req) => test('aws', req.body));
};
