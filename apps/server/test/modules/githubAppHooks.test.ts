/**
 * 0.13 GitHub App webhook receiver (`modules/githubAppHooks.ts`) and its
 * coexistence with the per-service receiver (`modules/hooks.ts`), against a
 * migrated in-memory SQLite. Both receivers are mounted with the prefixes
 * `modules/api.ts` uses, so route precedence is exercised too. No network:
 * `guardedFetch` is the fake GitHub router; nothing touches Docker.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditLog,
  createDb,
  deployments,
  githubAppInstallations,
  githubPrComments,
  serviceGithubLinks,
  services,
  sources,
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
// Preview teardown touches the host (runtime stop, log files, bridge, proxy config).
vi.mock('../../src/engine/logs.js', () => ({ deleteLog: vi.fn(() => true) }));
vi.mock('../../src/lib/serviceBridge.js', () => ({ removeServiceBridgeIfEmpty: vi.fn(async () => undefined) }));
vi.mock('../../src/engine/builders/docker.js', () => ({ dockerBuilder: { stop: vi.fn(async () => undefined) } }));
vi.mock('../../src/engine/builders/pm2.js', () => ({ pm2Builder: { stop: vi.fn(async () => undefined) } }));
vi.mock('../../src/engine/builders/compose.js', () => ({ composeBuilder: { stop: vi.fn(async () => undefined) } }));
vi.mock('../../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/engine/proxy.js')>()),
  writeDynamicConfig: vi.fn(async () => undefined),
}));

const { githubAppHookRoutes } = await import('../../src/modules/githubAppHooks.js');
const { hookReceiveRoutes } = await import('../../src/modules/hooks.js');
const { resetReplayWindowForTests } = await import('../../src/lib/webhooks.js');
const { clearGithubAppCaches } = await import('../../src/lib/githubApp.js');
const { encrypt } = await import('../../src/lib/crypto.js');
const { buildTestApp } = await import('../helpers.js');
const { fakeGithub, json, rsaKeyPair, seedApp, seedInstallation } = await import('../lib/githubAppKit.js');

const key = rsaKeyPair('pkcs1');
const APP_SECRET = 'app-webhook-secret';
const HOOK_SECRET = 'per-service-secret';
const SHA = 'a'.repeat(40);
const REPO_ID = 555;

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-gh-hooks-'));
let dbSeq = 0;

/**
 * A migrated temp-FILE SQLite: the preview path runs a transaction
 * (`replaceServiceTags`), which an in-memory libSQL client cannot.
 */
async function fileDb(): Promise<DB> {
  const { db: made } = createDb({ url: `file:${path.join(tmp, `t${++dbSeq}.db`)}` });
  await migrate(made, { migrationsFolder: MIGRATIONS });
  return made;
}

let db: DB;
let gh: ReturnType<typeof fakeGithub>;
let ghApp: GithubApp;
let inst: GithubAppInstallation;
let svcId: number;

