/**
 * C1 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): one evaluation per feature
 * for the panel, the API, the routes and the docs.
 *  - the capabilities route answers what the evaluator says;
 *  - a route refuses exactly what the evaluator calls unavailable;
 *  - every feature is refused through `assertServiceCapability` in some route;
 *  - docs/SUPPORT_MATRIX.md is generated from the evaluator
 *    (ND_UPDATE_SUPPORT_MATRIX=1 rewrites it).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { servers, services, serviceTargets, users, type DB } from '@ninedeploy/db';
import { SERVICE_CAPABILITY_IDS, type ServiceCapabilityId } from '@ninedeploy/schemas';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const { runtimeOf, serviceCapabilities } = await import('../src/lib/serviceCapabilities.js');
const { serviceCapabilityRoutes } = await import('../src/modules/serviceCapabilities.js');
const { restartLimitRoutes } = await import('../src/modules/restartLimit.js');
const { inlineDockerfileRoutes } = await import('../src/modules/inlineDockerfile.js');
const { asUser, buildTestApp } = await import('./helpers.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

/** One service per support-matrix column, ids 1–8. */
const FIXTURES = [
  { id: 1, slug: 'panel-docker', type: 'docker', repoUrl: 'https://github.com/acme/a' },
  { id: 2, slug: 'panel-docker-image', type: 'docker', image: 'nginx:1.27' },
  { id: 3, slug: 'panel-compose', type: 'compose', composeContent: 'services:\n  web:\n    image: nginx\n' },
  { id: 4, slug: 'panel-pm2', type: 'pm2', repoUrl: 'https://github.com/acme/b' },
  { id: 5, slug: 'node-docker', type: 'docker', repoUrl: 'https://github.com/acme/c', serverId: 9 },
  { id: 6, slug: 'node-compose', type: 'compose', composeContent: 'services:\n  web:\n    image: nginx\n', serverId: 9 },
  { id: 7, slug: 'swarm-docker', type: 'docker', image: 'nginx:1.27', orchestrator: 'swarm' },
  { id: 8, slug: 'panel-docker-fanout', type: 'docker', repoUrl: 'https://github.com/acme/d' },
] as const;

let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'h', isInstanceOperator: true });
  await db.insert(servers).values({ id: 9, name: 'node', host: 'node.test', tokenEncrypted: 'fixture' } as never);
  await db.insert(services).values(FIXTURES.map((f) => ({ name: f.slug, branch: 'main', ownerUserId: 1, port: 80, ...f })) as never);
  await db.insert(serviceTargets).values({ serviceId: 8, serverId: 9 } as never);
});
afterEach(() => closeMigratedDb(db));

const load = async (id: number) => (await db.query.services.findFirst({ where: (s, { eq }) => eq(s.id, id) }))!;

describe('evaluation', () => {
  it('names the runtime column and answers the panel-only features by placement', async () => {
    const caps = async (id: number) => serviceCapabilities(db, await load(id));
    expect(runtimeOf(await load(5))).toBe('node-docker');
    expect(runtimeOf(await load(7))).toBe('swarm-docker');
    expect((await caps(1)).maintenance).toEqual({ status: 'available', reason: null });
    // P2: a node serves the pages itself; its agent is checked when the setting is saved.
    expect((await caps(5)).maintenance).toMatchObject({ status: 'limited', reason: expect.stringMatching(/agent serves the pages itself: it must be v0\.18\.27/) });
    expect((await caps(5)).errorPages.status).toBe('limited');
    expect((await caps(5)).forwardAuth).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/panel host/) });
    expect((await caps(8)).maintenance).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/also runs on nodes/) });
    expect((await caps(8)).forwardAuth).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/also runs on nodes/) });
    expect((await caps(2)).inlineDockerfile.status).toBe('unavailable');
    expect((await caps(7)).restartLimit.status).toBe('unavailable');
    expect((await caps(4)).restartLimit.status).toBe('available');
    expect((await caps(3)).fileMounts.status).toBe('unavailable');
    expect((await caps(7)).autoscale.status).toBe('limited');
    expect((await caps(5)).scaleToZero.status).toBe('in_progress');
    expect((await caps(4)).canary.status).toBe('unavailable');
  });

  it('the route answers the evaluation, for a viewer', async () => {
    const app = await buildTestApp({ db });
    await app.register(serviceCapabilityRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'GET', url: '/services/5/capabilities', headers: asUser() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ serviceId: 5, runtime: 'node-docker', capabilities: await serviceCapabilities(db, await load(5)) });
    await app.close();
  });
});

