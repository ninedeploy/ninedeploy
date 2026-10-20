import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  type DB,
  deployments,
  envVars,
  previewEnvVars,
  runMigrations,
  services,
  sources,
  users,
} from '@ninedeploy/db';

/**
 * 0.16.14 previews of pull requests from forks, against a real migrated
 * SQLite: refused unless the parent turned `previewForks` on; then a plain
 * docker preview on the parent's git host, cloned with no credential, its
 * deploys held for approval, without database copies or preview-only
 * secrets. Also the GitLab / Bitbucket parsers, which now report the source
 * repository (a fork's MR used to read as the target's).
 */

vi.mock('../src/engine/logs.js', () => ({ deleteLog: vi.fn(() => true), logBus: { publish: vi.fn(), end: vi.fn() } }));
vi.mock('../src/lib/serviceBridge.js', () => ({ removeServiceBridgeIfEmpty: vi.fn(async () => undefined) }));
vi.mock('../src/engine/builders/docker.js', () => ({ dockerBuilder: { stop: vi.fn(async () => undefined) }, railpackUnavailableReason: vi.fn(async () => null) }));
vi.mock('../src/engine/builders/pm2.js', () => ({ pm2Builder: { stop: vi.fn(async () => undefined) } }));
vi.mock('../src/engine/builders/compose.js', () => ({ composeBuilder: { stop: vi.fn(async () => undefined) } }));
vi.mock('../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/proxy.js')>()),
  writeDynamicConfig: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const { handlePullRequest } = await import('../src/lib/webhookDispatch.js');
const { parsePullRequest } = await import('../src/lib/webhooks.js');
const { loadRuntimeEnv } = await import('../src/engine/pipeline.js');
const { ensurePreviewDatabaseCopies } = await import('../src/lib/previewDatabases.js');
const { resolveCloneCreds } = await import('../src/lib/sourceCreds.js');
const { cloneCredentialKind } = await import('../src/lib/remoteDeploy.js');
const { approvalStamp, holdForApprovalIfNeeded } = await import('../src/lib/protectedLanes.js');
const { encrypt } = await import('../src/lib/crypto.js');

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;
let db: DB;
let close: () => void = () => undefined;
let dir = '';
const row = async (id: number) => (await db.query.services.findFirst({ where: eq(services.id, id) }))!;
const pr = (repoUrl: string, n = 7) => ({ action: 'opened' as const, prNumber: n, branch: 'feature', sha: 'b'.repeat(40), title: 'Add it', author: 'mallory', repoUrl });
const FORK = 'https://github.com/mallory/app.git';

// A preview create opens a transaction (tags); an in-memory client has one connection.
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-preview-forks-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  await created.ready;
  db = created.db;
  close = () => created.client?.close();
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 2, email: 'owner@example.com', passwordHash: 'x', isInstanceOperator: true });
  await db.insert(sources).values({ id: 3, name: 'pat', type: 'github', tokenEncrypted: encrypt('ghp_parent_secret') } as never);
  await db.insert(services).values({
    id: 5,
    name: 'web',
    slug: 'web',
    type: 'docker',
    repoUrl: 'https://github.com/acme/app.git',
    branch: 'main',
    ownerUserId: 2,
    sourceId: 3,
    previewDeploymentsEnabled: true,
  } as never);
});

afterEach(() => {
  try {
    close();
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may hold the file a moment longer */
  }
});

describe('handlePullRequest and forks', () => {
  it('refuses a fork while previewForks is off, as before', async () => {
    expect(await handlePullRequest(db, await row(5), pr(FORK), 'github', log)).toEqual({ ok: 'skipped', reason: 'external_pr_repository' });
    expect(await handlePullRequest(db, await row(5), pr('https://github.com/acme/app.git'), 'github', log, { fromFork: true })).toEqual({
      ok: 'skipped',
      reason: 'external_pr_repository',
    });
    expect(await db.query.services.findMany({ where: eq(services.previewParentServiceId, 5) })).toHaveLength(0);
  });

  it('with previewForks on: a credential-free preview marked as a fork, its deploy queued for the worker to hold', async () => {
    await db.update(services).set({ previewForks: true }).where(eq(services.id, 5));
    const res = await handlePullRequest(db, await row(5), pr(FORK), 'github', log);
    expect(res).toMatchObject({ ok: true, action: 'preview_deployment_queued' });
    const preview = (await db.query.services.findFirst({ where: eq(services.previewParentServiceId, 5) }))!;
    expect(preview).toMatchObject({ previewFromFork: true, sourceId: null, repoUrl: FORK, branch: 'feature' });
    // A same-repository PR keeps the parent's credential and is no fork.
    await handlePullRequest(db, await row(5), pr('https://github.com/acme/app.git', 8), 'github', log);
    const own = (await db.query.services.findFirst({ where: eq(services.prNumber, 8) }))!;
    expect(own).toMatchObject({ previewFromFork: false, sourceId: 3 });
  });

  it('refuses a fork on another git host, and a parent that is not a plain docker service', async () => {
    await db.update(services).set({ previewForks: true }).where(eq(services.id, 5));
    expect(await handlePullRequest(db, await row(5), pr('https://evil.example/mallory/app.git'), 'github', log)).toEqual({
      ok: 'ignored',
      reason: 'fork_on_another_host',
    });
    for (const patch of [{ type: 'pm2' }, { dockerSocket: true }, { type: 'compose', composeContent: 'services: {}' }]) {
      await db.update(services).set({ type: 'docker', dockerSocket: false, composeContent: null, ...patch } as never).where(eq(services.id, 5));
      expect(await handlePullRequest(db, await row(5), pr(FORK), 'github', log)).toEqual({ ok: 'skipped', reason: 'fork_preview_unsupported_type' });
    }
  });
});