beforeEach(async () => {
  db = await fileDb();
  clearGithubAppCaches();
  resetReplayWindowForTests();
  gh = fakeGithub();
  h.guardedFetch.mockReset();
  h.guardedFetch.mockImplementation(gh.handler);
  ghApp = await seedApp(db, key.privateKey, { webhookSecretEncrypted: encrypt(APP_SECRET) });
  ({ inst } = await seedInstallation(db, ghApp));
  const [svc] = await db
    .insert(services)
    .values({
      name: 'web',
      slug: 'web',
      type: 'docker',
      repoUrl: 'https://github.com/acme/app.git',
      branch: 'main',
      previewDeploymentsEnabled: true,
    })
    .returning();
  svcId = svc!.id;
  await db.insert(serviceGithubLinks).values({ serviceId: svcId, installationRowId: inst.id, repoId: REPO_ID, repoFullName: 'acme/app' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows keeps the files locked until the worker exits */
  }
});

async function server() {
  const app = await buildTestApp({ db, rawBody: true });
  // The prefixes modules/api.ts uses: precedence is part of what is tested.
  await app.register(hookReceiveRoutes, { prefix: '/hooks' });
  await app.register(githubAppHookRoutes, { prefix: '/hooks/github-app' });
  return app;
}

const sign = (body: string, secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

type App = Awaited<ReturnType<typeof server>>;

async function deliver(app: App, url: string, event: string, payload: unknown, secret = APP_SECRET) {
  const body = JSON.stringify(payload);
  const res = await app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': randomUUID(),
      'x-hub-signature-256': sign(body, secret),
    },
    payload: body,
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

const appHook = (app: App, event: string, payload: unknown, secret?: string) =>
  deliver(app, `/hooks/github-app/${ghApp.hookKey}`, event, payload, secret);

function pushPayload(over: Record<string, unknown> = {}, files: string[] = ['src/index.ts']) {
  return {
    ref: 'refs/heads/main',
    after: SHA,
    head_commit: { id: SHA, message: 'fix', author: { username: 'bob' }, added: [], modified: files, removed: [] },
    commits: [],
    repository: { id: REPO_ID, full_name: 'acme/app', clone_url: 'https://github.com/acme/app.git' },
    installation: { id: inst.installationId },
    ...over,
  };
}

function prPayload(action: string, headRepoId = REPO_ID, number = 7) {
  return {
    action,
    number,
    pull_request: {
      number,
      title: 'Add feature',
      user: { login: 'alice' },
      head: {
        ref: 'feature',
        sha: 'b'.repeat(40),
        repo: { id: headRepoId, clone_url: headRepoId === REPO_ID ? 'https://github.com/acme/app.git' : 'https://github.com/mallory/app.git' },
      },
    },
    repository: { id: REPO_ID, full_name: 'acme/app', clone_url: 'https://github.com/acme/app.git' },
    installation: { id: inst.installationId },
  };
}

const deploymentsOf = (serviceId: number) => db.query.deployments.findMany({ where: eq(deployments.serviceId, serviceId) });
const auditActions = async () => (await db.select().from(auditLog)).map((r) => r.action);

async function perServiceHook(serviceId: number, over: Partial<typeof webhooks.$inferInsert> = {}) {
  const [row] = await db
    .insert(webhooks)
    .values({ serviceId, branch: 'main', secretEncrypted: encrypt(HOOK_SECRET), ...over })
    .returning();
  return row!;
}

describe('POST /v1/hooks/github-app/:hookKey — verification', () => {
  it('404s an unknown hook key, and the bare prefix falls to the per-service receiver (404 too)', async () => {
    const app = await server();
    expect((await deliver(app, '/hooks/github-app/nope', 'push', pushPayload())).status).toBe(404);
    // `/hooks/github-app` alone is the per-service `/:id` with a non-numeric id.
    const bare = await deliver(app, '/hooks/github-app', 'push', pushPayload());
    expect(bare.status).toBe(404);
    expect(bare.body).toMatchObject({ error: { message: 'Unknown webhook' } });
    expect(await deploymentsOf(svcId)).toHaveLength(0);
  });

  it('refuses a bad signature, another App’s secret and a non-GitHub signature scheme', async () => {
    const app = await server();
    expect((await appHook(app, 'push', pushPayload(), 'wrong-secret')).status).toBe(401);
    // A Gitea-style signature made with the right secret is still not a GitHub delivery.
    const body = JSON.stringify(pushPayload());
    const gitea = await app.inject({
      method: 'POST',
      url: `/hooks/github-app/${ghApp.hookKey}`,
      headers: {
        'content-type': 'application/json',
        'x-gitea-event': 'push',
        'x-gitea-signature': createHmac('sha256', APP_SECRET).update(body).digest('hex'),
      },
      payload: body,
    });
    expect(gitea.statusCode).toBe(401);
    expect(await deploymentsOf(svcId)).toHaveLength(0);
  });

  it('answers a ping, and the per-service receiver keeps its own route', async () => {
    const app = await server();
    expect(await appHook(app, 'ping', { zen: 'hi', hook_id: 1 })).toEqual({ status: 200, body: { ok: 'pong' } });
    const hook = await perServiceHook(svcId);
    expect(await deliver(app, `/hooks/${hook.id}`, 'ping', { zen: 'hi' }, HOOK_SECRET)).toEqual({ status: 200, body: { ok: 'pong' } });
  });

  it('ignores a replayed delivery (same signed body)', async () => {
    const app = await server();
    const first = await appHook(app, 'push', pushPayload());
    expect(first.body).toMatchObject({ ok: true });
    const again = await appHook(app, 'push', pushPayload());
    expect(again.body).toEqual({ ok: 'ignored', reason: 'replayed_delivery' });
    expect(await deploymentsOf(svcId)).toHaveLength(1);
  });

  it('ignores an installation that is not this App’s', async () => {
    const other = await seedApp(db, key.privateKey, { appId: 9999, webhookSecretEncrypted: encrypt('other') });
    await seedInstallation(db, other, { installationId: 7777, accountLogin: 'mallory' });
    const app = await server();
    const res = await appHook(app, 'push', pushPayload({ installation: { id: 7777 } }));
    expect(res.body).toEqual({ ok: 'ignored', reason: 'unknown_installation' });
    const created = await appHook(app, 'installation', {
      action: 'created',
      installation: { id: 8888, app_id: 9999, account: { login: 'mallory' } },
    });
    expect(created.body).toEqual({ ok: 'ignored', reason: 'foreign_installation' });
    expect(await db.query.githubAppInstallations.findMany({ where: eq(githubAppInstallations.githubAppId, ghApp.id) })).toHaveLength(1);
    expect(await deploymentsOf(svcId)).toHaveLength(0);
  });
});

describe('installation events', () => {
  it('created → suspend → unsuspend → new permissions → deleted, each audited with a null actor', async () => {
    const app = await server();
    const installation = {
      id: 9100,
      app_id: ghApp.appId,
      account: { login: 'globex', type: 'Organization', id: 31 },
      repository_selection: 'all',
      permissions: { contents: 'read', metadata: 'read' },
    };
    const created = await appHook(app, 'installation', { action: 'created', installation });
    expect(created.body).toMatchObject({ ok: true, action: 'installation_created' });
    const row = await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.installationId, 9100) });
    expect(row).toMatchObject({ accountLogin: 'globex', repositorySelection: 'all', removedAt: null, suspendedAt: null });
    const src = await db.query.sources.findFirst({ where: eq(sources.id, row!.sourceId!) });
    expect(src).toMatchObject({ type: 'github_app', name: 'gh-app:globex', tokenEncrypted: null });

    const ev = (action: string, extra: Record<string, unknown> = {}) =>
      appHook(app, 'installation', { action, installation: { ...installation, ...extra } });
    expect((await ev('suspend', { suspended_at: '2026-10-01T00:00:00Z' })).body).toMatchObject({ action: 'installation_suspended' });
    let now = await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.id, row!.id) });
    expect(now!.suspendedAt?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect((await ev('unsuspend')).body).toMatchObject({ action: 'installation_unsuspended' });
    expect((await ev('new_permissions_accepted', { permissions: { contents: 'read', statuses: 'write' } })).body).toMatchObject({
      action: 'installation_permissions_updated',
    });
    now = await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.id, row!.id) });
    expect(now).toMatchObject({ suspendedAt: null, permissions: { contents: 'read', statuses: 'write' } });
    expect((await ev('deleted')).body).toMatchObject({ action: 'installation_removed' });
    now = await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.id, row!.id) });
    expect(now!.removedAt).toBeInstanceOf(Date);
    // Never hard-deleted; its source stays.
    expect(await db.query.sources.findFirst({ where: eq(sources.id, row!.sourceId!) })).toBeTruthy();

    const audits = (await db.select().from(auditLog)).filter((a) => a.action.startsWith('github_installation.'));
    expect(audits.map((a) => a.action)).toEqual([
      'github_installation.created',
      'github_installation.suspended',
      'github_installation.unsuspended',
      'github_installation.permissions_updated',
      'github_installation.removed',
    ]);
    expect(audits.every((a) => a.userId === null)).toBe(true);
  });

  it('a removed or suspended installation stops routing pushes; an unknown one is only accepted as created', async () => {
    const app = await server();
    expect((await appHook(app, 'installation', { action: 'suspend', installation: { id: 4040 } })).body).toEqual({
      ok: 'ignored',
      reason: 'unknown_installation',
    });
    await appHook(app, 'installation', { action: 'suspend', installation: { id: inst.installationId } });
    expect((await appHook(app, 'push', pushPayload())).body).toEqual({ ok: 'ignored', reason: 'installation_inactive' });
    expect(await deploymentsOf(svcId)).toHaveLength(0);
  });

  it('installation_repositories: audits github.repos_changed naming the linked services that lost access', async () => {
    const app = await server();
    const res = await appHook(app, 'installation_repositories', {
      action: 'removed',
      repository_selection: 'selected',
      repositories_added: [],
      repositories_removed: [{ id: REPO_ID, full_name: 'acme/app' }],
      installation: { id: inst.installationId },
    });
    expect(res.body).toEqual({ ok: true, action: 'repositories_changed', affectedServiceIds: [svcId] });
    const entry = (await db.select().from(auditLog)).find((a) => a.action === 'github.repos_changed');
    expect(entry).toMatchObject({
      userId: null,
      meta: { removed: [{ id: REPO_ID, fullName: 'acme/app' }], affectedServiceIds: [svcId], lostAccessServiceIds: [svcId] },
    });
  });
});

