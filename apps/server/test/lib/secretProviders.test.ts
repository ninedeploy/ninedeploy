import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 0.14 secret-manager clients (DESIGN §4.3): Vault / OpenBao KV v2 and AWS
 * Secrets Manager, with `guardedFetch` mocked — nothing here reaches the
 * network. The static check at the bottom keeps every call on guardedFetch.
 */

vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'cd'.repeat(32));
vi.stubEnv('NINEDEPLOY_ALLOW_PRIVATE_EGRESS', '');

const egress = vi.hoisted(() => ({ guardedFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>() }));
vi.mock('../../src/lib/egressGuard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/egressGuard.js')>()),
  guardedFetch: egress.guardedFetch,
}));

const { encrypt } = await import('../../src/lib/crypto.js');
const vault = await import('../../src/lib/secretProviders/vault.js');
const aws = await import('../../src/lib/secretProviders/awsSecretsManager.js');
const providers = await import('../../src/lib/secretProviders/index.js');
const { findSecretRefs } = await import('../../src/lib/secretRefs.js');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const text = (body: string, status = 200) => new Response(body, { status });
const ref = (body: string) => ['$', '{{', body, '}}'].join('');

const VAULT_CFG = { address: 'https://vault.example.com', mount: 'secret', authMethod: 'token' as const, approleMount: 'approle' };
const TOKEN = 'hvs.super-secret-token';
const APPROLE = { roleId: 'role-id-1234', secretId: 'secret-id-5678' };

const AWS_CFG = { region: 'eu-west-1', roleSessionName: 'ninedeploy' };
const AWS_CREDS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

const kv2 = (data: Record<string, unknown>) => json({ data: { data, metadata: { version: 1 } } });

beforeEach(() => {
  egress.guardedFetch.mockReset();
  providers.clearSecretProviderCaches();
});
afterEach(() => {
  vi.useRealTimers();
  vi.stubEnv('NINEDEPLOY_ALLOW_PRIVATE_EGRESS', '');
});

