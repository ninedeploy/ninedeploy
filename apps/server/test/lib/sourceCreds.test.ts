/**
 * 0.13 `resolveCloneCreds` (lib/sourceCreds.ts) against a migrated SQLite.
 *
 * - Every non-App source resolves byte-identically to the credential block the
 *   pipeline and the insights routes carried before 0.13 (copied verbatim
 *   below as `legacyBlock`).
 * - A GitHub App link or source mints a repo-scoped `contents: read` token,
 *   refuses to send it to any host but the App's, inherits a preview parent's
 *   link and remembers the repository id in a lazily created link.
 * No network: `guardedFetch` is a fake GitHub router.
 */
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditLog,
  githubAppInstallations,
  serviceGithubLinks,
  services,
  sources,
  type DB,
  type GithubApp,
  type GithubAppInstallation,
} from '@ninedeploy/db';

const h = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ef'.repeat(32);
  process.env['DOCKER_HOST'] = 'tcp://127.0.0.1:9';
  return { guardedFetch: vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>() };
});

vi.mock('../../src/lib/egressGuard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/egressGuard.js')>();
  return { ...actual, guardedFetch: h.guardedFetch };
});

const { resolveCloneCreds } = await import('../../src/lib/sourceCreds.js');
const { clearGithubAppCaches, GithubAppError } = await import('../../src/lib/githubApp.js');
const { decrypt, encrypt } = await import('../../src/lib/crypto.js');
const { fakeGithub, json, migratedDb, rsaKeyPair, seedApp, seedInstallation } = await import('./githubAppKit.js');

const PAT = 'ghp_legacyPersonalAccessToken';
const GL_PAT = 'glpat-legacyToken';
const DEPLOY_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----';

/** The pre-0.13 credential block of engine/pipeline.ts / modules/insights.ts, verbatim. */
async function legacyBlock(db: DB, service: { sourceId?: number | null }) {
  let creds: { type?: string; token?: string; deployKey?: string } | undefined;
  if (service.sourceId) {
    const src = await db.query.sources.findFirst({ where: eq(sources.id, service.sourceId) });
    if (src) {
      creds = {
        type: src.type,
        token: src.tokenEncrypted ? decrypt(src.tokenEncrypted) : undefined,
        deployKey: src.deployKeyEncrypted ? decrypt(src.deployKeyEncrypted) : undefined,
      };
    }
  }
  return creds;
}

let db: DB;
let app: GithubApp;
let live: GithubAppInstallation;
let liveSourceId: number;
let gh: ReturnType<typeof fakeGithub>;
let svcSeq = 0;

async function source(values: typeof sources.$inferInsert): Promise<number> {
  const [row] = await db.insert(sources).values(values).returning();
  return row!.id;
}

async function service(values: Partial<typeof services.$inferInsert>) {
  const n = ++svcSeq;
  const [row] = await db
    .insert(services)
    .values({ name: `svc${n}`, slug: `svc-${n}`, type: 'docker', repoUrl: 'https://github.com/acme/web.git', branch: 'main', ...values })
    .returning();
  return row!;
}

async function link(serviceId: number, inst: GithubAppInstallation, over: Partial<typeof serviceGithubLinks.$inferInsert> = {}) {
  await db.insert(serviceGithubLinks).values({ serviceId, installationRowId: inst.id, repoId: 777, repoFullName: 'acme/web', ...over });
}

const tokenCalls = () => gh.calls.filter((c) => c.path.endsWith('/access_tokens'));
const repoCalls = () => gh.calls.filter((c) => c.path.startsWith('/repos/'));

beforeAll(async () => {
  db = await migratedDb();
  app = await seedApp(db, rsaKeyPair('pkcs1').privateKey);
  ({ inst: live, sourceId: liveSourceId } = await seedInstallation(db, app, { installationId: 1001 }));
});

beforeEach(() => {
  clearGithubAppCaches();
  gh = fakeGithub();
  gh.on('GET', /^\/repos\/acme\/web$/, () => json(200, { id: 555, full_name: 'acme/web' }));
  h.guardedFetch.mockReset();
  h.guardedFetch.mockImplementation(gh.handler);
});