describe('what a fork preview is denied', () => {
  beforeEach(async () => {
    await db.update(services).set({ previewForks: true, previewDatabaseCopy: true }).where(eq(services.id, 5));
    await handlePullRequest(db, await row(5), pr(FORK), 'github', log);
  });
  const preview = async () => (await db.query.services.findFirst({ where: eq(services.previewParentServiceId, 5) }))!;

  it('no clone credential, on the panel or a node', async () => {
    const p = await preview();
    expect(await resolveCloneCreds(db, p)).toBeUndefined();
    expect(await cloneCredentialKind(db, p)).toBe('none');
    // The parent itself still resolves its own.
    expect((await resolveCloneCreds(db, await row(5)))?.token).toBe('ghp_parent_secret');
    expect(await cloneCredentialKind(db, { ...p, sourceId: 3 })).toBe('none');
  });

  it('no secret preview-only values, while the plain ones arrive', async () => {
    await db.insert(previewEnvVars).values([
      { serviceId: 5, key: 'PREVIEW_PLAIN', valueEncrypted: encrypt('p'), isSecret: false },
      { serviceId: 5, key: 'PREVIEW_TOKEN', valueEncrypted: encrypt('s'), isSecret: true },
    ] as never);
    const env = await loadRuntimeEnv(db, await preview());
    expect(env.values['PREVIEW_PLAIN']).toBe('p');
    expect(env.values['PREVIEW_TOKEN']).toBeUndefined();
    expect(env.withheldFromPreview).toContain('preview-only secret PREVIEW_TOKEN');
  });

  it('no database copies', async () => {
    const lines: string[] = [];
    expect(await ensurePreviewDatabaseCopies(db, await preview(), (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual(['Preview database: no copies for a pull request from a fork (a copy holds production data)']);
  });

  it('a deploy waits for approval unless an admin starts it', async () => {
    const p = await preview();
    const [dep] = await db.select().from(deployments).where(eq(deployments.serviceId, p.id));
    expect(dep!.status).toBe('queued');
    const held = await holdForApprovalIfNeeded(db, { id: dep!.id, environmentId: null, previewParentServiceId: 5, previewFromFork: true, reviewedAt: null });
    expect(held).toBe(true);
    expect((await db.query.deployments.findFirst({ where: eq(deployments.id, dep!.id) }))!.status).toBe('awaiting_approval');
    expect(await approvalStamp(db, p, { id: 2, isOperator: true })).toEqual({ reviewedBy: 2, reviewedAt: expect.any(Date) });
    await db.insert(users).values({ id: 9, email: 'x@example.com', passwordHash: 'x' });
    expect(await approvalStamp(db, p, { id: 9, isOperator: false })).toEqual({});
  });

  it('the parent env copied into it is the non-secret part only, as for any preview', async () => {
    const rows = await db.select().from(envVars).where(eq(envVars.serviceId, (await preview()).id));
    expect(rows.every((r) => !r.isSecret)).toBe(true);
  });
});

describe('PR parsers report the source repository', () => {
  it('GitLab: object_attributes.source over the target project', () => {
    const body = {
      object_attributes: { action: 'open', iid: 4, source_branch: 'feat', last_commit: { id: 'c'.repeat(40) }, title: 't', source: { git_http_url: 'https://gitlab.com/mallory/app.git' } },
      project: { git_http_url: 'https://gitlab.com/acme/app.git' },
    };
    expect(parsePullRequest(body, 'gitlab', {})?.repoUrl).toBe('https://gitlab.com/mallory/app.git');
    const own = { ...body, object_attributes: { ...body.object_attributes, source: undefined } };
    expect(parsePullRequest(own, 'gitlab', {})?.repoUrl).toBe('https://gitlab.com/acme/app.git');
  });

  it('Bitbucket: pullrequest.source.repository over the destination', () => {
    const body = {
      pullrequest: { id: 3, title: 't', source: { branch: { name: 'feat' }, commit: { hash: 'd'.repeat(12) }, repository: { full_name: 'mallory/app' } } },
      repository: { full_name: 'acme/app' },
    };
    expect(parsePullRequest(body, 'bitbucket', { 'x-event-key': 'pullrequest:created' })?.repoUrl).toBe('https://bitbucket.org/mallory/app.git');
    const own = { ...body, pullrequest: { ...body.pullrequest, source: { ...body.pullrequest.source, repository: undefined } } };
    expect(parsePullRequest(own, 'bitbucket', { 'x-event-key': 'pullrequest:created' })?.repoUrl).toBe('https://bitbucket.org/acme/app.git');
  });
});
