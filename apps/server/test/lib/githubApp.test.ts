/**
 * 0.13 GitHub App client (`lib/githubApp.ts`): the RS256 App JWT, installation
 * token minting and caching, installation state on 404/403, the REST helper's
 * https rule and pagination, and redaction of every secret it handles.
 * No network: `guardedFetch` is replaced by a fake GitHub router.
 */
import { verify } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, githubAppInstallations, githubApps, type DB, type GithubApp, type GithubAppInstallation } from '@ninedeploy/db';

const h = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'cd'.repeat(32);
  process.env['DOCKER_HOST'] = 'tcp://127.0.0.1:9';
  return {
    guardedFetch: vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>(),
    decryptCalls: 0,
  };
});

vi.mock('../../src/lib/egressGuard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/egressGuard.js')>();
  return { ...actual, guardedFetch: h.guardedFetch };
});
// Counts decrypts so the KeyObject cache is observable; the real cipher runs.
vi.mock('../../src/lib/crypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/crypto.js')>();
  return {
    ...actual,
    decrypt: (payload: string) => {
      h.decryptCalls++;
      return actual.decrypt(payload);
    },
  };
});

const {
  appJwt,
  apiBase,
  clearGithubAppCaches,
  GithubAppError,
  githubApi,
  installationToken,
  listInstallationRepositories,
  revokeInstallationToken,
} = await import('../../src/lib/githubApp.js');
const { encrypt } = await import('../../src/lib/crypto.js');
const { fakeGithub, json, migratedDb, rsaKeyPair, seedApp, seedInstallation } = await import('./githubAppKit.js');

const pkcs1 = rsaKeyPair('pkcs1');
const pkcs8 = rsaKeyPair('pkcs8');

let db: DB;
let app: GithubApp;
let inst: GithubAppInstallation;
let gh: ReturnType<typeof fakeGithub>;
let clock = Date.parse('2026-10-08T12:00:00Z');

beforeAll(async () => {
  db = await migratedDb();
  app = await seedApp(db, pkcs1.privateKey);
  ({ inst } = await seedInstallation(db, app));
});

beforeEach(async () => {
  clearGithubAppCaches();
  clock = Date.parse('2026-10-08T12:00:00Z');
  gh = fakeGithub(() => clock);
  h.guardedFetch.mockReset();
  h.guardedFetch.mockImplementation(gh.handler);
  h.decryptCalls = 0;
  delete process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
  await db.update(githubAppInstallations).set({ removedAt: null, suspendedAt: null }).where(eq(githubAppInstallations.id, inst.id));
  inst = (await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.id, inst.id) }))!;
});

function decodeJwt(jwt: string) {
  const [header, payload, signature] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(header!, 'base64url').toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<string, number>,
    signed: Buffer.from(`${header}.${payload}`),
    signature: Buffer.from(signature!, 'base64url'),
  };
}

describe('appJwt', () => {
  it('signs RS256 with a PKCS#1 key: verifiable with the public key, iat now-60, exp now+540, iss = App id', () => {
    const jwt = appJwt(app, clock);
    const { header, payload, signed, signature } = decodeJwt(jwt);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    const now = Math.floor(clock / 1000);
    expect(payload).toEqual({ iat: now - 60, exp: now + 540, iss: 4242 });
    expect(verify('RSA-SHA256', signed, pkcs1.publicKey, signature)).toBe(true);
    expect(verify('RSA-SHA256', signed, pkcs8.publicKey, signature)).toBe(false);
  });

  it('accepts a PKCS#8 key too', async () => {
    const other = await seedApp(db, pkcs8.privateKey, { appId: 77 });
    const { signed, signature, payload } = decodeJwt(appJwt(other, clock));
    expect(payload.iss).toBe(77);
    expect(verify('RSA-SHA256', signed, pkcs8.publicKey, signature)).toBe(true);
  });

  it('caches the parsed key per (id, updatedAt) and re-reads it after a rotation', () => {
    appJwt(app, clock);
    appJwt(app, clock + 1000);
    expect(h.decryptCalls).toBe(1);
    // Rotated within the same second: the ciphertext differs, so the new key is used.
    const rotated = { ...app, privateKeyEncrypted: encrypt(pkcs8.privateKey) };
    const { signed, signature } = decodeJwt(appJwt(rotated, clock));
    expect(h.decryptCalls).toBe(2);
    expect(verify('RSA-SHA256', signed, pkcs8.publicKey, signature)).toBe(true);
    appJwt({ ...rotated, updatedAt: new Date(app.updatedAt.getTime() + 5000) }, clock);
    expect(h.decryptCalls).toBe(3);
  });

  it('refuses an unreadable or non-RSA key without echoing it', () => {
    const garbage = '-----BEGIN RSA PRIVATE KEY-----\nTOPSECRETPEMBODY\n-----END RSA PRIVATE KEY-----';
    const bad = { ...app, id: 990, privateKeyEncrypted: encrypt(garbage) };
    let thrown: unknown;
    try {
      appJwt(bad);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GithubAppError);
    expect((thrown as Error).message).toMatch(/could not be read/);
    expect((thrown as Error).message).not.toContain('TOPSECRETPEMBODY');
  });
});