describe('non-App sources: byte-identical to the pre-0.13 block', () => {
  it('PAT, deploy key, GitLab, no credential, no source and a deleted source', async () => {
    const pat = await source({ type: 'github', name: 'pat', tokenEncrypted: encrypt(PAT) });
    const key = await source({ type: 'gitlab', name: 'key', deployKeyEncrypted: encrypt(DEPLOY_KEY) });
    const gl = await source({ type: 'gitlab', name: 'gl', tokenEncrypted: encrypt(GL_PAT), deployKeyEncrypted: encrypt(DEPLOY_KEY) });
    const none = await source({ type: 'custom', name: 'none' });
    const targets = [
      await service({ sourceId: pat }),
      await service({ sourceId: key, repoUrl: 'git@gitlab.com:acme/api.git' }),
      await service({ sourceId: gl, repoUrl: 'https://gitlab.com/acme/api.git' }),
      await service({ sourceId: none, repoUrl: 'https://git.example.com/x.git' }),
      await service({ sourceId: null }),
      { id: 99_999, sourceId: 88_888, repoUrl: 'https://github.com/acme/web.git' },
      // The insights analysis route: no service yet.
      { sourceId: pat, repoUrl: 'https://github.com/acme/other.git' },
    ];
    const outputs = [];
    for (const t of targets) {
      const before = await legacyBlock(db, t);
      const after = await resolveCloneCreds(db, t);
      expect(after).toStrictEqual(before);
      // Same keys in the same order (a JSON/log serialisation would match too).
      expect(after === undefined ? undefined : Object.keys(after)).toEqual(before === undefined ? undefined : Object.keys(before));
      outputs.push(after);
    }
    expect(outputs).toEqual([
      { type: 'github', token: PAT, deployKey: undefined },
      { type: 'gitlab', token: undefined, deployKey: DEPLOY_KEY },
      { type: 'gitlab', token: GL_PAT, deployKey: DEPLOY_KEY },
      { type: 'custom', token: undefined, deployKey: undefined },
      undefined,
      undefined,
      { type: 'github', token: PAT, deployKey: undefined },
    ]);
    expect(h.guardedFetch).not.toHaveBeenCalled();
  });

  it('a disabled link, or an enabled one on a suspended or removed installation, leaves the source in charge', async () => {
    const pat = await source({ type: 'github', name: 'pat2', tokenEncrypted: encrypt(PAT) });
    const { inst: suspended } = await seedInstallation(db, app, { installationId: 2001, suspendedAt: new Date() });
    const { inst: removed } = await seedInstallation(db, app, { installationId: 2002, removedAt: new Date() });
    const a = await service({ sourceId: pat });
    await link(a.id, live, { enabled: false });
    const b = await service({ sourceId: pat });
    await link(b.id, suspended);
    const c = await service({ sourceId: pat });
    await link(c.id, removed);
    for (const s of [a, b, c]) expect(await resolveCloneCreds(db, s)).toStrictEqual(await legacyBlock(db, s));
    expect(h.guardedFetch).not.toHaveBeenCalled();
  });
});

