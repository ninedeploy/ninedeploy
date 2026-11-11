import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildImportPlan, CREDENTIAL_ENV, importPlanAction, renderImportPlan } from '../src/commands/importPlan.js';
import { planFromCaprover } from '../src/lib/importers/caprover.js';
import { planFromCoolify } from '../src/lib/importers/coolify.js';
import { planFromDokploy } from '../src/lib/importers/dokploy.js';
import { domainsFrom, envNames, isGeneratedHost, memToMb, stripUserinfo, type ImportPlan, type SourceGet } from '../src/lib/importers/plan.js';
import { caproverSource, coolifySource, dokploySource, normaliseBase, OtpRequiredError, SourceError } from '../src/lib/importers/sources.js';
import { caprover, caproverLive, coolify, dokploy, SENTINEL } from './fixtures/importSources.js';

/** A source that answers only the paths in its fixture (an unexpected call fails the test). */
const fromFixture = (map: Record<string, unknown>): SourceGet => async (p) => {
  if (!(p in map)) throw new Error(`unexpected source call ${p}`);
  return structuredClone(map[p]);
};

/** The A1 secret rule: no plan, and no printed plan, ever contains a secret. */
function assertNoSecret(plan: ImportPlan) {
  expect(JSON.stringify(plan)).not.toContain(SENTINEL);
  expect(renderImportPlan(plan)).not.toContain(SENTINEL);
}

const byName = (plan: ImportPlan, name: string) => plan.services.find((s) => s.name === name)!;
const issue = (items: Array<{ option: string; level: string }>, option: string) => items.find((i) => i.option === option);

