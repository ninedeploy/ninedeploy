import { describe, expect, it } from 'vitest';
import {
  awsProviderConfig,
  awsProviderPut,
  awsSecretId,
  secretProviderKind,
  secretProviderTestRequest,
  secretProviderTestResult,
  secretProviderView,
  vaultPath,
  vaultProviderPut,
  VAULT_FIELD_RE,
} from '../src/secretProviders.js';

const vaultConfig = { address: 'https://vault.example.com/', authMethod: 'token' as const };

describe('reference grammar pieces (0.14)', () => {
  it('accepts relative Vault paths and refuses dot segments and slashes at the edges', () => {
    for (const p of ['app', 'team/app/prod', 'a.b/c-d/e_f', '.hidden', 'x/..y']) {
      expect(vaultPath.safeParse(p).success, p).toBe(true);
    }
    for (const p of ['', '/app', 'app/', 'a//b', '.', '..', 'a/./b', 'a/../b', '../a', 'a/..', 'a b', 'a#b']) {
      expect(vaultPath.safeParse(p).success, p).toBe(false);
    }
    expect(VAULT_FIELD_RE.test('db_password')).toBe(true);
    expect(VAULT_FIELD_RE.test('a/b')).toBe(false);
  });

  it('accepts AWS secret names and ARNs only in the allowed charset', () => {
    expect(awsSecretId.safeParse('prod/db').success).toBe(true);
    expect(awsSecretId.safeParse('arn:aws:secretsmanager:eu-west-1:123456789012:secret:prod/db-AbCdEf').success).toBe(true);
    expect(awsSecretId.safeParse('').success).toBe(false);
    expect(awsSecretId.safeParse('a}}b').success).toBe(false);
    expect(awsSecretId.safeParse('a'.repeat(2049)).success).toBe(false);
  });
});

describe('vaultProviderPut (0.14)', () => {
  it('fills the mount defaults and normalises the address', () => {
    expect(vaultProviderPut.parse({ config: vaultConfig, credentials: { token: 'hvs.x' } })).toEqual({
      config: { address: 'https://vault.example.com', authMethod: 'token', mount: 'secret', approleMount: 'approle' },
      credentials: { token: 'hvs.x' },
    });
  });

  it('allows an update that omits credentials (stored ones are kept)', () => {
    expect(vaultProviderPut.parse({ enabled: false, config: vaultConfig }).credentials).toBeUndefined();
    expect(
      vaultProviderPut.parse({ config: { ...vaultConfig, authMethod: 'approle', namespace: 'admin/team' } }).config.namespace,
    ).toBe('admin/team');
  });

  it('keeps credentials to the chosen auth method', () => {
    expect(vaultProviderPut.safeParse({ config: vaultConfig, credentials: { roleId: 'r' } }).success).toBe(false);
    expect(vaultProviderPut.safeParse({ config: vaultConfig, credentials: { secretId: 's' } }).success).toBe(false);
    const approle = { ...vaultConfig, authMethod: 'approle' as const };
    expect(vaultProviderPut.safeParse({ config: approle, credentials: { roleId: 'r', secretId: 's' } }).success).toBe(true);
    const tokenOnApprole = vaultProviderPut.safeParse({ config: approle, credentials: { token: 't' } });
    expect(tokenOnApprole.success).toBe(false);
    expect(tokenOnApprole.error?.issues[0]?.path).toEqual(['credentials', 'token']);
  });

  it('refuses unknown keys, non-http addresses, credentials in URLs and bad mounts', () => {
    expect(vaultProviderPut.safeParse({ config: vaultConfig, extra: 1 }).success).toBe(false);
    expect(vaultProviderPut.safeParse({ config: { ...vaultConfig, kvVersion: 1 } }).success).toBe(false);
    expect(vaultProviderPut.safeParse({ config: vaultConfig, credentials: { password: 'x' } }).success).toBe(false);
    expect(vaultProviderPut.safeParse({ config: { ...vaultConfig, address: 'ftp://vault' } }).success).toBe(false);
    expect(vaultProviderPut.safeParse({ config: { ...vaultConfig, address: 'https://u:p@vault' } }).success).toBe(false);
    expect(vaultProviderPut.safeParse({ config: { ...vaultConfig, mount: '../sys' } }).success).toBe(false);
    expect(vaultProviderPut.safeParse({ config: { ...vaultConfig, authMethod: 'userpass' } }).success).toBe(false);
    expect(vaultProviderPut.safeParse({ config: vaultConfig, credentials: { token: '' } }).success).toBe(false);
  });
});

