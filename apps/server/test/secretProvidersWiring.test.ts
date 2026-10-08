/**
 * 0.14 secret managers (DESIGN §4, mount point M14) against a real migrated
 * SQLite, through the seams production mounts:
 *   - the `/v1/settings/secret-providers` routes (operator only, credentials
 *     never returned, omitted credentials kept, test updates last_tested_*);
 *   - the critical mount: `hasVaultRef` delegates to `hasSecretRef`, so every
 *     existing gate — env writes, the preview refusal, template deploys,
 *     service bundles, the preview withholding — catches `${{vault:…#…}}` and
 *     `${{aws:…}}` exactly as it catches Infisical / Doppler references;
 *   - r510 applies once, before the first fetch, for every provider;
 *   - the pipeline hands its deploy log to the resolver.
 * `guardedFetch` is mocked: nothing here reaches the network.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditLog,
  createDb,
  deployments,
  envVars,
  projects,
  secretProviders,
  serviceWorkspaces,
  services,
  users,
  workspaceMembers,
  workspaces,
  type DB,
} from '@ninedeploy/db';

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return { config: { ...actual.config, wildcardDomain: 'apps.example.com' } };
});
vi.mock('../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/proxy.js')>()),
  writeDynamicConfig: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/exec.js', () => ({
  capture: vi.fn(async () => ''),
  run: vi.fn(async () => undefined),
  sleep: vi.fn(async () => undefined),
}));
vi.mock('pm2', () => ({ default: { connect: vi.fn(), disconnect: vi.fn() } }));
const egress = vi.hoisted(() => ({ guardedFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>() }));
vi.mock('../src/lib/egressGuard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/egressGuard.js')>()),
  guardedFetch: egress.guardedFetch,
}));

vi.stubEnv('DOCKER_HOST', 'tcp://127.0.0.1:9');

const { decrypt, encrypt } = await import('../src/lib/crypto.js');
const { envRoutes, projectEnvRoutes } = await import('../src/modules/env.js');
const { templateRoutes } = await import('../src/modules/templates.js');
const { secretProviderRoutes } = await import('../src/modules/secretProviders.js');
const vault = await import('../src/lib/vault.js');
const { clearSecretProviderCaches } = await import('../src/lib/secretProviders/index.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const ref = (body: string) => ['$', '{{', body, '}}'].join('');
const VAULT_REF = ref('vault:team/app#db_password');
const AWS_REF = ref('aws:prod/db#password');
const NEW_REFS = [VAULT_REF, AWS_REF, ref('aws:arn:aws:secretsmanager:eu-west-1:123456789012:secret:prod/db-AbCdEf')];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let db: DB;
let close: () => void;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-secret-providers-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  egress.guardedFetch.mockReset();
  clearSecretProviderCaches();
});

afterEach(() => {
  vi.stubEnv('NINEDEPLOY_ALLOW_PRIVATE_EGRESS', '');
  close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

/** Operator #op, member #mem seated in W1 and W2; W1 is the only allowlisted workspace. */
async function world() {
  const [op] = await db.insert(users).values({ email: 'op@x', passwordHash: 'h', isInstanceOperator: true }).returning();
  const [mem] = await db.insert(users).values({ email: 'mem@x', passwordHash: 'h' }).returning();
  const [w1] = await db.insert(workspaces).values({ name: 'One', slug: 'one', ownerId: op!.id }).returning();
  const [w2] = await db.insert(workspaces).values({ name: 'Two', slug: 'two', ownerId: op!.id }).returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: w1!.id, userId: mem!.id, role: 'member' },
    { workspaceId: w2!.id, userId: mem!.id, role: 'member' },
  ]);
  await vault.setVaultAllowlist(db, { workspaceIds: [w1!.id], serviceIds: [] });
  const svc = async (name: string, ownerUserId: number, wsId: number | null) => {
    const [row] = await db.insert(services).values({ name, slug: name, ownerUserId }).returning();
    if (wsId != null) await db.insert(serviceWorkspaces).values({ serviceId: row!.id, workspaceId: wsId });
    return row!;
  };
  return { op: op!, mem: mem!, w1: w1!, w2: w2!, svc };
}

