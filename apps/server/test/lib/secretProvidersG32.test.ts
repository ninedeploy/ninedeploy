import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G3.2 secret managers: Parameter Store (through the aws row), GCP Secret
 * Manager, Azure Key Vault, 1Password Connect and the exec command, with
 * `guardedFetch` mocked — nothing here reaches the network. The exec tests run
 * the real node binary.
 */

vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'ab'.repeat(32));
vi.stubEnv('NINEDEPLOY_ALLOW_PRIVATE_EGRESS', '');
vi.stubEnv('NINEDEPLOY_SECRET_EXEC', '');

const egress = vi.hoisted(() => ({ guardedFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>() }));
vi.mock('../../src/lib/egressGuard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/egressGuard.js')>()),
  guardedFetch: egress.guardedFetch,
}));

const { encrypt } = await import('../../src/lib/crypto.js');
const providers = await import('../../src/lib/secretProviders/index.js');
const aws = await import('../../src/lib/secretProviders/awsSecretsManager.js');
const { gcpDriver, parseServiceAccount } = await import('../../src/lib/secretProviders/gcp.js');
const { azureDriver } = await import('../../src/lib/secretProviders/azure.js');
const { onePasswordDriver } = await import('../../src/lib/secretProviders/onePassword.js');
const { execDriver } = await import('../../src/lib/secretProviders/exec.js');
const { findSecretRefs, hasSecretRef } = await import('../../src/lib/secretRefs.js');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ref = (body: string) => ['$', '{{', body, '}}'].join('');
const call = (i: number) => {
  const [url, init] = egress.guardedFetch.mock.calls[i]!;
  return { url, init: init!, headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') };
};
const opts = { cacheKey: 'k1' };

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = {
  type: 'service_account',
  project_id: 'my-project-1',
  client_email: 'reader@my-project-1.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  token_uri: 'https://evil.example.com/token',
};
const GCP_CREDS = { serviceAccountJson: JSON.stringify(SA) };

beforeEach(() => {
  egress.guardedFetch.mockReset();
  providers.clearSecretProviderCaches();
});
afterEach(() => vi.stubEnv('NINEDEPLOY_SECRET_EXEC', ''));

describe('reference grammar (G3.2)', () => {
  it('parses every new form', () => {
    const value = [
      ref('ssm:/prod/db/password'),
      ref('ssm:/prod/db#user'),
      ref('gcp:db-password'),
      ref('gcp:db-password@3#user'),
      ref('gcp:api_key@latest'),
      ref('azure:db-password'),
      ref(`azure:db@${'a'.repeat(32)}`),
      ref('op:Production/Postgres DB/password'),
      ref('op:Production/Postgres/admin/password'),
      ref('exec:prod/db:password#user'),
    ].join(' ');
    expect(findSecretRefs(value).map((r) => [r.provider, 'name' in r ? r.name : '', 'jsonKey' in r ? r.jsonKey : null])).toEqual([
      ['ssm', '/prod/db/password', null],
      ['ssm', '/prod/db', 'user'],
      ['gcp', 'db-password', null],
      ['gcp', 'db-password@3', 'user'],
      ['gcp', 'api_key@latest', null],
      ['azure', 'db-password', null],
      ['azure', `db@${'a'.repeat(32)}`, null],
      ['op', 'Production/Postgres DB/password', null],
      ['op', 'Production/Postgres/admin/password', null],
      ['exec', 'prod/db:password', 'user'],
    ]);
  });

  it('refuses malformed new forms', () => {
    for (const bad of [
      'ssm:',
      'ssm:a b',
      'gcp:a.b',
      'gcp:a@v1',
      'azure:a_b',
      'azure:a@123',
      'op:vault/item',
      'op:a/b/c/d/e',
      'op: a/b/c',
      'op:a/b/c#k',
      'exec:',
      'exec:a b',
      'exec:--output=/tmp/x',
      'exec:-x',
    ]) {
      expect(hasSecretRef(ref(bad)), bad).toBe(false);
    }
  });

  it('maps each prefix to the row it reads with', () => {
    const kinds = findSecretRefs([ref('ssm:/a'), ref('op:a/b/c'), ref('gcp:a'), ref('azure:a'), ref('exec:a'), ref('aws:a')].join(''))
      .filter((r) => r.provider !== 'infisical' && r.provider !== 'doppler')
      .map((r) => providers.providerKindFor(r as never));
    expect(kinds).toEqual(['aws', 'onepassword', 'gcp', 'azure', 'exec', 'aws']);
  });
});

describe('Parameter Store', () => {
  it('reads a decrypted parameter with the aws credentials', async () => {
    egress.guardedFetch.mockResolvedValueOnce(json({ Parameter: { Name: '/prod/db', Type: 'SecureString', Value: 'pw' } }));
    const value = await aws.getParameter(
      { region: 'eu-west-1', roleSessionName: 'nd' },
      { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'secret' },
      '/prod/db',
      opts,
    );
    expect(value).toBe('pw');
    const c = call(0);
    expect(c.url).toBe('https://ssm.eu-west-1.amazonaws.com/');
    expect(c.headers['x-amz-target']).toBe('AmazonSSM.GetParameter');
    expect(c.headers['authorization']).toMatch(/\/eu-west-1\/ssm\/aws4_request/);
    expect(JSON.parse(c.body)).toEqual({ Name: '/prod/db', WithDecryption: true });
  });

  it('reports a missing parameter without its name', async () => {
    egress.guardedFetch.mockResolvedValueOnce(json({ __type: 'ParameterNotFound', message: 'Parameter /prod/db not found' }, 400));
    await expect(
      aws.getParameter({ region: 'eu-west-1', roleSessionName: 'nd' }, { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 's' }, '/prod/db', opts),
    ).rejects.toThrow(/^Parameter Store GetParameter answered 400/);
    egress.guardedFetch.mockResolvedValueOnce(json({ __type: 'ParameterNotFound', message: 'Parameter /prod/db not found' }, 400));
    await expect(
      aws.getParameter({ region: 'eu-west-1', roleSessionName: 'nd' }, { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 's' }, '/prod/db', opts),
    ).rejects.not.toThrow(/\/prod\/db/);
  });
});

describe('GCP Secret Manager', () => {
  it('signs an assertion for Google only, ignoring the key file token_uri, and decodes the payload', async () => {
    egress.guardedFetch
      .mockResolvedValueOnce(json({ access_token: 'ya29.tok', expires_in: 3600 }))
      .mockResolvedValueOnce(json({ payload: { data: Buffer.from('s3cret-ü').toString('base64') } }))
      .mockResolvedValueOnce(json({ payload: { data: Buffer.from('v2').toString('base64') } }));
    expect(await gcpDriver.read({}, GCP_CREDS, 'db-password', opts)).toBe('s3cret-ü');
    const token = call(0);
    expect(token.url).toBe('https://oauth2.googleapis.com/token');
    const assertion = new URLSearchParams(token.body).get('assertion')!;
    const [h, p, s] = assertion.split('.');
    const verify = createVerify('RSA-SHA256');
    verify.update(`${h}.${p}`);
    expect(verify.verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toMatchObject({
      iss: SA.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    });
    expect(call(1).url).toBe('https://secretmanager.googleapis.com/v1/projects/my-project-1/secrets/db-password/versions/latest:access');
    expect(call(1).headers['authorization']).toBe('Bearer ya29.tok');
    // The token is reused; projectId overrides the key's project; a version is honoured.
    expect(await gcpDriver.read({ projectId: 'other-project' }, GCP_CREDS, 'db-password@7', opts)).toBe('v2');
    expect(egress.guardedFetch).toHaveBeenCalledTimes(3);
    expect(call(2).url).toBe('https://secretmanager.googleapis.com/v1/projects/other-project/secrets/db-password/versions/7:access');
  });

  it('refuses a binary payload, a bad key and keeps the key out of errors', async () => {
    egress.guardedFetch.mockResolvedValueOnce(json({ access_token: 't' })).mockResolvedValueOnce(json({ payload: { data: Buffer.from([0xff, 0xfe]).toString('base64') } }));
    await expect(gcpDriver.read({}, GCP_CREDS, 'bin', opts)).rejects.toThrow('The secret is binary, not UTF-8 text');
    expect(() => parseServiceAccount('{}')).toThrow('no client_email or private_key');
    expect(() => parseServiceAccount('{"type":"authorized_user"}')).toThrow('not a service account key');
    expect(() => parseServiceAccount('nope')).toThrow('not valid JSON');
    providers.clearSecretProviderCaches();
    egress.guardedFetch.mockResolvedValueOnce(new Response(`invalid_grant for ${SA.private_key}`, { status: 400 }));
    const err = await gcpDriver.read({}, GCP_CREDS, 'x', opts).catch((e: Error) => e);
    expect(String(err)).toMatch(/Google OAuth token exchange answered 400/);
    expect(String(err)).not.toContain('PRIVATE KEY');
  });

  it('tests by minting a token and optionally reading a probe', async () => {
    egress.guardedFetch.mockResolvedValueOnce(json({ access_token: 't' }));
    expect(await gcpDriver.test({}, GCP_CREDS, opts)).toBe(`Service account ${SA.client_email} accepted (project my-project-1)`);
    const noProject = { serviceAccountJson: JSON.stringify({ ...SA, project_id: undefined }) };
    egress.guardedFetch.mockResolvedValueOnce(json({ access_token: 't' }));
    await expect(gcpDriver.test({}, noProject, opts)).rejects.toThrow('No GCP project');
  });

  it('rejects malformed references, token responses and missing secret payloads', async () => {
    await expect(gcpDriver.read({}, GCP_CREDS, 'bad@version', opts)).rejects.toThrow('Invalid GCP secret reference');
    expect(egress.guardedFetch).not.toHaveBeenCalled();
    egress.guardedFetch.mockResolvedValueOnce(json({}));
    await expect(gcpDriver.read({}, GCP_CREDS, 'good', opts)).rejects.toThrow('Google OAuth answered without an access token');
    egress.guardedFetch.mockResolvedValueOnce(json({ access_token: 'token' })).mockResolvedValueOnce(json({ payload: {} }));
    await expect(gcpDriver.read({}, GCP_CREDS, 'good', opts)).rejects.toThrow('Secret Manager answered without a payload');
  });

  it('checks an actual GCP probe without requesting a second token', async () => {
    egress.guardedFetch.mockResolvedValueOnce(json({ access_token: 'token' }))
      .mockResolvedValueOnce(json({ payload: { data: Buffer.from('value').toString('base64') } }));
    await expect(gcpDriver.test({}, GCP_CREDS, { ...opts, probeName: 'probe' })).resolves.toContain('probe secret readable');
    expect(egress.guardedFetch).toHaveBeenCalledTimes(2);
  });
});

describe('Azure Key Vault', () => {
  const cfg = { vaultUrl: 'https://my-vault.vault.azure.net', tenantId: '11111111-2222-3333-4444-555555555555', clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };

  it('gets a token with client credentials and reads the secret', async () => {
    egress.guardedFetch.mockResolvedValueOnce(json({ access_token: 'eyJ.tok', expires_in: 3599 })).mockResolvedValueOnce(json({ value: 'pw', id: 'x' }));
    expect(await azureDriver.read(cfg, { clientSecret: 'cs~secret' }, 'db-password', opts)).toBe('pw');
    expect(call(0).url).toBe(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`);
    expect(Object.fromEntries(new URLSearchParams(call(0).body))).toEqual({
      grant_type: 'client_credentials',
      client_id: cfg.clientId,
      client_secret: 'cs~secret',
      scope: 'https://vault.azure.net/.default',
    });
    expect(call(1).url).toBe('https://my-vault.vault.azure.net/secrets/db-password?api-version=7.4');
    expect(call(1).headers['authorization']).toBe('Bearer eyJ.tok');
  });

  it('uses the cloud of the vault and reads a version', async () => {
    egress.guardedFetch.mockResolvedValueOnce(json({ access_token: 't' })).mockResolvedValueOnce(json({ value: 'v' }));
    const v = 'a'.repeat(32);
    await azureDriver.read({ ...cfg, vaultUrl: 'https://kv.vault.azure.cn' }, { clientSecret: 's' }, `x@${v}`, opts);
    expect(call(0).url).toContain('https://login.chinacloudapi.cn/');
    expect(new URLSearchParams(call(0).body).get('scope')).toBe('https://vault.azure.cn/.default');
    expect(call(1).url).toBe(`https://kv.vault.azure.cn/secrets/x/${v}?api-version=7.4`);
  });

  it('keeps the client secret out of errors', async () => {
    egress.guardedFetch.mockResolvedValueOnce(new Response('AADSTS7000215: Invalid client secret cs~secret provided', { status: 401 }));
    const err = await azureDriver.read(cfg, { clientSecret: 'cs~secret' }, 'x', opts).catch((e: Error) => e);
    expect(String(err)).toMatch(/Microsoft Entra ID token request answered 401/);
    expect(String(err)).not.toContain('cs~secret');
  });

  it('uses US Government endpoints and tests an actual secret probe', async () => {
    const gov = { ...cfg, vaultUrl: 'https://kv.vault.usgovcloudapi.net' };
    egress.guardedFetch.mockResolvedValueOnce(json({ access_token: 'token' })).mockResolvedValueOnce(json({ value: 'value' }));
    await expect(azureDriver.test(gov, { clientSecret: 'secret' }, { ...opts, probeName: 'probe' })).resolves.toContain('probe secret readable');
    expect(call(0).url).toContain('https://login.microsoftonline.us/');
    expect(new URLSearchParams(call(0).body).get('scope')).toBe('https://vault.usgovcloudapi.net/.default');
  });

  it('refuses missing credentials, malformed references and missing API fields', async () => {
    await expect(azureDriver.read(cfg, {}, 'ok', opts)).rejects.toThrow('No Azure client secret is stored');
    await expect(azureDriver.read(cfg, { clientSecret: 'secret' }, 'bad_name', opts)).rejects.toThrow('Invalid Azure Key Vault reference');
    expect(egress.guardedFetch).not.toHaveBeenCalled();
    egress.guardedFetch.mockResolvedValueOnce(json({}));
    await expect(azureDriver.read(cfg, { clientSecret: 'secret' }, 'ok', opts)).rejects.toThrow('answered without an access token');
    egress.guardedFetch.mockResolvedValueOnce(json({ access_token: 'token' })).mockResolvedValueOnce(json({}));
    await expect(azureDriver.read(cfg, { clientSecret: 'secret' }, 'ok', opts)).rejects.toThrow('answered without a value');
  });
});

describe('1Password Connect', () => {
  const cfg = { address: 'https://connect.example.com' };
  const creds = { token: 'op-token' };
  const ITEM = {
    fields: [
      { id: 'password', label: 'password', value: 'top', section: undefined },
      { id: 'f2', label: 'password', value: 'admin-pw', section: { id: 's1' } },
      { id: 'f3', label: 'user', value: 'app' },
    ],
    sections: [{ id: 's1', label: 'admin' }],
  };

  it('resolves vault and item names, then the field (in a section when named)', async () => {
    egress.guardedFetch
      .mockResolvedValueOnce(json([{ id: 'v'.repeat(26), name: 'Production' }]))
      .mockResolvedValueOnce(json([{ id: 'i'.repeat(26), title: 'Postgres DB' }]))
      .mockResolvedValueOnce(json(ITEM));
    expect(await onePasswordDriver.read(cfg, creds, 'Production/Postgres DB/user', opts)).toBe('app');
    expect(call(0).url).toBe(`https://connect.example.com/v1/vaults?filter=${encodeURIComponent('name eq "Production"')}`);
    expect(call(0).headers['authorization']).toBe('Bearer op-token');
    expect(call(1).url).toBe(`https://connect.example.com/v1/vaults/${'v'.repeat(26)}/items?filter=${encodeURIComponent('title eq "Postgres DB"')}`);
    expect(call(2).url).toBe(`https://connect.example.com/v1/vaults/${'v'.repeat(26)}/items/${'i'.repeat(26)}`);

    // Ids skip the lookups; a section narrows an ambiguous label.
    egress.guardedFetch.mockResolvedValueOnce(json(ITEM));
    expect(await onePasswordDriver.read(cfg, creds, `${'v'.repeat(26)}/${'i'.repeat(26)}/admin/password`, opts)).toBe('admin-pw');
    egress.guardedFetch.mockResolvedValueOnce(json(ITEM));
    await expect(onePasswordDriver.read(cfg, creds, `${'v'.repeat(26)}/${'i'.repeat(26)}/password`, opts)).rejects.toThrow(
      'More than one 1Password field is called "password"',
    );
  });

  it('fails on a missing or ambiguous vault and refuses plain http', async () => {
    egress.guardedFetch.mockResolvedValueOnce(json([]));
    await expect(onePasswordDriver.read(cfg, creds, 'Nope/item/field', opts)).rejects.toThrow('1Password vault "Nope" was not found');
    egress.guardedFetch.mockResolvedValueOnce(json([{ id: 'a', name: 'Dup' }, { id: 'b', name: 'Dup' }]));
    await expect(onePasswordDriver.read(cfg, creds, 'Dup/item/field', opts)).rejects.toThrow('More than one 1Password vault is called "Dup"');
    expect(() => onePasswordDriver.validate({ address: 'http://connect:8080' })).toThrow(/must use https/);
    vi.stubEnv('NINEDEPLOY_ALLOW_PRIVATE_EGRESS', '1');
    expect(() => onePasswordDriver.validate({ address: 'http://connect:8080' })).not.toThrow();
    vi.stubEnv('NINEDEPLOY_ALLOW_PRIVATE_EGRESS', '');
  });

  it('rejects missing credentials and malformed or ambiguous item data', async () => {
    await expect(onePasswordDriver.read(cfg, {}, 'vault/item/field', opts)).rejects.toThrow('No 1Password Connect token is stored');
    await expect(onePasswordDriver.read(cfg, creds, 'vault/item', opts)).rejects.toThrow('Invalid 1Password reference');
    egress.guardedFetch.mockResolvedValueOnce(new Response('not-json'));
    await expect(onePasswordDriver.read(cfg, creds, 'vault/item/field', opts)).rejects.toThrow('body that is not JSON');
    egress.guardedFetch.mockResolvedValueOnce(json([{ id: 'v'.repeat(26), name: 'vault' }])).mockResolvedValueOnce(json([]));
    await expect(onePasswordDriver.read(cfg, creds, 'vault/item/field', opts)).rejects.toThrow('1Password item "item" was not found');
    egress.guardedFetch.mockResolvedValueOnce(json({ fields: [{ id: 'field', value: null }] }));
    await expect(onePasswordDriver.read(cfg, creds, `${'v'.repeat(26)}/${'i'.repeat(26)}/field`, opts)).rejects.toThrow('has no value');
    egress.guardedFetch.mockResolvedValueOnce(json({ fields: [] }));
    await expect(onePasswordDriver.read(cfg, creds, `${'v'.repeat(26)}/${'i'.repeat(26)}/field`, opts)).rejects.toThrow('field "field" was not found');
  });

  it('tests a token with a probe and does not expose it in errors', async () => {
    egress.guardedFetch.mockResolvedValueOnce(json([])).mockResolvedValueOnce(json({ fields: [{ id: 'field', value: 'value' }] }));
    const probeName = `${'v'.repeat(26)}/${'i'.repeat(26)}/field`;
    await expect(onePasswordDriver.test(cfg, creds, { ...opts, probeName })).resolves.toContain('probe field readable');
    egress.guardedFetch.mockResolvedValueOnce(new Response('rejected op-token', { status: 401 }));
    const error = await onePasswordDriver.test(cfg, creds, opts).catch((e: Error) => e);
    expect(String(error)).not.toContain('op-token');
    expect(String(error)).toContain('401');
  });
});

describe('exec', () => {
  const script = (code: string) => ({ command: [process.execPath, '-e', code, '{name}'], timeoutSeconds: 10 });

  it('is off without NINEDEPLOY_SECRET_EXEC=1', async () => {
    expect(() => execDriver.validate(script(''))).toThrow(/start the panel with NINEDEPLOY_SECRET_EXEC=1/);
    await expect(execDriver.read(script(''), {}, 'x', opts)).rejects.toThrow(/exec secret provider is off/);
  });

  it('runs without a shell, passes the name, drops one trailing newline and hides the panel environment', async () => {
    vi.stubEnv('NINEDEPLOY_SECRET_EXEC', '1');
    const code = 'process.stdout.write([process.argv[1], process.env.NINEDEPLOY_SECRET_NAME, String(process.env.NINEDEPLOY_MASTER_KEY)].join("|") + "\\n")';
    expect(await execDriver.read(script(code), {}, 'prod/db:pw;rm -rf $HOME', opts).catch(() => 'refused')).toBe('refused');
    expect(await execDriver.read(script(code), {}, 'prod/db:pw', opts)).toBe('prod/db:pw|prod/db:pw|undefined');
  });

  it('refuses .. segments and reports exit, timeout and output limits', async () => {
    vi.stubEnv('NINEDEPLOY_SECRET_EXEC', '1');
    await expect(execDriver.read(script(''), {}, 'a/../etc/passwd', opts)).rejects.toThrow('Invalid exec reference name');
    // As its own argument a leading dash would read as an option.
    await expect(execDriver.read(script(''), {}, '--output=/tmp/x', opts)).rejects.toThrow('Invalid exec reference name');
    expect(await execDriver.read(script('process.stdout.write(process.argv[1])'), {}, 'a/-b', opts)).toBe('a/-b');
    await expect(execDriver.read(script('process.stderr.write("no such secret"); process.exit(3)'), {}, 'x', opts)).rejects.toThrow(
      'The exec command failed: it exited with 3: no such secret',
    );
    await expect(execDriver.read({ ...script('setTimeout(() => {}, 60000)'), timeoutSeconds: 1 }, {}, 'x', opts)).rejects.toThrow(
      'it ran longer than 1 s',
    );
    await expect(execDriver.read(script('process.stdout.write("x".repeat(70000))'), {}, 'x', opts)).rejects.toThrow('more than 64 KiB');
    await expect(execDriver.read({ command: ['/nonexistent/secret-cli'], timeoutSeconds: 5 }, {}, 'x', opts)).rejects.toThrow(
      '/nonexistent/secret-cli was not found',
    );
  });
});

describe('resolution through the provider rows', () => {
  const row = (kind: string, configJson: unknown, creds: Record<string, string>) =>
    ({
      id: 7,
      kind,
      enabled: true,
      configJson,
      credentialEncrypted: encrypt(JSON.stringify(creds)),
      lastTestedAt: null,
      lastTestError: null,
      createdByUserId: null,
      createdAt: new Date(0),
      updatedAt: new Date(1000),
    }) as never;
  const refsOf = (env: Record<string, string>) => {
    const out = new Map<string, { ref: never; envKeys: string[] }>();
    for (const [k, v] of Object.entries(env)) for (const r of findSecretRefs(v)) out.set(r.raw, { ref: r as never, envKeys: [k] });
    return out;
  };

  it('reads ssm with the aws row and a JSON key from a named provider, each source once', async () => {
    const awsRow = providers.asConfigured(row('aws', { region: 'eu-west-1', roleSessionName: 'nd' }, { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 's' }));
    const azRow = providers.asConfigured(
      row('azure', { vaultUrl: 'https://v.vault.azure.net', tenantId: '11111111-2222-3333-4444-555555555555', clientId: '11111111-2222-3333-4444-555555555555' }, { clientSecret: 'cs' }),
    );
    expect(azRow?.kind).toBe('azure');
    egress.guardedFetch
      .mockResolvedValueOnce(json({ Parameter: { Value: 'ssm-value' } }))
      .mockResolvedValueOnce(json({ access_token: 't' }))
      .mockResolvedValueOnce(json({ value: '{"user":"app","pass":"pw"}' }));
    const out = await providers.resolveExternalRefs(
      { aws: awsRow, azure: azRow },
      refsOf({ A: ref('ssm:/a'), U: ref('azure:db#user'), P: ref('azure:db#pass') }),
    );
    expect(Object.fromEntries(out)).toEqual({ [ref('ssm:/a')]: 'ssm-value', [ref('azure:db#user')]: 'app', [ref('azure:db#pass')]: 'pw' });
    expect(egress.guardedFetch).toHaveBeenCalledTimes(3);
  });

  it('a named row without its credential is not configured, and errors name the provider and env key', async () => {
    expect(providers.asConfigured(row('gcp', {}, {}))).toBeNull();
    expect(providers.asConfigured(row('exec', { command: ['/bin/x'] }, {}))?.kind).toBe('exec');
    const op = providers.asConfigured(row('onepassword', { address: 'https://c.example.com' }, { token: 't' }));
    egress.guardedFetch.mockResolvedValueOnce(json([]));
    await expect(providers.resolveExternalRefs({ onepassword: op }, refsOf({ DB: ref('op:V/I/F') }))).rejects.toThrow(
      '1Password Connect reference (env key DB): 1Password vault "V" was not found',
    );
    // Not configured: left for the caller to keep literal.
    expect((await providers.resolveExternalRefs({ gcp: null }, refsOf({ X: ref('gcp:a') }))).size).toBe(0);
  });
});