describe('push routing by repository id', () => {
  it('deploys the linked service only — not an unlinked service with the same URL, not another repo id', async () => {
    const [unlinked] = await db
      .insert(services)
      .values({ name: 'twin', slug: 'twin', repoUrl: 'https://github.com/acme/app.git', branch: 'main' })
      .returning();
    const app = await server();
    const res = await appHook(app, 'push', pushPayload());
    expect(res.body).toMatchObject({ ok: true, event: 'push', results: [{ serviceId: svcId, ok: true, provider: 'github' }] });
    const deps = await deploymentsOf(svcId);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ commitSha: SHA, trigger: 'webhook', status: 'queued' });
    expect(await deploymentsOf(unlinked!.id)).toHaveLength(0);

    const other = await appHook(app, 'push', pushPayload({ repository: { id: 556, full_name: 'acme/other' }, after: 'c'.repeat(40) }));
    expect(other.body).toEqual({ ok: 'ignored', reason: 'no_linked_service' });
  });

  it('applies the per-service gates: branch, skip marker, SHA dedup', async () => {
    const app = await server();
    const branch = await appHook(app, 'push', pushPayload({ ref: 'refs/heads/dev' }));
    expect(branch.body).toMatchObject({ results: [{ serviceId: svcId, ok: 'skipped', reason: 'branch', branch: 'dev' }] });
    const skip = await appHook(
      app,
      'push',
      pushPayload({ head_commit: { id: SHA, message: 'docs [skip ci]', author: { username: 'bob' } } }),
    );
    expect(skip.body).toMatchObject({ results: [{ ok: 'skipped', reason: 'skip_marker' }] });
    await appHook(app, 'push', pushPayload());
    const dup = await appHook(app, 'push', pushPayload({ compare: 'different-body-same-sha' }));
    expect(dup.body).toMatchObject({ results: [{ ok: 'skipped', reason: 'duplicate' }] });
    expect(await deploymentsOf(svcId)).toHaveLength(1);
  });

  it('honours the link’s watch paths', async () => {
    await db.update(serviceGithubLinks).set({ watchPaths: 'api/**' }).where(eq(serviceGithubLinks.serviceId, svcId));
    const app = await server();
    const miss = await appHook(app, 'push', pushPayload({}, ['web/page.tsx']));
    expect(miss.body).toMatchObject({ results: [{ ok: 'skipped', reason: 'watch_paths', patterns: 1 }] });
    const hit = await appHook(app, 'push', pushPayload({}, ['api/server.ts']));
    expect(hit.body).toMatchObject({ results: [{ ok: true }] });
    expect(await deploymentsOf(svcId)).toHaveLength(1);
  });

  it('a renamed repository (same id, new clone URL) updates repoUrl and the link, audited', async () => {
    const app = await server();
    const res = await appHook(
      app,
      'push',
      pushPayload({ repository: { id: REPO_ID, full_name: 'acme/app-v2', clone_url: 'https://github.com/acme/app-v2.git' } }),
    );
    expect(res.body).toMatchObject({ results: [{ ok: true }] });
    const svc = await db.query.services.findFirst({ where: eq(services.id, svcId) });
    expect(svc!.repoUrl).toBe('https://github.com/acme/app-v2.git');
    const link = await db.query.serviceGithubLinks.findFirst({ where: eq(serviceGithubLinks.serviceId, svcId) });
    expect(link!.repoFullName).toBe('acme/app-v2');
    const entry = (await db.select().from(auditLog)).find((a) => a.action === 'service.repo_renamed');
    expect(entry).toMatchObject({
      userId: null,
      entity: 'web',
      meta: { serviceId: svcId, repoId: REPO_ID, from: 'https://github.com/acme/app.git', to: 'https://github.com/acme/app-v2.git' },
    });
  });

  it('never moves a service to another host, and a .git-only difference is no rename', async () => {
    const app = await server();
    await appHook(
      app,
      'push',
      pushPayload({ repository: { id: REPO_ID, full_name: 'acme/app', clone_url: 'https://evil.example/acme/app.git' } }),
    );
    await appHook(
      app,
      'push',
      pushPayload({ after: 'd'.repeat(40), repository: { id: REPO_ID, full_name: 'acme/app', clone_url: 'https://github.com/acme/app' } }),
    );
    const svc = await db.query.services.findFirst({ where: eq(services.id, svcId) });
    expect(svc!.repoUrl).toBe('https://github.com/acme/app.git');
    expect(await auditActions()).not.toContain('service.repo_renamed');
  });
});