const OP = asUser({ id: 1, isOperator: true });
const MEMBER = (id: number) => asUser({ id, isOperator: false });

async function providerApp() {
  await db.insert(users).values([
    { id: 1, email: 'op@x', passwordHash: 'h', isInstanceOperator: true },
    { id: 2, email: 'mem@x', passwordHash: 'h' },
  ]);
  const app = await buildTestApp({ db });
  await app.register(secretProviderRoutes, { prefix: '/settings/secret-providers' });
  return app;
}

const audits = async (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));

// ── routes ────────────────────────────────────────────────────────────────
describe('/v1/settings/secret-providers routes', () => {
  it('registers exactly the routes of DESIGN §4.2 (wiring)', async () => {
    const seen: string[] = [];
    const app = Fastify();
    app.decorate('authenticate', async () => undefined);
    app.decorate('requireAdmin', async () => undefined);
    app.addHook('onRoute', (r) => {
      for (const m of [r.method].flat()) if (m !== 'HEAD') seen.push(`${m} ${r.url}`);
    });
    await app.register(secretProviderRoutes, { prefix: '/v1/settings/secret-providers' });
    await app.ready();
    expect(seen.sort()).toEqual(
      [
        'GET /v1/settings/secret-providers',
        'PUT /v1/settings/secret-providers/vault',
        'PUT /v1/settings/secret-providers/aws',
        'DELETE /v1/settings/secret-providers/vault',
        'DELETE /v1/settings/secret-providers/aws',
        'POST /v1/settings/secret-providers/vault/test',
        'POST /v1/settings/secret-providers/aws/test',
      ].sort(),
    );
    await app.close();
  });

  it('is operator only: anonymous 401, members 403', async () => {
    const app = await providerApp();
    expect((await app.inject({ method: 'GET', url: '/settings/secret-providers' })).statusCode).toBe(401);
    for (const [method, url] of [
      ['GET', '/settings/secret-providers'],
      ['PUT', '/settings/secret-providers/vault'],
      ['DELETE', '/settings/secret-providers/aws'],
      ['POST', '/settings/secret-providers/vault/test'],
    ] as const) {
      expect((await app.inject({ method, url, headers: MEMBER(2), payload: method === 'GET' || method === 'DELETE' ? undefined : {} })).statusCode).toBe(403);
    }
    expect(await db.select().from(secretProviders)).toEqual([]);
  });

  it('lists both kinds as not configured on a fresh install; an unknown kind is a 404', async () => {
    const app = await providerApp();
    const res = await app.inject({ method: 'GET', url: '/settings/secret-providers', headers: OP });
    expect(res.json()).toEqual([
      { kind: 'vault', configured: false, enabled: false, config: {}, hasCredential: false, lastTestedAt: null, lastTestError: null },
      { kind: 'aws', configured: false, enabled: false, config: {}, hasCredential: false, lastTestedAt: null, lastTestError: null },
    ]);
    expect((await app.inject({ method: 'PUT', url: '/settings/secret-providers/gcp', headers: OP, payload: {} })).statusCode).toBe(404);
  });

  it('vault: saves, never returns the credential, keeps an omitted one, audits without secrets', async () => {
    const app = await providerApp();
    const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/settings/secret-providers/vault', headers: OP, payload });
    const saved = await put({ config: { address: 'https://vault.invalid', authMethod: 'token' }, credentials: { token: 'hvs.TOPSECRET' } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.body).not.toContain('hvs.TOPSECRET');
    expect(saved.json()).toMatchObject({
      kind: 'vault',
      configured: true,
      enabled: true,
      hasCredential: true,
      config: { address: 'https://vault.invalid', authMethod: 'token', mount: 'secret', approleMount: 'approle' },
    });
    const [row] = await db.select().from(secretProviders);
    expect(row!.credentialEncrypted).not.toContain('TOPSECRET');
    expect(JSON.parse(decrypt(row!.credentialEncrypted))).toEqual({ token: 'hvs.TOPSECRET' });
    expect(row!.createdByUserId).toBe(1);

    // Omitted credentials keep the stored token.
    expect((await put({ enabled: false, config: { address: 'https://vault2.invalid', authMethod: 'token', mount: 'kv' } })).json()).toMatchObject({
      enabled: false,
      configured: false,
      hasCredential: true,
    });
    const [after] = await db.select().from(secretProviders);
    expect(JSON.parse(decrypt(after!.credentialEncrypted))).toEqual({ token: 'hvs.TOPSECRET' });
    expect(after!.configJson).toMatchObject({ address: 'https://vault2.invalid', mount: 'kv' });

    // Switching the auth method needs that method's credentials; the old token is not carried.
    const approle = await put({ config: { address: 'https://vault.invalid', authMethod: 'approle' } });
    expect(approle.statusCode).toBe(400);
    expect(approle.json().error.message).toMatch(/roleId and credentials.secretId required/);
    expect((await put({ config: { address: 'https://vault.invalid', authMethod: 'approle' }, credentials: { roleId: 'r', secretId: 's' } })).statusCode).toBe(200);
    const [switched] = await db.select().from(secretProviders);
    expect(JSON.parse(decrypt(switched!.credentialEncrypted))).toEqual({ roleId: 'r', secretId: 's' });

    const trail = await audits('settings.secret_provider.save');
    expect(trail).toHaveLength(3);
    expect(JSON.stringify(trail)).not.toMatch(/TOPSECRET|vault\.invalid/);
    expect(trail[0]!.meta).toMatchObject({ kind: 'vault', authMethod: 'token', created: true });
  });

  it('vault: refuses http without private egress, accepts it with', async () => {
    const app = await providerApp();
    const put = () =>
      app.inject({
        method: 'PUT',
        url: '/settings/secret-providers/vault',
        headers: OP,
        payload: { config: { address: 'http://vault.internal:8200', authMethod: 'token' }, credentials: { token: 't' } },
      });
    const refused = await put();
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toMatch(/must use https.*NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1/);
    vi.stubEnv('NINEDEPLOY_ALLOW_PRIVATE_EGRESS', '1');
    expect((await put()).statusCode).toBe(200);
  });

  it('aws: a bad region is a 400, a key change needs its secret, IMDS endpoints are refused', async () => {
    const app = await providerApp();
    const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/settings/secret-providers/aws', headers: OP, payload });
    const creds = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
    expect((await put({ config: { region: 'mars-1' }, credentials: creds })).statusCode).toBe(400);
    expect((await put({ config: { region: 'eu-west-1' } })).statusCode).toBe(400);
    expect((await put({ config: { region: 'eu-west-1', endpoint: 'https://169.254.169.254' }, credentials: creds })).statusCode).toBe(400);
    const ok = await put({ config: { region: 'eu-west-1' }, credentials: creds });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).not.toContain(creds.secretAccessKey);
    expect(ok.body).not.toContain(creds.accessKeyId);
    expect((await put({ config: { region: 'eu-west-1' }, credentials: { accessKeyId: 'AKIAI44QH8DHBEXAMPLE' } })).statusCode).toBe(400);
    expect((await put({ config: { region: 'us-east-1' } })).statusCode).toBe(200); // omitted: kept
    const [row] = await db.select().from(secretProviders);
    expect(JSON.parse(decrypt(row!.credentialEncrypted))).toEqual(creds);
  });

  it('test: updates last_tested_* only, answers ok:false (never 500) on failure, refuses the other kind\'s probe', async () => {
    const app = await providerApp();
    await app.inject({
      method: 'PUT',
      url: '/settings/secret-providers/vault',
      headers: OP,
      payload: { config: { address: 'https://vault.invalid', authMethod: 'token' }, credentials: { token: 'hvs.T' } },
    });
    const test = (payload?: unknown) => app.inject({ method: 'POST', url: '/settings/secret-providers/vault/test', headers: OP, payload });
    egress.guardedFetch.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND vault.invalid'));
    const failed = await test();
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toEqual({ ok: false, detail: 'Vault request failed: getaddrinfo ENOTFOUND vault.invalid' });
    let [row] = await db.select().from(secretProviders);
    expect(row!.lastTestError).toBe('Vault request failed: getaddrinfo ENOTFOUND vault.invalid');
    expect(row!.lastTestedAt).toBeInstanceOf(Date);

    egress.guardedFetch.mockImplementation(async () => json({ data: { data: { a: '1' } } }));
    expect((await test({ probePath: 'team/app' })).json()).toEqual({ ok: true, detail: 'Token accepted (lookup-self); probe path readable (1 field)' });
    [row] = await db.select().from(secretProviders);
    expect(row!.lastTestError).toBeNull();
    expect((await test({ probeSecretId: 'x' })).statusCode).toBe(400);
    expect(await audits('settings.secret_provider.save')).toHaveLength(1); // the test itself is not audited (exempt)

    // Unconfigured kind: no call at all.
    egress.guardedFetch.mockClear();
    const aws = await app.inject({ method: 'POST', url: '/settings/secret-providers/aws/test', headers: OP });
    expect(aws.json()).toEqual({ ok: false, detail: 'No aws secret manager is configured' });
    expect(egress.guardedFetch).not.toHaveBeenCalled();
  });

  it('an undecryptable credential reads as "not configured" — GET, test and deploy, never a 500', async () => {
    await db.insert(secretProviders).values({
      kind: 'vault',
      configJson: { address: 'https://vault.example.com', authMethod: 'token', mount: 'secret', approleMount: 'approle' },
      credentialEncrypted: 'v42:not:a:real:envelope',
    });
    const app = await providerApp();
    const list = await app.inject({ method: 'GET', url: '/settings/secret-providers', headers: OP });
    expect(list.statusCode).toBe(200);
    expect(list.json()[0]).toMatchObject({ kind: 'vault', configured: false, enabled: true, hasCredential: false });
    const test = await app.inject({ method: 'POST', url: '/settings/secret-providers/vault/test', headers: OP });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({ ok: false, detail: expect.stringMatching(/cannot be read/) });
    // Re-entering the credential repairs it (the unreadable one is not "kept").
    const put = await app.inject({
      method: 'PUT',
      url: '/settings/secret-providers/vault',
      headers: OP,
      payload: { config: { address: 'https://vault.example.com', authMethod: 'token' }, credentials: { token: 'new' } },
    });
    expect(put.json()).toMatchObject({ configured: true });
    expect(egress.guardedFetch).not.toHaveBeenCalled();
  });

  it('delete removes the row and audits; a second delete is a no-op', async () => {
    const app = await providerApp();
    await app.inject({
      method: 'PUT',
      url: '/settings/secret-providers/aws',
      headers: OP,
      payload: { config: { region: 'eu-west-1' }, credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 's' } },
    });
    expect((await app.inject({ method: 'DELETE', url: '/settings/secret-providers/aws', headers: OP })).json()).toEqual({ ok: true, deleted: true });
    expect((await app.inject({ method: 'DELETE', url: '/settings/secret-providers/aws', headers: OP })).json()).toEqual({ ok: true, deleted: false });
    expect(await db.select().from(secretProviders)).toEqual([]);
    expect(await audits('settings.secret_provider.delete')).toHaveLength(1);
  });
});

