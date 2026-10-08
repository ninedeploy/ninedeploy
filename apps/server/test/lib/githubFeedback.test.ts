/**
 * 0.13 deploy feedback to GitHub (`lib/githubFeedback.ts`,
 * `plugins/githubFeedback.ts`): opt-in toggles, the commit-status mapping,
 * the upserted preview PR comment (404 → recreate, teardown edit, per-PR
 * serialization), and the observational contract — failures are logged
 * redacted and never thrown. No network: `guardedFetch` is the fake GitHub.
 */
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deployments,
  domains,
  githubAppInstallations,
  githubPrComments,
  serviceGithubLinks,
  services,
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

const { commitStateFor, deployingFeedback, outcomeFeedback, previewCommentMarker, previewDestroyedFeedback } = await import(
  '../../src/lib/githubFeedback.js'
);
const { clearGithubAppCaches } = await import('../../src/lib/githubApp.js');
const githubFeedbackPlugin = (await import('../../src/plugins/githubFeedback.js')).default;
const { buildTestApp } = await import('../helpers.js');
const { fakeGithub, json, migratedDb, rsaKeyPair, seedApp, seedInstallation } = await import('./githubAppKit.js');

const key = rsaKeyPair('pkcs1');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const PREVIEW_SHA = 'fedcba9876543210fedcba9876543210fedcba98';

let db: DB;
let gh: ReturnType<typeof fakeGithub>;
let ghApp: GithubApp;
let inst: GithubAppInstallation;
let parentId: number;
let previewId: number;
let depId: number;
let previewDepId: number;
let nextCommentId: number;

function logger() {
  const lines: string[] = [];
  return { lines, warn: vi.fn((obj: object, msg: string) => void lines.push(`${msg} ${JSON.stringify(obj)}`)) };
}

