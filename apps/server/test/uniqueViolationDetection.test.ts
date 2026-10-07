/**
 * F824–F827: unique-index mappings against a migrated SQLite.
 *
 * drizzle-orm wraps driver errors in DrizzleQueryError ("Failed query: …") with
 * the SQLite "UNIQUE constraint failed: <table>.<col>, …" text on `cause`, and
 * SQLite names the columns, not the index. The fake-db suites throw a bare Error
 * carrying the expected text, so only a real database shows whether each
 * duplicate/race mapping (isUniqueViolation) actually fires.
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  deployments,
  domains,
  projects,
  services,
  users,
  webhooks,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
  type DB,
} from '@ninedeploy/db';

// Runs between a route's duplicate/claim check and its insert — the tests use
// it to land a concurrent winner deterministically (the real probe asks Docker).
const gate = vi.hoisted(() => ({ beforeInsert: null as null | ((slug: string) => Promise<void>) }));
vi.mock('../src/lib/retainedSlugVolume.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/retainedSlugVolume.js')>()),
  assertPrimaryVolumeNotAttachedElsewhere: vi.fn(async () => undefined),
  assertSlugVolumeNotRetained: vi.fn(async (slug: string) => {
    const g = gate.beforeInsert;
    gate.beforeInsert = null;
    if (g) await g(slug);
  }),
}));
// Host side effects of the preview webhook and domain routes.
vi.mock('../src/engine/logs.js', () => ({ deleteLog: vi.fn(() => true) }));
vi.mock('../src/lib/serviceBridge.js', () => ({ removeServiceBridgeIfEmpty: vi.fn(async () => undefined) }));
vi.mock('../src/engine/builders/docker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/builders/docker.js')>()),
  dockerBuilder: { stop: vi.fn(async () => undefined) },
}));
vi.mock('../src/engine/builders/pm2.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/builders/pm2.js')>()),
  pm2Builder: { stop: vi.fn(async () => undefined) },
}));
vi.mock('../src/engine/builders/compose.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/builders/compose.js')>()),
  composeBuilder: { stop: vi.fn(async () => undefined) },
}));
vi.mock('../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/proxy.js')>()),
  writeDynamicConfig: vi.fn(async () => undefined),
}));

const { encrypt, sha256 } = await import('../src/lib/crypto.js');
const { resetReplayWindowForTests } = await import('../src/lib/webhooks.js');
const { envRoutes, projectEnvRoutes } = await import('../src/modules/env.js');
const { environmentRoutes } = await import('../src/modules/environments.js');
const { domainsRoutes } = await import('../src/modules/domains.js');
const { servicesRoutes } = await import('../src/modules/services.js');
const { serviceMigrationRoutes } = await import('../src/modules/serviceMigration.js');
const { hookReceiveRoutes } = await import('../src/modules/hooks.js');
const { acceptInvitationRoutes } = await import('../src/modules/invitations.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));

let db: DB;
let close: () => void;
let dir: string;
let opId: number;

// A file database: several routes run a transaction, and an in-memory libsql
// client has a single connection that a transaction holds.
beforeEach(async () => {
  gate.beforeInsert = null;
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-unique-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const [op] = await db.insert(users).values({ email: 'op@x', passwordHash: 'h', isInstanceOperator: true }).returning();
  opId = op!.id;
});

afterEach(() => {
  close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

/** Runs `after` once, right after the next `db.query.<table>.<method>` resolves. */
function raceAfter(table: 'services' | 'workspaceMembers', method: 'findMany' | 'findFirst', gateRef: { after: null | (() => Promise<void>) }): DB {
  const bind = (t: object, v: unknown) => (typeof v === 'function' ? v.bind(t) : v);
  const q = db.query[table] as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const tableQ = new Proxy(q, {
    get(t, p) {
      if (p !== method) return bind(t, Reflect.get(t, p));
      return async (...args: unknown[]) => {
        const out = await t[method]!(...args);
        const g = gateRef.after;
        gateRef.after = null;
        if (g) await g();
        return out;
      };
    },
  });
  const query = new Proxy(db.query, { get: (t, p) => (p === table ? tableQ : bind(t, Reflect.get(t, p))) });
  return new Proxy(db, { get: (t, p) => (p === 'query' ? query : bind(t, Reflect.get(t, p))) });
}