describe('Vault KV v2 client', () => {
  it('reads data.data with the token and namespace headers', async () => {
    egress.guardedFetch.mockResolvedValueOnce(kv2({ password: 'pw', port: 5432 }));
    const fields = await vault.readKv2({ ...VAULT_CFG, namespace: 'admin/team', mount: 'kv/apps' }, { token: TOKEN }, 'team/app', {
      cacheKey: 'k',
    });
    expect(fields).toEqual({ password: 'pw', port: 5432 });
    const [url, init] = egress.guardedFetch.mock.calls[0]!;
    expect(url).toBe('https://vault.example.com/v1/kv/apps/data/team/app');
    expect(init?.headers).toMatchObject({ 'x-vault-token': TOKEN, 'x-vault-namespace': 'admin/team' });
    expect(init?.method).toBe('GET');
    expect(vault.kvFieldValue(fields, 'password')).toBe('pw');
    expect(vault.kvFieldValue(fields, 'port')).toBe('5432');
    expect(vault.kvFieldValue(fields, 'missing')).toBeUndefined();
    expect(vault.kvFieldValue(fields, 'constructor')).toBeUndefined();
  });

  it('sends no namespace header when none is configured', async () => {
    egress.guardedFetch.mockResolvedValueOnce(kv2({ a: '1' }));
    await vault.readKv2(VAULT_CFG, { token: TOKEN }, 'x', { cacheKey: 'k' });
    expect(egress.guardedFetch.mock.calls[0]![1]?.headers).not.toHaveProperty('x-vault-namespace');
  });

  it('refuses a KV v1 mount (no nested data.data)', async () => {
    egress.guardedFetch.mockResolvedValueOnce(json({ data: { password: 'pw' } }));
    await expect(vault.readKv2(VAULT_CFG, { token: TOKEN }, 'x', { cacheKey: 'k' })).rejects.toThrow(/KV version 1 is not supported/);
  });

  it('never follows a redirect', async () => {
    egress.guardedFetch.mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/' } }));
    await expect(vault.readKv2(VAULT_CFG, { token: TOKEN }, 'x', { cacheKey: 'k' })).rejects.toThrow(/redirect \(307\).*not followed/);
    expect(egress.guardedFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses http unless private egress is allowed', async () => {
    const http = { ...VAULT_CFG, address: 'http://vault.internal:8200' };
    await expect(vault.readKv2(http, { token: TOKEN }, 'x', { cacheKey: 'k' })).rejects.toThrow(/must use https.*NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1/);
    expect(egress.guardedFetch).not.toHaveBeenCalled();
    vi.stubEnv('NINEDEPLOY_ALLOW_PRIVATE_EGRESS', '1');
    egress.guardedFetch.mockResolvedValueOnce(kv2({ a: '1' }));
    await expect(vault.readKv2(http, { token: TOKEN }, 'x', { cacheKey: 'k' })).resolves.toEqual({ a: '1' });
    expect(() => vault.vaultBaseUrl('not a url')).toThrow(/not a valid URL/);
    expect(() => vault.vaultBaseUrl('https://u:p@vault.example.com')).toThrow(/credentials/);
  });

  it('redacts the token and the path from errors and cuts the body to 200 characters', async () => {
    egress.guardedFetch.mockResolvedValueOnce(text(`denied ${TOKEN} for team/app ${'x'.repeat(500)}`, 403));
    const err = await vault.readKv2(VAULT_CFG, { token: TOKEN }, 'team/app', { cacheKey: 'k' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(vault.SecretProviderError);
    expect(err.message).toMatch(/^Vault answered 403: denied \[redacted\] for \[redacted\]/);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain('team/app');
    expect(err.message.length).toBeLessThan(260);
    egress.guardedFetch.mockRejectedValueOnce(new Error(`connect failed with ${TOKEN}`));
    const net = await vault.readKv2(VAULT_CFG, { token: TOKEN }, 'p', { cacheKey: 'k' }).catch((e: Error) => e);
    expect(net.message).toBe('Vault request failed: connect failed with [redacted]');
  });

  it('AppRole: logs in once, caches the token by row key until lease − 60 s, then logs in again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
    const cfg = { ...VAULT_CFG, authMethod: 'approle' as const, approleMount: 'approle-ci' };
    egress.guardedFetch.mockImplementation(async (url) =>
      String(url).endsWith('/login') ? json({ auth: { client_token: 'hvs.approle', lease_duration: 600 } }) : kv2({ f: 'v' }),
    );
    await vault.readKv2(cfg, APPROLE, 'a', { cacheKey: '1:100' });
    await vault.readKv2(cfg, APPROLE, 'b', { cacheKey: '1:100' });
    const logins = () => egress.guardedFetch.mock.calls.filter(([u]) => String(u).endsWith('/login'));
    expect(logins()).toHaveLength(1);
    const [loginUrl, loginInit] = logins()[0]!;
    expect(loginUrl).toBe('https://vault.example.com/v1/auth/approle-ci/login');
    expect(JSON.parse(String(loginInit?.body))).toEqual({ role_id: APPROLE.roleId, secret_id: APPROLE.secretId });
    expect(egress.guardedFetch.mock.calls.at(-1)![1]?.headers).toMatchObject({ 'x-vault-token': 'hvs.approle' });

    // A saved change (new updatedAt) is a new cache key.
    await vault.readKv2(cfg, APPROLE, 'a', { cacheKey: '1:200' });
    expect(logins()).toHaveLength(2);
    // Lease 600 s: still cached at 539 s, re-login at 541 s.
    vi.setSystemTime(new Date('2026-10-08T10:08:59Z'));
    await vault.readKv2(cfg, APPROLE, 'a', { cacheKey: '1:100' });
    expect(logins()).toHaveLength(2);
    vi.setSystemTime(new Date('2026-10-08T10:09:01Z'));
    await vault.readKv2(cfg, APPROLE, 'a', { cacheKey: '1:100' });
    expect(logins()).toHaveLength(3);
  });

  it('AppRole: a login without a client token, or missing ids, fails clearly', async () => {
    const cfg = { ...VAULT_CFG, authMethod: 'approle' as const };
    egress.guardedFetch.mockResolvedValueOnce(json({ auth: null }));
    await expect(vault.vaultToken(cfg, APPROLE, { cacheKey: 'z' })).rejects.toThrow(/without a client token/);
    await expect(vault.vaultToken(cfg, {}, { cacheKey: 'z' })).rejects.toThrow(/No AppRole/);
    await expect(vault.vaultToken(VAULT_CFG, {}, { cacheKey: 'z' })).rejects.toThrow(/No Vault token/);
  });

  it('test: lookup-self for a token, a fresh AppRole login, plus an optional probe read', async () => {
    egress.guardedFetch.mockResolvedValueOnce(json({ data: { ttl: 0 } })).mockResolvedValueOnce(kv2({ a: '1', b: '2' }));
    await expect(vault.testVaultProvider(VAULT_CFG, { token: TOKEN }, { cacheKey: 't', probePath: 'app' })).resolves.toBe(
      'Token accepted (lookup-self); probe path readable (2 fields)',
    );
    expect(egress.guardedFetch.mock.calls[0]![0]).toBe('https://vault.example.com/v1/auth/token/lookup-self');
    egress.guardedFetch.mockImplementation(async () => json({ auth: { client_token: 't', lease_duration: 0 } }));
    const cfg = { ...VAULT_CFG, authMethod: 'approle' as const };
    await vault.testVaultProvider(cfg, APPROLE, { cacheKey: 't' });
    await expect(vault.testVaultProvider(cfg, APPROLE, { cacheKey: 't' })).resolves.toBe('AppRole login succeeded');
    expect(egress.guardedFetch).toHaveBeenCalledTimes(4); // a test never reuses a cached token
  });
});

describe('AWS Secrets Manager client', () => {
  it('calls GetSecretValue signed for secretsmanager and returns the SecretString', async () => {
    egress.guardedFetch.mockResolvedValueOnce(json({ Name: 'prod/db', SecretString: '{"password":"pw","port":5432}' }));
    const s = await aws.getSecretString(AWS_CFG, AWS_CREDS, 'prod/db', { cacheKey: 'a' });
    const [url, init] = egress.guardedFetch.mock.calls[0]!;
    expect(url).toBe('https://secretsmanager.eu-west-1.amazonaws.com/');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-amz-target']).toBe('secretsmanager.GetSecretValue');
    expect(headers['content-type']).toBe('application/x-amz-json-1.1');
    expect(headers['authorization']).toMatch(/Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/eu-west-1\/secretsmanager\/aws4_request/);
    expect(headers).not.toHaveProperty('host');
    expect(init?.body).toBe('{"SecretId":"prod/db"}');
    expect(aws.jsonSecretKey(s, 'password')).toBe('pw');
    expect(aws.jsonSecretKey(s, 'port')).toBe('5432');
    expect(aws.jsonSecretKey(s, 'missing')).toBeUndefined();
    expect(() => aws.jsonSecretKey('plain', 'k')).toThrow(/not a JSON object/);
    expect(() => aws.jsonSecretKey('[1]', 'k')).toThrow(/not a JSON object/);
  });

  it('refuses SecretBinary', async () => {
    egress.guardedFetch.mockResolvedValueOnce(json({ SecretBinary: 'AAEC' }));
    await expect(aws.getSecretString(AWS_CFG, AWS_CREDS, 'bin', { cacheKey: 'a' })).rejects.toThrow(/SecretBinary, which is not supported/);
  });

  it('redacts keys and the secret id from errors, and never follows redirects', async () => {
    const id = 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:prod/db-AbCdEf';
    egress.guardedFetch.mockResolvedValueOnce(
      json({ __type: 'AccessDeniedException', Message: `User ${AWS_CREDS.accessKeyId} cannot read ${id}` }, 400),
    );
    const err = await aws.getSecretString(AWS_CFG, AWS_CREDS, id, { cacheKey: 'a' }).catch((e: Error) => e);
    expect(err.message).toMatch(/^Secrets Manager GetSecretValue answered 400: .*AccessDeniedException/);
    expect(err.message).not.toContain(id);
    expect(err.message).not.toContain(AWS_CREDS.accessKeyId);
    egress.guardedFetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://x' } }));
    await expect(aws.getSecretString(AWS_CFG, AWS_CREDS, 'x', { cacheKey: 'a' })).rejects.toThrow(/redirect \(302\)/);
  });

  it('assumes the role through STS once and caches it until expiry − 5 min', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
    const cfg = { ...AWS_CFG, roleArn: 'arn:aws:iam::123456789012:role/nd-reader', externalId: 'ext-id-1' };
    const sts = (n: number) =>
      text(
        `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>ASIAASSUMED00000000${n}</AccessKeyId>` +
          `<SecretAccessKey>assumed-secret-${n}</SecretAccessKey><SessionToken>session&amp;token-${n}</SessionToken>` +
          `<Expiration>2026-10-08T11:00:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`,
      );
    let n = 0;
    egress.guardedFetch.mockImplementation(async (url) => (String(url).startsWith('https://sts.') ? sts(++n) : json({ SecretString: 's' })));
    await aws.getSecretString(cfg, AWS_CREDS, 'a', { cacheKey: '2:1' });
    await aws.getSecretString(cfg, AWS_CREDS, 'b', { cacheKey: '2:1' });
    const stsCalls = () => egress.guardedFetch.mock.calls.filter(([u]) => String(u).startsWith('https://sts.'));
    expect(stsCalls()).toHaveLength(1);
    const [stsUrl, stsInit] = stsCalls()[0]!;
    expect(stsUrl).toBe('https://sts.eu-west-1.amazonaws.com/');
    const params = new URLSearchParams(String(stsInit?.body));
    expect(Object.fromEntries(params)).toMatchObject({
      Action: 'AssumeRole',
      RoleArn: cfg.roleArn,
      RoleSessionName: 'ninedeploy',
      ExternalId: 'ext-id-1',
      Version: '2011-06-15',
    });
    expect((stsInit!.headers as Record<string, string>)['authorization']).toMatch(/\/eu-west-1\/sts\/aws4_request/);
    const smHeaders = egress.guardedFetch.mock.calls.at(-1)![1]?.headers as Record<string, string>;
    expect(smHeaders['x-amz-security-token']).toBe('session&token-1');
    expect(smHeaders['authorization']).toContain('Credential=ASIAASSUMED000000001/');

    vi.setSystemTime(new Date('2026-10-08T10:54:59Z'));
    await aws.getSecretString(cfg, AWS_CREDS, 'c', { cacheKey: '2:1' });
    expect(stsCalls()).toHaveLength(1);
    vi.setSystemTime(new Date('2026-10-08T10:55:01Z'));
    await aws.getSecretString(cfg, AWS_CREDS, 'c', { cacheKey: '2:1' });
    expect(stsCalls()).toHaveLength(2);
  });

  it('refuses instance metadata (IMDS) and http endpoints, and needs a stored key', async () => {
    expect(() => aws.secretsManagerEndpoint({ ...AWS_CFG, endpoint: 'https://169.254.169.254' })).toThrow(/IMDS/);
    expect(() => aws.secretsManagerEndpoint({ ...AWS_CFG, endpoint: 'http://sm.internal' })).toThrow(/must use https/);
    expect(aws.secretsManagerEndpoint({ ...AWS_CFG, endpoint: 'https://vpce-1.secretsmanager.eu-west-1.vpce.amazonaws.com' })).toBe(
      'https://vpce-1.secretsmanager.eu-west-1.vpce.amazonaws.com/',
    );
    expect(aws.secretsManagerEndpoint({ ...AWS_CFG, region: 'cn-north-1' })).toBe('https://secretsmanager.cn-north-1.amazonaws.com.cn/');
    await expect(aws.getSecretString(AWS_CFG, {}, 'x', { cacheKey: 'a' })).rejects.toThrow(/No AWS access key is stored/);
    expect(egress.guardedFetch).not.toHaveBeenCalled();
  });

  it('test: GetCallerIdentity, plus an optional probe secret', async () => {
    egress.guardedFetch
      .mockResolvedValueOnce(text('<GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/nd</Arn></GetCallerIdentityResult>'))
      .mockResolvedValueOnce(json({ SecretString: 'x' }));
    await expect(aws.testAwsProvider(AWS_CFG, AWS_CREDS, { cacheKey: 'a', probeSecretId: 'prod/db' })).resolves.toBe(
      'Credentials accepted (arn:aws:iam::123456789012:user/nd); probe secret readable',
    );
    expect(new URLSearchParams(String(egress.guardedFetch.mock.calls[0]![1]?.body)).get('Action')).toBe('GetCallerIdentity');
  });
});

describe('provider rows and deploy-time resolution', () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({
      id: 1,
      kind: 'vault',
      enabled: true,
      configJson: VAULT_CFG,
      credentialEncrypted: encrypt(JSON.stringify({ token: TOKEN })),
      lastTestedAt: null,
      lastTestError: null,
      createdByUserId: null,
      createdAt: new Date(0),
      updatedAt: new Date(1000),
      ...over,
    }) as never;

  it('reads as not configured when absent, disabled, undecryptable or incomplete — never throws', () => {
    expect(providers.asConfigured(undefined)).toBeNull();
    expect(providers.asConfigured(row({ enabled: false }))).toBeNull();
    expect(providers.asConfigured(row({ credentialEncrypted: 'v9:not:an:envelope' }))).toBeNull();
    expect(providers.asConfigured(row({ credentialEncrypted: encrypt('[]') }))).toBeNull();
    expect(providers.asConfigured(row({ credentialEncrypted: encrypt('{}') }))).toBeNull();
    expect(providers.asConfigured(row({ configJson: { address: 'nope' } }))).toBeNull();
    expect(providers.asConfigured(row({ kind: 'aws', configJson: AWS_CFG, credentialEncrypted: encrypt('{"accessKeyId":"x"}') }))).toBeNull();
    expect(providers.asConfigured(row())).toMatchObject({ kind: 'vault', cacheKey: '1:1000', credentials: { token: TOKEN } });
  });

  const refsOf = (env: Record<string, string>) => {
    const map = new Map<string, { ref: never; envKeys: string[] }>();
    for (const [k, v] of Object.entries(env)) {
      for (const r of findSecretRefs(v)) {
        const e = map.get(r.raw) ?? { ref: r as never, envKeys: [] };
        e.envKeys.push(k);
        map.set(r.raw, e);
      }
    }
    return map;
  };

  it('fetches each distinct path once and maps every reference', async () => {
    egress.guardedFetch.mockImplementation(async () => kv2({ user: 'u', pass: 'p' }));
    const provider = providers.asConfigured(row());
    const out = await providers.resolveExternalRefs(
      { vault: provider },
      refsOf({ A: ref('vault:app#user'), B: ref('vault:app#pass'), C: ref('vault:app#user') }),
    );
    expect(Object.fromEntries(out)).toEqual({ [ref('vault:app#user')]: 'u', [ref('vault:app#pass')]: 'p' });
    expect(egress.guardedFetch).toHaveBeenCalledTimes(1);
  });

  it('a missing field throws naming the env key, never the path', async () => {
    egress.guardedFetch.mockImplementation(async () => kv2({ user: 'u' }));
    const err = await providers
      .resolveExternalRefs({ vault: providers.asConfigured(row()) }, refsOf({ DB_PASS: ref('vault:team/secret-app#pass') }))
      .catch((e: Error) => e);
    expect(err.message).toBe('Vault secret field "pass" not found (env key DB_PASS)');
  });

  it('enforces 100 references, 64 KiB per value, and the per-call / total time limits', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 101; i++) many[`K${i}`] = ref(`vault:p${i}#f`);
    await expect(providers.resolveExternalRefs({ vault: providers.asConfigured(row()) }, refsOf(many))).rejects.toThrow(
      /101 distinct vault\/aws secrets; at most 100/,
    );
    expect(egress.guardedFetch).not.toHaveBeenCalled();

    egress.guardedFetch.mockResolvedValueOnce(kv2({ big: 'x'.repeat(64 * 1024 + 1) }));
    await expect(
      providers.resolveExternalRefs({ vault: providers.asConfigured(row()) }, refsOf({ BIG: ref('vault:p#big') })),
    ).rejects.toThrow(/larger than 64 KiB \(env key BIG\)/);

    // A call that never answers is aborted by the per-call timeout.
    egress.guardedFetch.mockImplementation(
      (_u, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))),
    );
    await expect(
      providers.resolveExternalRefs({ vault: providers.asConfigured(row()) }, refsOf({ SLOW: ref('vault:p#f') }), {
        callTimeoutMs: 20,
      }),
    ).rejects.toThrow(/Vault reference \(env key SLOW\): Vault request failed/);
  });

  it('aws references resolve the whole string or one JSON key', async () => {
    egress.guardedFetch.mockImplementation(async () => json({ SecretString: '{"password":"pw"}' }));
    const provider = providers.asConfigured(
      row({ kind: 'aws', configJson: AWS_CFG, credentialEncrypted: encrypt(JSON.stringify(AWS_CREDS)) }),
    );
    const out = await providers.resolveExternalRefs({ aws: provider }, refsOf({ A: ref('aws:prod/db'), B: ref('aws:prod/db#password') }));
    expect(Object.fromEntries(out)).toEqual({ [ref('aws:prod/db')]: '{"password":"pw"}', [ref('aws:prod/db#password')]: 'pw' });
    expect(egress.guardedFetch).toHaveBeenCalledTimes(1);
    await expect(providers.resolveExternalRefs({ aws: provider }, refsOf({ C: ref('aws:prod/db#nope') }))).rejects.toThrow(
      'AWS secret key "nope" not found (env key C)',
    );
  });

  it('testSecretProvider never throws', async () => {
    egress.guardedFetch.mockRejectedValue(new Error('getaddrinfo ENOTFOUND vault.invalid'));
    await expect(providers.testSecretProvider(providers.asConfigured(row())!, {})).resolves.toEqual({
      ok: false,
      detail: 'Vault request failed: getaddrinfo ENOTFOUND vault.invalid',
    });
  });
});

describe('egress (static)', () => {
  it('lib/secretProviders/* and lib/awsSigV4.ts never call the global fetch — only guardedFetch', () => {
    const dir = new URL('../../src/lib/secretProviders/', import.meta.url);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => new URL(f, dir));
    files.push(new URL('../../src/lib/awsSigV4.ts', import.meta.url));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(src, String(file)).not.toMatch(/(?<![\w.])fetch\s*\(/);
      expect(src, String(file)).not.toMatch(/globalThis\s*\.\s*fetch|\bundici\b|node:https?\b/);
    }
    for (const client of ['vault.ts', 'awsSecretsManager.ts']) {
      expect(readFileSync(new URL(client, dir), 'utf8')).toMatch(/import \{[^}]*\bguardedFetch\b[^}]*\} from '\.\.\/egressGuard\.js'/);
    }
  });
});