describe('plan helpers', () => {
  it('strips userinfo from URLs and scp-style remotes, and leaves other text alone', () => {
    expect(stripUserinfo('https://u:p@github.com/a/b.git')).toBe('https://github.com/a/b.git');
    expect(stripUserinfo('https://github.com/a/b')).toBe('https://github.com/a/b');
    expect(stripUserinfo('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
    expect(stripUserinfo('user:secret@host:a/b.git')).toBe('host:a/b.git');
    expect(stripUserinfo('not a url')).toBe('not a url');
  });

  it('reads env names only, domains with their scheme, and memory sizes', () => {
    expect(envNames('A=1\n# c\n\nexport B=2\n bad key=3\nC\n=x')).toEqual([{ key: 'A' }, { key: 'B' }, { key: 'C' }]);
    expect(envNames(undefined)).toEqual([]);
    expect(domainsFrom('https://a.example, http://b.example:8080/x ,c.example,,')).toEqual([
      { host: 'a.example', https: true }, { host: 'b.example', https: false }, { host: 'c.example', https: false },
    ]);
    // Hosts the sources generate for themselves are marked, so they are never moved.
    expect(domainsFrom('http://x1.203.0.113.7.sslip.io,https://app-ab12.traefik.me,app.example')).toEqual([
      { host: 'x1.203.0.113.7.sslip.io', https: false, sourceDefault: true }, { host: 'app-ab12.traefik.me', https: true, sourceDefault: true }, { host: 'app.example', https: false },
    ]);
    expect(isGeneratedHost('a.10.0.0.1.NIP.IO')).toBe(true);
    expect(isGeneratedHost('traefik.me.example.com')).toBe(false);
    expect(memToMb('512m')).toBe(512);
    expect(memToMb('2g')).toBe(2048);
    expect(memToMb('1073741824')).toBe(1024);
    expect(memToMb('300', 'mb')).toBe(300);
    expect(memToMb('0')).toBeUndefined();
    expect(memToMb('lots')).toBeUndefined();
    expect(memToMb('1k')).toBeUndefined();
    expect(memToMb('1t')).toBe(1048576);
  });
});

describe('Coolify adapter', async () => {
  const plan = await planFromCoolify(fromFixture(coolify), 'https://coolify.example');

  it('keeps no secret anywhere in the plan', () => assertNoSecret(plan));

  it('maps a Dockerfile app from a GitHub source, with its limits, health check, domains and volumes', () => {
    const api = byName(plan, 'shop-api');
    expect(api.kind).toBe('git');
    expect(api.create).toEqual({
      name: 'shop-api', type: 'docker', repoUrl: 'https://github.com/acme/shop-api.git', branch: 'main',
      build: { buildPack: 'dockerfile', baseDir: '/api', dockerfilePath: 'Dockerfile.prod' },
      port: 3000, healthPath: '/health', memLimitMb: 512, cpuLimitMilli: 1500, volumeMount: '/app/uploads',
    });
    expect(api.domains).toEqual([{ host: 'api.shop.example', https: true }, { host: 'api-old.shop.example', https: false }]);
    // Preview-only variables are not the service's; duplicates collapse.
    expect(api.env).toEqual([{ key: 'DATABASE_URL' }, { key: 'NODE_ENV' }]);
    expect(issue(api.issues, 'source')?.level).toBe('manual');
    expect(issue(api.issues, 'ports_exposes')?.level).toBe('info');
    expect(issue(api.issues, 'ports_mappings')?.level).toBe('manual');
    expect(issue(api.issues, 'volumes')?.level).toBe('manual');
    expect(issue(api.issues, 'file mount')?.level).toBe('manual');
  });

  it('maps an image app, a compose app from its repository, and flags an unknown build pack', () => {
    expect(byName(plan, 'docs').create).toEqual({ name: 'docs', type: 'docker', image: 'nginx:1.27-alpine', port: 80 });
    const stack = byName(plan, 'stack-from-repo');
    expect(stack.kind).toBe('compose');
    expect(stack.create).toEqual({ name: 'stack-from-repo', type: 'compose', repoUrl: 'https://gitlab.example/acme/stack.git', branch: 'prod' });
    expect(stack.env).toEqual([{ key: 'STACK_TOKEN' }]);
    const odd = byName(plan, 'odd');
    expect(odd.create.build?.buildPack).toBe('auto');
    expect(issue(odd.issues, 'build_pack')?.level).toBe('unsupported');
    expect(odd.create.port).toBeUndefined();
  });

  it('lists a one-click stack without reading its compose file, and every database type', () => {
    const stack = byName(plan, 'plausible');
    expect(stack.kind).toBe('compose');
    expect(stack.domains).toEqual([{ host: 'stats.example', https: true }]);
    expect(issue(stack.issues, 'docker_compose')?.level).toBe('manual');
    expect(plan.databases.map((d) => [d.name, d.engine])).toEqual([['shop-db', 'postgres'], ['cache', 'keydb'], ['tiny', null]]);
    expect(issue(plan.databases[0]!.issues, 'is_public')?.level).toBe('manual');
    expect(plan.databases[0]!.runtime).toEqual({ kind: 'container', name: plan.databases[0]!.ref });
    expect(issue(plan.databases[2]!.issues, 'database_type')?.level).toBe('unsupported');
    expect(plan.source).toEqual({ kind: 'coolify', url: 'https://coolify.example', version: '4.7.0', scope: 'the team the API token belongs to' });
  });

  it('reads a GitHub owner/repo and an app with no repository', async () => {
    const p = await planFromCoolify(fromFixture({
      '/api/v1/version': '4.7.0',
      '/api/v1/applications': [{ uuid: 'x', name: 'x', build_pack: 'nixpacks', git_repository: 'acme/x' }, { uuid: 'y', build_pack: 'static', publish_directory: '/dist' }, { uuid: 'z', build_pack: 'dockerimage', private_key_id: 4 }],
      '/api/v1/applications/x/envs': [], '/api/v1/applications/x/storages': {},
      '/api/v1/applications/y/envs': null, '/api/v1/applications/y/storages': null,
      '/api/v1/applications/z/envs': [], '/api/v1/applications/z/storages': {},
      '/api/v1/services': [], '/api/v1/databases': [{ uuid: 'q', database_type: 'standalone-future' }],
    }), 'https://c.example');
    expect(byName(p, 'x').create.repoUrl).toBe('https://github.com/acme/x');
    expect(issue(byName(p, 'x').issues, 'git_repository')?.level).toBe('info');
    expect(byName(p, 'y').create.build).toEqual({ buildPack: 'static', baseDir: '/', outputDir: 'dist' });
    expect(issue(byName(p, 'y').issues, 'git_repository')?.level).toBe('manual');
    expect(issue(byName(p, 'z').issues, 'docker_registry_image_name')?.level).toBe('manual');
    expect(issue(byName(p, 'z').issues, 'source')?.level).toBe('manual');
    expect(p.databases[0]).toMatchObject({ name: 'q', engine: null });
  });
});

describe('Dokploy adapter', async () => {
  const plan = await planFromDokploy(fromFixture(dokploy), 'https://dokploy.example');

  it('keeps no secret anywhere in the plan (env blobs, registry and database passwords, git URLs)', () => assertNoSecret(plan));

  it('walks project.all and reads each application with application.one', () => {
    const web = byName(plan, 'web');
    expect(web.create).toEqual({
      name: 'web', type: 'docker', repoUrl: 'https://github.com/acme/web', branch: 'main',
      build: { buildPack: 'heroku', baseDir: '/' }, port: 3000, memLimitMb: 1024, cpuLimitMilli: 500, replicas: 3, volumeMount: '/data',
    });
    expect(web.env).toEqual([{ key: 'NODE_ENV' }, { key: 'STRIPE_KEY' }, { key: 'API_URL' }]);
    expect(web.domains).toEqual([{ host: 'acme.example', https: true }, { host: 'www.acme.example', https: true }]);
    expect(issue(web.issues, 'source')?.level).toBe('manual');
  });

  it('maps an image app with a private registry, a drop upload, and a custom git URL', () => {
    const worker = byName(plan, 'worker');
    expect(worker.create).toEqual({ name: 'worker', type: 'docker', image: 'ghcr.io/acme/worker:2.1', replicas: 10 });
    expect(issue(worker.issues, 'registry')?.level).toBe('manual');
    expect(issue(worker.issues, 'replicas')?.level).toBe('manual');
    expect(issue(worker.issues, 'ports')?.level).toBe('manual');
    expect(issue(worker.issues, 'command')?.level).toBe('manual');
    expect(issue(byName(plan, 'legacy').issues, 'sourceType')?.level).toBe('unsupported');
    expect(byName(plan, 'internal').create).toEqual({
      name: 'internal', type: 'docker', repoUrl: 'https://git.acme.example/internal.git', branch: 'release',
      build: { buildPack: 'dockerfile', baseDir: '/svc', dockerfilePath: 'Dockerfile' }, port: 8080,
    });
  });

  it('maps compose (inline and from a repository) and every database kind, libSQL unsupported', () => {
    const raw = byName(plan, 'monitoring');
    expect(raw.create).toEqual({ name: 'monitoring', type: 'compose' });
    expect(issue(raw.issues, 'composeFile')?.level).toBe('manual');
    const mail = byName(plan, 'mail');
    expect(mail.create).toMatchObject({ type: 'compose', repoUrl: 'https://github.com/acme/mail', branch: 'main' });
    expect(issue(mail.issues, 'composeType')?.level).toBe('info');
    expect(mail.volumes).toEqual([{ mountPath: '/var/mail', source: 'bind', name: undefined }]);
    expect(plan.databases.map((d) => [d.name, d.engine, d.image])).toEqual([
      ['main-db', 'postgres', 'postgres:16'], ['events', 'mongo', 'mongo:8'], ['cache', 'redis', 'redis:7'], ['edge', null, 'ghcr.io/tursodatabase/libsql-server'],
    ]);
    expect(issue(plan.databases[0]!.issues, 'externalPort')?.level).toBe('manual');
    // Dokploy runs a database as the Swarm service named after its appName (the dump commands target it).
    expect(plan.databases[0]!.runtime).toEqual({ kind: 'swarm-service', name: 'main-db-a1b2' });
    expect(plan.databases[1]!.runtime).toBeUndefined();
    expect(plan.source.scope).toMatch(/organization the API key belongs to/);
  });

  it('flags Gitea (host unknown) and hosted GitLab/Bitbucket guesses', async () => {
    const p = await planFromDokploy(fromFixture({
      '/api/settings.getDokployVersion': 'v0.31.0',
      '/api/project.all': [{ environments: [{ applications: [{ applicationId: 'g' }, { applicationId: 'l' }, { applicationId: 'b' }, { applicationId: 'n' }, {}], compose: [{}] }] }],
      '/api/application.one?applicationId=g': { name: 'g', sourceType: 'gitea', giteaOwner: 'o', giteaRepository: 'r', giteaBranch: 'main', buildType: 'nixpacks' },
      '/api/application.one?applicationId=l': { name: 'l', sourceType: 'gitlab', gitlabOwner: 'o', gitlabRepository: 'r', gitlabBranch: 'dev', buildType: 'static', publishDirectory: './out' },
      '/api/application.one?applicationId=b': { name: 'b', sourceType: 'bitbucket', bitbucketOwner: 'o', bitbucketRepository: 'r', buildType: 'weird' },
      '/api/application.one?applicationId=n': null,
    }), 'https://d.example');
    expect(byName(p, 'g').create.repoUrl).toBeUndefined();
    expect(issue(byName(p, 'g').issues, 'sourceType')?.level).toBe('manual');
    expect(byName(p, 'l').create).toMatchObject({ repoUrl: 'https://gitlab.com/o/r', branch: 'dev', build: { buildPack: 'static', outputDir: 'out' } });
    expect(byName(p, 'b').create.build?.buildPack).toBe('auto');
    expect(issue(byName(p, 'b').issues, 'buildType')?.level).toBe('unsupported');
    expect(byName(p, 'n').issues.some((i) => i.option === 'repository')).toBe(true);
  });
});

describe('CapRover adapter', async () => {
  const plan = await planFromCaprover(fromFixture(caprover), 'https://captain.apps.acme.example');

  it('keeps no secret anywhere in the plan (env values, git password and key, tokens, the auth hash)', () => assertNoSecret(plan));

  it('reads the CapRover version from versionInfo', () => expect(plan.source.version).toBe('1.16.0'));

  it('maps a repository-backed app, with its subdomain, custom domain, replicas and volume', () => {
    const blog = byName(plan, 'blog');
    expect(blog.kind).toBe('git');
    expect(blog.create).toEqual({ name: 'blog', type: 'docker', repoUrl: 'https://github.com/acme/blog.git', branch: 'main', build: { buildPack: 'auto' }, port: 2368, replicas: 2, volumeMount: '/var/lib/ghost/content' });
    expect(blog.domains).toEqual([{ host: 'blog.apps.acme.example', https: true, sourceDefault: true }, { host: 'blog.acme.example', https: true }]);
    expect(blog.env).toEqual([{ key: 'DB_PASSWORD' }, { key: 'url' }]);
    for (const option of ['repoInfo', 'httpAuth', 'customNginxConfig', 'captain-definition', 'default subdomain']) expect(issue(blog.issues, option), option).toBeTruthy();
  });

  it('maps an external image, refuses an image only CapRover holds, and lists a one-click database', () => {
    expect(byName(plan, 'proxy').create).toEqual({ name: 'proxy', type: 'docker', image: 'traefik/whoami:v1.10.3', port: 80 });
    expect(issue(byName(plan, 'proxy').issues, 'ports')?.level).toBe('manual');
    const uploaded = byName(plan, 'uploaded');
    expect(uploaded.create.image).toBeUndefined();
    expect(uploaded.domains).toEqual([]);
    expect(issue(uploaded.issues, 'deployedImageName')?.level).toBe('unsupported');
    expect(plan.databases).toEqual([expect.objectContaining({ name: 'pg', engine: 'postgres', image: 'postgres:14.5' })]);
    expect(plan.services.some((s) => s.name === 'pg')).toBe(false);
  });

  it('falls back to the list rootDomain, then captain.localhost', async () => {
    const p = await planFromCaprover(fromFixture({
      '/api/v2/user/system/info/': { rootDomain: '' },
      '/api/v2/user/apps/appDefinitions/': { rootDomain: 'list.example', appDefinitions: [{ appName: 'a', notExposeAsWebApp: false, versions: [], tags: [{ tagName: 'not-a-db' }] }, { notAnApp: true }] },
    }), 'https://c.example');
    expect(byName(p, 'a').domains[0]).toEqual({ host: 'a.list.example', https: false, sourceDefault: true });
    const q = await planFromCaprover(async (p2) => { if (p2.includes('system')) throw new Error('no'); return { appDefinitions: [{ appName: 'b', nodeId: 'n1', preDeployFunction: 'x', serviceUpdateOverride: 'y', instanceCount: 1 }] }; }, 'https://c.example');
    expect(byName(q, 'b').domains[0]!.host).toBe('b.captain.localhost');
    for (const option of ['nodeId', 'preDeployFunction', 'serviceUpdateOverride']) expect(issue(byName(q, 'b').issues, option), option).toBeTruthy();
  });
});

describe('CapRover adapter, against a capture from a live v1.16.0', async () => {
  const plan = await planFromCaprover(fromFixture(caproverLive), 'http://127.0.0.1:13000');

  it('keeps no secret anywhere in the plan (env values, the Git password, the push-webhook token)', () => assertNoSecret(plan));

  it('reads the version and plans the captured apps, with system/info returning an empty rootDomain', () => {
    expect(plan.source.version).toBe('1.16.0');
    const blog = byName(plan, 'blog');
    expect(blog.create).toEqual({ name: 'blog', type: 'docker', repoUrl: 'https://github.com/acme/blog.git', branch: 'main', build: { buildPack: 'auto' }, port: 2368, replicas: 2, volumeMount: '/var/lib/ghost/content' });
    expect(blog.domains).toEqual([{ host: 'blog.captain.localhost', https: false, sourceDefault: true }]);
    expect(blog.env).toEqual([{ key: 'DB_PASSWORD' }, { key: 'url' }]);
    const proxy = byName(plan, 'proxy');
    expect(proxy.create).toEqual({ name: 'proxy', type: 'docker', image: 'traefik/whoami:v1.10.3', port: 80 });
    expect(issue(proxy.issues, 'instanceCount')?.level).toBe('info');
    expect(issue(proxy.issues, 'ports')?.level).toBe('manual');
    expect(issue(blog.issues, 'instanceCount')).toBeUndefined();
  });

  it('lists a never-deployed one-click database without the placeholder as its image', () => {
    expect(plan.databases).toEqual([expect.objectContaining({ name: 'pg', engine: 'postgres', image: null })]);
    expect(issue(plan.databases[0]!.issues, 'deployedVersion')?.level).toBe('info');
    // Live v1.16.0: the Swarm service is named after the app (no srv-captain-- prefix unless isLegacyAppName).
    expect(plan.databases[0]!.runtime).toEqual({ kind: 'swarm-service', name: 'pg' });
  });

  it('keeps the srv-captain-- service prefix for a legacy app', async () => {
    const p = await planFromCaprover(fromFixture({
      '/api/v2/user/apps/appDefinitions/': { rootDomain: 'x.example', appDefinitions: [{ appName: 'old', isLegacyAppName: true, tags: [{ tagName: 'mysql' }], versions: [] }] },
    }), 'https://c.example');
    expect(p.databases[0]!.runtime).toEqual({ kind: 'swarm-service', name: 'srv-captain--old' });
  });

  it('never plans the placeholder image for an app that was never deployed', async () => {
    const p = await planFromCaprover(fromFixture({
      '/api/v2/user/apps/appDefinitions/': { rootDomain: 'x.example', appDefinitions: [{ appName: 'fresh', deployedVersion: 0, versions: [{ version: 0, deployedImageName: 'caprover/caprover-placeholder-app:latest' }], tags: [] }] },
    }), 'https://c.example');
    const fresh = byName(p, 'fresh');
    expect(fresh.create.image).toBeUndefined();
    expect(issue(fresh.issues, 'deployedVersion')?.level).toBe('manual');
    expect(p.source.version).toBeNull();
  });
});

describe('source clients', () => {
  const res = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

  it('normalises the base URL and refuses anything else', () => {
    expect(normaliseBase('https://u:p@coolify.example/sub/')).toBe('https://coolify.example/sub');
    expect(() => normaliseBase('ftp://x')).toThrow(SourceError);
    expect(() => normaliseBase('nope')).toThrow(/Not a URL/);
  });

  it('Coolify: bearer token, plain-text version, and an actionable error for a disabled API, a bad token and a missing ability', async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(`Bearer ${SENTINEL}`);
      if (url.endsWith('/version')) return res(200, '4.7.0');
      if (url.endsWith('/disabled')) return res(403, { message: 'API is disabled.' });
      if (url.endsWith('/denied')) return res(401, { message: 'Unauthenticated.' });
      if (url.endsWith('/scope')) return res(403, { message: 'Missing required permissions: read' });
      if (url.endsWith('/empty')) return res(403, '');
      return res(500, 'boom');
    });
    const get = coolifySource('https://c.example', SENTINEL, f as typeof fetch);
    expect(await get('/api/v1/version')).toBe('4.7.0');
    for (const [p, re] of [['/disabled', /Settings → Advanced → API access/], ['/denied', /token was refused/], ['/scope', /Missing required permissions/], ['/empty', /lacks access/], ['/x', /HTTP 500/]] as const) {
      const err = await get(p).catch((e: Error) => e);
      expect(err).toBeInstanceOf(SourceError);
      expect((err as Error).message).toMatch(re);
      expect((err as Error).message).not.toContain(SENTINEL);
    }
  });

  it('Dokploy: x-api-key, and errors without the key in them', async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string> | undefined)?.['x-api-key']).toBe(SENTINEL);
      if (url.includes('ok')) return res(200, { a: 1 });
      if (url.includes('denied')) return res(401, { message: 'Unauthorized' });
      if (url.includes('blank')) return res(200, '');
      return res(400, { message: 'Input validation failed' });
    });
    const get = dokploySource('https://d.example', SENTINEL, f as typeof fetch);
    expect(await get('/api/ok')).toEqual({ a: 1 });
    expect(await get('/api/blank')).toBeNull();
    await expect(get('/api/denied')).rejects.toThrow(/API key was refused/);
    await expect(get('/api/bad?x=1')).rejects.toThrow(/Dokploy \/api\/bad answered HTTP 400: Input validation failed/);
  });

  it('CapRover: signs in once, reads the envelope, and maps every refusal', async () => {
    const login = (status: number, data: unknown = {}) => vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v2/login/')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ password: SENTINEL });
        return res(200, { status, description: 'x', data });
      }
      const auth = (init?.headers as Record<string, string> | undefined)?.['x-captain-auth'];
      if (url.endsWith('/expired')) return res(200, { status: 1106 });
      if (url.endsWith('/broken')) return res(502, 'bad gateway');
      if (url.endsWith('/other')) return res(200, { status: 1000, description: 'nope' });
      return res(200, { status: 100, data: { auth } });
    });
    const ok = login(100, { token: 'tok' });
    const get = await caproverSource('https://cr.example', SENTINEL, undefined, ok as typeof fetch);
    expect(await get('/api/v2/user/apps/appDefinitions/')).toEqual({ auth: 'tok' });
    await expect(get('/expired')).rejects.toThrow(/run the import again/);
    await expect(get('/broken')).rejects.toThrow(/HTTP 502/);
    await expect(get('/other')).rejects.toThrow(/status 1000: nope/);
    expect(ok.mock.calls.filter(([u]) => String(u).endsWith('/login/'))).toHaveLength(1);

    await expect(caproverSource('https://cr.example', SENTINEL, undefined, login(1114) as typeof fetch)).rejects.toBeInstanceOf(OtpRequiredError);
    await expect(caproverSource('https://cr.example', SENTINEL, undefined, login(1113) as typeof fetch)).rejects.toThrow(/wait 30 seconds/);
    await expect(caproverSource('https://cr.example', SENTINEL, undefined, login(1105) as typeof fetch)).rejects.toThrow(/refused the password/);
    await expect(caproverSource('https://cr.example', SENTINEL, undefined, login(100, {}) as typeof fetch)).rejects.toThrow(/sign-in failed \(status 100\)/);
    await expect(caproverSource('https://cr.example', SENTINEL, undefined, (async () => res(503, '')) as typeof fetch)).rejects.toThrow(/HTTP 503/);
    const withOtp = vi.fn(async (_u: string, init?: RequestInit) => res(200, { status: 100, data: { token: JSON.parse(String(init?.body)).otpToken } }));
    await caproverSource('https://cr.example', SENTINEL, '123456', withOtp as typeof fetch);
    expect(JSON.parse(String(withOtp.mock.calls[0]![1]!.body))).toEqual({ password: SENTINEL, otpToken: '123456' });
  });
});