// ── the gates (M14) ─────────────────────────────────────────────────────────
describe('every hasVaultRef gate now covers vault: and aws: references', () => {
  it('env write gate: a member cannot store one on a non-allowlisted service / project / import / PATCH', async () => {
    const w = await world();
    const mine = await w.svc('mine', w.mem.id, w.w2.id);
    const allowed = await w.svc('allowed', w.mem.id, w.w1.id);
    const [p2] = await db.insert(projects).values({ name: 'P2', slug: 'p2', workspaceId: w.w2.id }).returning();
    const app = await buildTestApp({ db });
    await app.register(envRoutes, { prefix: '/services' });
    await app.register(projectEnvRoutes, { prefix: '/projects' });
    let n = 0;
    const post = (url: string, value: string) =>
      app.inject({ method: 'POST', url, headers: MEMBER(w.mem.id), payload: { key: `SECRET_${++n}`, value } });

    for (const value of NEW_REFS) {
      const refused = await post(`/services/${mine.id}/env`, `prefix-${value}`);
      expect(refused.statusCode, value).toBe(403);
      expect(refused.json().error.message).toMatch(/Vault references .*vault:.*aws:.* are not enabled for service "mine"/);
      expect((await post(`/projects/${p2!.id}/env`, value)).statusCode, value).toBe(403);
      expect((await post(`/services/${allowed.id}/env`, value)).statusCode, value).toBe(200);
    }
    const imported = await app.inject({
      method: 'POST',
      url: `/services/${mine.id}/env/import`,
      headers: MEMBER(w.mem.id),
      payload: { content: `PLAIN=1\nX=${AWS_REF}\n` },
    });
    expect(imported.statusCode).toBe(403);
    const plain = await post(`/services/${mine.id}/env`, 'just-a-value');
    expect(plain.statusCode).toBe(200);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/services/${mine.id}/env/${plain.json().id}`,
      headers: MEMBER(w.mem.id),
      payload: { key: 'SECRET', value: VAULT_REF },
    });
    expect(patched.statusCode).toBe(403);
    // Not a reference (bad grammar) → not gated, stays plain text everywhere.
    expect((await post(`/services/${mine.id}/env`, ref('vault:../sys#x'))).statusCode).toBe(200);
    const stored = await db.select().from(envVars).where(eq(envVars.serviceId, mine.id));
    expect(stored.map((r) => decrypt(r.valueEncrypted)).sort()).toEqual(['just-a-value', ref('vault:../sys#x')].sort());
  });

  it('preview refusal: a preview-only value may not hold one', async () => {
    const w = await world();
    const svc = await w.svc('parent', w.mem.id, w.w1.id);
    const app = await buildTestApp({ db });
    await app.register(envRoutes, { prefix: '/services' });
    for (const value of NEW_REFS) {
      const res = await app.inject({
        method: 'POST',
        url: `/services/${svc.id}/env/preview`,
        headers: MEMBER(w.mem.id),
        payload: { key: 'STRIPE_KEY', value },
      });
      expect(res.statusCode, value).toBe(400);
      expect(res.body).toMatch(/Vault references are not resolved for PR previews/);
    }
  });

  it('template deploys: refused up front outside the allowlist; nothing is created', async () => {
    const w = await world();
    await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, w.w1.id));
    const app = await buildTestApp({ db });
    await app.register(templateRoutes);
    for (const value of [VAULT_REF, AWS_REF]) {
      const res = await app.inject({
        method: 'POST',
        url: '/grafana/deploy',
        headers: MEMBER(w.mem.id),
        payload: { name: `graf-${value.length}`, env: [{ key: 'GF_SECRET', value }] },
      });
      expect(res.statusCode, value).toBe(403);
    }
    expect(await db.select().from(services)).toEqual([]);
    expect(await db.select().from(deployments)).toEqual([]);
  });

  it('service bundles: the gate the import route runs refuses a non-operator new service', async () => {
    // The route is operator-only today; this is the exact call it makes
    // (modules/serviceMigration.ts, r601): no owner, no tags.
    const target = { kind: 'newService' as const, name: 'imported', workspaceIds: [], projectIds: [] };
    for (const value of NEW_REFS) {
      await expect(vault.assertMayWriteVaultRefs(db, { id: 2, isOperator: false } as never, target, ['x', value])).rejects.toMatchObject({
        statusCode: 403,
      });
    }
    await expect(vault.assertMayWriteVaultRefs(db, { id: 1, isOperator: true } as never, target, NEW_REFS)).resolves.toBeUndefined();
    const src = readFileSync(new URL('../src/modules/serviceMigration.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/await assertMayWriteVaultRefs\(\s*app\.db,\s*req\.user!,\s*\{ kind: 'newService'/);
  });
});

// ── resolution: r510 before the first fetch ─────────────────────────────────
describe('deploy-time resolution with a configured provider', () => {
  async function configureVault() {
    await db.insert(secretProviders).values({
      kind: 'vault',
      configJson: { address: 'https://vault.example.com', authMethod: 'token', mount: 'secret', approleMount: 'approle' },
      credentialEncrypted: encrypt(JSON.stringify({ token: 'hvs.T' })),
    });
    egress.guardedFetch.mockImplementation(async () => json({ data: { data: { db_password: 'hunter2' } } }));
  }

  it('r510: a non-allowlisted service is refused before ANY provider call; allowed and operator-owned ones resolve', async () => {
    const w = await world();
    await configureVault();
    const attacker = await w.svc('attacker', w.mem.id, w.w2.id);
    const allowed = await w.svc('allowed', w.mem.id, w.w1.id);
    const opOwned = await w.svc('op-owned', w.op.id, w.w2.id);
    const env = { DB: VAULT_REF, PLAIN: 'p' };

    await expect(vault.resolveVaultRefs(db, env, { service: attacker, projectIds: [] })).rejects.toThrow(/not enabled for this service/);
    expect(egress.guardedFetch).not.toHaveBeenCalled();

    expect(await vault.resolveVaultRefs(db, env, { service: allowed, projectIds: [] })).toEqual({ DB: 'hunter2', PLAIN: 'p' });
    expect(await vault.resolveVaultRefs(db, env, { service: opOwned, projectIds: [] })).toEqual({ DB: 'hunter2', PLAIN: 'p' });
    expect(egress.guardedFetch.mock.calls.every(([url]) => url === 'https://vault.example.com/v1/secret/data/team/app')).toBe(true);
  });

  it('a configured vault and an unconfigured aws in one env: vault resolves, aws stays literal with a warning', async () => {
    const w = await world();
    await configureVault();
    const svc = await w.svc('svc', w.op.id, null);
    const log = vi.fn();
    const out = await vault.resolveVaultRefs(db, { A: VAULT_REF, B: AWS_REF }, { service: svc, projectIds: [] }, log);
    expect(out).toEqual({ A: 'hunter2', B: AWS_REF });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/AWS Secrets Manager references in B were left as literal text/);
  });

  it('a missing field fails the deploy instead of leaking the reference', async () => {
    const w = await world();
    await configureVault();
    const svc = await w.svc('svc', w.op.id, null);
    await expect(
      vault.resolveVaultRefs(db, { A: ref('vault:team/app#nope') }, { service: svc, projectIds: [] }),
    ).rejects.toThrow('Vault secret field "nope" not found (env key A)');
  });
});

// ── pipeline wiring ──────────────────────────────────────────────────────────
describe('pipeline passes its deploy log to the resolver (M14)', () => {
  it('loadRuntimeEnv forwards log to resolveVaultRefs, and the deploy passes its log', () => {
    const src = readFileSync(new URL('../src/engine/pipeline.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/await resolveVaultRefs\(db, env, \{ service, projectIds: projectLinks\.map\(\(p\) => p\.projectId\) \}, log\)/);
    expect(src).toMatch(/const runtimeEnvironment = await loadRuntimeEnv\(db, service, templateDatabaseId, log\);/);
    const vaultSrc = readFileSync(new URL('../src/lib/vault.ts', import.meta.url), 'utf8');
    expect(vaultSrc).toMatch(/export function hasVaultRef\(value: string\): boolean \{\s*return hasSecretRef\(value\);\s*\}/);
  });
});
