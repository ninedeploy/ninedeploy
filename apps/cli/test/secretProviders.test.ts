import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  secretProvidersDelete,
  secretProvidersList,
  secretProvidersSetAws,
  secretProvidersSetVault,
  secretProvidersTest,
} from '../src/commands/secretProviders.js';

/** 0.14: `ninedeploy secrets providers …` — secrets from files or env, never argv. */

const h = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock('../src/prompts.js', () => ({ prompt: h.prompt, promptHidden: vi.fn() }));

const ESC = String.fromCharCode(27);
const ENVS = [
  'NINEDEPLOY_VAULT_TOKEN',
  'NINEDEPLOY_VAULT_ROLE_ID',
  'NINEDEPLOY_VAULT_SECRET_ID',
  'NINEDEPLOY_AWS_ACCESS_KEY_ID',
  'NINEDEPLOY_AWS_SECRET_ACCESS_KEY',
  'NINEDEPLOY_AWS_SESSION_TOKEN',
];

const VIEW = {
  kind: 'vault' as const,
  configured: true,
  enabled: true,
  config: { address: 'https://vault.example', mount: 'secret', authMethod: 'token' } as Record<string, unknown>,
  hasCredential: true,
  lastTestedAt: null as string | null,
  lastTestError: null as string | null,
};