describe('ninedeploy import plan', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** A fetch that serves a fixture map by path (and CapRover's envelope and login). */
  const fetchFor = (map: Record<string, unknown>, envelope = false) => (async (url: string) => {
    const p = new URL(url).pathname + new URL(url).search;
    if (p === '/api/v2/login/') return new Response(JSON.stringify({ status: 100, data: { token: 't' } }));
    if (!(p in map)) return new Response('', { status: 404 });
    const v = map[p];
    return new Response(envelope ? JSON.stringify({ status: 100, data: v }) : typeof v === 'string' ? v : JSON.stringify(v));
  }) as typeof fetch;

  it('takes the credential from the environment, never asks, and builds every source', async () => {
    const ask = vi.fn();
    const env = { [CREDENTIAL_ENV.coolify]: 'tok', [CREDENTIAL_ENV.caprover]: 'pw' };
    expect((await buildImportPlan('coolify', 'https://c.example', { env, ask, fetch: fetchFor(coolify) })).services).toHaveLength(5);
    expect((await buildImportPlan('dokploy', 'https://d.example', { env, ask, fetch: fetchFor(dokploy) })).databases).toHaveLength(4);
    expect((await buildImportPlan('caprover', 'https://cr.example', { env, ask, fetch: fetchFor(caprover, true) })).services).toHaveLength(3);
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks for the credential, then the CapRover two-factor code, through the hidden prompt', async () => {
    const ask = vi.fn(async (m: string) => (m.includes('two-factor') ? '654321' : 'pw'));
    let logins = 0;
    const f = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/login/')) {
        logins++;
        const b = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(b.otpToken ? { status: 100, data: { token: 't' } } : { status: 1114 }));
      }
      return new Response(JSON.stringify({ status: 100, data: { appDefinitions: [] } }));
    }) as typeof fetch;
    const plan = await buildImportPlan('caprover', 'https://cr.example', { env: {}, ask, fetch: f });
    expect(plan.services).toEqual([]);
    expect(logins).toBe(2);
    expect(ask.mock.calls.map(([m]) => m)).toEqual(['CapRover password: ', 'CapRover two-factor code: ']);
    // With NINEDEPLOY_IMPORT_OTP set, a refused code is not asked again.
    await expect(buildImportPlan('caprover', 'https://cr.example', { env: { NINEDEPLOY_IMPORT_PASSWORD: 'pw', NINEDEPLOY_IMPORT_OTP: '1' }, ask, fetch: (async () => new Response(JSON.stringify({ status: 1114 }))) as typeof fetch })).rejects.toBeInstanceOf(OtpRequiredError);
  });

  it('refuses an unknown source and an empty credential', async () => {
    await expect(buildImportPlan('render', 'https://x.example', { env: {} })).rejects.toThrow(/Unknown source/);
    await expect(buildImportPlan('dokploy', 'https://x.example', { env: {}, ask: async () => '  ' })).rejects.toThrow(/NINEDEPLOY_IMPORT_TOKEN/);
  });

  it('prints the plan, writes --out as JSON, and prints --json without secrets', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nd-import-'));
    dirs.push(dir);
    const out = path.join(dir, 'plan.json');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { writes.push(String(s)); return true; }) as typeof process.stdout.write);
    const deps = { env: { NINEDEPLOY_IMPORT_TOKEN: 'tok' }, fetch: fetchFor(dokploy) };
    await importPlanAction('dokploy', { url: 'https://d.example', out }, deps);
    const printed = logs.join('\n') + writes.join('');
    expect(printed).toMatch(/Import plan: 6 service\(s\), 4 database\(s\)/);
    expect(printed).toMatch(/env: 3 variable\(s\): NODE_ENV, STRIPE_KEY, API_URL \(names only\)/);
    expect(printed).not.toContain(SENTINEL);
    const saved = readFileSync(out, 'utf8');
    expect(JSON.parse(saved).planVersion).toBe(1);
    expect(saved).not.toContain(SENTINEL);
    writes.length = 0;
    await importPlanAction('dokploy', { url: 'https://d.example', json: true }, deps);
    expect(JSON.parse(writes.join('')).source.kind).toBe('dokploy');
    expect(writes.join('')).not.toContain(SENTINEL);
  });

  it('reports a source error and sets the exit code', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await importPlanAction('coolify', { url: 'https://c.example' }, { env: { NINEDEPLOY_IMPORT_TOKEN: 't' }, fetch: (async () => new Response(JSON.stringify({ message: 'API is disabled.' }), { status: 403 })) as typeof fetch });
    expect(process.exitCode).toBe(1);
  });
});
