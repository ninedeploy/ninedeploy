import { readFileSync } from 'node:fs';
import process from 'node:process';
import type { AwsProviderPut, SecretProviderKind, SecretProviderView, VaultProviderPut } from '@ninedeploy/sdk';
import type { NineDeployClient } from '../client.js';
import { prompt } from '../prompts.js';
import { c, error, fmtTime, header, info, kv, spinner, success, table } from '../lib/format.js';
import { plain } from './sources.js';

/**
 * 0.14: HashiCorp Vault / OpenBao and AWS Secrets Manager —
 * `ninedeploy secrets providers list|set-vault|set-aws|test|delete`.
 * Operator only on the server.
 *
 * Secrets never travel on argv (they would land in shell history and `ps`):
 * a Vault token, AppRole role/secret id, AWS secret access key and session
 * token come from a file (`--token-file`, …) or an environment variable.
 * The AWS access key id is an identifier and may be passed as a flag. An
 * omitted credential keeps the stored value. Provider detail and test errors
 * are relayed provider text, so they pass through the F1011 sanitiser.
 */

export const VAULT_TOKEN_ENV = 'NINEDEPLOY_VAULT_TOKEN';
export const VAULT_ROLE_ID_ENV = 'NINEDEPLOY_VAULT_ROLE_ID';
export const VAULT_SECRET_ID_ENV = 'NINEDEPLOY_VAULT_SECRET_ID';
export const AWS_ACCESS_KEY_ID_ENV = 'NINEDEPLOY_AWS_ACCESS_KEY_ID';
export const AWS_SECRET_ACCESS_KEY_ENV = 'NINEDEPLOY_AWS_SECRET_ACCESS_KEY';
export const AWS_SESSION_TOKEN_ENV = 'NINEDEPLOY_AWS_SESSION_TOKEN';

const message = (err: unknown): string => plain(err instanceof Error ? err.message : String(err));

/** A secret from `file`, else the environment variable `env`; undefined when neither is set. */
function readSecret(file: string | undefined, env: string): string | undefined {
  if (file) return readFileSync(file, 'utf8').trim() || undefined;
  return process.env[env]?.trim() || undefined;
}

function parseKind(raw: string | undefined): SecretProviderKind | null {
  return raw === 'vault' || raw === 'aws' ? raw : null;
}

function enabledFrom(opts: { enable?: boolean; disable?: boolean }): { enabled?: boolean } | null {
  if (opts.enable && opts.disable) return null;
  if (opts.enable) return { enabled: true };
  if (opts.disable) return { enabled: false };
  return {};
}

const configText = (config: Record<string, unknown>): string => {
  const entries = Object.entries(config);
  return entries.length > 0 ? entries.map(([k, v]) => `${plain(k)}=${plain(typeof v === 'string' ? v : JSON.stringify(v))}`).join(' ') : '—';
};

function printView(v: SecretProviderView): void {
  kv('Configured', v.configured ? c.green('yes') : c.gray('no'));
  kv('Enabled', v.enabled ? 'yes' : 'no');
  kv('Credentials', v.hasCredential ? 'stored' : c.yellow('missing'));
  kv('Settings', configText(v.config));
}

/** `ninedeploy secrets providers list` */
export async function secretProvidersList(client: NineDeployClient): Promise<void> {
  try {
    const rows = await spinner('Reading secret managers', () => client.settings.secretProviders.list());
    header('Secret managers');
    table(
      rows.map((r) => ({
        kind: r.kind,
        configured: r.configured ? c.green('yes') : c.gray('no'),
        enabled: r.enabled ? 'yes' : 'no',
        credentials: r.hasCredential ? 'stored' : c.dim('—'),
        tested: fmtTime(r.lastTestedAt),
        lastError: r.lastTestError ? c.red(plain(r.lastTestError).slice(0, 80)) : '',
        settings: configText(r.config),
      })),
      ['kind', 'configured', 'enabled', 'credentials', 'tested', 'lastError', 'settings'],
    );
    info(`Reference syntax: \${{vault:<path>#<field>}} and \${{aws:<secretId>}} or \${{aws:<secretId>#<jsonKey>}}`);
  } catch (err) {
    error(message(err));
  }
}

export interface VaultCliOptions {
  address?: string;
  namespace?: string;
  mount?: string;
  auth?: string;
  approleMount?: string;
  tokenFile?: string;
  roleIdFile?: string;
  secretIdFile?: string;
  enable?: boolean;
  disable?: boolean;
}

