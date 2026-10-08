/**
 * 0.13 service ↔ GitHub App link routes (`modules/serviceGithub.ts`): link,
 * feedback toggles, migrate / finalize / revert and their authorization.
 * Real migrated SQLite; `guardedFetch` is the fake GitHub router.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditLog,
  githubAppInstallations,
  serviceGithubLinks,
  services,
  sources,
  users,
  webhooks,
  type DB,
  type GithubApp,
  type GithubAppInstallation,
} from '@ninedeploy/db';

const h = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
  process.env['DOCKER_HOST'] = 'tcp://127.0.0.1:9';
  return { guardedFetch: vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>() };
});

vi.mock('../../src/lib/egressGuard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/egressGuard.js')>();
  return { ...actual, guardedFetch: h.guardedFetch };
});

const { serviceGithubRoutes } = await import('../../src/modules/serviceGithub.js');
const { clearGithubAppCaches } = await import('../../src/lib/githubApp.js');
const { encrypt } = await import('../../src/lib/crypto.js');
const { buildTestApp } = await import('../helpers.js');
const { fakeGithub, json, migratedDb, rsaKeyPair, seedApp, seedInstallation } = await import('../lib/githubAppKit.js');

const key = rsaKeyPair('pkcs1');
const OPERATOR = 1;
const OWNER = 3; // owns the (personal) service: owner role, not an operator
const STRANGER = 4;

let db: DB;
let gh: ReturnType<typeof fakeGithub>;
let ghApp: GithubApp;
let inst: GithubAppInstallation;
let appSourceId: number;
let patSourceId: number;
let svcId: number;
let hookId: number;

const as = (id: number) => ({ 'x-test-user': String(id), 'x-test-operator': id === OPERATOR ? 'true' : 'false' });

beforeEach(async () => {
  db = await migratedDb();
  await db.insert(users).values([
    { id: OPERATOR, email: 'op@example.test', passwordHash: 'x', isInstanceOperator: true },
    { id: OWNER, email: 'owner@example.test', passwordHash: 'x' },
    { id: STRANGER, email: 'stranger@example.test', passwordHash: 'x' },
  ]);
  clearGithubAppCaches();
  gh = fakeGithub();
  gh.on('GET', /^\/repos\/acme\/app$/, () => json(200, { id: 555, full_name: 'acme/app' }));
  h.guardedFetch.mockReset();
  h.guardedFetch.mockImplementation(gh.handler);
  ghApp = await seedApp(db, key.privateKey);
  ({ inst, sourceId: appSourceId } = await seedInstallation(db, ghApp));
  const [pat] = await db.insert(sources).values({ type: 'github', name: 'pat', tokenEncrypted: encrypt('ghp_PATSECRET') }).returning();
  patSourceId = pat!.id;
  const [svc] = await db
    .insert(services)
    .values({ name: 'web', slug: 'web', ownerUserId: OWNER, sourceId: patSourceId, repoUrl: 'https://github.com/acme/app.git', branch: 'main' })
    .returning();
  svcId = svc!.id;
  const [hook] = await db
    .insert(webhooks)
    .values({ serviceId: svcId, sourceId: patSourceId, branch: 'main', watchPaths: 'api/**', secretEncrypted: encrypt('s') })
    .returning();
  hookId = hook!.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function server() {
  const app = await buildTestApp({ db });
  await app.register(serviceGithubRoutes);
  return app;
}

type App = Awaited<ReturnType<typeof server>>;
const call = async (app: App, who: number, method: string, url: string, payload?: unknown) => {
  const res = await app.inject({ method: method as 'GET', url, headers: as(who), ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: res.statusCode, body: res.json() as Record<string, any>, raw: res.body };
};

const linkRow = () => db.query.serviceGithubLinks.findFirst({ where: eq(serviceGithubLinks.serviceId, svcId) });
const svcRow = () => db.query.services.findFirst({ where: eq(services.id, svcId) });
const hookRow = () => db.query.webhooks.findFirst({ where: eq(webhooks.id, hookId) });
const audits = async (action: string) => (await db.select().from(auditLog)).filter((a) => a.action === action);

describe('GET /:id/github', () => {
  it('returns null when unlinked, the link view once linked, and 404s a stranger', async () => {
    const app = await server();
    expect(await call(app, OWNER, 'GET', `/${svcId}/github`)).toMatchObject({ status: 200, body: { link: null } });
    expect((await call(app, STRANGER, 'GET', `/${svcId}/github`)).status).toBe(404);
    await call(app, OPERATOR, 'PUT', `/${svcId}/github`, { sourceId: appSourceId });
    const res = await call(app, OWNER, 'GET', `/${svcId}/github`);
    expect(res.body.link).toMatchObject({
      serviceId: svcId,
      installationRowId: inst.id,
      githubAppId: ghApp.id,
      sourceId: appSourceId,
      repoId: 555,
      repoFullName: 'acme/app',
      enabled: true,
      tokenScope: 'repository',
      reportStatus: false,
      prComment: false,
      previousSourceId: null,
      active: true,
    });
    await db.update(githubAppInstallations).set({ suspendedAt: new Date() }).where(eq(githubAppInstallations.id, inst.id));
    expect((await call(app, OWNER, 'GET', `/${svcId}/github`)).body.link.active).toBe(false);
  });
});

describe('PUT /:id/github', () => {
  it('resolves the repo id through the installation (metadata-only token) and audits the link', async () => {
    const app = await server();
    const res = await call(app, OPERATOR, 'PUT', `/${svcId}/github`, { sourceId: appSourceId, tokenScope: 'installation', watchPaths: ' web/** ' });
    expect(res.status).toBe(200);
    expect(res.body.link).toMatchObject({ repoId: 555, tokenScope: 'installation', watchPaths: 'web/**' });
    const tokenCall = gh.calls.find((c) => c.path.endsWith('/access_tokens'));
    expect(tokenCall?.body).toEqual({ permissions: { metadata: 'read' } });
    expect(gh.calls.find((c) => c.path === '/repos/acme/app')?.headers.get('authorization')).toBe(`Bearer ${gh.minted[0]}`);
    // The service keeps its own source (PUT is not a migration).
    expect((await svcRow())!.sourceId).toBe(patSourceId);
    expect(await audits('service.github_link')).toEqual([
      expect.objectContaining({ userId: OPERATOR, entity: 'web', meta: expect.objectContaining({ repoId: 555, created: true }) }),
    ]);
    expect(res.raw).not.toContain('SECRETTOKEN');

    const again = await call(app, OPERATOR, 'PUT', `/${svcId}/github`, { sourceId: appSourceId, enabled: false });
    expect(again.body.link).toMatchObject({ enabled: false, tokenScope: 'installation', active: false });
    expect(await db.query.serviceGithubLinks.findMany()).toHaveLength(1);
  });

  it('refuses a mismatched repoId, a foreign host, a non-App source, an invisible repo and a preview', async () => {
    const app = await server();
    const mismatch = await call(app, OPERATOR, 'PUT', `/${svcId}/github`, { sourceId: appSourceId, repoId: 999 });
    expect(mismatch).toMatchObject({ status: 400, body: { error: { code: 'github_repo_id_mismatch' } } });

    expect((await call(app, OPERATOR, 'PUT', `/${svcId}/github`, { sourceId: patSourceId })).body.error.code).toBe('github_source_required');

    await db.update(services).set({ repoUrl: 'https://gitlab.com/acme/app.git' }).where(eq(services.id, svcId));
    gh.calls.length = 0;
    const host = await call(app, OPERATOR, 'PUT', `/${svcId}/github`, { sourceId: appSourceId });
    expect(host).toMatchObject({ status: 400, body: { error: { code: 'github_repo_url_invalid' } } });
    // The host check runs before any token is minted.
    expect(gh.calls).toHaveLength(0);

    await db.update(services).set({ repoUrl: 'https://github.com/acme/secret.git' }).where(eq(services.id, svcId));
    const hidden = await call(app, OPERATOR, 'PUT', `/${svcId}/github`, { sourceId: appSourceId });
    expect(hidden).toMatchObject({ status: 400, body: { error: { code: 'github_repo_not_accessible' } } });

    const [preview] = await db
      .insert(services)
      .values({ name: 'web pr', slug: 'web-pr-1', repoUrl: 'https://github.com/acme/app.git', isEphemeralPreview: true, previewParentServiceId: svcId, prNumber: 1 })
      .returning();
    expect((await call(app, OPERATOR, 'PUT', `/${preview!.id}/github`, { sourceId: appSourceId })).body.error.code).toBe('github_link_preview');
    expect(await db.query.serviceGithubLinks.findMany()).toHaveLength(0);
  });

  it('refuses a suspended installation', async () => {
    await db.update(githubAppInstallations).set({ suspendedAt: new Date() }).where(eq(githubAppInstallations.id, inst.id));
    const app = await server();
    expect((await call(app, OPERATOR, 'PUT', `/${svcId}/github`, { sourceId: appSourceId })).status).toBe(409);
  });
});

describe('authorization', () => {
  it('operator-only writes refuse the service owner (403) and a stranger (404), writing nothing', async () => {
    const app = await server();
    for (const [method, url, body] of [
      ['PUT', `/${svcId}/github`, { sourceId: appSourceId }],
      ['POST', `/${svcId}/github/migrate`, { sourceId: appSourceId }],
      ['POST', `/${svcId}/github/finalize`, undefined],
      ['DELETE', `/${svcId}/github`, undefined],
    ] as const) {
      expect((await call(app, OWNER, method, url, body)).status, `${method} ${url} as owner`).toBe(403);
      expect((await call(app, STRANGER, method, url, body)).status, `${method} ${url} as stranger`).toBe(404);
    }
    // Authorization runs before the body is parsed: an empty body is still a 403, not a 400.
    expect((await call(app, OWNER, 'PUT', `/${svcId}/github`, {})).status).toBe(403);
    expect(await db.query.serviceGithubLinks.findMany()).toHaveLength(0);
    expect(gh.calls).toHaveLength(0);
  });

  it('the feedback toggles are admin-tier: the owner may, a stranger may not', async () => {
    const app = await server();
    expect((await call(app, OWNER, 'PATCH', `/${svcId}/github/feedback`, { reportStatus: true })).status).toBe(404); // not linked yet
    await call(app, OPERATOR, 'PUT', `/${svcId}/github`, { sourceId: appSourceId });
    expect((await call(app, STRANGER, 'PATCH', `/${svcId}/github/feedback`, { reportStatus: true })).status).toBe(404);
    const res = await call(app, OWNER, 'PATCH', `/${svcId}/github/feedback`, { reportStatus: true, prComment: true });
    expect(res).toMatchObject({ status: 200, body: { link: { reportStatus: true, prComment: true } } });
    expect((await call(app, OWNER, 'PATCH', `/${svcId}/github/feedback`, {})).status).toBe(400);
    expect(await audits('service.github_link')).toContainEqual(
      expect.objectContaining({ userId: OWNER, meta: expect.objectContaining({ change: 'feedback', reportStatus: true, prComment: true }) }),
    );
  });
});

describe('migrate → finalize → revert', () => {
  it('migrate links with previous_source_id and changes neither the source nor the webhook', async () => {
    const app = await server();
    const res = await call(app, OPERATOR, 'POST', `/${svcId}/github/migrate`, { sourceId: appSourceId });
    expect(res.status).toBe(200);
    expect(res.body.link).toMatchObject({ previousSourceId: patSourceId, repoId: 555, enabled: true, watchPaths: 'api/**' });
    expect((await svcRow())!.sourceId).toBe(patSourceId);
    expect((await hookRow())!.active).toBe(true);
    expect(await audits('service.github_migrate')).toEqual([
      expect.objectContaining({ userId: OPERATOR, meta: expect.objectContaining({ previousSourceId: patSourceId, sourceId: appSourceId }) }),
    ]);
    expect((await call(app, OPERATOR, 'POST', `/${svcId}/github/migrate`, { sourceId: appSourceId })).status).toBe(409);
  });

  it('finalize detaches the PAT and deactivates the webhooks; revert restores both and unlinks', async () => {
    const app = await server();
    await call(app, OPERATOR, 'POST', `/${svcId}/github/migrate`, { sourceId: appSourceId });
    const fin = await call(app, OPERATOR, 'POST', `/${svcId}/github/finalize`);
    expect(fin).toMatchObject({ status: 200, body: { webhooksDeactivated: 1 } });
    expect((await svcRow())!.sourceId).toBe(appSourceId);
    expect((await hookRow())!.active).toBe(false);
    expect((await linkRow())!.previousSourceId).toBe(patSourceId);
    expect(await audits('service.github_finalize')).toEqual([
      expect.objectContaining({ meta: expect.objectContaining({ detachedSourceId: patSourceId, sourceId: appSourceId, webhooksDeactivated: 1 }) }),
    ]);

    const rev = await call(app, OPERATOR, 'DELETE', `/${svcId}/github`);
    expect(rev).toMatchObject({ status: 200, body: { ok: true, sourceId: patSourceId, webhooksReactivated: 1 } });
    expect((await svcRow())!.sourceId).toBe(patSourceId);
    expect((await hookRow())!.active).toBe(true);
    expect(await linkRow()).toBeUndefined();
    expect(await audits('service.github_unlink')).toEqual([
      expect.objectContaining({ meta: expect.objectContaining({ restoredSourceId: patSourceId, webhooksReactivated: 1 }) }),
    ]);
  });

  it('revert before finalize just unlinks (source and webhook were never touched)', async () => {
    const app = await server();
    await call(app, OPERATOR, 'POST', `/${svcId}/github/migrate`, { sourceId: appSourceId });
    expect((await call(app, OPERATOR, 'DELETE', `/${svcId}/github`)).body).toEqual({ ok: true, sourceId: patSourceId, webhooksReactivated: 0 });
    expect((await svcRow())!.sourceId).toBe(patSourceId);
    expect(await linkRow()).toBeUndefined();
  });

  it('finalize refuses a suspended installation; unlink refuses an App-source-only service', async () => {
    const app = await server();
    await call(app, OPERATOR, 'POST', `/${svcId}/github/migrate`, { sourceId: appSourceId });
    await db.update(githubAppInstallations).set({ suspendedAt: new Date() }).where(eq(githubAppInstallations.id, inst.id));
    expect((await call(app, OPERATOR, 'POST', `/${svcId}/github/finalize`)).status).toBe(409);
    expect((await svcRow())!.sourceId).toBe(patSourceId);
    expect((await hookRow())!.active).toBe(true);

    // A service created on the App source (lazy link, no previous source):
    // unlinking would be undone by the next clone, so it is refused.
    await db.update(githubAppInstallations).set({ suspendedAt: null }).where(eq(githubAppInstallations.id, inst.id));
    const [appOnly] = await db
      .insert(services)
      .values({ name: 'api', slug: 'api', sourceId: appSourceId, repoUrl: 'https://github.com/acme/app.git' })
      .returning();
    await db.insert(serviceGithubLinks).values({ serviceId: appOnly!.id, installationRowId: inst.id, repoId: 555, repoFullName: 'acme/app' });
    expect((await call(app, OPERATOR, 'DELETE', `/${appOnly!.id}/github`)).status).toBe(409);
    expect(await db.query.serviceGithubLinks.findFirst({ where: eq(serviceGithubLinks.serviceId, appOnly!.id) })).toBeTruthy();
  });

  it('finalize and revert 404 an unlinked service', async () => {
    const app = await server();
    expect((await call(app, OPERATOR, 'POST', `/${svcId}/github/finalize`)).status).toBe(404);
    expect((await call(app, OPERATOR, 'DELETE', `/${svcId}/github`)).status).toBe(404);
  });
});