describe('F824: duplicate creates answer 400/409, not 500', () => {
  it('service env, project env, environment and domain', async () => {
    const [svc] = await db.insert(services).values({ name: 'api', slug: 'api', ownerUserId: opId }).returning();
    const [ws] = await db.insert(workspaces).values({ name: 'w', slug: 'w', ownerId: opId }).returning();
    const [proj] = await db.insert(projects).values({ name: 'p', slug: 'p', workspaceId: ws!.id }).returning();
    const app = await buildTestApp({ db });
    await app.register(envRoutes, { prefix: '/services' });
    await app.register(domainsRoutes, { prefix: '/services' });
    await app.register(projectEnvRoutes, { prefix: '/projects' });
    await app.register(environmentRoutes, { prefix: '/environments' });
    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url, headers: asUser({ id: opId, isOperator: true }), payload });
    for (const [url, body, status] of [
      [`/services/${svc!.id}/env`, { key: 'K', value: '1' }, 400],
      [`/projects/${proj!.id}/env`, { key: 'K', value: '1' }, 400],
      ['/environments', { workspaceId: ws!.id, name: 'Prod' }, 400],
      [`/services/${svc!.id}/domains`, { hostname: 'app.example.com', path: '/' }, 409],
    ] as const) {
      expect((await post(url, body)).statusCode, url).toBe(200);
      const dup = await post(url, body);
      expect(dup.statusCode, url).toBe(status);
      expect(dup.json().error.message, url).toMatch(/already exists/);
    }
    // A non-unique insert failure is not reported as a duplicate.
    await db.run(sql`CREATE TRIGGER boom BEFORE INSERT ON env_vars WHEN NEW.key = 'BOOM' BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    expect((await post(`/services/${svc!.id}/env`, { key: 'BOOM', value: '1' })).statusCode).toBe(500);
    await app.close();
  });
});

describe('F825: race losers on the service-creating routes', () => {
  const winnerService = async (slug: string) => {
    await db.insert(services).values({ name: `winner ${slug}`, slug, ownerUserId: opId });
  };
  const bundle = (hostname: string) => ({
    version: '1.0.0',
    exportedAt: '2026-01-01T00:00:00.000Z',
    service: { name: 'Imported', type: 'docker', repoUrl: null, branch: 'main', image: 'nginx:1', port: 80, volumeMount: null, healthPath: '/', cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0 },
    buildConfig: null,
    envVars: [],
    domains: [{ hostname, path: '/', ssl: true }],
    webhooks: [],
    attachments: [],
  });

  it('create and clone answer 400 slug_taken; import answers 409 and writes nothing', async () => {
    const [src] = await db.insert(services).values({ name: 'src', slug: 'src', ownerUserId: opId, type: 'docker', image: 'nginx:1' }).returning();
    const app = await buildTestApp({ db });
    await app.register(serviceMigrationRoutes, { prefix: '/services' });
    await app.register(servicesRoutes, { prefix: '/services' });
    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url, headers: asUser({ id: opId, isOperator: true }), payload });

    gate.beforeInsert = winnerService;
    const created = await post('/services', { name: 'beta', type: 'docker', image: 'nginx:1' });
    expect(created.statusCode).toBe(400);
    expect(created.json().error.code).toBe('slug_taken');

    gate.beforeInsert = winnerService;
    const cloned = await post(`/services/${src!.id}/clone`, { name: 'copy' });
    expect(cloned.statusCode).toBe(400);
    expect(cloned.json().error.code).toBe('slug_taken');

    const before = (await db.select().from(services)).length;
    gate.beforeInsert = async () => {
      await db.insert(domains).values({ serviceId: src!.id, hostname: 'two.example.com', path: '/', status: 'active' });
    };
    const imported = await post('/services/import', bundle('two.example.com'));
    expect(imported.statusCode).toBe(409);
    expect(imported.json().error.message).toMatch(/registered by another service while importing/);
    expect(await db.select().from(services)).toHaveLength(before);
    await app.close();
  });
});

describe('F826: PR-preview webhook backstops', () => {
  const SECRET = 'hook-secret';
  const REPO = 'https://github.com/org/repo.git';

  it('a concurrent delivery and an already-routed preview host both answer 200', async () => {
    const [parent] = await db
      .insert(services)
      .values({ name: 'api', slug: 'api', ownerUserId: opId, type: 'docker', repoUrl: REPO, branch: 'main', previewDeploymentsEnabled: true })
      .returning();
    const [hook] = await db.insert(webhooks).values({ serviceId: parent!.id, branch: 'main', secretEncrypted: encrypt(SECRET) }).returning();
    const race = { after: null as null | (() => Promise<void>) };
    const app = await buildTestApp({ db: raceAfter('services', 'findMany', race), rawBody: true });
    await app.register(hookReceiveRoutes);
    const deliver = (pr: number) => {
      const body = JSON.stringify({
        action: 'opened',
        number: pr,
        pull_request: { number: pr, title: `PR ${pr}`, head: { ref: `f-${pr}`, sha: `sha${pr}`, repo: { clone_url: REPO } }, user: { login: 'a' }, merged: false },
      });
      resetReplayWindowForTests();
      const sig = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
      return app.inject({ method: 'POST', url: `/${hook!.id}`, headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': sig }, payload: body });
    };
    const previews = (pr: number) =>
      db.query.services.findMany({ where: and(eq(services.previewParentServiceId, parent!.id), eq(services.prNumber, pr)) });
    const depCount = async (id: number) => (await db.select().from(deployments).where(eq(deployments.serviceId, id))).length;

    // Another delivery for PR 2 created the preview after this one's existence check.
    race.after = async () => {
      await db.insert(services).values({
        name: 'api (PR #2)', slug: 'api-pr-2', ownerUserId: opId, type: 'docker', repoUrl: REPO,
        isEphemeralPreview: true, previewParentServiceId: parent!.id, prNumber: 2,
      });
    };
    const r2 = await deliver(2);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().action).toBe('preview_deployment_queued');
    const [p2] = await previews(2);
    expect(r2.json().previewServiceId).toBe(p2!.id);
    expect(await depCount(p2!.id)).toBe(1);

    // The rendered host is already routed (SQLite reports domains.hostname, domains.path).
    await db.insert(domains).values({ serviceId: parent!.id, hostname: 'pr-3-api.localhost', path: '/', status: 'active' });
    const r3 = await deliver(3);
    expect(r3.statusCode).toBe(200);
    expect(r3.json().previewDomainSkipped).toBe('domain_conflict_duplicate_hostname');
    const [p3] = await previews(3);
    expect(await depCount(p3!.id)).toBe(1);
    await app.close();
  });
});

describe('F827: concurrent invitation accept', () => {
  it('the loser of two concurrent accepts succeeds like an idempotent re-accept', async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'w', slug: 'w', ownerId: opId }).returning();
    const [bob] = await db.insert(users).values({ email: 'bob@x', passwordHash: 'h' }).returning();
    const token = 'b'.repeat(64);
    await db.insert(workspaceInvitations).values({
      workspaceId: ws!.id, email: 'bob@x', role: 'member', token: sha256(token), invitedByUserId: opId,
      expiresAt: new Date(Date.UTC(2999, 0, 1)),
    });
    const race = { after: null as null | (() => Promise<void>) };
    const app = await buildTestApp({ db: raceAfter('workspaceMembers', 'findFirst', race) });
    await app.register(acceptInvitationRoutes);
    // The other tab's insert lands right after this request's existence check.
    race.after = async () => {
      await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: bob!.id, role: 'member' });
    };
    const res = await app.inject({ method: 'POST', url: `/invitations/${token}/accept`, headers: asUser({ id: bob!.id, isOperator: false }) });
    expect(res.statusCode).toBe(200);
    const inv = await db.query.workspaceInvitations.findFirst({ where: eq(workspaceInvitations.token, sha256(token)) });
    expect(inv?.acceptedAt).not.toBeNull();
    await app.close();
  });
});