describe('routes refuse exactly what the evaluation calls unavailable', () => {
  it('restart limit and inline Dockerfile, for every fixture', async () => {
    const app = await buildTestApp({ db });
    await app.register(restartLimitRoutes, { prefix: '/services' });
    await app.register(inlineDockerfileRoutes, { prefix: '/services' });
    for (const f of FIXTURES) {
      const caps = await serviceCapabilities(db, await load(f.id));
      const limit = await app.inject({ method: 'PUT', url: `/services/${f.id}/restart-limit`, headers: asUser(), payload: { limit: { maxRestarts: 5, windowMinutes: 10 } } });
      expect(limit.statusCode === 400, `${f.slug} restart limit`).toBe(caps.restartLimit.status === 'unavailable');
      if (limit.statusCode === 400) expect(limit.json().error).toEqual({ code: 'restart_limit_unsupported', message: caps.restartLimit.reason });
      const dockerfile = await app.inject({ method: 'PUT', url: `/services/${f.id}/inline-dockerfile`, headers: asUser(), payload: { content: 'FROM nginx:1.27\n' } });
      expect(dockerfile.statusCode === 400, `${f.slug} inline Dockerfile`).toBe(caps.inlineDockerfile.status === 'unavailable');
    }
    await app.close();
  });

  it('every feature is refused through assertServiceCapability in a route', () => {
    const root = fileURLToPath(new URL('../src/modules', import.meta.url));
    const text = readdirSync(root)
      .filter((f) => f.endsWith('.ts') && statSync(join(root, f)).isFile())
      .map((f) => readFileSync(join(root, f), 'utf8'))
      .join('\n');
    const used = new Set([...text.matchAll(/assertServiceCapability\([^)]*'([A-Za-z]+)'\)/g)].map((m) => m[1]));
    expect(SERVICE_CAPABILITY_IDS.filter((id) => !used.has(id))).toEqual([]);
  });
});

const LABEL: Record<ServiceCapabilityId, string> = {
  maintenance: 'Maintenance mode',
  errorPages: 'Custom error pages',
  forwardAuth: 'Panel sign-in on a domain (forward auth)',
  restartLimit: 'Restart-loop limit',
  inlineDockerfile: 'Inline Dockerfile',
  fileMounts: 'File mounts',
  autoscale: 'Autoscaling',
  scaleToZero: 'Scale to zero',
  canary: 'Canary releases',
};
const COLUMNS: Array<{ id: number; title: string }> = [
  { id: 1, title: 'Docker (panel host)' },
  { id: 2, title: 'Docker from an image (panel host)' },
  { id: 3, title: 'Compose (panel host)' },
  { id: 4, title: 'PM2 (panel host)' },
  { id: 5, title: 'Docker (node)' },
  { id: 6, title: 'Compose (node)' },
  { id: 7, title: 'Docker (Swarm)' },
  { id: 8, title: 'Docker (panel host + node fan-out)' },
];
const MARK = { available: '✅', limited: '🟡', in_progress: '🚧', unavailable: '—' } as const;

describe('docs/SUPPORT_MATRIX.md', () => {
  it('is generated from the evaluation', async () => {
    const results = new Map<number, Awaited<ReturnType<typeof serviceCapabilities>>>();
    for (const c of COLUMNS) results.set(c.id, await serviceCapabilities(db, await load(c.id)));
    const notes: string[] = [];
    const noteFor = (reason: string) => {
      let i = notes.indexOf(reason);
      if (i < 0) i = notes.push(reason) - 1;
      return `[${i + 1}]`;
    };
    const rows = SERVICE_CAPABILITY_IDS.map((id) => {
      const cells = COLUMNS.map((c) => {
        const cap = results.get(c.id)![id];
        return cap.reason ? `${MARK[cap.status]} ${noteFor(cap.reason)}` : MARK[cap.status];
      });
      return `| ${LABEL[id]} | ${cells.join(' | ')} |`;
    });
    const doc = [
      '# Support matrix',
      '',
      '<!-- Generated by apps/server/test/serviceCapabilities.test.ts from lib/serviceCapabilities.ts. Do not edit by hand: run the test with ND_UPDATE_SUPPORT_MATRIX=1. -->',
      '',
      'Which service features work where. The panel reads the same evaluation from `GET /v1/services/:id/capabilities` and disables a control before you save it. The routes refuse with the same reasons.',
      '',
      `${MARK.available} works · ${MARK.limited} works partly or is held at run time · ${MARK.in_progress} being built · ${MARK.unavailable} refused when saved`,
      '',
      `| Feature | ${COLUMNS.map((c) => c.title).join(' | ')} |`,
      `|---|${COLUMNS.map(() => '---').join('|')}|`,
      ...rows,
      '',
      '## Notes',
      '',
      ...notes.map((n, i) => `${i + 1}. ${n}`),
      '',
      'Checks of the live environment are not in this table. They run when you save or deploy. Examples: whether Traefik can reach the panel for maintenance pages and forward auth, and whether a node agent advertises an operation.',
      '',
    ].join('\n');
    const file = new URL('../../../docs/SUPPORT_MATRIX.md', import.meta.url);
    if (process.env['ND_UPDATE_SUPPORT_MATRIX'] === '1') writeFileSync(file, doc);
    expect(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).toBe(doc);
  });
});