/** `ninedeploy secrets providers set-vault --address <url> [--auth token|approle] ...` */
export async function secretProvidersSetVault(client: NineDeployClient, opts: VaultCliOptions = {}): Promise<void> {
  const address = opts.address?.trim();
  if (!address) return error('Usage: ninedeploy secrets providers set-vault --address <https://vault…> [--auth token|approle] [--token-file <path>]');
  const authMethod = opts.auth ?? 'token';
  if (authMethod !== 'token' && authMethod !== 'approle') return error('--auth must be "token" or "approle"');
  const enabled = enabledFrom(opts);
  if (!enabled) return error('--enable and --disable cannot be combined');
  const credentials: NonNullable<VaultProviderPut['credentials']> = {};
  try {
    if (authMethod === 'token') {
      const token = readSecret(opts.tokenFile, VAULT_TOKEN_ENV);
      if (token) credentials.token = token;
    } else {
      const roleId = readSecret(opts.roleIdFile, VAULT_ROLE_ID_ENV);
      const secretId = readSecret(opts.secretIdFile, VAULT_SECRET_ID_ENV);
      if (roleId) credentials.roleId = roleId;
      if (secretId) credentials.secretId = secretId;
    }
  } catch (err) {
    return error(`Could not read a credential file: ${message(err)}`);
  }
  const input: VaultProviderPut = {
    ...enabled,
    config: {
      address,
      authMethod,
      ...(opts.namespace ? { namespace: opts.namespace } : {}),
      ...(opts.mount ? { mount: opts.mount } : {}),
      ...(opts.approleMount ? { approleMount: opts.approleMount } : {}),
    },
    ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
  };
  try {
    const view = await spinner('Saving the Vault settings', () => client.settings.secretProviders.set('vault', input));
    success('Vault / OpenBao saved');
    printView(view);
    info('Run `ninedeploy secrets providers test vault` to check the connection.');
  } catch (err) {
    error(message(err));
  }
}

export interface AwsCliOptions {
  region?: string;
  endpoint?: string;
  roleArn?: string;
  externalId?: string;
  roleSessionName?: string;
  accessKeyId?: string;
  secretAccessKeyFile?: string;
  sessionTokenFile?: string;
  enable?: boolean;
  disable?: boolean;
}

/** `ninedeploy secrets providers set-aws --region <region> ...` */
export async function secretProvidersSetAws(client: NineDeployClient, opts: AwsCliOptions = {}): Promise<void> {
  const region = opts.region?.trim();
  if (!region) return error('Usage: ninedeploy secrets providers set-aws --region <region> [--access-key-id <id>] [--secret-access-key-file <path>]');
  const enabled = enabledFrom(opts);
  if (!enabled) return error('--enable and --disable cannot be combined');
  const credentials: NonNullable<AwsProviderPut['credentials']> = {};
  try {
    const accessKeyId = opts.accessKeyId?.trim() || process.env[AWS_ACCESS_KEY_ID_ENV]?.trim();
    const secretAccessKey = readSecret(opts.secretAccessKeyFile, AWS_SECRET_ACCESS_KEY_ENV);
    const sessionToken = readSecret(opts.sessionTokenFile, AWS_SESSION_TOKEN_ENV);
    if (accessKeyId) credentials.accessKeyId = accessKeyId;
    if (secretAccessKey) credentials.secretAccessKey = secretAccessKey;
    if (sessionToken) credentials.sessionToken = sessionToken;
  } catch (err) {
    return error(`Could not read a credential file: ${message(err)}`);
  }
  const input: AwsProviderPut = {
    ...enabled,
    config: {
      region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      ...(opts.roleArn ? { roleArn: opts.roleArn } : {}),
      ...(opts.externalId ? { externalId: opts.externalId } : {}),
      ...(opts.roleSessionName ? { roleSessionName: opts.roleSessionName } : {}),
    },
    ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
  };
  try {
    const view = await spinner('Saving the AWS settings', () => client.settings.secretProviders.set('aws', input));
    success('AWS Secrets Manager saved');
    printView(view);
    info('Run `ninedeploy secrets providers test aws` to check the connection.');
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy secrets providers test <kind> [--probe-path <path>] [--probe-secret-id <id>]` */
export async function secretProvidersTest(
  client: NineDeployClient,
  kindArg: string,
  opts: { probePath?: string; probeSecretId?: string } = {},
): Promise<void> {
  const kind = parseKind(kindArg);
  if (!kind) return error('Usage: ninedeploy secrets providers test <vault|aws> [--probe-path <path>] [--probe-secret-id <id>]');
  if (kind === 'vault' && opts.probeSecretId) return error('--probe-secret-id belongs to the aws provider');
  if (kind === 'aws' && opts.probePath) return error('--probe-path belongs to the vault provider');
  const probe = kind === 'vault' ? (opts.probePath ? { probePath: opts.probePath } : {}) : opts.probeSecretId ? { probeSecretId: opts.probeSecretId } : {};
  try {
    const res = await spinner(`Testing the ${kind} secret manager`, () => client.settings.secretProviders.test(kind, probe));
    if (res.ok) success(plain(res.detail));
    else error(plain(res.detail));
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy secrets providers delete <kind> [--yes]` */
export async function secretProvidersDelete(client: NineDeployClient, kindArg: string, opts: { yes?: boolean } = {}): Promise<void> {
  const kind = parseKind(kindArg);
  if (!kind) return error('Usage: ninedeploy secrets providers delete <vault|aws> [--yes]');
  if (!opts.yes) {
    const confirm = await prompt(`Type "delete" to remove the ${kind} secret manager (its references stay literal at deploy)`, '');
    if (confirm.trim() !== 'delete') {
      info('Aborted.');
      return;
    }
  }
  try {
    const res = await spinner(`Removing the ${kind} secret manager`, () => client.settings.secretProviders.delete(kind));
    if (res.deleted) success(`The ${kind} secret manager was removed`);
    else info(`No ${kind} secret manager was configured.`);
  } catch (err) {
    error(message(err));
  }
}