function makeClient() {
  return { settings: { secretProviders: { list: vi.fn(), set: vi.fn(), delete: vi.fn(), test: vi.fn() } } };
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const err = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
let dir: string;
const secretFile = (name: string, value: string) => {
  const p = path.join(dir, name);
  writeFileSync(p, value);
  return p;
};

beforeEach(() => {
  vi.resetAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.exitCode = 0;
  for (const e of ENVS) delete process.env[e];
  dir = mkdtempSync(path.join(tmpdir(), 'nd-secrets-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const e of ENVS) delete process.env[e];
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});

describe('secrets providers list', () => {
  it('lists both kinds with sanitised provider text', async () => {
    const client = makeClient();
    client.settings.secretProviders.list.mockResolvedValue([
      { ...VIEW, lastTestedAt: '2026-10-08T00:00:00.000Z', lastTestError: `403 permission denied${ESC}[2J` },
      { kind: 'aws', configured: false, enabled: false, config: {}, hasCredential: false, lastTestedAt: null, lastTestError: null },
      { ...VIEW, kind: 'aws', config: { region: 'eu-west-1', nested: { a: 1 } } },
    ]);
    await secretProvidersList(client as never);
    const text = out();
    expect(text).toContain('403 permission denied');
    expect(text).not.toContain(`${ESC}[2J`);
    expect(text).toContain('address=https://vault.example');
    expect(text).toContain('nested={"a":1}');
    expect(text).toContain(`\${{vault:<path>#<field>}}`);
  });

  it('reports a list error', async () => {
    const client = makeClient();
    client.settings.secretProviders.list.mockRejectedValue(new Error('Admin access required'));
    await secretProvidersList(client as never);
    expect(err()).toContain('Admin access required');
  });
});

describe('secrets providers set-vault', () => {
  it('reads the token from --token-file and sends the config', async () => {
    const client = makeClient();
    client.settings.secretProviders.set.mockResolvedValue(VIEW);
    await secretProvidersSetVault(client as never, {
      address: ' https://vault.example ',
      namespace: 'team',
      mount: 'kv',
      tokenFile: secretFile('token', 'hvs.secret\n'),
      enable: true,
    });
    expect(client.settings.secretProviders.set).toHaveBeenCalledWith('vault', {
      enabled: true,
      config: { address: 'https://vault.example', authMethod: 'token', namespace: 'team', mount: 'kv' },
      credentials: { token: 'hvs.secret' },
    });
    expect(out()).toContain('Vault / OpenBao saved');
    expect(out()).not.toContain('hvs.secret');
  });

  it('AppRole credentials come from env, and an update may omit them', async () => {
    const client = makeClient();
    client.settings.secretProviders.set.mockResolvedValue({ ...VIEW, hasCredential: false, configured: false, enabled: false, config: {} });
    process.env['NINEDEPLOY_VAULT_ROLE_ID'] = 'role';
    process.env['NINEDEPLOY_VAULT_SECRET_ID'] = 'sid';
    await secretProvidersSetVault(client as never, { address: 'https://v', auth: 'approle', approleMount: 'ar', disable: true });
    expect(client.settings.secretProviders.set).toHaveBeenLastCalledWith('vault', {
      enabled: false,
      config: { address: 'https://v', authMethod: 'approle', approleMount: 'ar' },
      credentials: { roleId: 'role', secretId: 'sid' },
    });
    expect(out()).toContain('missing');
    delete process.env['NINEDEPLOY_VAULT_ROLE_ID'];
    delete process.env['NINEDEPLOY_VAULT_SECRET_ID'];
    await secretProvidersSetVault(client as never, { address: 'https://v', auth: 'approle' });
    await secretProvidersSetVault(client as never, { address: 'https://v', tokenFile: secretFile('empty', '  ') });
    expect(client.settings.secretProviders.set).toHaveBeenLastCalledWith('vault', { config: { address: 'https://v', authMethod: 'token' } });
  });

  it('refuses bad flags and unreadable files, and relays server errors', async () => {
    const client = makeClient();
    await secretProvidersSetVault(client as never, {});
    expect(err()).toContain('Usage: ninedeploy secrets providers set-vault');
    await secretProvidersSetVault(client as never, { address: 'https://v', auth: 'ldap' });
    expect(err()).toContain('--auth must be');
    await secretProvidersSetVault(client as never, { address: 'https://v', enable: true, disable: true });
    expect(err()).toContain('cannot be combined');
    await secretProvidersSetVault(client as never, { address: 'https://v', tokenFile: path.join(dir, 'nope') });
    expect(err()).toContain('Could not read a credential file');
    expect(client.settings.secretProviders.set).not.toHaveBeenCalled();
    client.settings.secretProviders.set.mockRejectedValue(new Error('credentials.token required'));
    await secretProvidersSetVault(client as never, { address: 'https://v' });
    expect(err()).toContain('credentials.token required');
  });
});

describe('secrets providers set-aws', () => {
  it('takes the key id from the flag and secrets from files', async () => {
    const client = makeClient();
    client.settings.secretProviders.set.mockResolvedValue({ ...VIEW, kind: 'aws' });
    await secretProvidersSetAws(client as never, {
      region: 'eu-west-1',
      endpoint: 'https://vpce.example',
      roleArn: 'arn:aws:iam::123456789012:role/nd',
      externalId: 'ext',
      roleSessionName: 'panel',
      accessKeyId: 'AKIAABCDEFGHIJKLMNOP',
      secretAccessKeyFile: secretFile('sak', 'shh'),
      sessionTokenFile: secretFile('st', 'tok'),
    });
    expect(client.settings.secretProviders.set).toHaveBeenCalledWith('aws', {
      config: {
        region: 'eu-west-1',
        endpoint: 'https://vpce.example',
        roleArn: 'arn:aws:iam::123456789012:role/nd',
        externalId: 'ext',
        roleSessionName: 'panel',
      },
      credentials: { accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 'shh', sessionToken: 'tok' },
    });
    expect(out()).toContain('AWS Secrets Manager saved');
  });

  it('falls back to env, and omits credentials when none are given', async () => {
    const client = makeClient();
    client.settings.secretProviders.set.mockResolvedValue({ ...VIEW, kind: 'aws' });
    process.env['NINEDEPLOY_AWS_ACCESS_KEY_ID'] = 'AKIAABCDEFGHIJKLMNOP';
    process.env['NINEDEPLOY_AWS_SECRET_ACCESS_KEY'] = 'envsecret';
    await secretProvidersSetAws(client as never, { region: 'us-east-1', enable: true });
    expect(client.settings.secretProviders.set).toHaveBeenLastCalledWith('aws', {
      enabled: true,
      config: { region: 'us-east-1' },
      credentials: { accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 'envsecret' },
    });
    for (const e of ENVS) delete process.env[e];
    await secretProvidersSetAws(client as never, { region: 'us-east-1' });
    expect(client.settings.secretProviders.set).toHaveBeenLastCalledWith('aws', { config: { region: 'us-east-1' } });
  });

  it('refuses bad flags and relays errors', async () => {
    const client = makeClient();
    await secretProvidersSetAws(client as never, {});
    expect(err()).toContain('Usage: ninedeploy secrets providers set-aws');
    await secretProvidersSetAws(client as never, { region: 'eu-west-1', enable: true, disable: true });
    expect(err()).toContain('cannot be combined');
    await secretProvidersSetAws(client as never, { region: 'eu-west-1', sessionTokenFile: path.join(dir, 'nope') });
    expect(err()).toContain('Could not read a credential file');
    client.settings.secretProviders.set.mockRejectedValue(new Error('invalid AWS region'));
    await secretProvidersSetAws(client as never, { region: 'mars-1' });
    expect(err()).toContain('invalid AWS region');
  });
});

describe('secrets providers test / delete', () => {
  it('tests with optional probes and prints sanitised detail', async () => {
    const client = makeClient();
    client.settings.secretProviders.test.mockResolvedValueOnce({ ok: true, detail: `token valid${ESC}[2J` });
    await secretProvidersTest(client as never, 'vault', { probePath: 'app/db' });
    expect(client.settings.secretProviders.test).toHaveBeenLastCalledWith('vault', { probePath: 'app/db' });
    expect(out()).toContain('token valid');
    expect(out()).not.toContain(`${ESC}[2J`);
    client.settings.secretProviders.test.mockResolvedValueOnce({ ok: false, detail: 'AccessDenied' });
    await secretProvidersTest(client as never, 'aws', { probeSecretId: 'prod/db' });
    expect(client.settings.secretProviders.test).toHaveBeenLastCalledWith('aws', { probeSecretId: 'prod/db' });
    expect(err()).toContain('AccessDenied');
    client.settings.secretProviders.test.mockResolvedValue({ ok: true, detail: 'ok' });
    await secretProvidersTest(client as never, 'vault');
    expect(client.settings.secretProviders.test).toHaveBeenLastCalledWith('vault', {});
    await secretProvidersTest(client as never, 'aws');
    expect(client.settings.secretProviders.test).toHaveBeenLastCalledWith('aws', {});
  });

  it('refuses a bad kind or a probe for the other kind, and relays errors', async () => {
    const client = makeClient();
    await secretProvidersTest(client as never, 'gcp');
    expect(err()).toContain('Usage: ninedeploy secrets providers test');
    await secretProvidersTest(client as never, 'vault', { probeSecretId: 'x' });
    expect(err()).toContain('--probe-secret-id belongs to the aws provider');
    await secretProvidersTest(client as never, 'aws', { probePath: 'x' });
    expect(err()).toContain('--probe-path belongs to the vault provider');
    expect(client.settings.secretProviders.test).not.toHaveBeenCalled();
    client.settings.secretProviders.test.mockRejectedValue(new Error('rate limited'));
    await secretProvidersTest(client as never, 'aws');
    expect(err()).toContain('rate limited');
  });

  it('deletes after confirmation', async () => {
    const client = makeClient();
    await secretProvidersDelete(client as never, 'x');
    expect(err()).toContain('Usage: ninedeploy secrets providers delete');
    h.prompt.mockResolvedValueOnce('');
    await secretProvidersDelete(client as never, 'vault');
    expect(out()).toContain('Aborted');
    h.prompt.mockResolvedValueOnce('delete');
    client.settings.secretProviders.delete.mockResolvedValueOnce({ ok: true, deleted: true });
    await secretProvidersDelete(client as never, 'vault');
    expect(out()).toContain('The vault secret manager was removed');
    client.settings.secretProviders.delete.mockResolvedValueOnce({ ok: true, deleted: false });
    await secretProvidersDelete(client as never, 'aws', { yes: true });
    expect(out()).toContain('No aws secret manager was configured');
    client.settings.secretProviders.delete.mockRejectedValue(new Error('denied'));
    await secretProvidersDelete(client as never, 'aws', { yes: true });
    expect(err()).toContain('denied');
  });
});