describe('installationToken', () => {
  it('mints with the App JWT, sends the scope, and serves the cached token until 5 minutes before expiry', async () => {
    const t1 = await installationToken(db, app, inst, { repositoryIds: [5], permissions: { contents: 'read' }, now: clock });
    expect(t1).toBe('ghs_1_SECRETTOKEN');
    expect(gh.calls).toHaveLength(1);
    const call = gh.calls[0]!;
    expect(call.url).toBe('https://api.github.com/app/installations/9001/access_tokens');
    expect(call.body).toEqual({ repository_ids: [5], permissions: { contents: 'read' } });
    const jwt = call.headers.get('authorization')!.replace(/^Bearer /, '');
    const { signed, signature } = decodeJwt(jwt);
    expect(verify('RSA-SHA256', signed, pkcs1.publicKey, signature)).toBe(true);

    // 54 minutes later: still more than 5 minutes left → cached.
    expect(await installationToken(db, app, inst, { repositoryIds: [5], permissions: { contents: 'read' }, now: clock + 54 * 60_000 })).toBe(t1);
    expect(gh.calls).toHaveLength(1);
    // 56 minutes later: inside the 5-minute margin → refreshed.
    clock += 56 * 60_000;
    expect(await installationToken(db, app, inst, { repositoryIds: [5], permissions: { contents: 'read' }, now: clock })).toBe('ghs_2_SECRETTOKEN');
    expect(gh.calls).toHaveLength(2);
  });

  it('keys the cache by sorted repositories and permissions', async () => {
    const a = await installationToken(db, app, inst, { repositoryIds: [2, 1], permissions: { contents: 'read' }, now: clock });
    expect(await installationToken(db, app, inst, { repositoryIds: [1, 2, 2], permissions: { contents: 'read' }, now: clock })).toBe(a);
    const b = await installationToken(db, app, inst, { repositoryIds: [1], permissions: { contents: 'read' }, now: clock });
    const c = await installationToken(db, app, inst, { repositoryIds: [1], permissions: { metadata: 'read' }, now: clock });
    const d = await installationToken(db, app, inst, { now: clock });
    expect(new Set([a, b, c, d]).size).toBe(4);
    expect(gh.calls).toHaveLength(4);
    expect(gh.calls[3]!.body).toEqual({});
  });

  it('a 404 marks the installation removed (audited, null actor) and evicts its tokens', async () => {
    const cached = await installationToken(db, app, inst, { now: clock });
    gh.on('POST', /access_tokens$/, () => json(404, { message: 'Not Found' }));
    clock += 58 * 60_000; // force a refresh
    await expect(installationToken(db, app, inst, { now: clock })).rejects.toMatchObject({ reason: 'removed', status: 404 });
    const row = await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.id, inst.id) });
    expect(row!.removedAt).toBeInstanceOf(Date);
    expect(row!.suspendedAt).toBeNull();
    const audits = await db.query.auditLog.findMany({ where: eq(auditLog.action, 'github_installation.removed') });
    expect(audits.at(-1)).toMatchObject({ userId: null, entity: 'acme' });
    expect(JSON.stringify(audits)).not.toContain(cached);
  });

  it('a 403 for a suspended installation sets suspended_at; another 403 changes nothing', async () => {
    gh.on('POST', /access_tokens$/, () => json(403, { message: 'Resource not accessible by integration' }));
    await expect(installationToken(db, app, inst, { permissions: { administration: 'write' }, now: clock })).rejects.toMatchObject({
      reason: 'forbidden',
      status: 403,
    });
    let row = await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.id, inst.id) });
    expect(row!.suspendedAt).toBeNull();

    gh.on('POST', /access_tokens$/, () => json(403, { message: 'This installation has been suspended' }));
    await expect(installationToken(db, app, inst, { now: clock })).rejects.toMatchObject({ reason: 'suspended' });
    row = await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.id, inst.id) });
    expect(row!.suspendedAt).toBeInstanceOf(Date);
    expect(row!.removedAt).toBeNull();
  });

  it('a 422 names the repository selection', async () => {
    gh.on('POST', /access_tokens$/, () =>
      json(422, { message: 'There is at least one repository that does not exist or is not accessible to the parent installation.' }),
    );
    await expect(installationToken(db, app, inst, { repositoryIds: [404], now: clock })).rejects.toThrow(/selected repositories/);
  });

  it('refuses an installation of another App', async () => {
    await expect(installationToken(db, app, { ...inst, githubAppId: app.id + 100 }, { now: clock })).rejects.toMatchObject({
      reason: 'no_installation',
    });
    expect(gh.calls).toHaveLength(0);
  });

  it('never puts the JWT or the token in a thrown message', async () => {
    // fetch's header validation embeds the whole header value in its message.
    h.guardedFetch.mockImplementation(async (_url, init) => {
      const auth = new Headers(init?.headers).get('authorization');
      throw new TypeError(`Headers.append: "${auth}" is an invalid header value.`);
    });
    let thrown: Error | undefined;
    try {
      await installationToken(db, app, inst, { now: clock });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(GithubAppError);
    expect(thrown!.message).toContain('[redacted]');
    expect(thrown!.message).not.toMatch(/eyJ[A-Za-z0-9_-]+\./); // no JWT segment
    expect(thrown!.message).not.toContain('BEGIN RSA');

    const token = 'ghs_LEAKCANARY\nsecond-line-secret';
    h.guardedFetch.mockImplementation(async () => {
      throw new TypeError(`invalid header value Bearer ${token}`);
    });
    const err = await githubApi(app, token, 'GET', '/installation/repositories').catch((e: Error) => e);
    expect((err as Error).message).not.toContain('LEAKCANARY');
    expect((err as Error).message).not.toContain('second-line-secret');
  });
});