beforeEach(async () => {
  db = await migratedDb();
  clearGithubAppCaches();
  gh = fakeGithub();
  nextCommentId = 1000;
  gh.on('POST', /^\/repos\/acme\/app\/statuses\/[0-9a-f]{40}$/, () => json(201, { id: 1 }));
  gh.on('POST', /^\/repos\/acme\/app\/issues\/\d+\/comments$/, () => json(201, { id: ++nextCommentId }));
  gh.on('PATCH', /^\/repos\/acme\/app\/issues\/comments\/\d+$/, (c) => json(200, { id: Number(c.path.split('/').pop()) }));
  h.guardedFetch.mockReset();
  h.guardedFetch.mockImplementation(gh.handler);
  ghApp = await seedApp(db, key.privateKey);
  ({ inst } = await seedInstallation(db, ghApp));
  const [parent] = await db
    .insert(services)
    .values({ name: 'Web @team', slug: 'web', repoUrl: 'https://github.com/acme/app.git' })
    .returning();
  parentId = parent!.id;
  const [preview] = await db
    .insert(services)
    .values({
      name: 'Web (PR #7)',
      slug: 'web-pr-7',
      repoUrl: 'https://github.com/acme/app.git',
      isEphemeralPreview: true,
      previewParentServiceId: parentId,
      prNumber: 7,
    })
    .returning();
  previewId = preview!.id;
  await db.insert(domains).values([
    { serviceId: parentId, hostname: 'web.example.com', status: 'active' },
    { serviceId: previewId, hostname: 'pr-7-web.preview.example.com', status: 'active' },
  ]);
  await db.insert(serviceGithubLinks).values({ serviceId: parentId, installationRowId: inst.id, repoId: 555, repoFullName: 'acme/app' });
  const [dep] = await db.insert(deployments).values({ serviceId: parentId, status: 'running', commitSha: SHA }).returning();
  depId = dep!.id;
  const [pdep] = await db.insert(deployments).values({ serviceId: previewId, status: 'running', commitSha: PREVIEW_SHA }).returning();
  previewDepId = pdep!.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const setLink = (patch: Partial<typeof serviceGithubLinks.$inferInsert>) =>
  db.update(serviceGithubLinks).set(patch).where(eq(serviceGithubLinks.serviceId, parentId));
const apiCalls = () => gh.calls.filter((c) => !c.path.endsWith('/access_tokens'));
const statusCalls = () => gh.calls.filter((c) => c.path.includes('/statuses/'));

describe('mapping', () => {
  it('maps deploy outcomes onto commit states and ignores the rest', () => {
    expect(commitStateFor('success')).toBe('success');
    expect(commitStateFor('failed')).toBe('failure');
    expect(commitStateFor('cancelled')).toBe('error');
    for (const s of ['trigger', 'rollback', 'cancel', undefined]) expect(commitStateFor(s)).toBeNull();
  });
});

describe('toggles', () => {
  it('both toggles off (the default): no GitHub call at all', async () => {
    const log = logger();
    await deployingFeedback(db, log, parentId, depId);
    await outcomeFeedback(db, log, depId, 'success');
    await outcomeFeedback(db, log, previewDepId, 'success');
    expect(gh.calls).toHaveLength(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a disabled link or an inactive installation reports nothing either', async () => {
    await setLink({ reportStatus: true, prComment: true, enabled: false });
    await outcomeFeedback(db, logger(), depId, 'success');
    await setLink({ enabled: true });
    await db.update(githubAppInstallations).set({ suspendedAt: new Date() }).where(eq(githubAppInstallations.id, inst.id));
    await outcomeFeedback(db, logger(), depId, 'success');
    expect(gh.calls).toHaveLength(0);
  });
});

describe('commit statuses', () => {
  beforeEach(async () => {
    await setLink({ reportStatus: true });
  });

  it('pending on deploying, then success / failure / error, with a statuses:write token scoped to the repo', async () => {
    const log = logger();
    await deployingFeedback(db, log, parentId, depId);
    for (const s of ['success', 'failed', 'cancelled', 'trigger']) await outcomeFeedback(db, log, depId, s);
    const calls = statusCalls();
    expect(calls.map((c) => c.body?.['state'])).toEqual(['pending', 'success', 'failure', 'error']);
    expect(calls[0]).toMatchObject({ method: 'POST', path: `/repos/acme/app/statuses/${SHA}` });
    expect(calls[0]!.body).toMatchObject({ context: 'ninedeploy/web', target_url: 'https://web.example.com' });
    expect(String(calls[1]!.body?.['description']).length).toBeLessThanOrEqual(140);
    const tokenCall = gh.calls.find((c) => c.path.endsWith('/access_tokens'));
    expect(tokenCall?.body).toEqual({ repository_ids: [555], permissions: { statuses: 'write' } });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('skips a SHA that is not 40-hex, and omits target_url without a domain', async () => {
    await db.update(deployments).set({ commitSha: 'abc1234' }).where(eq(deployments.id, depId));
    await deployingFeedback(db, logger(), parentId, depId);
    await outcomeFeedback(db, logger(), depId, 'success');
    expect(statusCalls()).toHaveLength(0);

    await db.update(deployments).set({ commitSha: SHA }).where(eq(deployments.id, depId));
    await db.delete(domains).where(eq(domains.serviceId, parentId));
    await outcomeFeedback(db, logger(), depId, 'success');
    expect(statusCalls()[0]!.body).not.toHaveProperty('target_url');
  });

  it('a preview reports through its parent’s link with the /preview context', async () => {
    await outcomeFeedback(db, logger(), previewDepId, 'success');
    expect(statusCalls()[0]).toMatchObject({ path: `/repos/acme/app/statuses/${PREVIEW_SHA}` });
    expect(statusCalls()[0]!.body).toMatchObject({ context: 'ninedeploy/web/preview', target_url: 'https://pr-7-web.preview.example.com' });
  });
});

describe('preview PR comment', () => {
  beforeEach(async () => {
    await setLink({ prComment: true });
  });

  it('creates one marked comment, stores its id, then PATCHes it', async () => {
    await deployingFeedback(db, logger(), previewId, previewDepId);
    await outcomeFeedback(db, logger(), previewDepId, 'success');
    const calls = apiCalls();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /repos/acme/app/issues/7/comments',
      'PATCH /repos/acme/app/issues/comments/1001',
    ]);
    const body = String(calls[1]!.body?.['body']);
    expect(body.startsWith(previewCommentMarker(parentId))).toBe(true);
    expect(body).toContain('Deployed');
    expect(body).toContain('https://pr-7-web.preview.example.com');
    expect(body).toContain('`fedcba9`');
    // The member-editable name cannot mention anyone.
    expect(body).not.toContain('@team');
    const row = await db.query.githubPrComments.findFirst({ where: eq(githubPrComments.serviceId, parentId) });
    expect(row).toMatchObject({ prNumber: 7, commentId: 1001, headSha: PREVIEW_SHA });
    expect(gh.calls.find((c) => c.path.endsWith('/access_tokens'))?.body).toEqual({
      repository_ids: [555],
      permissions: { pull_requests: 'write' },
    });
    // No comment for a production deploy, and no status (report_status is off).
    await outcomeFeedback(db, logger(), depId, 'success');
    expect(apiCalls()).toHaveLength(2);
  });

  it('recreates the comment when GitHub answers 404 for the stored one', async () => {
    await db.insert(githubPrComments).values({ serviceId: parentId, prNumber: 7, commentId: 77, headSha: null });
    gh.on('PATCH', /^\/repos\/acme\/app\/issues\/comments\/77$/, () => json(404, { message: 'Not Found' }));
    await outcomeFeedback(db, logger(), previewDepId, 'failed');
    expect(apiCalls().map((c) => `${c.method} ${c.path}`)).toEqual([
      'PATCH /repos/acme/app/issues/comments/77',
      'POST /repos/acme/app/issues/7/comments',
    ]);
    expect(String(apiCalls()[1]!.body?.['body'])).toContain('Deploy failed');
    const row = await db.query.githubPrComments.findFirst({ where: eq(githubPrComments.serviceId, parentId) });
    expect(row!.commentId).toBe(1001);
  });

  it('serializes per (service, PR): two concurrent outcomes create one comment', async () => {
    await Promise.all([outcomeFeedback(db, logger(), previewDepId, 'success'), outcomeFeedback(db, logger(), previewDepId, 'success')]);
    expect(apiCalls().map((c) => c.method)).toEqual(['POST', 'PATCH']);
    expect(await db.query.githubPrComments.findMany()).toHaveLength(1);
  });

  it('teardown edits the stored comment to "Preview destroyed", and creates nothing when none exists', async () => {
    await previewDestroyedFeedback(db, logger(), parentId, 7);
    expect(gh.calls).toHaveLength(0);
    await db.insert(githubPrComments).values({ serviceId: parentId, prNumber: 7, commentId: 55, headSha: PREVIEW_SHA });
    await previewDestroyedFeedback(db, logger(), parentId, 7);
    const patch = apiCalls()[0]!;
    expect(patch).toMatchObject({ method: 'PATCH', path: '/repos/acme/app/issues/comments/55' });
    expect(String(patch.body?.['body'])).toContain('Preview destroyed');
    expect(String(patch.body?.['body'])).not.toContain('Preview: ');
    gh.on('PATCH', /^\/repos\/acme\/app\/issues\/comments\/55$/, () => json(404, { message: 'Not Found' }));
    await previewDestroyedFeedback(db, logger(), parentId, 7);
    expect(apiCalls().filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

describe('observational only', () => {
  it('a GitHub failure is logged redacted and never thrown — the token never reaches the log', async () => {
    await setLink({ reportStatus: true, prComment: true });
    gh.on('POST', /\/statuses\//, (c) => json(500, { message: `boom ${c.headers.get('authorization')?.replace('Bearer ', '')}` }));
    gh.on('POST', /\/comments$/, () => {
      throw new Error(`socket hang up for ${gh.minted.at(-1)}`);
    });
    const log = logger();
    await expect(outcomeFeedback(db, log, previewDepId, 'success')).resolves.toBeUndefined();
    await expect(deployingFeedback(db, log, previewId, previewDepId)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
    const text = log.lines.join('\n');
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('SECRETTOKEN');
    expect(gh.minted.length).toBeGreaterThan(0);
  });

  it('an unreadable App key or a missing deployment is swallowed too', async () => {
    await setLink({ reportStatus: true });
    const log = logger();
    await expect(outcomeFeedback(db, log, 999_999, 'success')).resolves.toBeUndefined();
    await expect(deployingFeedback(db, log, 999_999, 1)).resolves.toBeUndefined();
    expect(gh.calls).toHaveLength(0);
  });
});

describe('plugin wiring', () => {
  it('listens on the kernel bus: service.deploying and deployment.status_changed reach GitHub', async () => {
    await setLink({ reportStatus: true });
    const app = await buildTestApp({ db });
    await app.register(githubFeedbackPlugin);
    await app.ready();
    app.kernel.events.emit('service.deploying', { serviceId: parentId, deployId: depId });
    app.kernel.events.emit('deployment.status_changed', { deploymentId: depId, status: 'success', serviceName: 'web' });
    await vi.waitFor(() => expect(statusCalls().map((c) => c.body?.['state']).sort()).toEqual(['pending', 'success']));
    await app.close();
  });

  it('is registered in app.ts after the kernel plugin', () => {
    const src = readFileSync(new URL('../../src/app.ts', import.meta.url), 'utf8');
    const kernel = src.indexOf('app.register(kernelPlugin)');
    const feedback = src.indexOf('app.register(githubFeedbackPlugin)');
    expect(kernel).toBeGreaterThan(0);
    expect(feedback).toBeGreaterThan(kernel);
  });
});