describe('GitHub App credentials', () => {
  it('an enabled link mints a contents:read token scoped to the linked repository', async () => {
    const pat = await source({ type: 'github', name: 'migrated', tokenEncrypted: encrypt(PAT) });
    const svc = await service({ sourceId: pat });
    await link(svc.id, live, { repoId: 31337 });
    const creds = await resolveCloneCreds(db, svc);
    expect(creds).toStrictEqual({ type: 'github_app', token: gh.minted[0] });
    expect(tokenCalls()).toHaveLength(1);
    expect(tokenCalls()[0]!.path).toBe('/app/installations/1001/access_tokens');
    expect(tokenCalls()[0]!.body).toEqual({ repository_ids: [31337], permissions: { contents: 'read' } });
    expect(repoCalls()).toHaveLength(0);
  });

  it('token_scope=installation drops the repository scope', async () => {
    const svc = await service({ sourceId: liveSourceId });
    await link(svc.id, live, { tokenScope: 'installation' });
    await resolveCloneCreds(db, svc);
    expect(tokenCalls()[0]!.body).toEqual({ permissions: { contents: 'read' } });
  });

  it('a github_app source with no link looks the repository up once and remembers it (feedback off)', async () => {
    const svc = await service({ sourceId: liveSourceId, name: 'web-app' });
    const creds = await resolveCloneCreds(db, svc);
    expect(creds).toMatchObject({ type: 'github_app' });
    // Lookup with a metadata-only token, then the repo-scoped clone token.
    expect(repoCalls()).toHaveLength(1);
    expect(tokenCalls().map((c) => c.body)).toEqual([
      { permissions: { metadata: 'read' } },
      { repository_ids: [555], permissions: { contents: 'read' } },
    ]);
    expect(creds!.token).toBe(gh.minted[1]);
    const row = await db.query.serviceGithubLinks.findFirst({ where: eq(serviceGithubLinks.serviceId, svc.id) });
    expect(row).toMatchObject({
      installationRowId: live.id,
      repoId: 555,
      repoFullName: 'acme/web',
      enabled: true,
      tokenScope: 'repository',
      reportStatus: false,
      prComment: false,
    });
    const audits = await db.query.auditLog.findMany({ where: eq(auditLog.action, 'service.github_link') });
    expect(audits.at(-1)).toMatchObject({ userId: null, entity: 'web-app' });

    // Next deploy: the link answers the repository id and the token is cached.
    gh.calls.length = 0;
    expect(await resolveCloneCreds(db, svc)).toStrictEqual(creds);
    expect(gh.calls).toHaveLength(0);
  });

  it('a PR preview inherits its parent’s link and gets no link of its own', async () => {
    const pat = await source({ type: 'github', name: 'parent-pat', tokenEncrypted: encrypt(PAT) });
    const parent = await service({ sourceId: pat });
    await link(parent.id, live, { repoId: 4242 });
    const preview = await service({ sourceId: pat, previewParentServiceId: parent.id, isEphemeralPreview: true, prNumber: 7, branch: 'feature' });
    expect(await resolveCloneCreds(db, preview)).toMatchObject({ type: 'github_app' });
    expect(tokenCalls()[0]!.body).toEqual({ repository_ids: [4242], permissions: { contents: 'read' } });
    expect(await db.query.serviceGithubLinks.findFirst({ where: eq(serviceGithubLinks.serviceId, preview.id) })).toBeUndefined();

    // A preview of an unlinked github_app service resolves, but is never linked itself.
    const appParent = await service({ sourceId: liveSourceId });
    const appPreview = await service({ sourceId: liveSourceId, previewParentServiceId: appParent.id, isEphemeralPreview: true, prNumber: 8 });
    expect(await resolveCloneCreds(db, appPreview)).toMatchObject({ type: 'github_app' });
    expect(await db.query.serviceGithubLinks.findFirst({ where: eq(serviceGithubLinks.serviceId, appPreview.id) })).toBeUndefined();
  });

  it('the insights analysis (no service id) resolves without writing a link', async () => {
    const before = (await db.select().from(serviceGithubLinks)).length;
    expect(await resolveCloneCreds(db, { sourceId: liveSourceId, repoUrl: 'https://github.com/acme/web' })).toMatchObject({ type: 'github_app' });
    expect((await db.select().from(serviceGithubLinks)).length).toBe(before);
  });

  it('refuses to send the token to another host, over another scheme or over SSH — before minting anything', async () => {
    const cases: Array<[string, RegExp]> = [
      ['https://gitlab.example.com/acme/web.git', /^Refusing to send a GitHub App token to gitlab\.example\.com/],
      ['https://github.com.evil.example/acme/web.git', /^Refusing to send a GitHub App token to github\.com\.evil\.example/],
      ['http://github.com/acme/web.git', /^Refusing to send a GitHub App token over http/],
      ['git@evil.example:acme/web.git', /^Refusing to send a GitHub App token to evil\.example/],
      ['git@github.com:acme/web.git', /clones over HTTPS/],
      ['https://x-access-token:old@github.com/acme/web.git', /carries credentials/],
      ['https://github.com/acme', /owner>\/<repo/],
    ];
    for (const [repoUrl, message] of cases) {
      const viaSource = await service({ sourceId: liveSourceId, repoUrl });
      await expect(resolveCloneCreds(db, viaSource)).rejects.toThrow(message);
      const viaLink = await service({ sourceId: null, repoUrl });
      await link(viaLink.id, live);
      await expect(resolveCloneCreds(db, viaLink)).rejects.toThrow(message);
    }
    expect(h.guardedFetch).not.toHaveBeenCalled();
  });

  it('a removed or suspended installation behind a github_app source is a clear refusal', async () => {
    const { inst: gone, sourceId: goneSource } = await seedInstallation(db, app, { installationId: 3001, removedAt: new Date() });
    await expect(resolveCloneCreds(db, await service({ sourceId: goneSource }))).rejects.toMatchObject({ reason: 'removed' });
    const { sourceId: pausedSource } = await seedInstallation(db, app, { installationId: 3002, suspendedAt: new Date() });
    await expect(resolveCloneCreds(db, await service({ sourceId: pausedSource }))).rejects.toMatchObject({ reason: 'suspended' });
    const orphan = await source({ type: 'github_app', name: 'orphan' });
    await expect(resolveCloneCreds(db, await service({ sourceId: orphan }))).rejects.toMatchObject({ reason: 'no_installation' });
    expect(h.guardedFetch).not.toHaveBeenCalled();
    expect(gone.removedAt).toBeInstanceOf(Date);
  });

  it('a repository outside the selection is named, and no token reaches the error or the audit log', async () => {
    gh.on('GET', /^\/repos\/acme\/secret$/, () => json(404, { message: 'Not Found' }));
    const svc = await service({ sourceId: liveSourceId, repoUrl: 'https://github.com/acme/secret.git' });
    let thrown: Error | undefined;
    try {
      await resolveCloneCreds(db, svc);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(GithubAppError);
    expect(thrown!.message).toMatch(/cannot see acme\/secret: it is not among the installation's selected repositories/);
    expect(gh.minted.length).toBeGreaterThan(0);
    const audits = JSON.stringify(await db.select().from(auditLog));
    const installations = JSON.stringify(await db.select().from(githubAppInstallations));
    for (const token of gh.minted) {
      expect(thrown!.message).not.toContain(token);
      expect(audits).not.toContain(token);
      expect(installations).not.toContain(token);
    }
    expect(await db.query.serviceGithubLinks.findFirst({ where: eq(serviceGithubLinks.serviceId, svc.id) })).toBeUndefined();
  });
});