describe('awsProviderPut (0.14)', () => {
  const creds = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

  it('accepts static keys and fills the session name', () => {
    expect(awsProviderPut.parse({ config: { region: 'eu-west-1' }, credentials: creds })).toEqual({
      config: { region: 'eu-west-1', roleSessionName: 'ninedeploy' },
      credentials: creds,
    });
    expect(awsProviderConfig.safeParse({ region: 'us-gov-west-1' }).success).toBe(true);
  });

  it('accepts AssumeRole with an external id, temporary keys and an endpoint', () => {
    const config = {
      region: 'us-east-1',
      endpoint: 'https://vpce-1.secretsmanager.us-east-1.vpce.amazonaws.com',
      roleArn: 'arn:aws:iam::123456789012:role/ninedeploy-reader',
      externalId: 'nd-ext-1',
      roleSessionName: 'panel@host',
    };
    const parsed = awsProviderPut.parse({
      config,
      credentials: { accessKeyId: 'ASIAIOSFODNN7EXAMPLE', secretAccessKey: 's', sessionToken: 't' },
    });
    expect(parsed.config).toEqual(config);
  });

  it('refuses bad regions, key ids, ARNs and an external id without a role', () => {
    for (const region of ['eu-west', 'EU-WEST-1', 'euwest1', 'eu-west-12']) {
      expect(awsProviderConfig.safeParse({ region }).success, region).toBe(false);
    }
    expect(awsProviderPut.safeParse({ config: { region: 'eu-west-1' }, credentials: { accessKeyId: 'AKIA123' } }).success).toBe(false);
    expect(awsProviderConfig.safeParse({ region: 'eu-west-1', roleArn: 'arn:aws:iam::123:role/x' }).success).toBe(false);
    expect(awsProviderConfig.safeParse({ region: 'eu-west-1', roleSessionName: 'a' }).success).toBe(false);
    expect(awsProviderConfig.safeParse({ region: 'eu-west-1', externalId: 'a b' , roleArn: 'arn:aws:iam::123456789012:role/x' }).success).toBe(false);
    const noRole = awsProviderConfig.safeParse({ region: 'eu-west-1', externalId: 'ext-1' });
    expect(noRole.success).toBe(false);
    expect(noRole.error?.issues[0]?.path).toEqual(['externalId']);
    expect(awsProviderPut.safeParse({ config: { region: 'eu-west-1', imds: true } }).success).toBe(false);
  });
});

describe('secret provider test and views', () => {
  it('accepts optional probes and refuses unknown keys', () => {
    expect(secretProviderTestRequest.parse({})).toEqual({});
    expect(secretProviderTestRequest.parse({ probePath: 'app/prod', probeSecretId: 'prod/db' })).toEqual({
      probePath: 'app/prod',
      probeSecretId: 'prod/db',
    });
    expect(secretProviderTestRequest.safeParse({ probePath: '../x' }).success).toBe(false);
    expect(secretProviderTestRequest.safeParse({ url: 'x' }).success).toBe(false);
    expect(secretProviderTestResult.parse({ ok: false, detail: 'connect failed' })).toEqual({ ok: false, detail: 'connect failed' });
  });

  it('shapes the listing and never carries a credential', () => {
    const view = {
      kind: 'vault',
      configured: false,
      enabled: false,
      config: {},
      hasCredential: false,
      lastTestedAt: null,
      lastTestError: null,
    };
    expect(secretProviderView.parse({ ...view, credentials: { token: 't' } })).toEqual(view);
    expect(secretProviderKind.options).toEqual(['vault', 'aws']);
  });
});
