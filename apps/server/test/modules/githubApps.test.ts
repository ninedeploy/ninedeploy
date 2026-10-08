/**
 * 0.13 GitHub App operator API (`modules/githubApps.ts`): the manifest flow
 * and its signed single-use state, manual registration, key and webhook
 * secret rotation, installation sync and delete. No network: `guardedFetch`
 * is a fake GitHub router (test/lib/githubAppKit.ts) and the panel origin is
 * pinned per test.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, githubApps, sources, users, type DB } from '@ninedeploy/db';

const h = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
  process.env['DOCKER_HOST'] = 'tcp://127.0.0.1:9';
  return {
    guardedFetch: vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>(),
    origin: 'https://panel.example.com',
  };
});

vi.mock('../../src/lib/egressGuard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/egressGuard.js')>();
  return { ...actual, guardedFetch: h.guardedFetch };
});
vi.mock('../../src/lib/panelOrigin.js', () => ({ panelOrigin: async () => h.origin }));

const { githubAppsRoutes, resetManifestNoncesForTests } = await import('../../src/modules/githubApps.js');
const { clearGithubAppCaches } = await import('../../src/lib/githubApp.js');
const { decrypt } = await import('../../src/lib/crypto.js');
const { asUser, buildTestApp } = await import('../helpers.js');
const { fakeGithub, json, migratedDb, rsaKeyPair, seedApp, seedInstallation } = await import('../lib/githubAppKit.js');

const key = rsaKeyPair('pkcs1');
const otherKey = rsaKeyPair('pkcs1');

let db: DB;
let gh: ReturnType<typeof fakeGithub>;

beforeEach(async () => {
  db = await migratedDb();
  await db.insert(users).values([
    { id: 1, email: 'op1@example.test', passwordHash: 'x', isInstanceOperator: true },
    { id: 2, email: 'op2@example.test', passwordHash: 'x', isInstanceOperator: true },
  ]);
  clearGithubAppCaches();
  resetManifestNoncesForTests();
  gh = fakeGithub();
  h.guardedFetch.mockReset();
  h.guardedFetch.mockImplementation(gh.handler);
  h.origin = 'https://panel.example.com';
  delete process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
});

async function server() {
  const app = await buildTestApp({ db });
  await app.register(githubAppsRoutes);
  return app;
}

function decodeState(state: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(state.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function jwtClaims(authorization: string | null): Record<string, unknown> {
  const jwt = (authorization ?? '').replace(/^Bearer /, '');
  return JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

const CONVERSION = {
  id: 777,
  slug: 'ninedeploy-panel',
  name: 'NineDeploy panel.example.com',
  client_id: 'Iv1.client',
  client_secret: 'CLIENT_SECRET_VALUE',
  webhook_secret: 'WEBHOOK_SECRET_VALUE',
  pem: key.privateKey,
  html_url: 'https://github.com/apps/ninedeploy-panel',
  owner: { login: 'acme', type: 'Organization' },
  permissions: { contents: 'read', metadata: 'read' },
  events: ['push', 'pull_request'],
};

function secretsIn(text: string): string[] {
  return [
    'CLIENT_SECRET_VALUE',
    'WEBHOOK_SECRET_VALUE',
    'PRIVATE KEY',
    key.privateKey.split('\n')[1]!,
    otherKey.privateKey.split('\n')[1]!,
  ].filter((s) => text.includes(s));
}

describe('POST /manifest', () => {
  it('builds a personal-account manifest with a signed state naming the user, hook key and API base', async () => {
    const app = await server();
    const res = await app.inject({ method: 'POST', url: '/manifest', headers: asUser(1), payload: { target: 'user' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const state = decodeState(body.state);
    expect(state).toMatchObject({ uid: 1, web: 'https://github.com', api: 'https://api.github.com' });
    expect(state['hookKey']).toMatch(/^[0-9a-f]{32}$/);
    expect(body.postUrl).toBe(`https://github.com/settings/apps/new?state=${encodeURIComponent(body.state)}`);
    expect(body.manifest).toMatchObject({
      url: 'https://panel.example.com',
      public: false,
      hook_attributes: { url: `https://panel.example.com/v1/hooks/github-app/${state['hookKey']}`, active: true },
      redirect_url: 'https://panel.example.com/github-apps/callback',
      setup_url: 'https://panel.example.com/github-apps/installed',
      setup_on_update: true,
      default_permissions: { contents: 'read', metadata: 'read', pull_requests: 'write', statuses: 'write' },
      default_events: ['push', 'pull_request'],
    });
    expect(body.manifest.default_permissions.checks).toBeUndefined();
    expect(String(body.manifest.name).length).toBeLessThanOrEqual(34);
    expect(body.manifest.name).toMatch(/^NineDeploy panel\.example/);
    expect(gh.calls).toHaveLength(0);
  });

  it('targets the organization and adds checks:write when asked; GHES derives <web>/api/v3', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/manifest',
      headers: asUser(1),
      payload: { target: 'org', org: 'acme', webBaseUrl: 'https://ghe.example.com/', checks: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.postUrl.startsWith('https://ghe.example.com/organizations/acme/settings/apps/new?state=')).toBe(true);
    expect(body.manifest.default_permissions.checks).toBe('write');
    expect(decodeState(body.state)).toMatchObject({ web: 'https://ghe.example.com', api: 'https://ghe.example.com/api/v3' });
  });

  it('refuses a localhost panel origin (GitHub cannot reach it)', async () => {
    h.origin = 'http://localhost:3000';
    const app = await server();
    const res = await app.inject({ method: 'POST', url: '/manifest', headers: asUser(1), payload: { target: 'user' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('panel_origin_local');
  });

  it('refuses an http GitHub base unless private egress is allowed', async () => {
    const app = await server();
    const payload = { target: 'user', webBaseUrl: 'http://ghe.lan' };
    const refused = await app.inject({ method: 'POST', url: '/manifest', headers: asUser(1), payload });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('insecure_base_url');
    process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = '1';
    const allowed = await app.inject({ method: 'POST', url: '/manifest', headers: asUser(1), payload });
    expect(allowed.statusCode).toBe(200);
  });

  it('is operator-only', async () => {
    const app = await server();
    const res = await app.inject({ method: 'POST', url: '/manifest', headers: asUser({ id: 3, isOperator: false }), payload: { target: 'user' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /manifest/complete', () => {
  async function startManifest(app: Awaited<ReturnType<typeof server>>, user = 1, payload: Record<string, unknown> = { target: 'user' }) {
    const res = await app.inject({ method: 'POST', url: '/manifest', headers: asUser(user), payload });
    return res.json() as { state: string; manifest: Record<string, unknown> };
  }

  it('converts the code, stores every secret encrypted and returns metadata only', async () => {
    gh.on('POST', /^\/app-manifests\/[^/]+\/conversions$/, () => json(201, CONVERSION));
    const app = await server();
    const { state } = await startManifest(app);
    const hookKey = decodeState(state)['hookKey'];
    const res = await app.inject({ method: 'POST', url: '/manifest/complete', headers: asUser(1), payload: { code: 'abc123', state } });
    expect(res.statusCode).toBe(200);
    expect(secretsIn(res.body)).toEqual([]);
    expect(res.json()).toMatchObject({
      appId: 777,
      slug: 'ninedeploy-panel',
      ownerLogin: 'acme',
      ownerType: 'Organization',
      webhookUrl: `https://panel.example.com/v1/hooks/github-app/${hookKey}`,
      installUrl: 'https://github.com/apps/ninedeploy-panel/installations/new',
      hasPrivateKey: true,
      hasClientSecret: true,
    });

    // The conversion is unauthenticated: the code is the credential.
    const call = gh.calls.find((c) => c.path === '/app-manifests/abc123/conversions')!;
    expect(call.url.startsWith('https://api.github.com/')).toBe(true);
    expect(call.headers.get('authorization')).toBeNull();

    const row = (await db.query.githubApps.findFirst())!;
    expect(row.hookKey).toBe(hookKey);
    expect(row.createdByUserId).toBe(1);
    for (const enc of [row.privateKeyEncrypted, row.webhookSecretEncrypted, row.clientSecretEncrypted!]) {
      expect(secretsIn(enc)).toEqual([]);
    }
    expect(decrypt(row.privateKeyEncrypted)).toBe(key.privateKey);
    expect(decrypt(row.webhookSecretEncrypted)).toBe('WEBHOOK_SECRET_VALUE');
    expect(decrypt(row.clientSecretEncrypted!)).toBe('CLIENT_SECRET_VALUE');

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'github_app.create'));
    expect(audits).toHaveLength(1);
    expect(secretsIn(JSON.stringify(audits))).toEqual([]);
  });

  it('refuses a replayed state', async () => {
    gh.on('POST', /^\/app-manifests\/[^/]+\/conversions$/, () => json(201, CONVERSION));
    const app = await server();
    const { state } = await startManifest(app);
    const first = await app.inject({ method: 'POST', url: '/manifest/complete', headers: asUser(1), payload: { code: 'abc', state } });
    expect(first.statusCode).toBe(200);
    const replay = await app.inject({ method: 'POST', url: '/manifest/complete', headers: asUser(1), payload: { code: 'abc', state } });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.code).toBe('manifest_state_used');
    expect(gh.calls.filter((c) => c.path.endsWith('/conversions'))).toHaveLength(1);
  });

  it("refuses another user's state without burning it", async () => {
    gh.on('POST', /^\/app-manifests\/[^/]+\/conversions$/, () => json(201, CONVERSION));
    const app = await server();
    const { state } = await startManifest(app, 1);
    const wrong = await app.inject({ method: 'POST', url: '/manifest/complete', headers: asUser(2), payload: { code: 'abc', state } });
    expect(wrong.statusCode).toBe(403);
    expect(gh.calls).toHaveLength(0);
    const right = await app.inject({ method: 'POST', url: '/manifest/complete', headers: asUser(1), payload: { code: 'abc', state } });
    expect(right.statusCode).toBe(200);
  });

  it('refuses a tampered or expired state', async () => {
    const app = await server();
    const { state } = await startManifest(app);
    const [payload, sig] = state.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...decodeState(state), uid: 2 })).toString('base64url');
    const tampered = await app.inject({ method: 'POST', url: '/manifest/complete', headers: asUser(2), payload: { code: 'abc', state: `${forged}.${sig}` } });
    expect(tampered.statusCode).toBe(400);
    expect(tampered.json().error.code).toBe('manifest_state_invalid');

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61 * 60_000);
    const expired = await app.inject({ method: 'POST', url: '/manifest/complete', headers: asUser(1), payload: { code: 'abc', state: `${payload}.${sig}` } });
    expect(expired.statusCode).toBe(400);
    expect(expired.json().error.code).toBe('manifest_state_expired');
    expect(gh.calls).toHaveLength(0);
  });

  it('answers 400 manifest_code_invalid for a code GitHub does not know', async () => {
    const app = await server();
    const { state } = await startManifest(app);
    const res = await app.inject({ method: 'POST', url: '/manifest/complete', headers: asUser(1), payload: { code: 'nope', state } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('manifest_code_invalid');
    expect(await db.query.githubApps.findMany()).toHaveLength(0);
  });

  it('calls the GHES API base carried in the state', async () => {
    gh.on('POST', /^\/api\/v3\/app-manifests\/[^/]+\/conversions$/, () =>
      json(201, { ...CONVERSION, html_url: 'https://ghe.example.com/github-apps/nd' }),
    );
    const app = await server();
    const { state } = await startManifest(app, 1, { target: 'user', webBaseUrl: 'https://ghe.example.com' });
    const res = await app.inject({ method: 'POST', url: '/manifest/complete', headers: asUser(1), payload: { code: 'c1', state } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ webBaseUrl: 'https://ghe.example.com', apiBaseUrl: 'https://ghe.example.com/api/v3' });
    expect(gh.calls[0]!.url).toBe('https://ghe.example.com/api/v3/app-manifests/c1/conversions');
  });

  it('generates and registers a webhook secret when GitHub returns none', async () => {
    gh.on('POST', /^\/app-manifests\/[^/]+\/conversions$/, () => json(201, { ...CONVERSION, webhook_secret: null }));
    gh.on('PATCH', /^\/app\/hook\/config$/, () => json(200, {}));
    const app = await server();
    const { state } = await startManifest(app);
    const res = await app.inject({ method: 'POST', url: '/manifest/complete', headers: asUser(1), payload: { code: 'c', state } });
    expect(res.statusCode).toBe(200);
    const patch = gh.calls.find((c) => c.method === 'PATCH')!;
    const row = (await db.query.githubApps.findFirst())!;
    expect(patch.body).toMatchObject({ url: `https://panel.example.com/v1/hooks/github-app/${row.hookKey}`, content_type: 'json' });
    expect(decrypt(row.webhookSecretEncrypted)).toBe(patch.body!['secret']);
    expect(res.body).not.toContain(String(patch.body!['secret']));
  });
});

describe('POST / (manual entry)', () => {
  const appInfo = {
    id: 4242,
    slug: 'my-app',
    client_id: 'Iv1.manual',
    html_url: 'https://github.com/apps/my-app',
    owner: { login: 'octo', type: 'User' },
    permissions: { contents: 'read' },
    events: ['push'],
  };

  it('validates the key with GET /app, generates a webhook secret and registers it', async () => {
    gh.on('GET', /^\/app$/, () => json(200, appInfo));
    gh.on('PATCH', /^\/app\/hook\/config$/, () => json(200, {}));
    const app = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(1),
      payload: { name: 'Manual', appId: 4242, privateKey: key.privateKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Manual', appId: 4242, slug: 'my-app', clientId: 'Iv1.manual', ownerLogin: 'octo', hasClientSecret: false });
    expect(secretsIn(res.body)).toEqual([]);

    const get = gh.calls.find((c) => c.method === 'GET' && c.path === '/app')!;
    expect(jwtClaims(get.headers.get('authorization'))).toMatchObject({ iss: 4242 });
    const patch = gh.calls.find((c) => c.method === 'PATCH')!;
    const row = (await db.query.githubApps.findFirst())!;
    expect(patch.body).toMatchObject({ url: `https://panel.example.com/v1/hooks/github-app/${row.hookKey}`, content_type: 'json' });
    expect(String(patch.body!['secret'])).toMatch(/^[0-9a-f]{64}$/);
    expect(decrypt(row.webhookSecretEncrypted)).toBe(patch.body!['secret']);
    expect(res.body).not.toContain(String(patch.body!['secret']));
    expect(row.hookKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it('keeps a given webhook secret and does not touch the hook config', async () => {
    gh.on('GET', /^\/app$/, () => json(200, appInfo));
    h.origin = 'http://localhost:3000';
    const app = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(1),
      payload: { name: 'Manual', appId: 4242, privateKey: key.privateKey, webhookSecret: 'given-secret', clientSecret: 'cs' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasClientSecret).toBe(true);
    expect(gh.calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(decrypt((await db.query.githubApps.findFirst())!.webhookSecretEncrypted)).toBe('given-secret');
  });

  it('stores nothing when GitHub refuses the credentials or the key names another App', async () => {
    gh.on('GET', /^\/app$/, () => json(401, { message: 'A JSON web token could not be decoded' }));
    const app = await server();
    const payload = { name: 'Manual', appId: 4242, privateKey: key.privateKey };
    const refused = await app.inject({ method: 'POST', url: '/', headers: asUser(1), payload });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('github_app_rejected');

    gh.on('GET', /^\/app$/, () => json(200, { ...appInfo, id: 1 }));
    const mismatch = await app.inject({ method: 'POST', url: '/', headers: asUser(1), payload });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe('github_app_mismatch');
    expect(await db.query.githubApps.findMany()).toHaveLength(0);
    expect(secretsIn(refused.body + mismatch.body)).toEqual([]);
  });

  it('refuses a PEM that is not a usable RSA key before calling GitHub', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(1),
      payload: { name: 'Manual', appId: 4242, privateKey: '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('github_app_bad_key');
    expect(gh.calls).toHaveLength(0);
  });

  it('refuses http bases unless private egress is allowed, and a duplicate App', async () => {
    const app = await server();
    const http = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(1),
      payload: { name: 'GHES', appId: 1, privateKey: key.privateKey, webBaseUrl: 'http://ghe.lan', apiBaseUrl: 'http://ghe.lan/api/v3' },
    });
    expect(http.statusCode).toBe(400);
    expect(http.json().error.code).toBe('insecure_base_url');

    await seedApp(db, key.privateKey, { appId: 4242 });
    const dup = await app.inject({ method: 'POST', url: '/', headers: asUser(1), payload: { name: 'Again', appId: 4242, privateKey: key.privateKey } });
    expect(dup.statusCode).toBe(409);
    expect(gh.calls).toHaveLength(0);
  });
});

describe('reads, updates and delete', () => {
  it('lists and shows Apps without any secret', async () => {
    const row = await seedApp(db, key.privateKey, { clientSecretEncrypted: 'x', htmlUrl: 'https://github.com/apps/nd' });
    const app = await server();
    const list = await app.inject({ method: 'GET', url: '/', headers: asUser(1) });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    const one = await app.inject({ method: 'GET', url: `/${row.id}`, headers: asUser(1) });
    expect(one.json()).toMatchObject({
      id: row.id,
      webhookUrl: `https://panel.example.com/v1/hooks/github-app/${row.hookKey}`,
      installUrl: 'https://github.com/apps/nd/installations/new',
      hasPrivateKey: true,
      hasClientSecret: true,
    });
    for (const body of [list.body, one.body]) {
      expect(body).not.toMatch(/Encrypted|whsec_test|PRIVATE KEY/);
    }
    expect((await app.inject({ method: 'GET', url: '/999', headers: asUser(1) })).statusCode).toBe(404);
  });

  it('patches the name and client secret (null clears it)', async () => {
    const row = await seedApp(db, key.privateKey);
    const app = await server();
    const set = await app.inject({ method: 'PATCH', url: `/${row.id}`, headers: asUser(1), payload: { name: 'Renamed', clientSecret: 'sec' } });
    expect(set.json()).toMatchObject({ name: 'Renamed', hasClientSecret: true });
    expect(decrypt((await db.query.githubApps.findFirst())!.clientSecretEncrypted!)).toBe('sec');
    const cleared = await app.inject({ method: 'PATCH', url: `/${row.id}`, headers: asUser(1), payload: { clientSecret: null } });
    expect(cleared.json().hasClientSecret).toBe(false);
    expect((await app.inject({ method: 'PATCH', url: `/${row.id}`, headers: asUser(1), payload: {} })).statusCode).toBe(400);
  });

  it('rotates the private key only after GitHub accepts it', async () => {
    const row = await seedApp(db, key.privateKey);
    gh.on('GET', /^\/app$/, () => json(401, { message: 'bad' }));
    const app = await server();
    const refused = await app.inject({ method: 'PUT', url: `/${row.id}/private-key`, headers: asUser(1), payload: { privateKey: otherKey.privateKey } });
    expect(refused.statusCode).toBe(400);
    expect(decrypt((await db.query.githubApps.findFirst())!.privateKeyEncrypted)).toBe(key.privateKey);

    gh.on('GET', /^\/app$/, () => json(200, { id: row.appId, slug: 'nd' }));
    const ok = await app.inject({ method: 'PUT', url: `/${row.id}/private-key`, headers: asUser(1), payload: { privateKey: otherKey.privateKey } });
    expect(ok.statusCode).toBe(200);
    expect(secretsIn(ok.body)).toEqual([]);
    expect(decrypt((await db.query.githubApps.findFirst())!.privateKeyEncrypted)).toBe(otherKey.privateKey.trim());
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'github_app.rotate_key'))).toHaveLength(1);
  });

  it('re-syncs the webhook with the stored secret and rotates the secret', async () => {
    const row = await seedApp(db, key.privateKey);
    gh.on('PATCH', /^\/app\/hook\/config$/, () => json(200, {}));
    const app = await server();
    const sync = await app.inject({ method: 'POST', url: `/${row.id}/webhook/sync`, headers: asUser(1) });
    expect(sync.statusCode).toBe(200);
    expect(gh.calls.at(-1)!.body).toEqual({ url: `https://panel.example.com/v1/hooks/github-app/${row.hookKey}`, secret: 'whsec_test', content_type: 'json' });
    expect(sync.body).not.toContain('whsec_test');

    const rotate = await app.inject({ method: 'POST', url: `/${row.id}/webhook-secret/rotate`, headers: asUser(1) });
    expect(rotate.statusCode).toBe(200);
    const sent = String(gh.calls.at(-1)!.body!['secret']);
    expect(sent).not.toBe('whsec_test');
    expect(decrypt((await db.query.githubApps.findFirst())!.webhookSecretEncrypted)).toBe(sent);
    expect(rotate.body).not.toContain(sent);

    h.origin = 'http://127.0.0.1:3000';
    const local = await app.inject({ method: 'POST', url: `/${row.id}/webhook/sync`, headers: asUser(1) });
    expect(local.statusCode).toBe(400);
  });

  it('keeps the rotated-out secret when GitHub refuses the new hook config', async () => {
    const row = await seedApp(db, key.privateKey);
    gh.on('PATCH', /^\/app\/hook\/config$/, () => json(500, { message: 'boom' }));
    const app = await server();
    const res = await app.inject({ method: 'POST', url: `/${row.id}/webhook-secret/rotate`, headers: asUser(1) });
    expect(res.statusCode).toBe(502);
    expect(decrypt((await db.query.githubApps.findFirst())!.webhookSecretEncrypted)).toBe('whsec_test');
  });

  it('deletes the App but keeps its generated sources', async () => {
    const row = await seedApp(db, key.privateKey);
    const { sourceId } = await seedInstallation(db, row);
    const app = await server();
    const res = await app.inject({ method: 'DELETE', url: `/${row.id}`, headers: asUser(1) });
    expect(res.statusCode).toBe(200);
    expect(await db.query.githubApps.findMany()).toHaveLength(0);
    expect(await db.query.githubAppInstallations.findMany()).toHaveLength(0);
    expect(await db.query.sources.findFirst({ where: eq(sources.id, sourceId) })).toMatchObject({ type: 'github_app', tokenEncrypted: null });
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'github_app.delete'))).toHaveLength(1);
  });
});

describe('installations', () => {
  const installations = [
    { id: 11, app_id: 4242, account: { login: 'acme', type: 'Organization', id: 501 }, repository_selection: 'all', permissions: { contents: 'read' }, suspended_at: null },
    { id: 12, app_id: 4242, account: { login: 'octo', type: 'User', id: 502 }, repository_selection: 'selected', permissions: {}, suspended_at: '2026-10-01T00:00:00Z' },
  ];

  it('syncs installations into rows and one tokenless github_app source each, idempotently', async () => {
    const row = await seedApp(db, key.privateKey);
    let listed = installations;
    gh.on('GET', /^\/app\/installations$/, () => json(200, listed));
    const app = await server();

    // The SPA's installation_id query is never read: only GitHub's list counts.
    const first = await app.inject({ method: 'POST', url: `/${row.id}/installations/sync?installation_id=999`, headers: asUser(1) });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ created: 2, updated: 0, removed: 0, sourcesCreated: 2, truncated: false });
    const call = gh.calls.find((c) => c.path === '/app/installations')!;
    expect(jwtClaims(call.headers.get('authorization'))).toMatchObject({ iss: 4242 });

    const rows = await db.query.githubAppInstallations.findMany({ orderBy: (t, { asc }) => [asc(t.installationId)] });
    expect(rows.map((r) => r.installationId)).toEqual([11, 12]);
    expect(rows[0]).toMatchObject({ accountLogin: 'acme', accountType: 'Organization', accountId: 501, repositorySelection: 'all', suspendedAt: null });
    expect(rows[1]!.suspendedAt).toBeInstanceOf(Date);
    const srcs = await db.query.sources.findMany();
    expect(srcs.map((s) => [s.type, s.name, s.tokenEncrypted, s.deployKeyEncrypted])).toEqual([
      ['github_app', 'gh-app:acme', null, null],
      ['github_app', 'gh-app:octo', null, null],
    ]);
    expect(rows.map((r) => r.sourceId).sort()).toEqual(srcs.map((s) => s.id).sort());

    const again = await app.inject({ method: 'POST', url: `/${row.id}/installations/sync`, headers: asUser(1) });
    expect(again.json()).toMatchObject({ created: 0, updated: 2, sourcesCreated: 0 });
    expect(await db.query.sources.findMany()).toHaveLength(2);

    // A deleted source comes back; an installation GitHub no longer lists is marked removed, never deleted.
    await db.delete(sources).where(eq(sources.id, rows[0]!.sourceId!));
    listed = [installations[0]!];
    const third = await app.inject({ method: 'POST', url: `/${row.id}/installations/sync`, headers: asUser(1) });
    expect(third.json()).toMatchObject({ updated: 1, removed: 1, sourcesCreated: 1 });
    const after = await db.query.githubAppInstallations.findMany({ orderBy: (t, { asc }) => [asc(t.installationId)] });
    expect(after).toHaveLength(2);
    expect(after[1]!.removedAt).toBeInstanceOf(Date);
    expect(after[0]!.sourceId).not.toBe(rows[0]!.sourceId);
    expect(await db.query.sources.findFirst({ where: eq(sources.id, after[0]!.sourceId!) })).toMatchObject({ type: 'github_app' });

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'github_app.sync'));
    expect(audits).toHaveLength(3);
  });

  it('runs concurrent syncs one at a time (one source per installation)', async () => {
    const row = await seedApp(db, key.privateKey);
    gh.on('GET', /^\/app\/installations$/, () => json(200, installations));
    const app = await server();
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: `/${row.id}/installations/sync`, headers: asUser(1) }),
      app.inject({ method: 'POST', url: `/${row.id}/installations/sync`, headers: asUser(1) }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(await db.query.sources.findMany()).toHaveLength(2);
  });

  it('lists installations with a configure link and no secret', async () => {
    const row = await seedApp(db, key.privateKey);
    await seedInstallation(db, row, { installationId: 21, accountLogin: 'acme', accountType: 'Organization' });
    const app = await server();
    const res = await app.inject({ method: 'GET', url: `/${row.id}/installations`, headers: asUser(1) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({
        installationId: 21,
        accountLogin: 'acme',
        repositorySelection: 'selected',
        configureUrl: 'https://github.com/organizations/acme/settings/installations/21',
        removedAt: null,
      }),
    ]);
  });

  it('surfaces a GitHub failure without storing anything', async () => {
    const row = await seedApp(db, key.privateKey);
    gh.on('GET', /^\/app\/installations$/, () => json(401, { message: 'Bad credentials' }));
    const app = await server();
    const res = await app.inject({ method: 'POST', url: `/${row.id}/installations/sync`, headers: asUser(1) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('github_app_rejected');
    expect(await db.query.githubAppInstallations.findMany()).toHaveLength(0);
    expect(await db.query.githubApps.findFirst({ where: eq(githubApps.id, row.id) })).toBeTruthy();
  });
});