describe('githubApi', () => {
  it('requires https unless private egress is allowed, and refuses credentials in the base', async () => {
    const http = { apiBaseUrl: 'http://ghe.internal/api/v3' };
    expect(() => apiBase(http)).toThrow(/must use https/);
    await expect(githubApi(http, 't', 'GET', '/app')).rejects.toMatchObject({ reason: 'bad_base_url' });
    expect(h.guardedFetch).not.toHaveBeenCalled();
    process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = '1';
    expect(apiBase(http)).toBe('http://ghe.internal/api/v3');
    expect(() => apiBase({ apiBaseUrl: 'https://u:p@ghe.example.com/api/v3' })).toThrow(/credentials/);
    expect(apiBase({ apiBaseUrl: 'https://ghe.example.com/api/v3/' })).toBe('https://ghe.example.com/api/v3');
  });

  it('routes through guardedFetch on the App base, surfaces GitHub errors with their status, and does not follow redirects', async () => {
    gh.on('GET', /^\/api\/v3\/repos\/a\/b$/, () => json(200, { id: 1 }));
    const ghes = { apiBaseUrl: 'https://ghe.example.com/api/v3' };
    expect((await githubApi(ghes, 'tok', 'GET', '/repos/a/b')).data).toEqual({ id: 1 });
    expect(h.guardedFetch.mock.calls[0]![0]).toBe('https://ghe.example.com/api/v3/repos/a/b');
    await expect(githubApi(ghes, 'tok', 'GET', '/repos/a/missing')).rejects.toMatchObject({ status: 404, reason: 'not_found' });
    gh.on('GET', /^\/api\/v3\/moved$/, () => new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/' } }));
    await expect(githubApi(ghes, 'tok', 'GET', '/moved')).rejects.toThrow(/redirect/);
  });

  it('listInstallationRepositories follows the Link header with page URLs it builds itself', async () => {
    gh.on('GET', /^\/installation\/repositories$/, (call) => {
      const page = Number(new URL(call.url).searchParams.get('page'));
      const next = page < 3 ? { link: `<https://evil.example/steal?page=${page + 1}>; rel="next"` } : {};
      return json(200, { total_count: 3, repositories: [{ id: page, full_name: `acme/r${page}` }] }, next);
    });
    const all = await listInstallationRepositories(app, 'tok');
    expect(all.truncated).toBe(false);
    expect(all.repositories.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(gh.calls.every((c) => c.url.startsWith('https://api.github.com/installation/repositories?per_page=100&page='))).toBe(true);
    const capped = await listInstallationRepositories(app, 'tok', { maxPages: 2 });
    expect(capped).toMatchObject({ truncated: true });
    expect(capped.repositories).toHaveLength(2);
  });
});

describe('revokeInstallationToken', () => {
  it('DELETEs /installation/token with the token, evicts it, and never throws', async () => {
    gh.on('DELETE', /^\/installation\/token$/, () => json(204, null));
    const token = await installationToken(db, app, inst, { now: clock });
    expect(await revokeInstallationToken(app, token)).toBe(true);
    const del = gh.calls.at(-1)!;
    expect(del.method).toBe('DELETE');
    expect(del.headers.get('authorization')).toBe(`Bearer ${token}`);
    // Evicted: the next request mints a new one.
    expect(await installationToken(db, app, inst, { now: clock })).not.toBe(token);

    h.guardedFetch.mockRejectedValue(new Error(`boom ${token}`));
    expect(await revokeInstallationToken(app, token)).toBe(false);
  });
});

describe('row reads', () => {
  it('the App row carries no plaintext secret', async () => {
    const row = await db.query.githubApps.findFirst({ where: eq(githubApps.id, app.id) });
    expect(row!.privateKeyEncrypted).not.toContain('PRIVATE KEY');
  });
});