describe('pull requests', () => {
  it('refuses a fork by repository id, before anything is created', async () => {
    const app = await server();
    const res = await appHook(app, 'pull_request', prPayload('opened', 999));
    expect(res.body).toEqual({ ok: 'skipped', reason: 'external_pr_repository' });
    expect(await db.query.services.findMany({ where: eq(services.previewParentServiceId, svcId) })).toHaveLength(0);
  });

  it('a same-repository PR creates the preview through the shared handler, and close tears it down', async () => {
    const app = await server();
    const res = await appHook(app, 'pull_request', prPayload('opened'));
    expect(res.body).toMatchObject({
      ok: true,
      results: [{ serviceId: svcId, ok: true, provider: 'github', action: 'preview_deployment_queued', prNumber: 7 }],
    });
    const preview = await db.query.services.findFirst({
      where: and(eq(services.previewParentServiceId, svcId), eq(services.prNumber, 7)),
    });
    expect(preview).toMatchObject({ slug: 'web-pr-7', branch: 'feature', isEphemeralPreview: true });
    // A preview never gets its own link: it inherits the parent's.
    expect(await db.query.serviceGithubLinks.findFirst({ where: eq(serviceGithubLinks.serviceId, preview!.id) })).toBeUndefined();
    expect(await deploymentsOf(preview!.id)).toHaveLength(1);

    const closed = await appHook(app, 'pull_request', prPayload('closed'));
    expect(closed.body).toMatchObject({ results: [{ ok: true, action: 'preview_destroyed', serviceId: preview!.id }] });
    expect(await db.query.services.findFirst({ where: eq(services.id, preview!.id) })).toBeUndefined();
  });

  it('teardown edits an opted-in PR comment to "destroyed"', async () => {
    await db.update(serviceGithubLinks).set({ prComment: true }).where(eq(serviceGithubLinks.serviceId, svcId));
    await db.insert(githubPrComments).values({ serviceId: svcId, prNumber: 7, commentId: 4321, headSha: 'b'.repeat(40) });
    gh.on('PATCH', /^\/repos\/acme\/app\/issues\/comments\/4321$/, () => json(200, { id: 4321 }));
    const app = await server();
    await appHook(app, 'pull_request', prPayload('opened'));
    await appHook(app, 'pull_request', prPayload('closed'));
    // Fire-and-forget after the teardown: poll for the call, never sleep.
    await vi.waitFor(() => expect(gh.calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = gh.calls.find((c) => c.method === 'PATCH')!;
    expect(String(patch.body?.['body'])).toContain(`<!-- ninedeploy:preview:${svcId} -->`);
    expect(String(patch.body?.['body'])).toContain('Preview destroyed');
  });
});

describe('coexistence with the per-service webhook', () => {
  it('skips a per-service delivery for an App-driven service', async () => {
    const hook = await perServiceHook(svcId);
    const app = await server();
    const res = await deliver(app, `/hooks/${hook.id}`, 'push', pushPayload(), HOOK_SECRET);
    expect(res.body).toEqual({ ok: 'skipped', reason: 'github_app_linked' });
    expect(await deploymentsOf(svcId)).toHaveLength(0);
  });

  it('takes over again when the installation is suspended or removed, or the link disabled', async () => {
    const hook = await perServiceHook(svcId);
    const app = await server();
    await db.update(githubAppInstallations).set({ suspendedAt: new Date() }).where(eq(githubAppInstallations.id, inst.id));
    const suspended = await deliver(app, `/hooks/${hook.id}`, 'push', pushPayload(), HOOK_SECRET);
    expect(suspended.body).toMatchObject({ ok: true, provider: 'github' });

    await db.update(githubAppInstallations).set({ suspendedAt: null, removedAt: new Date() }).where(eq(githubAppInstallations.id, inst.id));
    const removed = await deliver(app, `/hooks/${hook.id}`, 'push', pushPayload({ after: 'e'.repeat(40), head_commit: { id: 'e'.repeat(40), message: 'x' } }), HOOK_SECRET);
    expect(removed.body).toMatchObject({ ok: true });

    await db.update(githubAppInstallations).set({ removedAt: null }).where(eq(githubAppInstallations.id, inst.id));
    await db.update(serviceGithubLinks).set({ enabled: false }).where(eq(serviceGithubLinks.serviceId, svcId));
    const disabled = await deliver(app, `/hooks/${hook.id}`, 'push', pushPayload({ after: 'f'.repeat(40), head_commit: { id: 'f'.repeat(40), message: 'y' } }), HOOK_SECRET);
    expect(disabled.body).toMatchObject({ ok: true });
    expect(await deploymentsOf(svcId)).toHaveLength(3);
  });

  it('an unlinked service is unchanged', async () => {
    const [plain] = await db.insert(services).values({ name: 'plain', slug: 'plain', repoUrl: 'https://github.com/acme/plain.git' }).returning();
    const hook = await perServiceHook(plain!.id);
    const app = await server();
    const res = await deliver(app, `/hooks/${hook.id}`, 'push', pushPayload(), HOOK_SECRET);
    expect(res.body).toMatchObject({ ok: true, provider: 'github' });
    expect(await deploymentsOf(plain!.id)).toHaveLength(1);
  });

  it('no double deploy when both deliveries of one push arrive together', async () => {
    const hook = await perServiceHook(svcId);
    const app = await server();
    const [viaApp, viaHook] = await Promise.all([
      appHook(app, 'push', pushPayload()),
      deliver(app, `/hooks/${hook.id}`, 'push', pushPayload(), HOOK_SECRET),
    ]);
    expect(viaHook.body).toEqual({ ok: 'skipped', reason: 'github_app_linked' });
    expect(viaApp.body).toMatchObject({ results: [{ ok: true }] });
    expect(await deploymentsOf(svcId)).toHaveLength(1);
  });

  it('two App deliveries of one SHA racing each other leave one deployment (race guard)', async () => {
    const app = await server();
    await Promise.all([
      appHook(app, 'push', pushPayload({ compare: 'one' })),
      appHook(app, 'push', pushPayload({ compare: 'two' })),
    ]);
    const active = (await deploymentsOf(svcId)).filter((d) => d.status === 'queued');
    expect(active).toHaveLength(1);
  });
});
